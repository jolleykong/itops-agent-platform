/**
 * cmdbSyncWriter — iTop CI → 平台表的数据写入层
 *
 * 为什么不直接用 dcRepository/serverRepository？
 *   现有 repository 的 create 方法是给「平台原生 CRUD」设计的，字段集与 iTop 同步所需的
 *   （如 servers.ip_address / network_devices 的最小字段集）不完全匹配。
 *   强行复用会导致字段错配或需要给 repo 加大量「仅为同步用」的方法，反而增加耦合。
 *
 *   因此本文件作为 cmdb-sync 模块专属的数据写入层（类似 modules/dc 里的 writer 模式），
 *   把裸 SQL 收敛到这里，让 itopSyncService.ts 只负责编排（取数 → 映射 → 写入 → 记日志）。
 *
 * 所有写入都接受一个外部传入的 db 事务上下文（better-sqlite3 Transaction），
 * 由 itopSyncService 决定事务边界，保证「数据写入 + idMap 更新」原子性。
 */

/* eslint-disable no-restricted-imports -- cmdb-sync 专属写入层：需要直接执行同步专用 SQL
   （servers/network_devices 的现有 repo create 方法字段集与 iTop 同步需求不匹配，
    强行复用会导致字段错配。详见本文件头注释）*/
import db from '../../../models/database';
import { roomsRepo, racksRepo, pdusRepo, cmdbSyncStateRepo } from '../../../repositories';
import type { DcRackCreateInput } from '../../../repositories/dcRepository/types';

// ============================================================
// Location → dc_rooms
// ============================================================

export function upsertRoom(
  existingId: string | undefined,
  fields: { name: string; description?: string },
): string {
  if (existingId) {
    // roomsRepo.update 要求完整 DcRoomUpdateInput，这里只同步 name/description
    db.prepare(`
      UPDATE dc_rooms SET name = ?, description = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, fields.description ?? '', existingId);
    return existingId;
  }
  const newId = crypto.randomUUID();
  roomsRepo.create({
    id: newId,
    name: fields.name,
    description: fields.description ?? '',
  });
  return newId;
}

// ============================================================
// Rack → dc_racks
// ============================================================

/**
 * 机柜 3D 自动布局：同机房机柜按名称排序，每 6 台一排（间距 3.2m）
 * 只对坐标仍为 (0,0) 的未布局机柜生效，不覆盖手动拖动过的位置
 */
function ensureRackLayout(roomId: string, rackId: string): void {
  const rack = db.prepare('SELECT position_x, position_z FROM dc_racks WHERE id = ?').get(rackId) as
    | { position_x: number; position_z: number }
    | undefined;
  if (!rack || (Number(rack.position_x) !== 0 || Number(rack.position_z) !== 0)) return;
  const racks = db.prepare('SELECT id FROM dc_racks WHERE room_id = ? ORDER BY name').all(roomId) as { id: string }[];
  const idx = racks.findIndex((r) => r.id === rackId);
  if (idx < 0) return;
  const row = Math.floor(idx / 6) + 1;
  const col = idx % 6;
  db.prepare(
    "UPDATE dc_racks SET position_x = ?, position_z = ?, row_number = ?, updated_at = datetime('now','localtime') WHERE id = ?",
  ).run(col * 3.2, row * 3.2, row, rackId);
}

/**
 * @returns { id, action } 新建或更新的平台 ID；若缺少 room_id 则 throw 以触发 skip
 */
export function upsertRack(
  existingId: string | undefined,
  fields: { name: string; nb_u?: number; location_name?: string },
  roomId: string | null,
): { id: string; action: 'create' | 'update' } {
  // dc_racks.room_id 是 NOT NULL（见 v028_dc_infrastructure），缺机房时不能写入
  if (!roomId) {
    throw new Error(
      `机柜 ${fields.name} 无法关联到机房（location_name="${fields.location_name ?? ''}" 未同步或为空），跳过`,
    );
  }

  if (existingId) {
    // 只更新 name / total_u / room_id（COALESCE 保留原值）
    // nb_u 坑：iTop 机柜 nb_u 常为空 → REST 返回 '' → `'' ?? 42` 不兜空串 → total_u 存成 ''。
    // 必须显式数值化，空/0 一律回退 42U 标准柜。
    const totalU = Number(fields.nb_u) > 0 ? Number(fields.nb_u) : 42;
    db.prepare(`
      UPDATE dc_racks SET name = ?, total_u = ?, room_id = COALESCE(?, room_id), updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, totalU, roomId, existingId);
    ensureRackLayout(roomId, existingId);
    return { id: existingId, action: 'update' };
  }

  const totalU = Number(fields.nb_u) > 0 ? Number(fields.nb_u) : 42;
  const newId = crypto.randomUUID();
  const input: DcRackCreateInput = {
    id: newId,
    name: fields.name,
    room_id: roomId,
    total_u: totalU,
  };
  racksRepo.create(input);
  ensureRackLayout(roomId, newId);
  return { id: newId, action: 'create' };
}

// ============================================================
// Server → servers
// ============================================================

export interface ServerUpsertResult {
  id: string;
  action: 'create' | 'update' | 'skip';
  message?: string;
}

/**
 * 注意：servers.ip_address 在 v001 schema 中并无 UNIQUE 约束
 * （只有 network_devices.ip_address 和 credentials 表的 ip_address 是 UNIQUE）。
 * 因此这里不再做 IP 冲突预检——直接写入即可。
 *
 * iTop 字段映射：
 *   managementip_name → ip_address（管理 IP，优先）
 *   svrbizip_name     → 备用（业务 IP，managementip 为空时用）
 *   osfamily_name     → os
 */
export function upsertServer(
  existingId: string | undefined,
  fields: {
    name: string;
    managementip_name?: string;
    svrbizip_name?: string;
    osfamily_name?: string;
  },
): ServerUpsertResult {
  const ip = fields.managementip_name || fields.svrbizip_name || '';

  if (existingId) {
    db.prepare(`
      UPDATE servers
      SET name = ?, os = ?, hostname = COALESCE(NULLIF(?, ''), hostname), ip_address = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, fields.osfamily_name ?? '', ip, ip || null, existingId);
    return { id: existingId, action: 'update' };
  }

  const newId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO servers (id, name, hostname, port, username, password, use_ssh_key, os, os_type, ip_address, enabled, tags, created_at, updated_at)
    VALUES (?, ?, ?, 22, '', NULL, 0, ?, 'linux', ?, 1, '[]', datetime('now','localtime'), datetime('now','localtime'))
  `).run(newId, fields.name, ip || fields.name, fields.osfamily_name ?? '', ip || null);

  return {
    id: newId,
    action: 'create',
    message: '未同步 SSH 密码/密钥，请在平台手动配置',
  };
}

// ============================================================
// DatacenterDevice → network_devices / dc_pdus
// ============================================================

export interface DeviceUpsertResult {
  id: string;
  action: 'create' | 'update' | 'skip';
  table: 'network_devices' | 'dc_pdus';
  message?: string;
}

/**
 * 根据 finalclass 分流：
 *   pdu / ups 类 → dc_pdus
 *   其他（switch / router / firewall 等）→ network_devices（要求唯一 IP）
 *
 * iTop 字段映射：
 *   managementip_name → ip_address（管理 IP）
 *   finalclass        → 设备类型判断（NetworkDevice / PDU / UPS ...）
 */
export function upsertDatacenterDevice(
  existingId: string | undefined,
  fields: {
    name: string;
    description?: string;
    managementip_name?: string;
    finalclass?: string;
  },
): DeviceUpsertResult {
  // IP 兜底：台账导入的设备 name 即管理 IP（iTop 里 managementip 未关联 → managementip_name 为空）
  const ip = fields.managementip_name || (/^\d{1,3}(\.\d{1,3}){3}$/.test(fields.name.trim()) ? fields.name.trim() : '');
  const finalClass = (fields.finalclass ?? '').toLowerCase();
  const isPDU = finalClass.includes('pdu') || finalClass.includes('ups');

  if (isPDU) {
    if (existingId) {
      db.prepare(`
        UPDATE dc_pdus SET name = ?, updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(fields.name, existingId);
      return { id: existingId, action: 'update', table: 'dc_pdus' };
    }
    const newId = crypto.randomUUID();
    pdusRepo.create({
      id: newId,
      name: fields.name,
      type: 'pdu',
      status: 'active',
      ip_address: ip,
      model: fields.description ?? '',
    });
    return { id: newId, action: 'create', table: 'dc_pdus' };
  }

  // network_devices 分支
  // network_devices.ip_address 是 NOT NULL UNIQUE（见 v006_network_device_credentials），
  // 无 IP 的设备必须跳过；IP 冲突时关联到已有记录。
  if (existingId) {
    db.prepare(`
      UPDATE network_devices SET name = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, existingId);
    return { id: existingId, action: 'update', table: 'network_devices' };
  }

  if (!ip) {
    return {
      id: '',
      action: 'skip',
      table: 'network_devices',
      message: `${fields.name} 无 IP 地址，跳过（network_devices 要求唯一 IP）`,
    };
  }

  // IP 唯一性检查（仅 network_devices 需要）
  const ipOwner = db.prepare('SELECT id FROM network_devices WHERE ip_address = ?').get(ip) as
    | { id: string }
    | undefined;
  if (ipOwner) {
    return {
      id: ipOwner.id,
      action: 'skip',
      table: 'network_devices',
      message: `IP ${ip} 已存在，关联到已有设备`,
    };
  }

  const newId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO network_devices (id, name, ip_address, vendor, device_type, status, snmp_enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'unknown', 'unknown', 'online', 1, datetime('now','localtime'), datetime('now','localtime'))
  `).run(newId, fields.name, ip);
  return { id: newId, action: 'create', table: 'network_devices' };
}

// ============================================================
// 辅助：按名称查机房（Rack 关联用）
// ============================================================

export function findRoomIdByName(name: string): string | null {
  const room = db.prepare('SELECT id FROM dc_rooms WHERE name = ?').get(name) as
    | { id: string }
    | undefined;
  return room?.id ?? null;
}

// ============================================================
// 挂柜关系 → dc_rack_slots（方案 A：让 3D 机房看到机柜内设备）
//
// 数据流：iTop Server/DatacenterDevice.rack_id（iTop 数字 id）
//        → Rack idMap（rackStrategy 先行同步，iTop id → dc_racks.id）
//        → dc_rack_slots(rack_id, device_id, start_u, end_u)
//
// U 位来源优先级：
//   1) description 中的台账标注「位置：Uxx」（台账 2026-11-24v2 导入时写入）
//   2) 机柜内首个空闲 U 位（sync Server 的 description 被 zbx2itop DS 锁定、
//      无台账 U 位 → 自动占位，后续可在平台 UI 调整）
// ============================================================

// description 实测格式（台账导入）：'位置:U30（台账 2026-11-24） 位置:U32（台账 2026-11-24v2）'
// — v1/v2 标注并存（半角冒号），必须取最后一个匹配（最新的 v2 标注）
const U_POSITION_RE = /位置[:：]\s*U(\d+)/gi;

/** 从 description 解析台账 U 位号；多条标注并存时取最后一条（最新） */
export function parseUPosition(description?: string): number | null {
  if (!description) return null;
  const matches = [...description.matchAll(U_POSITION_RE)];
  if (matches.length === 0) return null;
  const u = parseInt(matches[matches.length - 1][1], 10);
  return Number.isFinite(u) && u > 0 ? u : null;
}

/** iTop Rack 数字 id → 平台 dc_racks.id（经 cmdb_sync_state 的 Rack idMap） */
export function findRackPlatformId(itopRackId: string): string | null {
  if (!itopRackId) return null;
  const idMap = cmdbSyncStateRepo.getIdMap('Rack');
  return idMap[String(itopRackId)] ?? null;
}

/** 在机柜内找首个可容纳 needU 个连续 U 位的起始位；满则 null */
function findFreeStartU(rackId: string, needU: number): number | null {
  const rack = db.prepare('SELECT total_u FROM dc_racks WHERE id = ?').get(rackId) as
    | { total_u: number }
    | undefined;
  // iTop 机柜 nb_u 常为空 → REST 返回 '' → total_u 存成空串；容量必须容错回 42U
  const rackTotal = Number(rack?.total_u);
  const totalU = Number.isFinite(rackTotal) && rackTotal > 0 ? rackTotal : 42;
  const rows = db
    .prepare('SELECT start_u, end_u FROM dc_rack_slots WHERE rack_id = ?')
    .all(rackId) as { start_u: number; end_u: number }[];
  const occupied = new Set<number>();
  for (const r of rows) {
    for (let u = r.start_u; u <= r.end_u; u++) occupied.add(u);
  }
  for (let u = 1; u + needU - 1 <= totalU; u++) {
    let free = true;
    for (let k = 0; k < needU; k++) {
      if (occupied.has(u + k)) {
        free = false;
        break;
      }
    }
    if (free) return u;
  }
  return null;
}

/** 指定 U 位是否被该机柜内其他槽位占用 */
function isUOccupied(rackId: string, u: number, excludeSlotId?: string): boolean {
  const row = db
    .prepare(
      'SELECT id FROM dc_rack_slots WHERE rack_id = ? AND start_u <= ? AND end_u >= ? AND id != COALESCE(?, \'\') LIMIT 1',
    )
    .get(rackId, u, u, excludeSlotId ?? null);
  return row !== undefined;
}

export interface SlotSyncResult {
  action: 'create' | 'update' | 'skip';
  message?: string;
}

/**
 * 同步单台设备的挂柜关系（幂等，随每轮 sync 重算）
 *
 * 规则：
 *   - iTop 无机柜关联且平台已有槽位 → 摘除槽位（解除挂柜，iTop 是唯一事实源）
 *   - 设备未落库（platformId 空）且无槽位 → skip
 *   - 已有槽位：同柜不动；换柜时保留原 U 位（冲突则重新占位）
 *   - 无槽位：台账 U 位可用则落台账 U（冲突顺延），否则自动占首个空闲 U
 *
 * @param deviceId   平台设备 id（servers.id / network_devices.id / dc_pdus.id / 占位=设备名）
 * @param deviceType dc_rack_slots.device_type：'server' | 'network_device' | 'pdu' | 'ups' | 'other'
 */
export function syncDeviceSlot(
  deviceId: string,
  deviceType: 'server' | 'network_device' | 'pdu' | 'ups' | 'other',
  itopRackId: string | undefined,
  description?: string,
): SlotSyncResult {
  const existing = deviceId
    ? (db
        .prepare('SELECT id, rack_id, start_u, end_u FROM dc_rack_slots WHERE device_id = ? AND device_type = ? LIMIT 1')
        .get(deviceId, deviceType) as
        | { id: string; rack_id: string; start_u: number; end_u: number }
        | undefined)
    : undefined;

  // iTop 侧已无机柜关联（rack_id 清零/未同步）→ 摘除平台槽位（数据源是唯一事实）
  const rackId = findRackPlatformId(String(itopRackId ?? ''));
  if (!rackId) {
    if (existing) {
      db.prepare('DELETE FROM dc_rack_slots WHERE id = ?').run(existing.id);
      return { action: 'update', message: '解除挂柜（iTop 侧已取消机柜关联）' };
    }
    return { action: 'skip', message: deviceId ? '机柜未关联，跳过挂柜' : '设备未落库，跳过挂柜' };
  }

  // ── 已有槽位：处理换柜 ──
  if (existing) {
    if (existing.rack_id === rackId) {
      return { action: 'skip', message: '挂柜关系未变化' };
    }
    const needU = existing.end_u - existing.start_u + 1;
    if (!isUOccupied(rackId, existing.start_u, existing.id)) {
      db.prepare(
        "UPDATE dc_rack_slots SET rack_id = ?, updated_at = datetime('now','localtime') WHERE id = ?",
      ).run(rackId, existing.id);
      return { action: 'update', message: `换柜，保留 U${existing.start_u}-${existing.end_u}` };
    }
    const free = findFreeStartU(rackId, needU);
    if (free === null) {
      return { action: 'skip', message: '换柜失败：目标机柜无空闲连续 U 位' };
    }
    db.prepare(
      "UPDATE dc_rack_slots SET rack_id = ?, start_u = ?, end_u = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    ).run(rackId, free, free + needU - 1, existing.id);
    return { action: 'update', message: `换柜，占 U${free}-${free + needU - 1}` };
  }

  // ── 新挂柜 ──
  const descU = parseUPosition(description);
  let startU: number | null = null;
  let note = '';
  if (descU !== null && !isUOccupied(rackId, descU)) {
    startU = descU;
    note = `台账 U${descU}`;
  }
  if (startU === null) {
    const free = findFreeStartU(rackId, 1);
    if (free === null) return { action: 'skip', message: '机柜无空闲 U 位，跳过挂柜' };
    startU = free;
    note = descU !== null ? `台账 U${descU} 冲突，自动占位` : '自动占位';
  }
  db.prepare(
    `INSERT INTO dc_rack_slots (id, rack_id, device_id, device_type, start_u, end_u, position_face, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'front', ?, datetime('now','localtime'), datetime('now','localtime'))`,
  ).run(crypto.randomUUID(), rackId, deviceId, deviceType, startU, startU, note);
  return { action: 'create', message: `挂柜 U${startU}（${note}）` };
}
