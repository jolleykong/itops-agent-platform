import axios, { type AxiosError, type CreateAxiosDefaults } from 'axios';
import { logger } from '../../../utils/logger';

/**
 * Elasticsearch HTTP API 客户端（日志查询）
 *
 * 面向"日志巡检/查询"场景的只读封装：
 *   - test()          连接测试（以一次 size=0 的聚合查询代替 GET /，兼容 viewer 只读角色）
 *   - listIndexFamilies() 索引族枚举（_index terms 聚合，绕过 _cat/indices 的 cluster monitor 要求）
 *   - search()        结构化日志查询（时间窗 + query_string + 级别/主机过滤 + 可选聚合）
 *   - rawSearch()     原生 DSL 透传（仅 _search，强制 size 上限与超时）
 *
 * 设计要点（与 prometheusService 保持一致）：
 *   1. 每次调用基于 opts 动态创建 axios 实例，不缓存长连接；
 *   2. 统一返回 { success, data?, error? }；
 *   3. 容量防护内置：size 上限、时间窗上限、请求超时——ES 端可能承载亿级文档（如 networklog）。
 */

export interface EsClientBasicAuth {
  username: string;
  password: string;
}

export interface EsClientOptions {
  url: string;
  basicAuth?: EsClientBasicAuth;
  timeoutMs?: number;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** 索引族统计（按名称前缀聚合） */
export interface EsIndexFamily {
  family: string;
  indexCount: number;
  docCount: number;
  latestIndex?: string;
}

/** 结构化日志查询参数 */
export interface EsSearchParams {
  index: string;
  queryString?: string;
  logLevel?: string[];
  hostName?: string;
  sid?: string;
  timeField?: string;
  rangeHours?: number;
  size?: number;
  /** 聚合维度：host=host.name, level=log_level, sid=oracle_sid */
  groupBy?: 'host' | 'level' | 'sid' | 'none';
}

/** search() 返回结构 */
export interface EsSearchResult {
  total: number;
  hits: Array<{
    index: string;
    timestamp?: string;
    host?: string;
    level?: string;
    sid?: string;
    message: string;
    source: Record<string, unknown>;
  }>;
  aggregations?: Record<string, Array<{ key: string; count: number }>>;
  tookMs: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const MAX_SIZE = 500;
const DEFAULT_SIZE = 50;
/** 时间窗上限 30 天（月级索引下更大窗口已无意义且昂贵） */
const MAX_RANGE_HOURS = 720;
const MAX_INDEX_FAMILIES = 200;

const INDEX_NAME_RE = /^[A-Za-z0-9._\-\*\+\,]+$/;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function buildAxiosConfig(opts: EsClientOptions): CreateAxiosDefaults {
  const timeout = Math.min(
    opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const config: CreateAxiosDefaults = {
    baseURL: normalizeBaseUrl(opts.url),
    timeout,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    validateStatus: () => true,
  };
  if (opts.basicAuth?.username) {
    config.auth = {
      username: opts.basicAuth.username,
      password: opts.basicAuth.password ?? '',
    };
  }
  return config;
}

function describeAxiosError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError;
    if (ax.code === 'ECONNABORTED') return `请求超时（${ax.config?.timeout ?? '?'}ms）`;
    if (ax.code === 'ENOTFOUND' || ax.code === 'EAI_AGAIN') return ax.message || 'DNS 解析失败';
    if (ax.code === 'ECONNREFUSED') return ax.message || '连接被拒绝';
    if (ax.code === 'ECONNRESET') return ax.message || '连接被重置';
    if (ax.response?.status === 401) return '认证失败（用户名或密码错误）';
    if (ax.response?.status === 403) {
      const reason =
        (ax.response.data as { error?: { reason?: string } } | undefined)?.error?.reason ?? '';
      return `权限不足（403）${reason ? `：${reason.slice(0, 200)}` : ''}`;
    }
    return ax.message || `HTTP 请求失败 (${ax.code ?? 'UNKNOWN'})`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** ES 错误响应体转可读信息 */
function describeEsResponseError(
  data: unknown,
  fallback: string,
): string {
  const d = data as { error?: { reason?: string; type?: string } } | undefined;
  if (d?.error?.reason) return `${d.error.type ?? 'ES Error'}: ${d.error.reason.slice(0, 300)}`;
  return fallback;
}

function validateIndexName(index: string): boolean {
  return INDEX_NAME_RE.test(index);
}

/** 索引名 → 索引族前缀（剥离 -YYYY.MM / -YYYY.MM.DD 日期后缀） */
function familyOf(name: string): string {
  return name.replace(/-\d{4}\.\d{2}(\.\d{2})?$/, '');
}

async function esPost<T>(
  opts: EsClientOptions,
  path: string,
  body?: Record<string, unknown>,
): Promise<ServiceResult<T>> {
  try {
    const res = await axios.post(path, body ?? {}, buildAxiosConfig(opts));
    if (res.status >= 200 && res.status < 300) {
      return { success: true, data: res.data as T };
    }
    return {
      success: false,
      error: describeEsResponseError(res.data, `ES 请求失败（HTTP ${res.status}）`),
    };
  } catch (err) {
    logger.error('[elasticsearchService] request failed:', err);
    return { success: false, error: describeAxiosError(err) };
  }
}

/**
 * 连接测试：执行一次 size=0 的 _index 聚合。
 * 不用 GET /（viewer 角色缺 cluster monitor 会 403），搜索聚合即可证明连通+认证+可读。
 */
export async function test(
  opts: EsClientOptions,
): Promise<ServiceResult<{ totalDocs: number; indexFamilies: number }>> {
  const body = {
    size: 0,
    aggs: { idx: { terms: { field: '_index', size: 50 } } },
  };
  const result = await esPost<{
    hits: { total: { value: number } };
    aggregations: { idx: { buckets: Array<{ key: string; doc_count: number }> } };
  }>(opts, '/_search', body);
  if (!result.success || !result.data) return result as ServiceResult<{ totalDocs: number; indexFamilies: number }>;
  const families = new Set(result.data.aggregations.idx.buckets.map((b) => familyOf(b.key)));
  return {
    success: true,
    data: {
      totalDocs: result.data.hits.total.value,
      indexFamilies: families.size,
    },
  };
}

/** 索引族枚举：_index terms 聚合后按前缀分组 */
export async function listIndexFamilies(
  opts: EsClientOptions,
): Promise<ServiceResult<EsIndexFamily[]>> {
  const body = {
    size: 0,
    aggs: { idx: { terms: { field: '_index', size: MAX_INDEX_FAMILIES } } },
  };
  const result = await esPost<{
    aggregations: { idx: { buckets: Array<{ key: string; doc_count: number }> } };
  }>(opts, '/_search', body);
  if (!result.success || !result.data) return { success: false, error: result.error };

  const map = new Map<string, { count: number; docCount: number; latest?: string }>();
  for (const b of result.data.aggregations.idx.buckets) {
    const family = familyOf(b.key);
    const entry = map.get(family) ?? { count: 0, docCount: 0, latest: b.key };
    entry.count += 1;
    entry.docCount += b.doc_count;
    if (b.key > (entry.latest ?? '')) entry.latest = b.key;
    map.set(family, entry);
  }
  const families: EsIndexFamily[] = [...map.entries()]
    .map(([family, e]) => ({ family, indexCount: e.count, docCount: e.docCount, latestIndex: e.latest }))
    .sort((a, b) => b.docCount - a.docCount);
  return { success: true, data: families };
}

/** 按聚合维度取字段名 */
function aggFieldFor(groupBy: NonNullable<EsSearchParams['groupBy']>): string | null {
  switch (groupBy) {
    case 'host':
      return 'host.name.keyword';
    case 'level':
      return 'log_level.keyword';
    case 'sid':
      return 'oracle_sid.keyword';
    default:
      return null;
  }
}

/** 结构化日志查询 */
export async function search(
  opts: EsClientOptions,
  params: EsSearchParams,
): Promise<ServiceResult<EsSearchResult>> {
  if (!validateIndexName(params.index)) {
    return { success: false, error: '索引名包含非法字符' };
  }
  const size = Math.min(Math.max(params.size ?? DEFAULT_SIZE, 1), MAX_SIZE);
  const rangeHours = Math.min(Math.max(params.rangeHours ?? 24, 1), MAX_RANGE_HOURS);
  const timeField = params.timeField && params.timeField.length > 0 ? params.timeField : '@timestamp';

  const must: Array<Record<string, unknown>> = [];
  if (params.queryString && params.queryString.trim().length > 0) {
    must.push({ query_string: { query: params.queryString.trim() } });
  }
  const filter: Array<Record<string, unknown>> = [
    { range: { [timeField]: { gte: `now-${rangeHours}h` } } },
  ];
  if (params.logLevel && params.logLevel.length > 0) {
    filter.push({ terms: { 'log_level.keyword': params.logLevel } });
  }
  if (params.hostName && params.hostName.trim().length > 0) {
    filter.push({ term: { 'host.name.keyword': params.hostName.trim() } });
  }
  if (params.sid && params.sid.trim().length > 0) {
    filter.push({ term: { 'oracle_sid.keyword': params.sid.trim() } });
  }

  const body: Record<string, unknown> = {
    size,
    sort: [{ [timeField]: { order: 'desc', unmapped_type: 'date' } }],
    query: { bool: { must, filter } },
    track_total_hits: true,
  };

  const aggField = params.groupBy ? aggFieldFor(params.groupBy) : null;
  if (aggField) {
    body.aggs = { group: { terms: { field: aggField, size: 50 } } };
  }

  const result = await esPost<{
    took: number;
    hits: {
      total: { value: number };
      hits: Array<{ _index: string; _source: Record<string, unknown> }>;
    };
    aggregations?: { group: { buckets: Array<{ key: string; doc_count: number }> } };
  }>(opts, `/${params.index}/_search`, body);
  if (!result.success || !result.data) return { success: false, error: result.error };

  const d = result.data;
  const hits = d.hits.hits.map((h) => {
    const s = h._source;
    const host = (s.host as { name?: string; hostname?: string } | undefined)?.name ??
      (s.host as { hostname?: string } | undefined)?.hostname;
    const message = typeof s.message === 'string' ? s.message : JSON.stringify(s);
    return {
      index: h._index,
      timestamp: s['@timestamp'] as string | undefined,
      host,
      level: (s.log_level as string | undefined) ?? (s.LOG_LEVEL as string | undefined),
      sid: s.oracle_sid as string | undefined,
      message: message.slice(0, 2000),
      source: s,
    };
  });

  const aggregations: Record<string, Array<{ key: string; count: number }>> | undefined =
    d.aggregations
      ? {
          group: d.aggregations.group.buckets.map((b) => ({ key: b.key, count: b.doc_count })),
        }
      : undefined;

  return {
    success: true,
    data: {
      total: d.hits.total.value,
      hits,
      aggregations,
      tookMs: d.took,
    },
  };
}

/** 原生 DSL 透传（仅 _search；size 强制上限；防误用：拒绝删除/写入类操作路径） */
export async function rawSearch(
  opts: EsClientOptions,
  index: string,
  dsl: Record<string, unknown>,
): Promise<ServiceResult<Record<string, unknown>>> {
  if (!validateIndexName(index)) {
    return { success: false, error: '索引名包含非法字符' };
  }
  // 容量防护：覆盖调用方的 size
  const safeDsl = {
    ...dsl,
    size: Math.min(typeof dsl.size === 'number' && dsl.size > 0 ? dsl.size : DEFAULT_SIZE, MAX_SIZE),
    track_total_hits: true,
  };
  return esPost<Record<string, unknown>>(opts, `/${index}/_search`, safeDsl);
}
