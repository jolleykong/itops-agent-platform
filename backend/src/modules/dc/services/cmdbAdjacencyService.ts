/**
 * cmdbAdjacencyService — 从 iTop CMDB 读取网络邻接（消费端唯一数据源）
 *
 * 架构定位（2026-11-28 用户定调「aiops 只能且必须只从 iTop 消费」）：
 *   网络邻接的**采集与裁决在 cipipe**，结果写入 iTop 的
 *   `lnkConnectableCIToNetworkDevice`；aiops 只读 iTop，不再直连 cipipe。
 *
 *   写入方（cipipe）：
 *     · netadj cdp  —— CDP 双向确认的交换机互联（ND↔ND）
 *     · netadj push —— ARP 裁决的终端接入（仅 ConnectableCI）
 *     · fdb         —— FDB 定位的物理接入端口（MAC 表 → 端口）
 *
 * 语义（已核实 iTop 数据模型）：
 *   NetworkDevice 本身属于 ConnectableCI，所以同一个关联类同时表达两件事：
 *     connectableci_id = 下游，networkdevice_id = 上游
 *     · 下游是 ND      → 交换机互联（本机作为上游时，connectableci 是它的下联）
 *     · 下游是非 ND    → 终端设备接入该交换机
 *
 * 层级：无上联者为层 0（核心/出口），逐跳递增。递归防环（最多 6 跳）。
 */
import { logger } from '../../../utils/logger';
import { itopClient } from '../../cmdb-sync/services/itopClient';
/** 链路节点（与 ciChainService 的 CiChainNode 同形，此处内联避免循环依赖） */
export interface CmdbChainNode {
  class: string;
  name: string;
  /** 与父节点的关系说明（CiChainNode 里是必填，这里保持一致避免映射时丢字段） */
  relation: string;
  extra?: string;
  ip?: string;
}

const LNK = 'lnkConnectableCIToNetworkDevice';
const MAX_HOP = 6;

let _cache: { at: number; graph: CmdbNdGraph } | null = null;
const CACHE_MS = 60_000;

export interface CmdbNdNode {
  id: number;
  name: string;
  layer?: number;
}

export interface CmdbNdEdge {
  /** 下游（ConnectableCI）id */
  downId: number;
  /** 上游（NetworkDevice）id */
  upId: number;
  /** 端口描述（cipipe 写入，形如 "Gi2/0/3" 或 "CDP: A -> B"） */
  port: string;
}

export interface CmdbNdGraph {
  nodes: Map<number, CmdbNdNode>;
  edges: CmdbNdEdge[];
  /** ND id → 上联 ND id 列表 */
  upstream: Map<number, number[]>;
  /** ND id → 下联 ND id 列表 */
  downstream: Map<number, number[]>;
  /** ND id → 接入的终端（名称 + 端口） */
  attached: Map<number, { name: string; port: string }[]>;
  /** 名称（多为管理 IP）→ ND id */
  byName: Map<string, number>;
}

interface RawLnk {
  downId: number;
  downName: string;
  downClass: string;
  upId: number;
  upName: string;
  port: string;
}

/** 一次性拉全量邻接与 ND 名单，本地建图（iTop 不支持 join，分两次查最省）。 */
export async function cmdbNdGraph(force = false): Promise<CmdbNdGraph> {
  if (!force && _cache && Date.now() - _cache.at < CACHE_MS) {
    return _cache.graph;
  }

  const graph: CmdbNdGraph = {
    nodes: new Map(), edges: [], upstream: new Map(),
    downstream: new Map(), attached: new Map(), byName: new Map(),
  };

  // ① NetworkDevice 名单（拿 id ↔ name，name 多为管理 IP）
  try {
    const res = await itopClient.getObjects<Record<string, unknown>>(
      'NetworkDevice', 'SELECT NetworkDevice', 'name',
    );
    if (res.success && res.data) {
      for (const o of Object.values(res.data.objects)) {
        const id = Number(o.key);
        const name = String((o.fields as Record<string, unknown>).name ?? '').trim();
        if (!Number.isFinite(id) || !name) continue;
        graph.nodes.set(id, { id, name });
        graph.byName.set(name, id);
      }
    }
  } catch (err) {
    logger.warn(`cmdbAdjacency: 拉 NetworkDevice 失败 ${(err as Error).message}`);
  }

  // ② 全量邻接
  const links: RawLnk[] = [];
  try {
    const res = await itopClient.getObjects<Record<string, unknown>>(
      LNK, `SELECT ${LNK}`,
      'connectableci_id,connectableci_id_friendlyname,' +
      'networkdevice_id,networkdevice_id_friendlyname,network_port',
    );
    if (res.success && res.data) {
      for (const o of Object.values(res.data.objects)) {
        const f = o.fields as Record<string, unknown>;
        const downId = Number(f.connectableci_id ?? 0);
        const upId = Number(f.networkdevice_id ?? 0);
        if (!downId || !upId) continue;
        links.push({
          downId,
          upId,
          downName: String(f.connectableci_id_friendlyname ?? '').trim(),
          // 下游的类拿不到（iTop 静默忽略 *_finalclass），靠 id 是否在 ND 名单判断
          downClass: graph.nodes.has(downId) ? 'NetworkDevice' : '',
          upName: String(f.networkdevice_id_friendlyname ?? '').trim(),
          port: String(f.network_port ?? '').trim(),
        });
      }
    }
  } catch (err) {
    logger.warn(`cmdbAdjacency: 拉邻接失败 ${(err as Error).message}`);
  }

  for (const l of links) {
    graph.edges.push({ downId: l.downId, upId: l.upId, port: l.port });
    if (graph.nodes.has(l.downId)) {
      // 下游也是交换机 → 交换机互联
      push(graph.downstream, l.upId, l.downId);
      push(graph.upstream, l.downId, l.upId);
    } else {
      // 下游是终端设备 → 接在该交换机上
      const arr = graph.attached.get(l.upId) ?? [];
      arr.push({ name: l.downName || `#${l.downId}`, port: l.port });
      graph.attached.set(l.upId, arr);
    }
  }

  // ③ 层级：无上联者 = 0
  for (const id of graph.nodes.keys()) resolveLayer(graph, id);

  logger.info(
    `cmdbAdjacency: ND ${graph.nodes.size}、邻接 ${links.length}、` +
    `有终端的交换机 ${graph.attached.size}`,
  );
  _cache = { at: Date.now(), graph };
  return graph;
}

function push(m: Map<number, number[]>, k: number, v: number) {
  const arr = m.get(k);
  if (arr) { if (!arr.includes(v)) arr.push(v); } else m.set(k, [v]);
}

function resolveLayer(g: CmdbNdGraph, id: number, seen = new Set<number>()): number {
  const n = g.nodes.get(id);
  if (!n) return 0;
  if (n.layer !== undefined) return n.layer;
  if (seen.has(id)) { n.layer = 0; return 0; }   // 防环
  seen.add(id);
  const ups = g.upstream.get(id) ?? [];
  n.layer = ups.length === 0 ? 0 : 1 + Math.max(...ups.map(u => resolveLayer(g, u, seen)));
  return n.layer;
}

/** 交换机上联链：返回从近到远的上级交换机节点；core=true 表示自身即层 0。 */
export async function cmdbUplinkChain(ipOrName: string): Promise<{
  chain: CmdbChainNode[];
  core: boolean;
}> {
  const g = await cmdbNdGraph();
  const id = g.byName.get(ipOrName.trim());
  if (!id) return { chain: [], core: false };
  const self = g.nodes.get(id);
  if ((self?.layer ?? 0) === 0) return { chain: [], core: true };

  const chain: CmdbChainNode[] = [];
  let cur = id;
  const seen = new Set<number>([id]);
  for (let hop = 0; hop < MAX_HOP; hop++) {
    const ups = g.upstream.get(cur) ?? [];
    const next = ups.find(u => !seen.has(u));
    if (next === undefined) break;
    seen.add(next);
    const n = g.nodes.get(next);
    if (!n) break;
    chain.push({
      class: 'NetworkDevice',
      name: n.name,
      relation: `上联交换机（L${n.layer ?? 0}）`,
      extra: `网络层级 L${n.layer ?? 0}`,
    });
    cur = next;
    if ((n.layer ?? 0) === 0) break;
  }
  return { chain, core: false };
}

/** 某交换机的全部邻接：下联交换机 / 上联交换机 / 接入的终端。 */
export async function cmdbNdNeighbors(ipOrName: string): Promise<{
  self?: CmdbNdNode;
  upstream: CmdbNdNode[];
  downstream: CmdbNdNode[];
  attached: { name: string; port: string }[];
}> {
  const g = await cmdbNdGraph();
  const id = g.byName.get(ipOrName.trim());
  if (!id) return { upstream: [], downstream: [], attached: [] };
  const pick = (ids: number[] = []) =>
    ids.map(i => g.nodes.get(i)).filter((n): n is CmdbNdNode => !!n);
  return {
    self: g.nodes.get(id),
    upstream: pick(g.upstream.get(id)),
    downstream: pick(g.downstream.get(id)),
    attached: g.attached.get(id) ?? [],
  };
}
