/**
 * ciRelationGraphService — CMDB 全量 CI 关系图（一次构建，供「资源工作台」全量展开）
 *
 * 与 ciChainService 的分工：
 *   ciChainService  逐台展开（点击一个节点→查它的上下级），实时、精确、可递归；
 *   ciRelationGraph 全量展开（一次拿全部 CI 及其关系边），用于看板上的全景浏览、
 *                   按轴/按类筛选、孤立对象识别与关系统计。
 *
 * 数据来源与纪律（架构定位总纲 P1–P5）：
 *   · iTop 走 REST/OQL 按类批量拉（每类 1 次请求），不直连 iTop 库；
 *   · cipipe 走 HTTP 只读接口（netobs 观测 + netlinks 拓扑），不直连治理库；
 *   · 本服务**纯只读**，不写 iTop 也不写 cipipe。
 *
 * 关系轴（2026-11-28 用户定则）：
 *   host    宿主轴  VirtualMachine → Hypervisor → Server
 *   storage 存储轴  Server/VM → StorageVolume → StorageSystem（CMDB 未采集，恒空）
 *   network 网络轴  机器 → 观测交换机 → … → 核心/出口
 *   db      数据库  DBServer → 承载对象
 *   rack    位置    Server/NetworkDevice/StorageSystem → Rack
 *   os      运行层  Server → OsHost（本地 Zabbix 主机表）
 */
import { itopClient } from '../../cmdb-sync/services/itopClient';
import { fetchNetlinksTopology, fetchNetobsAll, type NetlinkTopology } from './cipipeAdjacencyService';
import { osNameMatchesHost } from './zabbixDbMapService';
import db from '../../../models/database';
import { logger } from '../../../utils/logger';

// ============================================================
// 类型
// ============================================================

export type RelAxis = 'host' | 'storage' | 'network' | 'db' | 'rack' | 'os';

export interface RelNode {
  /** 全局唯一键：`<class>:<name>` */
  key: string;
  class: string;
  name: string;
  ip?: string;
  status?: string;
  /** 同步重复残渣（__DUP_*）——默认剔除，统计里单列 */
  dup: boolean;
  /** 各类关系计数（下级 / 上级） */
  children: number;
  parents: number;
  /** 该节点所属关系轴（自身参与过的轴） */
  axes: RelAxis[];
  /** 上级三轴的最近一跳名称（便于表格直接显示归属） */
  dims: { network?: string; host?: string; storage?: string };
}

export interface RelEdge {
  from: string;
  to: string;
  axis: RelAxis;
  relation: string;
}

export interface RelStats {
  /** iTop 全量对象数（含残渣） */
  totalRaw: number;
  /** 剔除残渣后的 iTop 原生对象数（不含 OS 层虚拟类） */
  total: number;
  /** OS 层节点数（Zabbix 主机，虚拟类，非 iTop CI） */
  osNodes: number;
  /** 残渣数 */
  dupCount: number;
  /** 完全孤立（无上下级任何关系，仅计 iTop 原生对象） */
  isolated: number;
  /** 各轴有关系的对象数 */
  byAxis: Record<RelAxis | 'children', number>;
  /** 各类对象数（剔残渣，不含 OS 层） */
  byClass: Record<string, number>;
}

export interface RelGraph {
  generatedAt: string;
  stats: RelStats;
  nodes: RelNode[];
  edges: RelEdge[];
  /** 孤立对象（无任何关系）的 key 列表 */
  isolated: string[];
  /** 网络轴根源聚合（根源设备 → 收敛对象数） */
  networkRoots: { root: string; count: number }[];
  /** 数据缺口提示（某轴整体不可用的原因） */
  gaps: string[];
}

// ============================================================
// 常量
// ============================================================

/** 同步重复残渣命名（与 ciChainService 保持一致） */
const RE_DUP_RESIDUE = /__DUP_(?:SERVER|VIRTUALMACHINE|HYPERVISOR|DBSERVER|NETWORKDEVICE|STORAGESYSTEM)_\d+$/;

/** 占位宿主/承载对象（未关联时 iTop 写入的假值，不作关系边） */
const PLACEHOLDER_PARENTS = new Set([
  'ZBX-VM-Unassigned-Host',
  'ZBX-DB-Host-Unassigned',
]);

/** 各类的取数字段（最小可靠集，避免不存在的字段导致整查失败） */
const CLASS_QUERIES: { cls: string; fields: string }[] = [
  { cls: 'Server', fields: 'name,status,managementip,rack_id_friendlyname' },
  { cls: 'Hypervisor', fields: 'name,status,server_id_friendlyname' },
  { cls: 'VirtualMachine', fields: 'name,status,managementip,virtualhost_id_friendlyname' },
  { cls: 'DBServer', fields: 'name,status,system_id_friendlyname' },
  { cls: 'NetworkDevice', fields: 'name,status,managementip,rack_id_friendlyname' },
  { cls: 'StorageSystem', fields: 'name,status,rack_id_friendlyname' },
  // 机柜参与「位置轴」：设备 → 机柜。只取 name，避免 Rack 字段集差异导致整查失败
  { cls: 'Rack', fields: 'name' },
];

/** 无上级关系的设备类（自身即轴的根源，不产生 parents 边） */
const NO_HOST_AXIS = new Set(['Server', 'NetworkDevice', 'StorageSystem']);

function str(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function nodeKey(cls: string, name: string): string {
  return `${cls}:${name}`;
}

/** 残渣/占位状态判定（status 为 inactive/obsolete 视为淘汰对象） */
function isStale(status?: string): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'inactive' || s === 'obsolete';
}

// ============================================================
// 主流程
// ============================================================

interface RawCi {
  class: string;
  name: string;
  ip?: string;
  status?: string;
  fields: Record<string, unknown>;
}

/** 按类批量拉 iTop 全量对象（失败静默跳过该类，不拖垮整图） */
async function fetchAllCi(): Promise<RawCi[]> {
  const out: RawCi[] = [];
  for (const q of CLASS_QUERIES) {
    try {
      const res = await itopClient.getObjects<Record<string, unknown>>(
        q.cls, `SELECT ${q.cls}`, q.fields,
      );
      if (!res.success || !res.data) {
        logger.warn(`ciRelationGraph: 拉取 ${q.cls} 失败 ${res.error ?? ''}`);
        continue;
      }
      for (const entry of Object.values(res.data.objects)) {
        const name = str(entry.fields, 'name') ?? String(entry.key);
        out.push({
          class: entry.class || q.cls,
          name,
          ip: str(entry.fields, 'managementip'),
          status: str(entry.fields, 'status'),
          fields: entry.fields,
        });
      }
      logger.info(`ciRelationGraph: ${q.cls} ${res.data.count} 条`);
    } catch (err) {
      logger.warn(`ciRelationGraph: 拉取 ${q.cls} 异常 ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * 构建全量 CI 关系图。
 * @param includeDup 是否包含 __DUP_* 同步残渣（默认剔除，仅统计里计数）
 */
export async function buildRelationGraph(includeDup = false): Promise<RelGraph> {
  const raw = await fetchAllCi();

  /** 名称 → 节点键（用于把 host/server_id 之类的「友好名」解析回节点） */
  const byName = new Map<string, string[]>();
  for (const r of raw) {
    const arr = byName.get(r.name);
    if (arr) arr.push(nodeKey(r.class, r.name));
    else byName.set(r.name, [nodeKey(r.class, r.name)]);
  }
  /** 管理 IP → 节点键（网络轴按 IP 关联的关键索引；名称通常不是 IP，必须单建） */
  const ipToKeys = new Map<string, string[]>();
  for (const r of raw) {
    if (!r.ip) continue;
    const k = nodeKey(r.class, r.name);
    const arr = ipToKeys.get(r.ip);
    if (arr) arr.push(k);
    else ipToKeys.set(r.ip, [k]);
  }

  const dupCount = raw.filter(r => RE_DUP_RESIDUE.test(r.name)).length;

  // ── 节点（残渣按需剔除）──
  const nodes = new Map<string, RelNode>();
  for (const r of raw) {
    const dup = RE_DUP_RESIDUE.test(r.name);
    if (dup && !includeDup) continue;
    // status 为过期/淘汰的对象不进图（与 ciChain 的残渣过滤一致）
    if (isStale(r.status) && !includeDup) continue;
    const key = nodeKey(r.class, r.name);
    nodes.set(key, {
      key, class: r.class, name: r.name, ip: r.ip, status: r.status,
      dup, children: 0, parents: 0, axes: [], dims: {},
    });
  }

  const edges: RelEdge[] = [];
  /** 边去重：同一 (from, to, axis) 只保留一条（本地库同名多行会产生重复匹配） */
  const edgeSeen = new Set<string>();
  const addEdge = (fromKey: string, toKey: string, axis: RelAxis, relation: string) => {
    if (!nodes.has(fromKey) || !nodes.has(toKey)) return;
    if (fromKey === toKey) return;
    const sig = `${fromKey}|${toKey}|${axis}`;
    if (edgeSeen.has(sig)) return;
    edgeSeen.add(sig);
    edges.push({ from: fromKey, to: toKey, axis, relation });
  };

  /** 友好名 → 目标节点键（优先同名同类；忽略占位与无法解析的名称） */
  const resolveParent = (name: string | undefined, prefer?: string[]): string | undefined => {
    if (!name || PLACEHOLDER_PARENTS.has(name)) return undefined;
    const cands = byName.get(name);
    if (!cands) return undefined;
    if (prefer) {
      const hit = cands.find(k => prefer.some(p => k.startsWith(`${p}:`)));
      if (hit) return hit;
    }
    // 唯一候选直接采用；多候选取第一个存在的
    return cands.find(k => nodes.has(k));
  };

  // ── iTop 原生关系 ──
  for (const r of raw) {
    const dup = RE_DUP_RESIDUE.test(r.name);
    if (dup && !includeDup) continue;
    if (isStale(r.status) && !includeDup) continue;
    const selfKey = nodeKey(r.class, r.name);

    // 宿主轴：VM → Hypervisor → Server
    if (r.class === 'VirtualMachine') {
      const hv = resolveParent(str(r.fields, 'virtualhost_id_friendlyname'), ['Hypervisor']);
      if (hv) addEdge(selfKey, hv, 'host', '虚拟化宿主');
    }
    if (r.class === 'Hypervisor') {
      const host = resolveParent(str(r.fields, 'server_id_friendlyname'), ['Server']);
      if (host) addEdge(selfKey, host, 'host', '物理服务器');
    }
    // 数据库：DBServer → 承载对象（system_id 存友好名，可能是物理机/VM/OS 层主机名，
    // 优先 Server/VM，找不到时放宽到任意类——OS 层 CI 也真实承载实例）
    if (r.class === 'DBServer') {
      const sys = str(r.fields, 'system_id_friendlyname');
      if (sys && !PLACEHOLDER_PARENTS.has(sys)) {
        const host = resolveParent(sys, ['Server', 'VirtualMachine']) ?? resolveParent(sys);
        if (host) addEdge(selfKey, host, 'db', '承载对象');
      }
    }
    // 位置：设备 → 机柜
    const rack = str(r.fields, 'rack_id_friendlyname');
    if (rack) {
      const rk = nodeKey('Rack', rack);
      // 机柜本身可能未纳入本次拉取（Rack 类不拉），用 aliveness 校验兜底
      if (nodes.has(rk)) addEdge(selfKey, rk, 'rack', '所在机柜');
    }
  }

  // ── 网络轴（cipipe）：机器 → 观测交换机 → 上联 → 核心/出口 ──
  let topo: NetlinkTopology = { nodes: [], edges: [], unconfirmed: [], layer_of: {} };
  let netobs: Awaited<ReturnType<typeof fetchNetobsAll>> = [];
  try {
    [topo, netobs] = await Promise.all([fetchNetlinksTopology(), fetchNetobsAll()]);
  } catch (err) {
    logger.warn(`ciRelationGraph: cipipe 取数失败 ${(err as Error).message}`);
  }

  /** IP → 观测到它的交换机（source_host）集合 */
  const ipToSwitches = new Map<string, Set<string>>();
  for (const o of netobs) {
    if (!o.ip || !o.source_host) continue;
    const s = ipToSwitches.get(o.ip);
    if (s) s.add(o.source_host);
    else ipToSwitches.set(o.ip, new Set([o.source_host]));
  }

  /** 交换机管理 IP → 图中 NetworkDevice 键 */
  const ndByIp = new Map<string, string>();
  for (const r of raw) {
    if (r.class !== 'NetworkDevice') continue;
    const k = nodeKey(r.class, r.name);
    if (!nodes.has(k)) continue;
    if (r.ip) ndByIp.set(r.ip, k);
    // iTop 里网络设备名常等于管理 IP（10.0.20.1）
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(r.name)) ndByIp.set(r.name, k);
  }

  // 机器 → 交换机：按「被观测 IP」反查该 IP 上的 CMDB 对象（含 Server/VM/HV/存储等），
  // 再连到观测到它的交换机。注意必须走 ipToKeys —— 机器名通常不等于 IP。
  for (const [ip, switches] of ipToSwitches) {
    for (const selfKey of ipToKeys.get(ip) ?? []) {
      if (!nodes.has(selfKey)) continue;
      const selfCls = selfKey.split(':')[0];
      for (const sw of switches) {
        // 交换机自己观测到自己（VLAN SVI / 管理口）不建自连边
        if (selfCls === 'NetworkDevice' && sw === ip) continue;
        const swKey = ndByIp.get(sw)
          ?? byName.get(sw)?.find(k => k.startsWith('NetworkDevice:') && nodes.has(k));
        if (swKey) addEdge(selfKey, swKey, 'network', 'ARP 观测交换机');
      }
    }
  }

  // 交换机 → 上联交换机（CDP 边；a/b 均为管理 IP）
  const layerOf = topo.layer_of ?? {};
  for (const e of topo.edges ?? []) {
    const a = ndByIp.get(e.a) ?? byName.get(e.a)?.find(k => k.startsWith('NetworkDevice:'));
    const b = ndByIp.get(e.b) ?? byName.get(e.b)?.find(k => k.startsWith('NetworkDevice:'));
    if (!a || !b || !nodes.has(a) || !nodes.has(b)) continue;
    // 层号小者在上：无层信息时按字典序稳定定向
    const la = layerOf[e.a] ?? 99;
    const lb = layerOf[e.b] ?? 99;
    const [down, up] = la <= lb ? [a, b] : [b, a];
    addEdge(down, up, 'network', 'CDP 上联');
  }

  // ── 运行层（os 轴）：物理机 → 操作系统（Zabbix 主机表，本地库一次查询 + 内存匹配）──
  // 与机房看板 localOsChildren 同规则：仅 svr-* 物理机参与，按硬件后缀匹配 OS 主机名；
  // 排除 MGMT/iLo/idrac/bmc/imm 等带外管理口命名。
  try {
    const osRows = db
      .prepare(
        `SELECT name, ip_address, os FROM servers
         WHERE length(name) >= 3
           AND name NOT LIKE 'svr-MGMT-%' AND name NOT LIKE 'svr-iLo-%'
           AND name NOT LIKE 'svr-idrac-%' AND name NOT LIKE 'svr-bmc-%'
           AND name NOT LIKE 'svr-imm-%'`,
      )
      .all() as { name: string; ip_address: string | null; os: string | null }[];

    // OS 主机本身作为节点加入（虚拟类 OsHost，与机房看板一致）
    const osKeys = new Set<string>();
    for (const r of osRows) {
      const k = nodeKey('OsHost', r.name);
      if (nodes.has(k)) continue;
      nodes.set(k, {
        key: k, class: 'OsHost', name: r.name, ip: r.ip_address ?? undefined,
        status: undefined, dup: false, children: 0, parents: 0, axes: [], dims: {},
      });
      osKeys.add(k);
    }

    for (const r of raw) {
      if (r.class !== 'Server') continue;
      const selfKey = nodeKey(r.class, r.name);
      if (!nodes.has(selfKey)) continue;
      // 硬件后缀：去掉 svr-MGMT-<ip>- 前缀后的机型标识
      const suffix = r.name.replace(/^svr-(?:MGMT|iLo|idrac|bmc|imm)-[\d.]+-/i, '');
      if (!suffix) continue;
      for (const o of osRows) {
        if (!osNameMatchesHost(o.name, suffix) && !r.name.includes(`-${o.name}`)) continue;
        addEdge(selfKey, nodeKey('OsHost', o.name), 'os', '操作系统（Zabbix）');
      }
    }
    if (osKeys.size > 0) {
      logger.info(`ciRelationGraph: OS 层节点 ${osKeys.size} 个`);
    }
  } catch (err) {
    logger.warn(`ciRelationGraph: OS 层匹配失败 ${(err as Error).message}`);
  }

  // ── 计数与轴归属 ──
  const nodeList = [...nodes.values()];
  const byKey = new Map(nodeList.map(n => [n.key, n]));
  for (const e of edges) {
    const f = byKey.get(e.from);
    const t = byKey.get(e.to);
    if (f) {
      f.children += 1;
      if (!f.axes.includes(e.axis)) f.axes.push(e.axis);
    }
    if (t) {
      t.parents += 1;
      if (!t.axes.includes(e.axis)) t.axes.push(e.axis);
      // 三轴最近一跳（供表格直接显示归属）
      if (e.axis === 'host' && !t.dims.host) t.dims.host = f?.name;
      if (e.axis === 'network' && !t.dims.network) t.dims.network = f?.name;
      if (e.axis === 'storage' && !t.dims.storage) t.dims.storage = f?.name;
    }
  }

  // ── 统计（OS 层是 Zabbix 主机虚拟类，不属 iTop CI，单独计量）──
  const nativeNodes = nodeList.filter(n => n.class !== 'OsHost');
  const byClass: Record<string, number> = {};
  for (const n of nativeNodes) byClass[n.class] = (byClass[n.class] ?? 0) + 1;

  // 孤立判定只针对 iTop 原生 CI：OS 层是链路终点（运行层本身无下级），
  // 计入孤立会把统计淹没
  const isolated = nativeNodes
    .filter(n => n.children === 0 && n.parents === 0)
    .map(n => n.key);
  const byAxis = {
    children: nativeNodes.filter(n => n.children > 0).length,
    host: nativeNodes.filter(n => n.axes.includes('host')).length,
    storage: nativeNodes.filter(n => n.axes.includes('storage')).length,
    network: nativeNodes.filter(n => n.axes.includes('network')).length,
    db: nativeNodes.filter(n => n.axes.includes('db')).length,
    rack: nativeNodes.filter(n => n.axes.includes('rack')).length,
    os: nativeNodes.filter(n => n.axes.includes('os')).length,
  };

  // ── 网络轴根源聚合：沿 network 边向上走到层号最小的设备 ──
  const netParents = new Map<string, string[]>(); // child → 直属上级（交换机）
  for (const e of edges) {
    if (e.axis !== 'network') continue;
    const arr = netParents.get(e.from);
    if (arr) arr.push(e.to); else netParents.set(e.from, [e.to]);
  }
  const rootCache = new Map<string, string>();
  const findRoot = (key: string, seen = new Set<string>()): string => {
    const cached = rootCache.get(key);
    if (cached) return cached;
    if (seen.has(key)) return key;
    seen.add(key);
    const ups = netParents.get(key);
    if (!ups || ups.length === 0) {
      rootCache.set(key, key);
      return key;
    }
    const root = findRoot(ups[0], seen);
    rootCache.set(key, root);
    return root;
  };
  const rootCount = new Map<string, number>();
  for (const n of nativeNodes) {
    if (!n.axes.includes('network')) continue;
    const root = findRoot(n.key);
    rootCount.set(root, (rootCount.get(root) ?? 0) + 1);
  }
  const networkRoots = [...rootCount.entries()]
    .map(([root, count]) => ({ root: byKey.get(root)?.name ?? root, count }))
    .sort((a, b) => b.count - a.count);

  // ── 数据缺口（轴整体不可用时明示，避免看板"看起来是空的"）──
  const gaps: string[] = [];
  if (byAxis.storage === 0) {
    gaps.push('存储轴：CMDB 未采集 Server/VM ↔ 存储卷挂载关系（logicalvolume / lnkservertovolume 为空），全部对象无存储轴');
  }
  if (netobs.length === 0) {
    gaps.push('网络轴：cipipe netobs 无观测数据（服务不可达或未采集）');
  }
  if (byAxis.network === 0 && netobs.length > 0) {
    gaps.push('网络轴：netobs 观测到的 IP 未匹配到 CMDB 对象（管理 IP 缺失或命名不一致）');
  }
  if (byAxis.os === 0) {
    gaps.push('运行层：本地 Zabbix 主机表未匹配到 OS 层（物理机命名不含硬件后缀？）');
  }

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalRaw: raw.length,
      total: nativeNodes.length,
      osNodes: nodeList.length - nativeNodes.length,
      dupCount,
      isolated: isolated.length,
      byAxis,
      byClass,
    },
    nodes: nodeList,
    edges,
    isolated,
    networkRoots,
    gaps,
  };
}

/** 极简模式：只返回统计与孤立清单（供看板首屏，避免传全量节点） */
export async function buildRelationSummary(includeDup = false) {
  const g = await buildRelationGraph(includeDup);
  return {
    generatedAt: g.generatedAt,
    stats: g.stats,
    networkRoots: g.networkRoots,
    gaps: g.gaps,
    isolatedSample: g.isolated.slice(0, 50),
    isolatedTotal: g.isolated.length,
  };
}
