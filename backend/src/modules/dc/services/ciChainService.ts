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
 *
 * 虚拟类（非 iTop 类，仅本服务内部使用）：
 *   OsHost — Zabbix OS 层主机（物理机场景，来源平台本地 servers 表）
 *   VmOs   — 虚拟机的操作系统层 CI（iTop 里仍存成 VirtualMachine，见 vmCounterparts 注释）
 *   NetPeer — CDP 邻接设备（cipipe netlinks 拓扑未落 iTop 的设备；devid@ip 可展开）
 */
import db from '../../../models/database';
import { logger } from '../../../utils/logger';
import { itopClient } from '../../cmdb-sync/services/itopClient';
import { findDbHostsByOsHost, findDbHostsByDbServerName, osNameMatchesHost } from './zabbixDbMapService';
import {
  fetchNetlinksTopology,
  fetchNetobsByHost,
  groupByIfname,
  groupByVid,
  type NetlinkTopology,
} from './cipipeAdjacencyService';

// ============================================================
// 类型
// ============================================================

export interface CiChainNode {
  /** iTop 类名，本地虚拟类：OsHost（Zabbix OS 层）/ NetPort（交换机端口）/ Vlan / IpAddr / Rack / Room */
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
  Server: 'name,status,brand_name,model_name,serialnumber,managementip,osfamily_name,rack_id_friendlyname',
  Hypervisor: 'name,status,managementip,server_id_friendlyname',
  VirtualMachine: 'name,status,osfamily_name,managementip,virtualhost_id_friendlyname',
  DBServer: 'name,status,system_id_friendlyname',
  NetworkDevice: 'name,status,managementip,brand_name,model_name,rack_id_friendlyname',
  StorageSystem: 'name,status,brand_name,model_name,rack_id_friendlyname',
  PDU: 'name,status,rack_id_friendlyname',
  UPS: 'name,status,rack_id_friendlyname',
};

/** 兜底最小字段集（output_fields 含类不存在的字段时降级重试） */
const MIN_FIELDS = 'name,status';

/** VirtualMachine 关系判定所需字段（-VM ↔ OS 层配对要用 IP 与宿主） */
const VM_FIELDS = 'name,status,osfamily_name,managementip,virtualhost_id_friendlyname';

/** 纯 IPv4 字面量名称：Zabbix 早期按 IP 建 CI 的遗留命名 */
const PURE_IP_NAME = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 同步重复残渣命名（cipipe itop-dedup 同类产物，过期内容页可见可清理） */
const RE_DUP_RESIDUE = /__DUP_(?:SERVER|VIRTUALMACHINE|HYPERVISOR|DBSERVER|NETWORKDEVICE|STORAGESYSTEM)_\d+$/;

/**
 * 链路展开通用残渣过滤（代码层，不能放 OQL —— OQL `!=` 会连 NULL 一起排除）：
 * status 未设置（NULL）/production/active 正常；inactive/obsolete 为改名闭环淘汰的
 * 旧命名或同步残渣（如 VR-SSAPP18__DUP_VIRTUALMACHINE_2031 仍挂着同 IP），不进链路。
 */
function isStaleCiStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').trim().toLowerCase();
  return s === 'inactive' || s === 'obsolete';
}

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

/**
 * DBServer 残渣过滤（代码层，不能放 OQL）：
 * iTop OQL 的 `!=` 会把 status 未设置（NULL）的行一并排除，而新同步 CI status 恰好是 NULL，
 * 所以无法用 OQL 表达「非 inactive 且含 NULL」，必须在结果集里剔除。
 * 残渣来源：Zabbix 主机改名 DB-ORA-* 后旧命名 CI 已标 inactive。
 */
function isStaleDbServer(status: string | null | undefined): boolean {
  const s = (status ?? '').trim().toLowerCase();
  return s === 'inactive' || s === 'obsolete';
}

/** 下层（children）关系查询表 */
const CHILDREN_QUERIES: Record<string, RelationQuery[]> = {
  Server: [
    { className: 'Hypervisor', relation: '虚拟化宿主', oql: n => `SELECT Hypervisor WHERE server_id_friendlyname = '${esc(n)}'`, fields: 'name,status,managementip' },
    { className: 'VirtualMachine', relation: '直挂虚拟机', oql: n => `SELECT VirtualMachine WHERE virtualhost_id_friendlyname = '${esc(n)}'`, fields: 'name,status,osfamily_name,managementip' },
    { className: 'DBServer', relation: '数据库实例', oql: n => `SELECT DBServer WHERE system_id_friendlyname = '${esc(n)}'`, fields: 'name,status' },
  ],
  Hypervisor: [
    { className: 'VirtualMachine', relation: '虚拟机', oql: n => `SELECT VirtualMachine WHERE virtualhost_id_friendlyname = '${esc(n)}'`, fields: 'name,status,osfamily_name,managementip' },
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

/** 硬件名（svr-MGMT/iLo/idrac/bmc/imm-{IP}-{OS名}）→ OS 主机名后缀（2026-11-26 起前缀大写 SVR-，/i 兼容两代） */
function hardwareOsSuffix(serverName: string): string {
  return serverName.replace(/^svr-(?:MGMT|iLo|idrac|bmc|imm)-[\d.]+-/i, '');
}

/**
 * 硬件服务器 → OS 层主机（本地反查）
 * 硬件命名 svr-MGMT-{带外IP}-{OS名}：OS 主机名是硬件名的 `-` 后缀段。
 * OS 行命名规范（2026-11-25 定稿）：svr-<hostname>-<备注>（svr-obdb02-197 / svr-ctdbdc01-BO），
 * 兼容裸主机名与旧世代「-数字尾巴」行（obdb02-197）。
 */
function localOsChildren(serverName: string): CiChainNode[] {
  if (!/^svr-/i.test(serverName)) return [];
  const suffix = hardwareOsSuffix(serverName);
  if (!suffix) return [];
  const rows = db
    .prepare(
      `SELECT id, name, ip_address, os FROM servers
       WHERE (instr(?, '-' || name) > 0 OR name LIKE ? || '-%' OR name LIKE 'svr-' || ? || '-%')
         AND length(name) >= 3 AND name NOT LIKE 'svr-MGMT-%'
         AND name NOT LIKE 'svr-iLo-%' AND name NOT LIKE 'svr-idrac-%'
         AND name NOT LIKE 'svr-bmc-%' AND name NOT LIKE 'svr-imm-%'
       LIMIT 20`,
    )
    .all(serverName, suffix, suffix) as LocalServerRow[];
  // 同名重复行去重（本地表存在同名多行），保留信息最全的一条
  const byName = new Map<string, CiChainNode>();
  for (const r of rows) {
    const matched = serverName.includes(`-${r.name}`) || osNameMatchesHost(r.name, suffix);
    if (!matched || byName.has(r.name)) continue;
    byName.set(r.name, {
      class: 'OsHost',
      name: r.name,
      relation: '操作系统层（Zabbix）',
      ip: r.ip_address ?? undefined,
      extra: r.os || undefined,
    });
  }
  return [...byName.values()];
}

/**
 * OS 层主机 → 硬件服务器（本地反查，BMC 命名约定）
 * OS 行命名 svr-<hostname>-<备注>：剥 svr- 前缀后剩余段需等于硬件后缀或以其为前缀。
 */
function localHardwareParents(osName: string): CiChainNode[] {
  const rows = db
    .prepare(
      `SELECT id, name FROM servers
       WHERE name LIKE 'svr-MGMT-%' OR name LIKE 'svr-iLo-%'
          OR name LIKE 'svr-idrac-%' OR name LIKE 'svr-bmc-%' OR name LIKE 'svr-imm-%'`,
    )
    .all() as { id: string; name: string }[];
  const seen = new Set<string>();
  const out: CiChainNode[] = [];
  for (const r of rows) {
    const m = r.name.match(/^svr-(?:MGMT|iLo|idrac|bmc|imm)-[\d.]+-(.+)$/i);
    if (!m || !osNameMatchesHost(osName, m[1])) continue;
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push({ class: 'Server', name: r.name, relation: '承载硬件' });
    if (out.length >= 3) break;
  }
  return out;
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

  // ── 2. 本地虚拟类分支（不查 iTop 实体类） ──
  if (className === 'OsHost') {
    return osHostChain(name);
  }
  // VmOs：虚拟机的操作系统层 CI（iTop 里存成 VirtualMachine，语义是 OS）
  if (className === 'VmOs') {
    return vmOsChain(name);
  }
  // NetPort / Vlan：网络邻接链路虚拟类（数据源 cipipe netobs，见下）
  if (className === 'NetPort') {
    return netPortChain(name);
  }
  if (className === 'Vlan') {
    return vlanChain(name);
  }
  // NetPeer：CDP 邻接设备（cipipe netlinks 拓扑中未落 iTop 的交换机/路由器，
  // 名称编码 `devid@ip`；未纳管单侧观测只有 devid 无 ip，展开为叶子）
  if (className === 'NetPeer') {
    return netPeerChain(name);
  }
  // IpAddr：未落 CMDB 的邻接对端（叶子节点，展开只给提示）
  if (className === 'IpAddr') {
    return {
      self: { class: 'IpAddr', name },
      parents: [],
      children: [],
      source: 'none',
      degraded: '该 IP 未落 CMDB（cipipe 裁决为 none/conflict，待登记或裁决后自动入链）',
    };
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
  const selfIp = fieldStr(f, 'managementip');
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
      // 占位符（未关联的 DBServer 全部指向 ZBX-DB-Host-Unassigned）不展示
      if (host && host !== 'ZBX-DB-Host-Unassigned') parents.push({ class: 'FunctionalCI', name: host, relation: '承载对象' });
      // Zabbix gv$instance 派生：DBServer → 其 RAC 全部 OS 节点（跨集群实例）
      try {
        parents.push(...(await dbServerOsParents(name)));
      } catch (err) {
        logger.warn(`ciChain dbServerOsParents failed for ${name}: ${(err as Error).message}`);
      }
      break;
    }
    default:
      break;
  }

  // 子关系（OQL 反查）
  for (const q of CHILDREN_QUERIES[self.class] ?? []) {
    const rows = await listByOQL(q.className, q.oql(name), q.fields);
    for (const r of rows) {
      const st = normalizeStatus(fieldStr(r.fields, 'status'));
      const nm = fieldStr(r.fields, 'name') ?? String(r.key);
      // 残渣过滤：DBServer 旧命名（Zabbix 改名前）与 __DUP 同步残渣（含 VM/
      // Hypervisor 层，如 VR-SSAPP18__DUP_VIRTUALMACHINE_2031）不进链路
      if (r.class === 'DBServer' && isStaleDbServer(st)) continue;
      if (r.class === 'VirtualMachine' || r.class === 'Hypervisor') {
        if (isStaleCiStatus(st) || RE_DUP_RESIDUE.test(nm)) continue;
      }
      children.push({
        class: r.class,
        name: nm,
        relation: q.relation,
        status: st,
        ip: fieldStr(r.fields, 'managementip'),
        extra: fieldStr(r.fields, 'osfamily_name'),
      });
    }
  }

  // 硬件服务器追加本地 OS 层（Zabbix agent 主机，iTop 不独立建 CI）
  if (self.class === 'Server') {
    children.push(...localOsChildren(name));
  }

  // 网络设备：设备 → 端口/VLAN → 下一节点 递归展开（2026-11-27 用户定则）
  // 端口/VLAN 数据两个来源：① iTop PhysicalInterface（CMDB 权威，交换机侧
  // 端口同步上线前多为空）② cipipe netobs ARP 邻接（观测态，已裁决）。
  if (self.class === 'NetworkDevice') {
    // ① iTop 本机端口（CMDB 权威）
    const piRows = await listByOQL(
      'PhysicalInterface',
      `SELECT PhysicalInterface WHERE connectableci_id_friendlyname = '${esc(name)}'`,
      'name,description',
    );
    for (const r of piRows) {
      const n = fieldStr(r.fields, 'name') ?? String(r.key);
      children.push({
        class: 'PhysicalInterface',
        name: n,
        relation: '本机端口（CMDB）',
        extra: fieldStr(r.fields, 'description'),
      });
    }
    // ② cipipe ARP 邻接：端口与 VLAN 虚拟节点（host 键：iTop 名 = 管理 IP）
    const host = selfIp || name;
    const obs = await fetchNetobsByHost(host);
    if (obs.length === 0 && host !== name) {
      // 名称不是纯 IP 的设备（博科FC交换机6505-10.240.1.241）：再按名称尾部的 IP 试一次
      const ipTail = name.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
      if (ipTail) obs.push(...(await fetchNetobsByHost(ipTail[1])));
    }
    children.push(...netobsAdjacencyChildren(obs, host));
    // ③ CDP 设备级邻接（cipipe netlinks 拓扑）：交换机↔交换机/路由器的
    //    物理链路层级（接入→汇聚→核心→出口），按 BFS 层级分下联/互联/上联
    try {
      const cdp = await cdpPeerNodes(host);
      const seenCdp = new Set(children.map(c => `${c.class}:${c.name}`));
      for (const c of cdp.children) {
        const k = `${c.class}:${c.name}`;
        if (!seenCdp.has(k)) { seenCdp.add(k); children.push(c); }
      }
      parents.push(...cdp.parents);
    } catch (err) {
      logger.warn(`ciChain cdpPeerNodes failed for ${name}: ${(err as Error).message}`);
    }
  }

  // 虚拟机的「另一层」关联（v3.21）：
  // iTop 里同一台虚拟机常有两个 CI ——
  //   虚拟化层 = vCenter 发现对象，可见名 {vCenter名}-VM，通常 production
  //   操作系统层 = Zabbix agent 采集主机，名 VS-/VR- 前缀或历史遗留的纯 IP 名
  // 关联键两条并行：① 名称（-VM 后缀互为对端，最高优先）② managementip。
  // 名称必须并行：实测有 -VM 的 managementip 为空（vCenter 未采到 guest IP，
  // 如 VS-finedb-VM），纯 IP 匹配会整条断开。
  // 展示语义：从 -VM 下钻得到的是「操作系统」（class=VmOs），不是又一层虚拟机；
  // 从 OS 层回看才是「虚拟化对象」（class=VirtualMachine）。
  if (self.class === 'VirtualMachine') {
    const selfIsVmLayer = /-VM$/i.test(name);
    try {
      const counterparts = await vmCounterparts(name, selfIp);
      for (const r of counterparts) {
        const other = fieldStr(r.fields, 'name') ?? String(r.key);
        children.push({
          class: selfIsVmLayer ? 'VmOs' : 'VirtualMachine',
          name: other,
          relation: selfIsVmLayer ? '操作系统' : '虚拟化对象',
          status: normalizeStatus(fieldStr(r.fields, 'status')),
          ip: fieldStr(r.fields, 'managementip'),
          extra: fieldStr(r.fields, 'osfamily_name'),
        });
      }
    } catch (err) {
      logger.warn(`ciChain vmCounterparts failed for ${name}: ${(err as Error).message}`);
    }
    // 本身已是 OS 层（非 -VM）：数据库实例直接挂在这一层（含同 IP 别名归并）
    if (!selfIsVmLayer) {
      try {
        const seen = new Set(children.map(c => `${c.class}:${c.name}`));
        for (const c of await vmOsDbChildren(name, selfIp)) {
          const k = `${c.class}:${c.name}`;
          if (!seen.has(k)) { seen.add(k); children.push(c); }
        }
      } catch (err) {
        logger.warn(`ciChain vmOsDbChildren failed for ${name}: ${(err as Error).message}`);
      }
    }
  }

  return {
    self: { class: self.class, name: fieldStr(f, 'name') ?? name, status: normalizeStatus(fieldStr(f, 'status')), ip: selfIp, extra: selfExtra },
    parents,
    children,
    source: 'itop',
  };
}

// ============================================================
// 网络邻接链路（设备 → 端口/VLAN → 下一节点）
// 数据源：cipipe netobs（ARP 观测 + 计算层优先裁决）；虚拟类 NetPort/Vlan/IpAddr
// 名称编码：`<端口或vid>@<交换机host>` —— 展开请求只携带 class+name，host 必须内嵌
// ============================================================

const NETOBS_KEY_RE = /^([^@]+)@(.+)$/;

/** 解码 `x@host` 编码；非法形态返回 null */
function decodeNetobsKey(name: string): { key: string; host: string } | null {
  const m = name.match(NETOBS_KEY_RE);
  return m ? { key: m[1], host: m[2] } : null;
}

/** iTop VLAN vlan_tag → description（命名对照，一次拉全量缓存调用内使用） */
async function vlanDescriptions(): Promise<Map<string, string>> {
  const rows = await listByOQL('VLAN', 'SELECT VLAN', 'vlan_tag,description');
  const m = new Map<string, string>();
  for (const r of rows) {
    const tag = fieldStr(r.fields, 'vlan_tag');
    const desc = fieldStr(r.fields, 'description');
    if (tag && desc) m.set(tag, desc);
  }
  return m;
}

/**
 * 一组观测 → 下一节点列表：
 *   unique/dedup 且具名 → 已裁决 CI（可继续递归展开）；
 *   其余 → IpAddr 叶子（conflict=冲突待裁决，none=未落 CMDB）。
 */
function nextHopNodes(rows: NetobsRow[]): CiChainNode[] {
  const out: CiChainNode[] = [];
  const seenCi = new Set<string>();
  const seenIp = new Set<string>();
  for (const r of rows) {
    if ((r.match_kind === 'unique' || r.match_kind === 'dedup') && r.ci_name) {
      const k = `${r.ci_class}:${r.ci_name}`;
      if (!seenCi.has(k)) {
        seenCi.add(k);
        out.push({ class: r.ci_class || 'FunctionalCI', name: r.ci_name, relation: '邻接下一跳', ip: r.ip || undefined });
      }
      continue;
    }
    if (!r.ip || seenIp.has(r.ip)) continue;
    seenIp.add(r.ip);
    out.push({
      class: 'IpAddr',
      name: r.ip,
      relation: r.match_kind === 'conflict' ? '冲突邻接（cipipe 待裁决）' : '未裁决邻接（未落 CMDB）',
      extra: r.mac || undefined,
    });
  }
  return out;
}

/** 网络设备 children 追加：端口节点 + VLAN 节点（观测态，端口按自然序、VLAN 按数值序） */
function netobsAdjacencyChildren(obs: NetobsRow[], host: string): CiChainNode[] {
  const out: CiChainNode[] = [];
  if (obs.length === 0) return out;

  const byPort = groupByIfname(obs);
  const byVid = groupByVid(obs);

  // 端口节点（VLAN 接口 VlNNN 也是「端口」，与物理口一起展示）
  const portNames = [...byPort.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const p of portNames) {
    const rows = byPort.get(p) ?? [];
    const vids = [...new Set(rows.map(r => r.vid).filter(Boolean))];
    const hosts = new Set(rows.map(r => r.ip).filter(Boolean)).size;
    out.push({
      class: 'NetPort',
      name: `${p}@${host}`,
      relation: /^Vl\d+$/.test(p) ? 'VLAN 接口（SVI）' : '端口（ARP 邻接）',
      extra: [vids.length ? `VLAN ${vids.join('/')}` : '', hosts ? `${hosts} 个邻接` : ''].filter(Boolean).join(' · ') || undefined,
      ip: host,
    });
  }

  // VLAN 节点
  const vids = [...byVid.keys()].sort((a, b) => Number(a) - Number(b));
  for (const v of vids) {
    const rows = byVid.get(v) ?? [];
    const hosts = new Set(rows.map(r => r.ip).filter(Boolean)).size;
    out.push({
      class: 'Vlan',
      name: `${v}@${host}`,
      relation: `VLAN ${v}`,
      extra: hosts ? `${hosts} 个邻接` : undefined,
    });
  }
  return out;
}

// ============================================================
// CDP 网络链路层级（设备级邻接：接入 → 汇聚 → 核心 → 出口）
// 数据源：cipipe netlinks（CDP 邻居发现 + BFS 分层，核心种子 layer=0）。
// 设备级边只统计两端都参与 CDP 采集的设备；单侧观测（对端未纳管）作
// NetPeer 叶子节点。iTop 已建 CI 的对端映射为 NetworkDevice 继续递归展开。
// ============================================================

/** 从 cipipe 边端口明细中提取两端端口名（"a[p1] -> b[p2]" → "p1 ⇄ p2"） */
function extractPortPair(entry: string): string {
  const parts = [...entry.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
  return parts.length >= 2 ? `${parts[0]} ⇄ ${parts[1]}` : entry;
}

/** 按 managementip 批量查 iTop NetworkDevice（peer_ip → CI 名映射） */
async function networkDeviceNamesByIps(ips: string[]): Promise<Map<string, string>> {
  if (ips.length === 0 || !itopClient.isConfigured()) return new Map();
  const oql = `SELECT NetworkDevice WHERE ${ips.map(ip => `managementip = '${esc(ip)}'`).join(' OR ')}`;
  const rows = await listByOQL('NetworkDevice', oql, 'name,managementip');
  const m = new Map<string, string>();
  for (const r of rows) {
    const ip = fieldStr(r.fields, 'managementip');
    const n = fieldStr(r.fields, 'name');
    if (ip && n) m.set(ip, n);
  }
  return m;
}

/**
 * 某设备的 CDP 设备级邻接（下联/互联 → children；上联 → parents）。
 * 层级判定用 cipipe BFS 分层：对端层 > 本层 = 下联；相等 = 互联（双向展示）；
 * 小于 = 上联。单侧 CDP 观测（对端未纳管）→ NetPeer 叶子。
 */
async function cdpPeerNodes(selfIp: string): Promise<{ children: CiChainNode[]; parents: CiChainNode[] }> {
  const children: CiChainNode[] = [];
  const parents: CiChainNode[] = [];
  if (!selfIp) return { children, parents };
  const topo: NetlinkTopology = await fetchNetlinksTopology();
  if (topo.nodes.length === 0) return { children, parents };

  const selfLayer = topo.layer_of[selfIp];
  const neighborIps = new Set<string>();
  const edgePorts = new Map<string, string[]>();
  for (const e of topo.edges) {
    const peer = e.a === selfIp ? e.b : (e.b === selfIp ? e.a : null);
    if (!peer) continue;
    neighborIps.add(peer);
    edgePorts.set(peer, e.ports.map(extractPortPair));
  }
  // 单侧观测：本机端口 CDP 看到、但未参与采集的对端（路由器/未纳管交换机等）
  const singles = new Map<string, NetlinkUnconfirmedAgg>();
  for (const u of topo.unconfirmed) {
    if (u.src !== selfIp || !u.peer || u.peer === '?') continue;
    const agg = singles.get(u.peer) ?? { peer: u.peer, ports: new Set<string>(), platform: u.platform };
    if (u.port) agg.ports.add(u.port);
    if (!agg.platform && u.platform) agg.platform = u.platform;
    singles.set(u.peer, agg);
  }

  let ip2name = new Map<string, string>();
  try {
    ip2name = await networkDeviceNamesByIps([...neighborIps]);
  } catch (err) {
    logger.warn(`ciChain networkDeviceNamesByIps failed: ${(err as Error).message}`);
  }

  for (const ip of neighborIps) {
    const peerLayer = topo.layer_of[ip];
    const mapped = ip2name.get(ip);
    const node = topo.nodes.find(n => n.ip === ip);
    const ports = edgePorts.get(ip)?.join(' · ');
    if (selfLayer == null || peerLayer == null || peerLayer > selfLayer) {
      children.push({
        class: mapped ? 'NetworkDevice' : 'NetPeer',
        name: mapped || `${node?.name || ip}@${ip}`,
        relation: 'CDP 下联',
        ip,
        extra: ports,
      });
    } else if (peerLayer === selfLayer) {
      children.push({ class: mapped ? 'NetworkDevice' : 'NetPeer', name: mapped || `${node?.name || ip}@${ip}`, relation: 'CDP 互联', ip, extra: ports });
      parents.push({ class: mapped ? 'NetworkDevice' : 'NetPeer', name: mapped || `${node?.name || ip}@${ip}`, relation: 'CDP 互联', ip, extra: ports });
    } else {
      parents.push({ class: mapped ? 'NetworkDevice' : 'NetPeer', name: mapped || `${node?.name || ip}@${ip}`, relation: 'CDP 上联', ip, extra: ports });
    }
  }
  for (const agg of singles.values()) {
    children.push({
      class: 'NetPeer',
      name: agg.peer,
      relation: 'CDP 邻接（未纳管）',
      extra: [agg.platform, agg.ports.size ? `本机 ${[...agg.ports].join('/')}` : '']
        .filter(Boolean).join(' · ') || undefined,
    });
  }
  return { children, parents };
}

interface NetlinkUnconfirmedAgg {
  peer: string;
  ports: Set<string>;
  platform: string | null;
}

/** NetPeer 展开：cipipe 拓扑已纳管（devid@ip）→ 列其 CDP 邻接；未纳管 → 叶子 */
async function netPeerChain(encoded: string): Promise<CiChain> {
  const dec = decodeNetobsKey(encoded);
  if (!dec) {
    return {
      self: { class: 'NetPeer', name: encoded },
      parents: [],
      children: [],
      source: 'none',
      degraded: 'CDP 单侧观测的未纳管设备（不在 cipipe 采集清单；如需纳管请加入 netlink 采集主机列表）',
    };
  }
  const ip = dec.host;
  const topo = await fetchNetlinksTopology();
  const node = topo.nodes.find(n => n.ip === ip);
  if (!node) {
    return { self: null, parents: [], children: [], source: 'none', degraded: `cipipe CDP 拓扑中未找到 ${ip}` };
  }
  const { children, parents } = await cdpPeerNodes(ip);
  return {
    self: { class: 'NetPeer', name: node.name, ip, extra: node.layer != null ? `网络层级 L${node.layer}` : '未连通（孤立设备）' },
    parents,
    children,
    source: 'local',
  };
}

/** NetPort 展开：端口信息卡 + 端口 VLAN + 邻接下一跳 */
async function netPortChain(encoded: string): Promise<CiChain> {
  const dec = decodeNetobsKey(encoded);
  if (!dec) {
    return { self: null, parents: [], children: [], source: 'none', degraded: '端口节点名称格式异常（应为 端口@交换机）' };
  }
  const { key: ifname, host } = dec;
  const obs = (await fetchNetobsByHost(host)).filter(r => r.ifname === ifname);
  const children: CiChainNode[] = [];
  if (obs.length === 0) {
    return {
      self: { class: 'NetPort', name: ifname, ip: host },
      parents: [{ class: 'NetworkDevice', name: host, relation: '所属交换机' }],
      children: [],
      source: 'none',
      degraded: 'cipipe 无该端口的 ARP 观测',
    };
  }
  // 端口承载的 VLAN（多 vid = trunk 口）
  for (const v of [...new Set(obs.map(r => r.vid).filter(Boolean))].sort((a, b) => Number(a) - Number(b))) {
    children.push({ class: 'Vlan', name: `${v}@${host}`, relation: '端口 VLAN' });
  }
  children.push(...nextHopNodes(obs));
  return {
    self: { class: 'NetPort', name: ifname, ip: host, extra: `${obs.length} 条 ARP 观测` },
    parents: [{ class: 'NetworkDevice', name: host, relation: '所属交换机' }],
    children,
    source: 'local',
  };
}

/** Vlan 展开：VLAN 命名（iTop 裁决名）+ 该 VLAN 内邻接下一跳 */
async function vlanChain(encoded: string): Promise<CiChain> {
  const dec = decodeNetobsKey(encoded);
  if (!dec) {
    return { self: null, parents: [], children: [], source: 'none', degraded: 'VLAN 节点名称格式异常（应为 vid@交换机）' };
  }
  const { key: vid, host } = dec;
  const obs = (await fetchNetobsByHost(host)).filter(r => r.vid === vid);
  let vlanName: string | undefined;
  try {
    vlanName = (await vlanDescriptions()).get(vid);
  } catch {
    vlanName = undefined; // iTop VLAN 命名不可得时退回纯 vid 展示
  }
  const children = obs.length > 0 ? nextHopNodes(obs) : [];
  return {
    self: {
      class: 'Vlan',
      name: vlanName ? `VLAN ${vid} · ${vlanName}` : `VLAN ${vid}`,
      extra: obs.length ? `${obs.length} 条 ARP 观测` : undefined,
    },
    parents: [{ class: 'NetworkDevice', name: host, relation: '观测交换机' }],
    children,
    source: obs.length > 0 ? 'local' : 'none',
    degraded: obs.length === 0 ? 'cipipe 无该交换机在此 VLAN 的观测' : undefined,
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
// DB 层派生（Zabbix gv$instance → iTop DBServer）
// ============================================================

/**
 * OS 层节点 → 数据库实例（children）
 * Zabbix gv_instance_map 中 host_name 命中该节点的 DB 主机，
 * 反查 iTop 中名称包含 DB 主机技术名或可见名的 DBServer CI
 * （技术名如 CPCNRTN ⊂ DB-ORA-10-CPCNRTN；可见名兜底如 DB-ORA-OBDB-ODBC ⊂ OBCP）。
 */
async function osDbInstanceChildren(osName: string): Promise<CiChainNode[]> {
  const dbHosts = await findDbHostsByOsHost(osName);
  if (dbHosts.length === 0) return [];
  const conds = new Set<string>();
  for (const m of dbHosts) {
    conds.add(`name LIKE '%${esc(m.zhost)}%'`);
    if (m.zname && m.zname !== m.zhost) conds.add(`name LIKE '%${esc(m.zname)}%'`);
  }
  const rows = await listByOQL('DBServer', `SELECT DBServer WHERE ${[...conds].join(' OR ')}`, 'name,status');
  const byName = new Map<string, CiChainNode>();
  for (const m of dbHosts) {
    const instances = m.instances.map(i => i.instance_name).join('/');
    const zhost = m.zhost.toLowerCase();
    const zname = m.zname?.toLowerCase();
    for (const r of rows) {
      const dbsName = fieldStr(r.fields, 'name') ?? String(r.key);
      const n = dbsName.toLowerCase();
      if (!(zname && n.includes(zname)) && !n.includes(zhost)) continue;
      if (isStaleDbServer(fieldStr(r.fields, 'status'))) continue;
      if (!byName.has(dbsName)) {
        byName.set(dbsName, {
          class: 'DBServer',
          name: dbsName,
          relation: `数据库集群（实例 ${instances}）`,
          status: normalizeStatusSafe(fieldStr(r.fields, 'status')),
        });
      }
    }
  }
  return [...byName.values()];
}

/** iTop DBServer → OS 层节点（parents，反向派生；gv$instance 全集群实例跨节点） */
async function dbServerOsParents(dbServerName: string): Promise<CiChainNode[]> {
  const dbHosts = await findDbHostsByDbServerName(dbServerName);
  const byName = new Map<string, CiChainNode>();
  for (const m of dbHosts) {
    for (const inst of m.instances) {
      if (!byName.has(inst.host_name)) {
        byName.set(inst.host_name, {
          class: 'OsHost',
          name: inst.host_name,
          relation: `操作系统节点（${inst.instance_name}）`,
        });
      }
    }
  }
  return [...byName.values()];
}

function normalizeStatusSafe(s?: string): string | undefined {
  return s?.trim() || undefined;
}

// ============================================================
// 虚拟机 ↔ 操作系统层（VmOs）
// ============================================================

/**
 * 找出某个虚拟机 CI 的「另一层」对象（-VM ↔ OS 层互查）。
 *
 * 匹配顺序：名称优先（剥/加 `-VM` 后缀精确命中），再叠加 managementip 同址对象。
 * 名称必须优先，因为部分 -VM 的 managementip 为空（如 VS-finedb-VM），只按 IP 会整条断链。
 *
 * 纯 IP 命名的对象是 Zabbix 早期按 IP 建 CI 的遗留物 —— 同一台机常有
 * `VR-SSAPP150` 与 `10.240.21.131` 两份，后者属于残渣。只要存在具名对端就剔除纯 IP 项。
 */
async function vmCounterparts(vmName: string, vmIp?: string): Promise<ITopEntry[]> {
  const selfIsVmLayer = /-VM$/i.test(vmName);
  const base = vmName.replace(/-VM$/i, '');
  const wantName = selfIsVmLayer ? base : `${vmName}-VM`;
  const byName = new Map<string, ITopEntry>();

  const add = (rows: ITopEntry[]) => {
    for (const r of rows) {
      const n = fieldStr(r.fields, 'name');
      if (!n || n === vmName) continue;
      // __DUP 同步残渣不作为对端（曾把 obsolete 的 VR-SSAPP18__DUP_VIRTUALMACHINE_2031
      // 按 managementip 同址带进链路，展示成「操作系统」）
      if (RE_DUP_RESIDUE.test(n)) continue;
      if (isStaleCiStatus(fieldStr(r.fields, 'status'))) continue;
      // 同层不挂（同为 -VM 或同为非 -VM 的多台，各自由自身关联对方）
      if (/-VM$/i.test(n) === selfIsVmLayer) continue;
      if (!byName.has(n)) byName.set(n, r);
    }
  };

  add(await listByOQL('VirtualMachine', `SELECT VirtualMachine WHERE name = '${esc(wantName)}'`, VM_FIELDS));
  if (vmIp) {
    add(await listByOQL('VirtualMachine', `SELECT VirtualMachine WHERE managementip = '${esc(vmIp)}'`, VM_FIELDS));
  }

  const all = [...byName.values()];
  const named = all.filter(r => !PURE_IP_NAME.test(fieldStr(r.fields, 'name') ?? ''));
  // 具名对端存在时只留具名的；一条都没有（历史库普遍按 IP 命名）才退回纯 IP 项
  return named.length > 0 ? named : all;
}

/**
 * VmOs 自身 + 邻接：宿主在上、数据库实例在下。
 * self 仍来自 iTop 的 VirtualMachine CI，但对外以 VmOs 呈现（前端标签「操作系统」）。
 */
async function vmOsChain(osName: string): Promise<CiChain> {
  if (!itopClient.isConfigured()) {
    return { self: null, parents: [], children: [], source: 'local', degraded: 'iTop 未配置或不可达' };
  }
  const self = await getSelf('VirtualMachine', osName);
  if (!self) {
    return {
      self: null,
      parents: [],
      children: [],
      source: 'none',
      degraded: `iTop 中未找到操作系统 CI「${osName}」`,
    };
  }

  const f = self.fields;
  const ip = fieldStr(f, 'managementip') || localServerIp(osName);

  // 父：虚拟化宿主（占位符 ZBX-VM-Unassigned-Host 表示未关联，不展示）
  const parents: CiChainNode[] = [];
  const hv = fieldStr(f, 'virtualhost_id_friendlyname');
  if (hv && hv !== 'ZBX-VM-Unassigned-Host') {
    parents.push({ class: 'Hypervisor', name: hv, relation: '虚拟化宿主' });
  }

  // 子：该操作系统上运行的数据库实例（iTop DBServer）
  let children: CiChainNode[] = [];
  try {
    children = await vmOsDbChildren(osName, ip);
  } catch (err) {
    logger.warn(`ciChain vmOsDbChildren failed for ${osName}: ${(err as Error).message}`);
  }

  return {
    self: {
      class: 'VmOs',
      name: fieldStr(f, 'name') ?? osName,
      status: normalizeStatus(fieldStr(f, 'status')),
      ip,
      extra: fieldStr(f, 'osfamily_name') || undefined,
    },
    parents,
    children,
    source: 'itop',
    degraded: children.length === 0 ? '该操作系统未关联数据库实例 CI' : undefined,
  };
}

/** 本地 servers 表补 IP（iTop 侧 managementip 偶有空值） */
function localServerIp(name: string): string | undefined {
  const row = db.prepare('SELECT ip_address FROM servers WHERE name = ? AND ip_address IS NOT NULL').get(name) as
    | { ip_address: string | null }
    | undefined;
  return row?.ip_address ?? undefined;
}

/**
 * 操作系统层 CI 下的数据库实例。
 *
 * 两个来源合并：
 *   1. iTop DBServer.system_id_friendlyname 命中「同名或同 IP 的 OS 层 CI」——
 *      同 IP 别名必须一起查：DB-ORA-Finedb-ODBC 挂的是别名 `finedb`，
 *      而 -VM 对应的具名 OS 层是 `VS-finedb`，只按自身名查会漏。
 *   2. Zabbix gv$instance 派生（Oracle RAC 实例跨节点）。
 */
async function vmOsDbChildren(osName: string, ip?: string): Promise<CiChainNode[]> {
  const names = new Set<string>([osName]);
  if (ip) {
    const same = await listByOQL(
      'VirtualMachine',
      `SELECT VirtualMachine WHERE managementip = '${esc(ip)}'`,
      'name,managementip,status',
    );
    for (const r of same) {
      const n = fieldStr(r.fields, 'name');
      // 别名只取 OS 层（非 -VM）且非 __DUP 残渣/过期对象；-VM 是虚拟化层对象，不会承载 DBServer
      if (n && !/-VM$/i.test(n) && !RE_DUP_RESIDUE.test(n)
          && !isStaleCiStatus(fieldStr(r.fields, 'status'))) names.add(n);
    }
  }

  const conds = [...names].map(n => `system_id_friendlyname = '${esc(n)}'`);
  const rows = await listByOQL('DBServer', `SELECT DBServer WHERE ${conds.join(' OR ')}`, 'name,status');

  const out: CiChainNode[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const n = fieldStr(r.fields, 'name') ?? String(r.key);
    if (seen.has(n) || isStaleDbServer(fieldStr(r.fields, 'status'))) continue;
    seen.add(n);
    out.push({
      class: 'DBServer',
      name: n,
      relation: '数据库实例',
      status: normalizeStatus(fieldStr(r.fields, 'status')),
    });
  }

  try {
    for (const c of await osDbInstanceChildren(osName)) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
  } catch (err) {
    logger.warn(`ciChain osDbInstanceChildren failed for ${osName}: ${(err as Error).message}`);
  }

  return out;
}


async function osHostChain(osName: string): Promise<CiChain> {
  let row = db.prepare('SELECT id, name, ip_address, os, os_type, description FROM servers WHERE name = ?').get(osName) as
    | (LocalServerRow & { os_type: string | null; description: string | null })
    | undefined;
  // 容错：gv$instance 派生节点是真实主机名（obdb02），本地行按规范是
  // svr-<hostname>-<备注>（svr-obdb02-197）——按命名规则兜底取信息最全的一条
  if (!row) {
    const candidates = db
      .prepare(
        `SELECT id, name, ip_address, os, os_type, description FROM servers
         WHERE (name LIKE 'svr-' || ? || '-%' OR name LIKE ? || '-%')
           AND length(name) >= 3 AND name NOT LIKE 'svr-MGMT-%'
         LIMIT 5`,
      )
      .all(osName, osName) as (LocalServerRow & { os_type: string | null; description: string | null })[];
    row = candidates.find(r => osNameMatchesHost(r.name, osName));
  }

  const parents = localHardwareParents(osName);

  // DB 层派生：该节点上运行的 Oracle 实例 → iTop DBServer CI（Zabbix gv$instance，失败静默为空）
  let dbChildren: CiChainNode[] = [];
  try {
    dbChildren = await osDbInstanceChildren(osName);
  } catch (err) {
    logger.warn(`ciChain osDbInstanceChildren failed for ${osName}: ${(err as Error).message}`);
  }

  // iTop：合并进 guest 的 OS 层标记（description 含 os-agent:{OS主机名}）
  return {
    self: row
      ? { class: 'OsHost', name: row.name, ip: row.ip_address ?? undefined, extra: row.os || row.os_type || undefined }
      : null,
    parents,
    children: dbChildren,
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
