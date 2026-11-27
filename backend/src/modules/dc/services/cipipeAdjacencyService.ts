/**
 * cipipeAdjacencyService — 从 cipipe 治理层拉取 ARP 网络邻接观测
 *
 * cipipe netobs 是「写入 DB 前的治理层」产物：交换机（source_host，= iTop
 * NetworkDevice 的管理 IP 名）在端口（ifname）上观测到的 VLAN（vid）与
 * 对端 IP/MAC，并已按「计算层优先」规则完成 IP→CI 裁决
 * （match_kind=unique/dedup 时 ci_class/ci_name 可用；conflict/none 留人工）。
 *
 * 架构纪律（2026-11-27 总纲）：消费端只读 —— aiops 走 cipipe HTTP 服务接口，
 * 不直连治理库（cipipe_* 表），不产生任何写入。
 */
import { logger } from '../../../utils/logger';

/** cipipe 管理页/服务地址（宿主映射端口；容器内经宿主 IP 访问） */
const BASE_URL = process.env.CIPPIPE_API_URL || 'http://10.0.1.116:18081';

export interface NetobsRow {
  source_host: string;
  ifname: string;
  vid: string;
  ip: string;
  mac: string;
  observed_at?: string;
  match_kind: string;
  ci_class: string | null;
  ci_id: string | null;
  ci_name: string | null;
}

/** 拉取某台交换机的全部邻接观测（cipipe 侧已完成裁决；失败静默为空，不拖垮链路） */
export async function fetchNetobsByHost(sourceHost: string): Promise<NetobsRow[]> {
  const url = `${BASE_URL}/netobs/observations?source_host=${encodeURIComponent(sourceHost)}&limit=2000`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { ok?: boolean; items?: NetobsRow[] };
    return Array.isArray(j.items) ? j.items : [];
  } catch (err) {
    logger.warn(`cipipe netobs fetch failed for ${sourceHost}: ${(err as Error).message}`);
    return [];
  }
}

/** 按 ifname 分组（保持出现顺序） */
export function groupByIfname(rows: NetobsRow[]): Map<string, NetobsRow[]> {
  const m = new Map<string, NetobsRow[]>();
  for (const r of rows) {
    const list = m.get(r.ifname);
    if (list) list.push(r); else m.set(r.ifname, [r]);
  }
  return m;
}

/** 按 vid 分组（仅非空 vid；VLAN 接口自身行 vid=自身 tag） */
export function groupByVid(rows: NetobsRow[]): Map<string, NetobsRow[]> {
  const m = new Map<string, NetobsRow[]>();
  for (const r of rows) {
    if (!r.vid) continue;
    const list = m.get(r.vid);
    if (list) list.push(r); else m.set(r.vid, [r]);
  }
  return m;
}
