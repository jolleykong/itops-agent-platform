/**
 * zabbixDbMapService — 从 Zabbix 读取 Oracle DB 主机的 RAC 实例→节点映射
 *
 * 数据源（2026-11-25 落地）：
 *   1. gv_instance_map 项（Oracle by ODBC 模板，1h 采集）：
 *      db.odbc.get[gv_instance_map,…] → gv$instance 全集群实例清单
 *      值形如 [{"instance_name":"CPCNRTN1","host_name":"zydb11","instance_role":"PRIMARY_INSTANCE"},…]
 *   2. oracle.instance_hostname 项（模板依赖项）+ 主机资产「名称」字段：
 *      host.get selectInventory.name → v$instance 经 SCAN 路由的当前节点（会在集群节点间漂移）
 *
 * 消费方（ciChainService）：派生 DBServer ↔ OsHost（OS 层节点）的双向关联。
 * 不落库：每次按需拉取 + TTL 缓存，Zabbix 始终是监控侧事实源。
 */
import { zabbixConnectionStore } from '../../monitor/services/zabbixConnectionStore';
import { logger } from '../../../utils/logger';

export interface DbInstanceEntry {
  instance_name: string;
  host_name: string;
  instance_role?: string;
}

export interface DbHostInstanceMap {
  /** Zabbix DB 主机（host 技术名，如 CPCNRTN） */
  zhost: string;
  /** Zabbix 可见名（如 DB-ORA-10-CPCNRTN） */
  zname: string;
  instances: DbInstanceEntry[];
}

interface CacheEntry {
  at: number;
  maps: DbHostInstanceMap[];
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: CacheEntry | null = null;
let inflight: Promise<DbHostInstanceMap[]> | null = null;

/** 单次 Zabbix JSON-RPC 调用（token 优先，账号密码兜底 login） */
async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T | null> {
  const config = zabbixConnectionStore.get();
  if (!config) return null;
  const auth = await zabbixConnectionStore.resolveAuth(config);
  if (!auth) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 8000);
  try {
    const resp = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-rpc', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      signal: controller.signal,
    });
    const json = (await resp.json()) as { result?: T; error?: { message: string; data?: string } };
    if (json.error) {
      logger.warn(`zabbixDbMapService ${method} RPC error: ${json.error.message} ${json.error.data ?? ''}`);
      return null;
    }
    return json.result ?? null;
  } catch (err) {
    logger.warn(`zabbixDbMapService ${method} failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 解析 gv_instance_map 的 item lastvalue（JSON 数组文本），容错解析失败 */
function parseInstances(raw: string | undefined): DbInstanceEntry[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (e): e is DbInstanceEntry =>
          !!e && typeof e === 'object' && typeof (e as DbInstanceEntry).host_name === 'string' && typeof (e as DbInstanceEntry).instance_name === 'string',
      )
      .map(e => ({ instance_name: e.instance_name, host_name: e.host_name, instance_role: e.instance_role }));
  } catch {
    return [];
  }
}

/** 拉取所有 DB 主机的实例映射（带 TTL 缓存与并发去重；失败返回 [] 不抛错） */
export async function fetchDbInstanceMaps(): Promise<DbHostInstanceMap[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.maps;
  if (inflight) return inflight;

  inflight = (async () => {
    const rows = await rpc<Array<{ hostid: string; lastvalue: string; hosts?: Array<{ host: string; name: string }> }>>('item.get', {
      output: ['hostid', 'lastvalue'],
      search: { key_: 'gv_instance_map' },
      monitored: true,
      selectHosts: ['host', 'name'],
      limit: 500,
    });
    const maps: DbHostInstanceMap[] = [];
    if (rows) {
      for (const r of rows) {
        const h = r.hosts?.[0];
        if (!h) continue;
        const instances = parseInstances(r.lastvalue);
        if (instances.length === 0) continue;
        maps.push({ zhost: h.host, zname: h.name, instances });
      }
    }
    cache = { at: Date.now(), maps };
    if (maps.length > 0) logger.info(`zabbixDbMapService: ${maps.length} DB hosts with instance map loaded`);
    return maps;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 找出「其 RAC 实例运行在指定 OS 节点上」的 DB 主机及实例清单 */
export async function findDbHostsByOsHost(osName: string): Promise<DbHostInstanceMap[]> {
  const maps = await fetchDbInstanceMaps();
  const target = osName.toLowerCase();
  return maps
    .map(m => ({ ...m, instances: m.instances.filter(i => i.host_name.toLowerCase() === target) }))
    .filter(m => m.instances.length > 0);
}

/**
 * 反向：给定 iTop DBServer 名称（如 DB-ORA-10-CPCNRTN / 10-CPCNRTN），
 * 找出名称中包含的 Zabbix DB 主机及其全部实例（跨节点）。
 */
export async function findDbHostsByDbServerName(dbServerName: string): Promise<DbHostInstanceMap[]> {
  const maps = await fetchDbInstanceMaps();
  const n = dbServerName.toLowerCase();
  return maps.filter(m => n.includes(m.zhost.toLowerCase()));
}

/** 清缓存（测试用） */
export function clearDbMapCache(): void {
  cache = null;
}
