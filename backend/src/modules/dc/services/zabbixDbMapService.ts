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

/**
 * 归一化 OS 节点名：剥离遗留「-数字」后缀。
 * 背景（2026-11-25 排查 obdb02 关联缺失）：部分旧 OS 主机可见名带机房编号尾巴
 * （svr-obdb02-197 → itops/iTop 行名 obdb02-197），与 BMC 硬件名后缀/ gv$instance
 * 的真实主机名（obdb02）不一致，导致派生链按名匹配断链。
 * 只剥「纯数字尾巴」（obdb02-197 → obdb02），不影响 zydb11 / mchrdb01 / rac-vip1 等。
 */
export function normalizeOsNodeName(name: string): string {
  return name.trim().replace(/-\d+$/, '');
}

/**
 * OS 节点命名匹配（2026-11-25 定稿规范）：
 * OS 层物理机可见名 = svr-<hostname>-<备注信息>（如 svr-obdb02-197、svr-ctdbdc01-BO）。
 * 匹配规则（rowName 为 OS 行名 / host 为真实主机名，均不区分大小写）：
 *   1. 完全相等（裸主机名行，旧世代）
 *   2. svr- 前缀剥离后：剩余段 === host 或以「host-」开头（备注信息）
 *   3. 兜底：剥离「-纯数字尾巴」后相等（obdb02-197 ↔ obdb02）
 */
export function osNameMatchesHost(rowName: string, host: string): boolean {
  const r = rowName.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  if (!r || !h) return false;
  if (r === h) return true;
  if (r.startsWith('svr-')) {
    const rem = r.slice(4);
    if (rem === h || rem.startsWith(h + '-')) return true;
  }
  return normalizeOsNodeName(r) === normalizeOsNodeName(h);
}

/** 找出「其 RAC 实例运行在指定 OS 节点上」的 DB 主机及实例清单 */
export async function findDbHostsByOsHost(osName: string): Promise<DbHostInstanceMap[]> {
  const maps = await fetchDbInstanceMaps();
  return maps
    .map(m => ({ ...m, instances: m.instances.filter(i => osNameMatchesHost(osName, i.host_name)) }))
    .filter(m => m.instances.length > 0);
}

/**
 * 反向：给定 iTop DBServer 名称，找出对应的 Zabbix DB 主机及其全部实例（跨节点）。
 * 优先按技术名（zhost，如 CPCNRTN ⊂ DB-ORA-10-CPCNRTN）；技术名与 CI 名无交集时
 * （如 OBCP ↔ DB-ORA-OBDB-ODBC）按可见名（zname）兜底匹配。
 */
export async function findDbHostsByDbServerName(dbServerName: string): Promise<DbHostInstanceMap[]> {
  const maps = await fetchDbInstanceMaps();
  const n = dbServerName.toLowerCase();
  return maps.filter(m => {
    const zh = m.zhost?.toLowerCase();
    const zn = m.zname?.toLowerCase();
    return (!!zh && n.includes(zh)) || (!!zn && n.includes(zn));
  });
}

/** 清缓存（测试用） */
export function clearDbMapCache(): void {
  cache = null;
}
