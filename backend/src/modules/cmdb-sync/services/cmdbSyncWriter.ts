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

  // existingId 来自同步状态里的 itop_id_map，可能指向已被删除的行（去重清理、手工删柜）。
  // 此时 UPDATE 会静默影响 0 行、后续 syncDeviceSlot 又会用悬空 rack_id 插槽位（FK 失败），
  // 因此先确认行还在。
  const alive = existingId
    ? (db.prepare('SELECT id FROM dc_racks WHERE id = ?').get(existingId) as { id: string } | undefined)
    : undefined;

  if (alive) {
    // 只更新 name / total_u / room_id（COALESCE 保留原值）
    // nb_u 坑：iTop 机柜 nb_u 常为空 → REST 返回 '' → `'' ?? 42` 不兜空串 → total_u 存成 ''。
    // 必须显式数值化，空/0 一律回退 42U 标准柜。
    const totalU = Number(fields.nb_u) > 0 ? Number(fields.nb_u) : 42;
    db.prepare(`
      UPDATE dc_racks SET name = ?, total_u = ?, room_id = COALESCE(?, room_id), updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, totalU, roomId, alive.id);
    ensureRackLayout(roomId, alive.id);
    return { id: alive.id, action: 'update' };
  }

  // 幂等兜底：idMap 是同步状态的一部分，一旦丢失/重置（换库、清 state、手工删行），
  // 仅靠 existingId 会在同一机房内重复建柜 —— 现网曾出现 19 组同名机柜（一个空柜一个实柜）。
  // 因此在 create 前按 (room_id, name) 再查一次，命中即转为更新。
  const dup = db
    .prepare('SELECT id FROM dc_racks WHERE room_id = ? AND name = ? ORDER BY id LIMIT 1')
    .get(roomId, fields.name) as { id: string } | undefined;
  if (dup) {
    const totalUdup = Number(fields.nb_u) > 0 ? Number(fields.nb_u) : 42;
    db.prepare(`UPDATE dc_racks SET total_u = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(totalUdup, dup.id);
    ensureRackLayout(roomId, dup.id);
    return { id: dup.id, action: 'update' };
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
 *   managementip → ip_address（管理 IP，优先）
 *   svrbizip_name     → 备用（业务 IP，managementip 为空时用）
 *   osfamily_name     → os
 *   brand/model/serial → description 资产行（「品牌: x；型号: y；SN: z」），
 *                        servers 表无独立资产列，落 description；iTop description 兜底
 */
export function upsertServer(
  existingId: string | undefined,
  fields: {
    name: string;
    managementip?: string;
    svrbizip_name?: string;
    osfamily_name?: string;
    description?: string;
    serialnumber?: string;
    model_name?: string;
    brand_name?: string;
  },
): ServerUpsertResult {
  const ip = fields.managementip || fields.svrbizip_name || '';

  // 资产行：iTop 有品牌/型号/SN（BMC FRU 补齐成果）则组合；否则沿用 iTop description
  const assetParts: string[] = [];
  if (fields.brand_name) assetParts.push(`品牌: ${fields.brand_name}`);
  if (fields.model_name) assetParts.push(`型号: ${fields.model_name}`);
  if (fields.serialnumber) assetParts.push(`SN: ${fields.serialnumber}`);
  const desc = assetParts.length > 0
    ? [assetParts.join('；'), fields.description].filter(Boolean).join('；')
    : (fields.description ?? '');

  if (existingId) {
    const updateWith = (setIp: boolean) =>
      db.prepare(`
      UPDATE servers
      SET name = ?, os = ?, hostname = COALESCE(NULLIF(?, ''), hostname)${setIp ? ', ip_address = ?' : ''},
          description = CASE WHEN ? != '' THEN ? ELSE description END,
          updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(...(setIp
        ? [fields.name, fields.osfamily_name ?? '', ip, ip || null, desc, desc, existingId]
        : [fields.name, fields.osfamily_name ?? '', ip, desc, desc, existingId]));

    try {
      updateWith(true);
      return { id: existingId, action: 'update' };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // 该 IP 已被别的服务器行占用（RAC SCAN VIP 多节点共用）→ 不覆盖 IP，其余字段照常更新
      if (!/UNIQUE|Duplicate entry/i.test(msg)) throw e;
      updateWith(false);
      return {
        id: existingId,
        action: 'update',
        message: `管理 IP ${ip} 已被其他服务器占用，本次未更新 IP`,
      };
    }
  }

  const newId = crypto.randomUUID();
  const insertServer = (ipValue: string | null) =>
    db.prepare(`
    INSERT INTO servers (id, name, hostname, port, username, password, use_ssh_key, os, os_type, ip_address, description, enabled, tags, created_at, updated_at)
    VALUES (?, ?, ?, 22, '', NULL, 0, ?, 'linux', ?, ?, 1, '[]', datetime('now','localtime'), datetime('now','localtime'))
  `).run(newId, fields.name, ip || fields.name, fields.osfamily_name ?? '', ipValue, desc);

  try {
    insertServer(ip || null);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // 同一个管理 IP 被多个 CI 共用（典型：RAC 的 SCAN VIP 被 5 个节点共享），
    // 而 servers.ip_address 上有唯一索引 → 退化成「不带 IP 写入」，
    // 避免整台服务器因为 IP 冲突而丢失（IP 可在平台手工补）。
    if (!/UNIQUE|Duplicate entry/i.test(msg)) throw e;
    insertServer(null);
    return {
      id: newId,
      action: 'create',
      message: `管理 IP ${ip} 已被其他服务器占用（唯一索引），已按无 IP 写入；未同步 SSH 密码/密钥`,
    };
  }

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
 * network_devices.device_type 的 CHECK 枚举映射（v009_network_complete_coverage）：
 * iTop NetworkDeviceType 名称 / finalclass → 平台枚举值
 */
function mapNetworkDeviceType(iTopTypeName?: string, finalClass?: string): string {
  const s = `${iTopTypeName ?? ''} ${finalClass ?? ''}`.toLowerCase();
  if (/switch|交换/.test(s)) return 'switch';
  if (/firewall|防火/.test(s)) return 'firewall';
  if (/router|路由/.test(s)) return 'router';
  if (/load.?balanc|负载/.test(s)) return 'loadbalancer';
  if (/wlc|无线控制/.test(s)) return 'wlc';
  if (/\bap\b|接入点/.test(s)) return 'ap';
  if (/gateway|网关/.test(s)) return 'gateway';
  return 'unknown';
}

/**
 * 根据 finalclass 分流：
 *   pdu / ups 类 → dc_pdus
 *   其他（switch / router / firewall 等）→ network_devices（要求唯一 IP）
 *
 * iTop 字段映射：
 *   managementip     → ip_address（管理 IP）
 *   finalclass            → 设备类型判断（NetworkDevice / PDU / UPS ...）
 *   networkdevicetype_id_friendlyname → device_type 枚举映射（Switch/Firewall/Router...）
 *   brand_name / model_name → vendor / model（台账导入的设备这些字段常为空，空值不覆盖）
 */
export function upsertDatacenterDevice(
  existingId: string | undefined,
  fields: {
    name: string;
    description?: string;
    managementip?: string;
    finalclass?: string;
    networkdevicetype_id_friendlyname?: string;
    serialnumber?: string;
    model_name?: string;
    brand_name?: string;
  },
): DeviceUpsertResult {
  // IP 兜底：台账导入的设备 name 即管理 IP（iTop 里 managementip 未关联 → managementip 为空）
  const ip = fields.managementip || (/^\d{1,3}(\.\d{1,3}){3}$/.test(fields.name.trim()) ? fields.name.trim() : '');
  const finalClass = (fields.finalclass ?? '').toLowerCase();
  const isPDU = finalClass.includes('pdu') || finalClass.includes('ups');
  const deviceType = mapNetworkDeviceType(fields.networkdevicetype_id_friendlyname, fields.finalclass);

  if (isPDU) {
    const pduType = finalClass.includes('ups') ? 'ups' : 'pdu';
    const model = fields.model_name || fields.description || '';
    if (existingId) {
      db.prepare(`
        UPDATE dc_pdus SET name = ?, type = COALESCE(NULLIF(?, ''), type),
          model = CASE WHEN ? != '' THEN ? ELSE model END,
          updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(fields.name, pduType, model, model, existingId);
      return { id: existingId, action: 'update', table: 'dc_pdus' };
    }
    const newId = crypto.randomUUID();
    pdusRepo.create({
      id: newId,
      name: fields.name,
      type: pduType,
      status: 'active',
      ip_address: ip,
      model,
    });
    return { id: newId, action: 'create', table: 'dc_pdus' };
  }

  // network_devices 分支
  // network_devices.ip_address 是 NOT NULL UNIQUE（见 v006_network_device_credentials），
  // 无 IP 的设备必须跳过；IP 冲突时关联到已有记录。
  if (existingId) {
    db.prepare(`
      UPDATE network_devices SET name = ?,
        device_type = CASE WHEN ? != 'unknown' THEN ? ELSE device_type END,
        vendor = CASE WHEN ? != '' THEN ? ELSE vendor END,
        model = COALESCE(NULLIF(?, ''), model),
        updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, deviceType, deviceType, fields.brand_name ?? '', fields.brand_name ?? '', fields.model_name ?? '', existingId);
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
    INSERT INTO network_devices (id, name, ip_address, vendor, model, device_type, status, snmp_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'online', 1, datetime('now','localtime'), datetime('now','localtime'))
  `).run(newId, fields.name, ip, fields.brand_name || 'unknown', fields.model_name ?? '', deviceType);
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

/** 机柜 total_u（iTop nb_u 常为空，容错回 42U 标准柜） */
function rackTotalU(rackId: string): number {
  const rack = db.prepare('SELECT total_u FROM dc_racks WHERE id = ?').get(rackId) as
    | { total_u: number }
    | undefined;
  const totalU = Number(rack?.total_u);
  return Number.isFinite(totalU) && totalU > 0 ? totalU : 42;
}

/** 在机柜内找首个可容纳 needU 个连续 U 位的起始位；满则 null */
function findFreeStartU(rackId: string, needU: number): number | null {
  const totalU = rackTotalU(rackId);
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

/** 指定 U 位区间 [startU, endU] 是否被该机柜内其他槽位占用 */
function isSpanOccupied(rackId: string, startU: number, endU: number, excludeSlotId?: string): boolean {
  const rows = db
    .prepare('SELECT start_u, end_u FROM dc_rack_slots WHERE rack_id = ? AND id != COALESCE(?, \'\')')
    .all(rackId, excludeSlotId ?? null) as { start_u: number; end_u: number }[];
  return rows.some((r) => r.start_u <= endU && r.end_u >= startU);
}

/**
 * 设备默认高度（U）：sync 落槽位时按类型展开 U 位区间。
 * 台账只登记「起始 U 位」（区间第一个 U），高度按类型默认：
 *   - 服务器 2U
 *   - 网络设备 / PDU / UPS 1U
 *   - 存储等无 IP 占位设备（'other'）不假设高度 → 留空，仅记起始 U（1U 占位渲染）
 */
function deviceHeightU(deviceType: 'server' | 'network_device' | 'pdu' | 'ups' | 'other'): number {
  return deviceType === 'server' ? 2 : 1;
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
 *   - 已有槽位：同柜时先对齐台账起始 U（区间空闲才移动），再按类型默认高度校准 end_u；换柜保留台账起始 U
 *   - 无槽位：台账起始 U + 类型高度可用则直落（区间冲突顺延），否则自动占首个空闲区间
 *   - 高度口径：server=2U，network_device/pdu/ups=1U，other（存储等）留空仅记起始 U
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

  const needU = deviceHeightU(deviceType);

  // ── 已有槽位：台账 U 对齐 / 高度校准 / 换柜 ──
  if (existing) {
    const descU = parseUPosition(description);

    if (existing.rack_id === rackId) {
      // 1) 台账起始 U 对齐（iTop 是唯一事实源）：目标区间空闲且在柜内才移动，被占则保持原位
      let startU = existing.start_u;
      let alignNote = '';
      if (
        descU !== null && descU !== existing.start_u &&
        descU + needU - 1 <= rackTotalU(rackId) &&
        !isSpanOccupied(rackId, descU, descU + needU - 1, existing.id)
      ) {
        startU = descU;
        alignNote = needU > 1 ? `对齐台账 U${descU}-${descU + needU - 1}（${needU}U）` : `对齐台账 U${descU}`;
      }
      const spanEnd = startU + needU - 1;
      if (startU === existing.start_u && existing.end_u === spanEnd) {
        return {
          action: 'skip',
          message: descU !== null && descU !== existing.start_u
            ? '挂柜关系未变化（台账 U 区间被占，保持原位）'
            : '挂柜关系未变化',
        };
      }
      if (!isSpanOccupied(rackId, startU, spanEnd, existing.id)) {
        db.prepare(
          "UPDATE dc_rack_slots SET start_u = ?, end_u = ?, updated_at = datetime('now','localtime') WHERE id = ?",
        ).run(startU, spanEnd, existing.id);
        return {
          action: 'update',
          message: alignNote || `高度按类型默认校准为 U${startU}-${spanEnd}（${needU}U）`,
        };
      }
      // 2) 高度扩展冲突 → 重新占位
      const free = findFreeStartU(rackId, needU);
      if (free === null) return { action: 'skip', message: '高度校准失败：机柜无空闲连续 U 位，保持原槽位' };
      db.prepare(
        "UPDATE dc_rack_slots SET start_u = ?, end_u = ?, updated_at = datetime('now','localtime') WHERE id = ?",
      ).run(free, free + needU - 1, existing.id);
      return { action: 'update', message: `高度校准冲突，重新占位 U${free}-${free + needU - 1}` };
    }

    // 3) 换柜：优先保留台账起始 U 并按类型高度展开，冲突/超容则重新占位
    const keepEnd = existing.start_u + needU - 1;
    if (keepEnd <= rackTotalU(rackId) && !isSpanOccupied(rackId, existing.start_u, keepEnd, existing.id)) {
      db.prepare(
        "UPDATE dc_rack_slots SET rack_id = ?, end_u = ?, updated_at = datetime('now','localtime') WHERE id = ?",
      ).run(rackId, keepEnd, existing.id);
      return { action: 'update', message: `换柜，保留 U${existing.start_u}-${keepEnd}` };
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

  // ── 新挂柜：台账起始 U + 类型高度，区间冲突顺延 ──
  const descU = parseUPosition(description);
  let startU: number | null = null;
  let note = '';
  if (descU !== null && descU + needU - 1 <= rackTotalU(rackId) && !isSpanOccupied(rackId, descU, descU + needU - 1)) {
    startU = descU;
    note = needU > 1 ? `台账 U${descU}-${descU + needU - 1}（${needU}U）` : `台账 U${descU}`;
  }
  if (startU === null) {
    const free = findFreeStartU(rackId, needU);
    if (free === null) return { action: 'skip', message: '机柜无空闲 U 位，跳过挂柜' };
    startU = free;
    note = descU !== null ? `台账 U${descU} 区间冲突，自动占位` : '自动占位';
  }
  const endU = startU + needU - 1;
  db.prepare(
    `INSERT INTO dc_rack_slots (id, rack_id, device_id, device_type, start_u, end_u, position_face, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'front', ?, datetime('now','localtime'), datetime('now','localtime'))`,
  ).run(crypto.randomUUID(), rackId, deviceId, deviceType, startU, endU, note);
  return {
    action: 'create',
    message: needU > 1 ? `挂柜 U${startU}-${endU}（${note}）` : `挂柜 U${startU}（${note}）`,
  };
}
