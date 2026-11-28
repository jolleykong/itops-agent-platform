/**
 * ciRelationGraphService — CMDB 全量 CI 关系图（一次构建，供「资源工作台」全量展开）
 *
 * 与 ciChainService 的分工：
 *   ciChainService  逐台展开（点击一个节点→查它的上下级），实时、精确、可递归；
 *   ciRelationGraph 全量展开（一次拿全部 CI 及其关系边），用于看板全景浏览、
 *                   按轴/按类筛选、孤立识别、关系统计与拓扑画布。
 *
 * 2026-11-28 治理第一批（本次改造）：
 *   ① 关联方式改为**数字外键精确 join**（relationRegistry.idField），
 *      友好名仅在数字外键缺失时兜底，且降级次数计入 stats.nameFallback，
 *      让"还在靠文本匹配"始终可见；
 *   ② 过滤/命名规则统一取自 ciFilters（不再本地复制正则）；
 *   ③ 每条边标注 origin（数据来源）与 exact（是否精确关联）：
 *        itop     = CMDB 权威关联（数字外键）
 *        observed = cipipe 网络观测（未经 CMDB 确认，可能多源）
 *        topology = CDP 拓扑采集
 *        local    = 本地 Zabbix 主机表匹配
 *      —— 观测态不再与 CMDB 权威关系混为一谈。
 *
 * 数据来源与纪律（架构定位总纲 P1–P5）：
 *   · iTop 走 REST/OQL 按类批量拉（每类 1 次请求），不直连 iTop 库；
 *   · 网络邻接读 iTop lnkConnectableCIToNetworkDevice（cipipe netadj 已把裁决结果写入 CMDB）；
 *   · aiops **不直连 cipipe**，观测态数据不经 CMDB 不进图（架构定位总纲 P3）；
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
import { osNameMatchesHost } from './zabbixDbMapService';
import db from '../../../models/database';
import {
  fieldNum,
  fieldStr,
  hardwareOsSuffix,
  isBandManagementName,
  isDupResidue,
  isHiddenFromChain,
  isPlaceholderName,
  parseObjectId,
  type RelAxis,
} from './ciFilters';
import { AXIS_META, fieldsForClass, parentRulesFor } from './relationRegistry';
import { logger } from '../../../utils/logger';

export type { RelAxis };

// ============================================================
// 类型
// ============================================================

/** 边的数据来源 / 可信度 */
export type EdgeOrigin = 'itop' | 'observed' | 'topology' | 'local';

export interface RelNode {
  /** 全局唯一键：`<class>:<name>` */
  key: string;
  /** iTop 数字对象 id（虚拟类 OsHost 无） */
  id?: number;
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
  /** 上级各轴的最近一跳名称（便于表格直接显示归属） */
  dims: { network?: string; host?: string; storage?: string };
  /** 网络轴：观测到本机的交换机数量（>1 表示多源观测，接入点不唯一） */
  netObserverCount?: number;
  /** 网络轴层级：交换机为 CDP 层级（0=核心/出口）；终端设备为其接入交换机层级+1 */
  netLayer?: number;
  /**
   * 网络位置推导（**不建边**，仅展示）：
   * VirtualMachine 是 VirtualDevice，物理上没有「接在哪个交换机端口」这条边，
   * iTop 拒绝是模型正确。虚机的网络可达性经宿主链推导：
   *   VM → Hypervisor → Server → 接入交换机
   */
  netVia?: { host: string; switchName?: string; port?: string };
}

export interface RelEdge {
  from: string;
  to: string;
  axis: RelAxis;
  relation: string;
  /** 数据来源：itop=CMDB 权威；observed=网络观测；topology=CDP；local=本地库 */
  origin: EdgeOrigin;
  /** 是否由数字外键精确解析（false = 友好名降级匹配） */
  exact: boolean;
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
  /** 数字外键精确解析的关系数（治理指标：越高越好） */
  idJoin: number;
  /** 友好名降级兜底的关系数（治理指标：应逐步归零） */
  nameFallback: number;
  /** 多源观测的机器数（网络接入点不唯一） */
  multiSourceHosts: number;
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

/** 全量展开需要拉取的类（Server/VM/HV/DB/网络/存储 + 机柜 + 电源） */
const GRAPH_CLASSES = [
  'Server',
  'Hypervisor',
  'VirtualMachine',
  'DBServer',
  'NetworkDevice',
  'StorageSystem',
  'Rack',
  'PDU',
  'UPS',
] as const;

interface RawCi {
  class: string;
  id?: number;
  name: string;
  ip?: string;
  status?: string;
  fields: Record<string, unknown>;
}

/** 按类批量拉 iTop 全量对象（失败静默跳过该类，不拖垮整图） */
async function fetchAllCi(): Promise<RawCi[]> {
  const out: RawCi[] = [];
  for (const cls of GRAPH_CLASSES) {
    try {
      const res = await itopClient.getObjects<Record<string, unknown>>(
        cls, `SELECT ${cls}`, fieldsForClass(cls),
      );
      if (!res.success || !res.data) {
        logger.warn(`ciRelationGraph: 拉取 ${cls} 失败 ${res.error ?? ''}`);
        continue;
      }
      for (const [objKey, entry] of Object.entries(res.data.objects)) {
        const name = fieldStr(entry.fields, 'name') ?? String(entry.key);
        out.push({
          class: entry.class || cls,
          id: parseObjectId(entry.key) ?? parseObjectId(objKey),
          name,
          ip: fieldStr(entry.fields, 'managementip'),
          status: fieldStr(entry.fields, 'status'),
          fields: entry.fields,
        });
      }
      logger.info(`ciRelationGraph: ${cls} ${res.data.count} 条`);
    } catch (err) {
      logger.warn(`ciRelationGraph: 拉取 ${cls} 异常 ${(err as Error).message}`);
    }
  }
  return out;
}

export function nodeKey(cls: string, name: string): string {
  return `${cls}:${name}`;
}

/** 结果缓存：全量建图涉及 9 类 iTop 查询 + cipipe 全量拉取，命中即秒开 */
interface GraphCache {
  at: number;
  dup: boolean;
  graph: RelGraph;
}
let cache: GraphCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 清空缓存（治理动作后可主动失效） */
export function invalidateRelationGraph(): void {
  cache = null;
}

// ============================================================
// 网络邻接：**只读 CMDB**（架构定位总纲 P3）
// ============================================================
//
// 2026-11-28 用户定则：治理在 cipipe 完成，规范化结果落 CMDB，aiops 只消费 CMDB。
// 此前网络轴直接读 cipipe netobs 观测表，属架构违规（观测态绕过 CMDB 进展示层）。
// 现在改为读 iTop 的 lnkConnectableCIToNetworkDevice —— 由 cipipe `netadj push`
// 把已裁决邻接写入；CMDB 里没有的关系，界面就不再出现。
//
// 已知边界：iTop 该关联类只接受 ConnectableCI（物理机/存储等），虚机/宿主的
// 网络邻接无法用原生类表达，因此不进 CMDB（消费端也不画）。

interface ItopAdjacency {
  /** connectableci 的 iTop 数字 id（本端，下游） */
  ciId: number;
  /** networkdevice 的 iTop 数字 id（对端，上游） */
  ndId: number;
  /** NetworkDevice 名称（iTop 里多为管理 IP） */
  ndName: string;
  port: string;
}

/**
 * 拉取 CMDB 里的网络邻接（失败静默为空，不拖垮整图）。
 *
 * 注意：iTop 对 `connectableci_id_finalclass` 这类派生外部字段**静默忽略**
 * （不报错、也不返回），所以类的判定必须靠数字 id 在本地解析 —— 见主流程。
 */
async function fetchItopAdjacency(): Promise<ItopAdjacency[]> {
  try {
    const res = await itopClient.getObjects<Record<string, unknown>>(
      'lnkConnectableCIToNetworkDevice',
      'SELECT lnkConnectableCIToNetworkDevice',
      'connectableci_id,networkdevice_id,networkdevice_id_friendlyname,network_port',
    );
    if (!res.success || !res.data) {
      logger.warn(`ciRelationGraph: 拉取网络邻接失败 ${res.error ?? ''}`);
      return [];
    }
    const out: ItopAdjacency[] = [];
    for (const entry of Object.values(res.data.objects)) {
      const ciId = fieldNum(entry.fields, 'connectableci_id');
      const ndId = fieldNum(entry.fields, 'networkdevice_id');
      const ndName = fieldStr(entry.fields, 'networkdevice_id_friendlyname');
      if (!ciId || !ndId || !ndName) continue;
      out.push({ ciId, ndId, ndName, port: fieldStr(entry.fields, 'network_port') ?? '' });
    }
    logger.info(`ciRelationGraph: CMDB 网络邻接 ${out.length} 条`);
    return out;
  } catch (err) {
    logger.warn(`ciRelationGraph: 拉取网络邻接异常 ${(err as Error).message}`);
    return [];
  }
}

/**
 * 构建全量 CI 关系图。
 * @param includeDup 是否包含 __DUP_* / 弃用状态对象（默认剔除，仅统计里计数）
 * @param force      跳过缓存强制重建
 */
export async function buildRelationGraph(includeDup = false, force = false): Promise<RelGraph> {
  if (!force && cache && cache.dup === includeDup && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.graph;
  }
  const raw = await fetchAllCi();

  // ── 索引 ──
  /** 名称 → 节点键（友好名降级解析用） */
  const byName = new Map<string, string[]>();
  /** `<class>:<id>` → 节点键（数字外键精确解析用） */
  const byId = new Map<string, string>();
  /** 管理 IP → 节点键（网络轴按 IP 关联） */
  const ipToKeys = new Map<string, string[]>();

  for (const r of raw) {
    const k = nodeKey(r.class, r.name);
    const nameArr = byName.get(r.name);
    if (nameArr) nameArr.push(k); else byName.set(r.name, [k]);
    if (r.id != null) byId.set(`${r.class}:${r.id}`, k);
    if (r.ip) {
      const ipArr = ipToKeys.get(r.ip);
      if (ipArr) ipArr.push(k); else ipToKeys.set(r.ip, [k]);
    }
  }

  const dupCount = raw.filter(r => isDupResidue(r.name)).length;

  // ── 节点 ──
  const nodes = new Map<string, RelNode>();
  /** 被剔除的占位对象键（代表「未关联」，用于缺口统计） */
  const placeholderKeys = new Set<string>();
  for (const r of raw) {
    if (isHiddenFromChain(r.name, r.status, includeDup)) continue;
    // 占位对象（ZBX-*-Unassigned）代表「未关联」，是 iTop 里的真实对象但**不是**
    // 有效的关系端点——把它放进图里会让看板显示「实例已归属」，实为数据缺口。
    // 剔除后，指向它的边因 nodes.has 校验自动丢弃（数字外键命中也不例外）。
    if (isPlaceholderName(r.name)) {
      placeholderKeys.add(nodeKey(r.class, r.name));
      continue;
    }
    const key = nodeKey(r.class, r.name);
    nodes.set(key, {
      key, id: r.id, class: r.class, name: r.name, ip: r.ip, status: r.status,
      dup: isDupResidue(r.name), children: 0, parents: 0, axes: [], dims: {},
    });
  }

  // ── 边集合 ──
  const edges: RelEdge[] = [];
  const edgeSeen = new Set<string>();
  /** 加边；返回是否真的加入（便于精确统计 idJoin / nameFallback） */
  const addEdge = (
    fromKey: string, toKey: string, axis: RelAxis,
    relation: string, origin: EdgeOrigin, exact: boolean,
  ): boolean => {
    if (!nodes.has(fromKey) || !nodes.has(toKey)) return false;
    if (fromKey === toKey) return false;
    const sig = `${fromKey}|${toKey}|${axis}`;
    if (edgeSeen.has(sig)) return false;
    edgeSeen.add(sig);
    edges.push({ from: fromKey, to: toKey, axis, relation, origin, exact });
    return true;
  };

  let idJoin = 0;
  let nameFallback = 0;
  /** 因目标为占位宿主而未建立的关系（= 未关联的真实缺口），按本端类计数 */
  const unlinkedByClass: Record<string, number> = {};

  /** 友好名 → 目标节点键（降级路径，忽略占位符） */
  const resolveByName = (name: string | undefined, prefer: string[]): string | undefined => {
    if (!name || isPlaceholderName(name)) return undefined;
    const cands = byName.get(name);
    if (!cands) return undefined;
    for (const cls of prefer) {
      const hit = cands.find(k => k.startsWith(`${cls}:`) && nodes.has(k));
      if (hit) return hit;
    }
    return cands.find(k => nodes.has(k));
  };

  // ── iTop 原生上级关系：走 relationRegistry，数字外键优先 ──
  for (const r of raw) {
    if (isHiddenFromChain(r.name, r.status, includeDup)) continue;
    const selfKey = nodeKey(r.class, r.name);
    for (const rule of parentRulesFor(r.class)) {
      // ① 数字外键精确解析
      const pid = fieldNum(r.fields, rule.idField);
      if (pid) {
        let hit: string | undefined;
        let hitPlaceholder = false;
        for (const cls of rule.toClasses) {
          const k = byId.get(`${cls}:${pid}`);
          if (!k) continue;
          if (placeholderKeys.has(k)) { hitPlaceholder = true; hit = undefined; break; }
          if (nodes.has(k)) { hit = k; break; }
        }
        if (hit) {
          if (addEdge(selfKey, hit, rule.axis, rule.relation, 'itop', true)) idJoin += 1;
          continue;
        }
        if (hitPlaceholder) {
          // 指向占位宿主：实例确实未关联，记为缺口而非关系（也不再走降级）
          unlinkedByClass[r.class] = (unlinkedByClass[r.class] ?? 0) + 1;
          continue;
        }
      }
      // ② 降级：友好名文本
      const nm = fieldStr(r.fields, rule.nameField);
      const fb = resolveByName(nm, rule.toClasses);
      if (fb) {
        if (addEdge(selfKey, fb, rule.axis, rule.relation, 'itop', false)) nameFallback += 1;
      }
    }
  }
  if (nameFallback > 0) {
    logger.warn(`ciRelationGraph: 友好名降级匹配 ${nameFallback} 条（数字外键缺失，建议治理）`);
  }

  // ── 网络轴：只读 CMDB（lnkConnectableCIToNetworkDevice，由 cipipe netadj 写入）──
  const adjacency = await fetchItopAdjacency();

  /** 交换机名称/管理 IP → NetworkDevice 键 */
  const ndByIp = new Map<string, string>();
  for (const r of raw) {
    if (r.class !== 'NetworkDevice') continue;
    const k = nodeKey(r.class, r.name);
    if (!nodes.has(k)) continue;
    if (r.ip) ndByIp.set(r.ip, k);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(r.name)) ndByIp.set(r.name, k);
    ndByIp.set(r.name, k);
  }

  /** 主机 → 观测到它的交换机集合（仅用于展示「多源」，关系本身取自 CMDB） */
  const hostSwitches = new Map<string, Set<string>>();
  /** 交换机 → 上级交换机（CMDB 里的 ND↔ND 边，来自 CDP 双向确认） */
  const ndUpstream = new Map<string, string[]>();

  for (const a of adjacency) {
    // connectableci 的类在本地按 id 解析（iTop 不返回 *_finalclass 派生字段）
    const fromKey = byId.get(`Server:${a.ciId}`)
      ?? byId.get(`NetworkDevice:${a.ciId}`)
      ?? byId.get(`StorageSystem:${a.ciId}`)
      ?? byId.get(`PDU:${a.ciId}`)
      ?? byId.get(`UPS:${a.ciId}`);
    if (!fromKey || !nodes.has(fromKey)) continue;
    const swKey = ndByIp.get(a.ndName)
      ?? byName.get(a.ndName)?.find(k => k.startsWith('NetworkDevice:') && nodes.has(k));
    if (!swKey) continue;

    // connectableci 是 NetworkDevice → 交换机互联（CDP 已推入 CMDB）
    // 这说明 iTop 的 ConnectableCI 语义覆盖了 ND：物理链路只存这一层。
    if (fromKey.startsWith('NetworkDevice:')) {
      if (fromKey === swKey) continue;
      const arr = ndUpstream.get(fromKey);
      if (arr) arr.push(swKey); else ndUpstream.set(fromKey, [swKey]);
      addEdge(fromKey, swKey, 'network',
        a.port ? `上联交换机（${a.port}）` : '上联交换机', 'itop', true);
      continue;
    }

    // 其余为终端接入边（Server/Storage 等 ConnectableCI）
    const s = hostSwitches.get(fromKey);
    if (s) s.add(swKey); else hostSwitches.set(fromKey, new Set([swKey]));
    addEdge(fromKey, swKey, 'network',
      a.port ? `接入交换机（${a.port}）` : '接入交换机', 'itop', true);
  }
  let multiSourceHosts = 0;
  for (const [hostKey, sws] of hostSwitches) {
    if (sws.size > 1) multiSourceHosts += 1;
    const n = nodes.get(hostKey);
    if (n) n.netObserverCount = sws.size;
  }

  // 交换机层级：沿 ND↔ND 边向上，无上游者为核心/出口（layer 0）
  const ndLayer = new Map<string, number>();
  const resolveNdLayer = (key: string, seen = new Set<string>()): number => {
    const cached = ndLayer.get(key);
    if (cached !== undefined) return cached;
    if (seen.has(key)) return 0;
    seen.add(key);
    const ups = ndUpstream.get(key);
    const l = !ups || ups.length === 0 ? 0 : 1 + Math.max(...ups.map(u => resolveNdLayer(u, seen)));
    ndLayer.set(key, l);
    return l;
  };
  for (const key of nodes.keys()) {
    if (key.startsWith('NetworkDevice:')) resolveNdLayer(key);
  }
  // 终端设备的网络层级 = 接入交换机层级 + 1
  for (const [hostKey, sws] of hostSwitches) {
    const n = nodes.get(hostKey);
    if (!n) continue;
    const layers = [...sws].map(k => ndLayer.get(k)).filter((v): v is number => v !== undefined);
    if (layers.length) n.netLayer = Math.min(...layers) + 1;
  }
  for (const [k, l] of ndLayer) {
    const n = nodes.get(k);
    if (n) n.netLayer = l;
  }

  // ── 运行层（os 轴）：物理机 → 操作系统（本地 Zabbix 主机表）──
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

    for (const r of osRows) {
      const k = nodeKey('OsHost', r.name);
      if (nodes.has(k)) continue;
      nodes.set(k, {
        key: k, class: 'OsHost', name: r.name, ip: r.ip_address ?? undefined,
        status: undefined, dup: false, children: 0, parents: 0, axes: [], dims: {},
      });
    }

    for (const r of raw) {
      if (r.class !== 'Server') continue;
      if (isBandManagementName(r.name)) continue;
      const selfKey = nodeKey(r.class, r.name);
      if (!nodes.has(selfKey)) continue;
      const suffix = hardwareOsSuffix(r.name);
      if (!suffix) continue;
      for (const o of osRows) {
        if (!osNameMatchesHost(o.name, suffix) && !r.name.includes(`-${o.name}`)) continue;
        addEdge(selfKey, nodeKey('OsHost', o.name), 'os', '操作系统（Zabbix）', 'local', false);
      }
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
      if (e.axis === 'host' && !t.dims.host) t.dims.host = f?.name;
      if (e.axis === 'network' && !t.dims.network) t.dims.network = f?.name;
      if (e.axis === 'storage' && !t.dims.storage) t.dims.storage = f?.name;
    }
  }

  // ── 虚机网络位置推导（不建边）──
  // 模型依据：VirtualMachine 是 VirtualDevice（无物理端口），iTop 因此拒绝把它
  // 写成 lnkConnectableCIToNetworkDevice 的 connectableci —— 这是模型正确，不是缺陷。
  // 虚机的网络可达性只能经宿主链继承：VM → Hypervisor → Server → 接入交换机。
  // 这条推导也说明了「多维度拓扑」的意义：单轴断处可跨轴续接。
  const hostUp = new Map<string, string[]>();
  const netUp = new Map<string, { sw: string; port: string }[]>();
  for (const e of edges) {
    if (e.axis === 'host') {
      const arr = hostUp.get(e.from);
      if (arr) arr.push(e.to); else hostUp.set(e.from, [e.to]);
    }
    if (e.axis === 'network') {
      const arr = netUp.get(e.from);
      if (arr) arr.push({ sw: e.to, port: e.relation });
      else netUp.set(e.from, [{ sw: e.to, port: e.relation }]);
    }
  }
  for (const n of nodeList) {
    if (n.class !== 'VirtualMachine' || n.netLayer !== undefined) continue;
    const hvKey = hostUp.get(n.key)?.[0];
    if (!hvKey) continue;
    const hostKey = hostUp.get(hvKey)?.[0];
    if (!hostKey) continue;
    const sw = netUp.get(hostKey)?.[0];
    const hostNode = nodes.get(hostKey);
    n.netVia = {
      host: hostNode?.name ?? hostKey,
      switchName: sw ? nodes.get(sw.sw)?.name : undefined,
      port: sw?.port,
    };
    // 层级也继承宿主机（+1 表示经虚拟化一跳）
    if (hostNode?.netLayer !== undefined) n.netLayer = hostNode.netLayer + 1;
  }

  // ── 统计（OS 层是 Zabbix 主机虚拟类，不属 iTop CI，单独计量）──
  const nativeNodes = nodeList.filter(n => n.class !== 'OsHost');
  const byClass: Record<string, number> = {};
  for (const n of nativeNodes) byClass[n.class] = (byClass[n.class] ?? 0) + 1;

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

  // ── 网络轴根源聚合 ──
  const netParents = new Map<string, string[]>();
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

  // ── 数据缺口 ──
  const gaps: string[] = [];
  if (byAxis.storage === 0) {
    gaps.push(`${AXIS_META.storage.label}：CMDB 未采集 Server/VM ↔ 存储卷挂载关系（logicalvolume / lnkservertovolume 为空），全部对象无存储轴`);
  }
  if (adjacency.length === 0) {
    gaps.push('网络轴：CMDB 无网络邻接（lnkConnectableCIToNetworkDevice 为空）—— 需在 cipipe 执行 netadj push / netadj cdp');
  }
  if (byAxis.network > 0 && ndLayer.size > 0) {
    const layer0 = [...ndLayer.entries()].filter(([, l]) => l === 0).length;
    gaps.push(
      `网络轴：CMDB 交换机互联 ${ndUpstream.size} 台已建有上联；${layer0} 台无上联记录` +
      '（其中含真正的核心/出口，也含 CDP 尚未采集到的交换机——如需补全请扩采并重跑 netadj cdp）',
    );
  }
  if (byAxis.network === 0 && adjacency.length > 0) {
    gaps.push('网络轴：CMDB 邻接的主机未匹配到本次拉取的对象（如虚机邻接在 iTop 无对应关联类）');
  }
  if (byAxis.os === 0) {
    gaps.push('运行层：本地 Zabbix 主机表未匹配到 OS 层（物理机命名不含硬件后缀？）');
  }
  if (nameFallback > 0) {
    gaps.push(`关联质量：${nameFallback} 条关系靠友好名文本降级匹配（数字外键缺失），${idJoin} 条为精确外键`);
  }
  // 指向占位宿主 = 真实未关联（占位对象已从图中剔除，这里显式说明缺口规模）
  const unlinkedParts = Object.entries(unlinkedByClass)
    .map(([cls, n]) => `${cls} ${n} 个`)
    .join('、');
  if (unlinkedParts) {
    gaps.push(`未关联：${unlinkedParts}指向占位宿主（ZBX-*-Unassigned），已在图中省略 —— 这是 CMDB 关联缺口，需治理补全`);
  }

  const result: RelGraph = {
    generatedAt: new Date().toISOString(),
    stats: {
      totalRaw: raw.length,
      total: nativeNodes.length,
      osNodes: nodeList.length - nativeNodes.length,
      dupCount,
      isolated: isolated.length,
      byAxis,
      byClass,
      idJoin,
      nameFallback,
      multiSourceHosts,
    },
    nodes: nodeList,
    edges,
    isolated,
    networkRoots,
    gaps,
  };
  cache = { at: Date.now(), dup: includeDup, graph: result };
  return result;
}

/** 极简模式：只返回统计与孤立样例（供看板首屏，避免传全量节点） */
export async function buildRelationSummary(includeDup = false, force = false) {
  const g = await buildRelationGraph(includeDup, force);
  return {
    generatedAt: g.generatedAt,
    stats: g.stats,
    networkRoots: g.networkRoots,
    gaps: g.gaps,
    isolatedSample: g.isolated.slice(0, 50),
    isolatedTotal: g.isolated.length,
  };
}
