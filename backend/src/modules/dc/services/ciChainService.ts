/**
 * ciChainService — 机柜设备点击后的 CI 关系层级展开
 *
 * 数据源（分层）：
 *   1. iTop REST（唯一事实源，实时查询）— CI 间关系字段（2026-11-25 实测确认）：
 *      - VirtualMachine.virtualhost_id_friendlyname → 虚拟化宿主（Hypervisor）
 *      - Hypervisor.server_id_friendlyname         → 物理服务器（多为 0 = 未关联）
 *      - DBServer.system_id_friendlyname           → 承载 CI（物理机 / VM）
 *      - Server/NetworkDevice/StorageSystem/PDU/UPS.rack_id_friendlyname → 所在机柜
 *   2. 平台本地 servers 表 — OS 层（Zabbix agent 主机）不在 iTop 独立建 CI，
 *      与硬件层通过 BMC 命名约定关联：svr-MGMT-{带外IP}-{OS名}，后缀反查双向解析。
 *
 * 接口形态：每层一个请求（前端按节点懒展开，多级别层次递归）：
 *   GET /dc/ci-chain?class=&name=                ← 已知 iTop class，查邻接关系
 *   GET /dc/ci-chain?deviceId=&deviceType=&deviceName= ← 槽位设备首查（解析 class+name）
 */
import db from '../../../models/database';
import { logger } from '../../../utils/logger';
import { itopClient } from '../../cmdb-sync/services/itopClient';

// ============================================================
// 类型
// ============================================================

export interface CiChainNode {
  /** iTop 类名，本地虚拟类：OsHost（Zabbix OS 层）/ Rack / Room */
  class: string;
  name: string;
  /** 与父节点（被展开节点）的关系说明 */
  relation: string;
  status?: string;
  ip?: string;
  /** 次要信息（品牌型号 / OS 家族等） */
  extra?: string;
}

export interface CiChain {
  self: {
    class: string;
    name: string;
    status?: string;
    ip?: string;
    extra?: string;
  } | null;
  parents: CiChainNode[];
  children: CiChainNode[];
  /** itop=实时查 iTop；local=仅本地库降级；none=完全未命中 */
  source: 'itop' | 'local' | 'none';
  /** 降级/未命中说明（前端展示给用户） */
  degraded?: string;
}

// ============================================================
// OQL 辅助
// ============================================================

/** OQL 字符串字面量转义（单引号） */
function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

/** 各类 self 查询的 output_fields（只列确认存在的字段，减少 REST 报错面） */
const SELF_FIELDS: Record<string, string> = {
  Server: 'name,status,brand_name,model_name,serialnumber,managementip_name,osfamily_name,rack_id_friendlyname',
  Hypervisor: 'name,status,managementip_name,server_id_friendlyname',
  VirtualMachine: 'name,status,osfamily_name,managementip_name,virtualhost_id_friendlyname',
  DBServer: 'name,status,system_id_friendlyname',
  NetworkDevice: 'name,status,managementip_name,brand_name,model_name,rack_id_friendlyname',
  StorageSystem: 'name,status,brand_name,model_name,rack_id_friendlyname',
  PDU: 'name,status,rack_id_friendlyname',
  UPS: 'name,status,rack_id_friendlyname',
};

/** 兜底最小字段集（output_fields 含类不存在的字段时降级重试） */
const MIN_FIELDS = 'name,status';

interface ITopEntry {
  key: string | number;
  class: string;
  fields: Record<string, unknown>;
}

/** 按 name 查单个 CI；字段集报错时降级重试最小集 */
async function getSelf(className: string, name: string): Promise<ITopEntry | null> {
  const oql = `SELECT ${className} WHERE name = '${esc(name)}'`;
  let res = await itopClient.getObjects(className, oql, SELF_FIELDS[className] ?? MIN_FIELDS);
  if (!res.success) {
    // 降级重试：最小字段集（避免个别类缺列导致整查失败）
    res = await itopClient.getObjects(className, oql, MIN_FIELDS);
  }
  if (!res.success || !res.data) return null;
  const first = Object.values(res.data.objects)[0];
  return first ?? null;
}

/** 批量查询子/父 CI 列表（失败静默返回空——单个关系查询失败不应拖垮整层） */
async function listByOQL(className: string, oql: string, fields: string): Promise<ITopEntry[]> {
  const res = await itopClient.getObjects(className, oql, fields);
  if (!res.success || !res.data) return [];
  return Object.values(res.data.objects);
}

function fieldStr(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/** other 占位设备：`SELECT DatacenterDevice WHERE name=… AND finalclass != 'Server'` 反查实际类名 */
async function resolveConcreteDeviceClass(name: string): Promise<string | null> {
  const res = await itopClient.getObjects(
    'DatacenterDevice',
    `SELECT DatacenterDevice WHERE name = '${esc(name)}' AND finalclass != 'Server'`,
    'name',
  );
  if (!res.success || !res.data) return null;
  const first = Object.values(res.data.objects)[0];
  return first?.class ?? null;
}

// ============================================================
// 关系定义：每类的父/子 OQL
// ============================================================

interface RelationQuery {
  className: string;
  relation: string;
  oql: (name: string) => string;
  fields: string;
}

/** 下层（children）关系查询表 */
const CHILDREN_QUERIES: Record<string, RelationQuery[]> = {
  Server: [
    { className: 'Hypervisor', relation: '虚拟化宿主', oql: n => `SELECT Hypervisor WHERE server_id_friendlyname = '${esc(n)}'`, fields: 'name,status,managementip_name' },
    { className: 'VirtualMachine', relation: '直挂虚拟机', oql: n => `SELECT VirtualMachine WHERE virtualhost_id_friendlyname = '${esc(n)}'`, fields: 'name,status,osfamily_name,managementip_name' },
    { className: 'DBServer', relation: '数据库实例', oql: n => `SELECT DBServer WHERE system_id_friendlyname = '${esc(n)}'`, fields: 'name,status' },
  ],
  Hypervisor: [
    { className: 'VirtualMachine', relation: '虚拟机', oql: n => `SELECT VirtualMachine WHERE virtualhost_id_friendlyname = '${esc(n)}'`, fields: 'name,status,osfamily_name,managementip_name' },
  ],
  VirtualMachine: [
    { className: 'DBServer', relation: '数据库实例', oql: n => `SELECT DBServer WHERE system_id_friendlyname = '${esc(n)}'`, fields: 'name,status' },
  ],
};

/** rack 挂载类（DatacenterDevice 子类）共用的父关系：所在机柜 */
function rackParent(rackName?: string): CiChainNode[] {
  if (!rackName) return [];
  return [{ class: 'Rack', name: rackName, relation: '所在机柜' }];
}

// ============================================================
// 本地 OS 层（Zabbix agent 主机）— servers 表
// ============================================================

interface LocalServerRow {
  id: string;
  name: string;
  ip_address: string | null;
  os: string | null;
}

/**
 * 硬件服务器 → OS 层主机（本地反查）
 * 硬件命名 svr-MGMT-{带外IP}-{OS名}：OS 主机名是硬件名的 `-` 后缀段
 */
function localOsChildren(serverName: string): CiChainNode[] {
  if (!serverName.startsWith('svr-MGMT-')) return [];
  const rows = db
    .prepare(
      `SELECT id, name, ip_address, os FROM servers
       WHERE instr(?, '-' || name) > 0 AND length(name) >= 3 AND name NOT LIKE 'svr-MGMT-%'
       LIMIT 5`,
    )
    .all(serverName) as LocalServerRow[];
  return rows.map(r => ({
    class: 'OsHost',
    name: r.name,
    relation: '操作系统层（Zabbix）',
    ip: r.ip_address ?? undefined,
    extra: r.os || undefined,
  }));
}

/** OS 层主机 → 硬件服务器（本地反查，BMC 命名约定） */
function localHardwareParents(osName: string): CiChainNode[] {
  const rows = db
    .prepare(
      `SELECT id, name FROM servers
       WHERE name LIKE 'svr-MGMT-%' AND instr(name, '-' || ?) > 0
       LIMIT 3`,
    )
    .all(osName) as { id: string; name: string }[];
  return rows.map(r => ({
    class: 'Server',
    name: r.name,
    relation: '承载硬件',
  }));
}

// ============================================================
// 主入口
// ============================================================

/** iTop status 枚举 → 展示用语义（production/active 在用，obsolete 已下线） */
function normalizeStatus(s?: string): string | undefined {
  return s?.trim() || undefined;
}

export async function getCiChain(params: {
  class?: string;
  name?: string;
  deviceId?: string;
  deviceType?: string;
  deviceName?: string;
}): Promise<CiChain> {
  // ── 1. 解析目标 CI（槽位设备首查路径） ──
  let className = params.class?.trim();
  let name = params.name?.trim();

  if (!className || !name) {
    const resolved = resolveSlotDevice(params.deviceType ?? '', params.deviceId ?? '', params.deviceName ?? '');
    className = resolved.class;
    name = resolved.name;
    if (!name) {
      return { self: null, parents: [], children: [], source: 'none', degraded: '设备未落库且无名称，无法解析 CI' };
    }
  }

  // ── 2. 本地虚拟类分支（不查 iTop） ──
  if (className === 'OsHost') {
    return osHostChain(name);
  }
  if (className === 'Rack' || className === 'Room') {
    return rackRoomChain(className, name);
  }
  // other 占位设备：按名称在 DatacenterDevice（排除 Server 子类）反查实际 finalclass，再按具体类查链
  if (className === 'DatacenterDevice') {
    const concrete = await resolveConcreteDeviceClass(name);
    if (!concrete) {
      return { self: null, parents: [], children: [], source: 'none', degraded: `iTop 中未找到「${name}」对应的数据中心设备` };
    }
    className = concrete;
  }

  // ── 3. iTop 实时查询 ──
  if (!itopClient.isConfigured()) {
    return localFallback(name);
  }

  const self = await getSelf(className, name);
  if (!self) {
    return {
      self: null,
      parents: [],
      children: [],
      source: 'none',
      degraded: `iTop 中未找到 ${className}「${name}」（可能未同步或已下线）`,
    };
  }

  const f = self.fields;
  const selfIp = fieldStr(f, 'managementip_name');
  const selfExtraParts = [fieldStr(f, 'brand_name'), fieldStr(f, 'model_name'), fieldStr(f, 'osfamily_name')]
    .filter(Boolean)
    .join(' / ');
  const serial = fieldStr(f, 'serialnumber');
  const selfExtra = [selfExtraParts, serial ? `SN: ${serial}` : ''].filter(Boolean).join(' · ') || undefined;

  const parents: CiChainNode[] = [];
  const children: CiChainNode[] = [];

  // 父关系（从 self 字段直接取友好名）
  switch (self.class) {
    case 'Server':
    case 'NetworkDevice':
    case 'StorageSystem':
    case 'PDU':
    case 'UPS':
      parents.push(...rackParent(fieldStr(f, 'rack_id_friendlyname')));
      break;
    case 'Hypervisor': {
      const host = fieldStr(f, 'server_id_friendlyname');
      if (host) parents.push({ class: 'Server', name: host, relation: '物理服务器' });
      break;
    }
    case 'VirtualMachine': {
      const hv = fieldStr(f, 'virtualhost_id_friendlyname');
      if (hv) parents.push({ class: 'Hypervisor', name: hv, relation: '虚拟化宿主' });
      break;
    }
    case 'DBServer': {
      const host = fieldStr(f, 'system_id_friendlyname');
      if (host) parents.push({ class: 'FunctionalCI', name: host, relation: '承载对象' });
      break;
    }
    default:
      break;
  }

  // 子关系（OQL 反查）
  for (const q of CHILDREN_QUERIES[self.class] ?? []) {
    const rows = await listByOQL(q.className, q.oql(name), q.fields);
    for (const r of rows) {
      children.push({
        class: r.class,
        name: fieldStr(r.fields, 'name') ?? String(r.key),
        relation: q.relation,
        status: normalizeStatus(fieldStr(r.fields, 'status')),
        ip: fieldStr(r.fields, 'managementip_name'),
        extra: fieldStr(r.fields, 'osfamily_name'),
      });
    }
  }

  // 硬件服务器追加本地 OS 层（Zabbix agent 主机，iTop 不独立建 CI）
  if (self.class === 'Server') {
    children.push(...localOsChildren(name));
  }

  return {
    self: { class: self.class, name: fieldStr(f, 'name') ?? name, status: normalizeStatus(fieldStr(f, 'status')), ip: selfIp, extra: selfExtra },
    parents,
    children,
    source: 'itop',
  };
}

// ============================================================
// 槽位设备 → iTop CI 解析
// ============================================================

function resolveSlotDevice(deviceType: string, deviceId: string, deviceName: string): { class: string; name: string } {
  switch (deviceType) {
    case 'server': {
      const row = deviceId
        ? (db.prepare('SELECT name FROM servers WHERE id = ?').get(deviceId) as { name: string } | undefined)
        : undefined;
      return { class: 'Server', name: row?.name || deviceName };
    }
    case 'network_device': {
      const row = deviceId
        ? (db.prepare('SELECT name FROM network_devices WHERE id = ?').get(deviceId) as { name: string } | undefined)
        : undefined;
      return { class: 'NetworkDevice', name: row?.name || deviceName };
    }
    case 'pdu':
    case 'ups': {
      const row = deviceId
        ? (db.prepare('SELECT name FROM dc_pdus WHERE id = ?').get(deviceId) as { name: string } | undefined)
        : undefined;
      return { class: deviceType === 'ups' ? 'UPS' : 'PDU', name: row?.name || deviceName };
    }
    default: {
      // other（存储/无 IP 占位设备）：iTop 侧按名称反查 DatacenterDevice（排除 Server 子类），取实际 finalclass
      return { class: 'DatacenterDevice', name: deviceName || deviceId };
    }
  }
}

// ============================================================
// 本地虚拟类链
// ============================================================

function osHostChain(osName: string): CiChain {
  const row = db.prepare('SELECT id, name, ip_address, os, os_type, description FROM servers WHERE name = ?').get(osName) as
    | (LocalServerRow & { os_type: string | null; description: string | null })
    | undefined;

  const parents = localHardwareParents(osName);

  // iTop：合并进 guest 的 OS 层标记（description 含 os-agent:{OS主机名}）
  return {
    self: row
      ? { class: 'OsHost', name: row.name, ip: row.ip_address ?? undefined, extra: row.os || row.os_type || undefined }
      : null,
    parents,
    children: [],
    source: 'local',
    degraded: parents.length === 0 ? '本地未找到匹配的硬件服务器（BMC 命名约定未命中）' : undefined,
  };
}

function rackRoomChain(className: string, name: string): CiChain {
  const rack = db
    .prepare('SELECT r.name, r.total_u, r.room_id, rm.name AS room_name FROM dc_racks r LEFT JOIN dc_rooms rm ON rm.id = r.room_id WHERE r.name = ?')
    .get(name) as { name: string; total_u: number; room_id: string; room_name: string } | undefined;
  if (!rack) {
    return { self: null, parents: [], children: [], source: 'none', degraded: `平台机柜「${name}」不存在` };
  }
  return {
    self: { class: 'Rack', name: rack.name, extra: `${Number(rack.total_u) || 42}U` },
    parents: rack.room_name ? [{ class: 'Room', name: rack.room_name, relation: '所在机房' }] : [],
    children: [],
    source: 'local',
  };
}

/** iTop 不可用时的本地降级：仅返回平台已落库的设备信息 */
function localFallback(name: string): CiChain {
  const server = db.prepare('SELECT name, ip_address, os, description FROM servers WHERE name = ?').get(name) as
    | { name: string; ip_address: string | null; os: string | null; description: string | null }
    | undefined;
  return {
    self: server
      ? { class: 'Server', name: server.name, ip: server.ip_address ?? undefined, extra: server.description ?? undefined }
      : null,
    parents: [],
    children: [],
    source: 'local',
    degraded: 'iTop 未配置或不可达，仅展示平台本地数据',
  };
}
