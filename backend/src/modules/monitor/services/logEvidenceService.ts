import { settingsRepository } from '../../../repositories/settingsRepository';
import { rawSearch } from './elasticsearchService';
import { elasticsearchConnectionStore } from './elasticsearchConnectionStore';
import { logger } from '../../../utils/logger';

/**
 * logEvidenceService — ES 日志证据层（零信任日志上下文）
 *
 * 统一回答：给定（主机名, 时间窗, 设备类别），返回该主机在此期间
 * "值得关注"的日志证据摘要（聚合统计 + 截断样本）。
 *
 * 设计文档：docs/es-log-evidence-design.md（2026-11-19 定稿）
 *
 * 容量铁律：
 *   1. 输出永远是聚合摘要 + 截断样本，绝不给 LLM 喂原始日志；
 *   2. 强制 host.name term + 时间窗双过滤（networklog 亿级文档）；
 *   3. 单次查询 timeout 默认 5s、样本 ≤ 20、任何异常静默降级
 *      （available:false），绝不阻塞告警/巡检主流程；
 *   4. 结果按 (host, window, category) 缓存 10 分钟，告警重跑不重复查询。
 *
 * 实证校准（2026-11-19，ES 10.240.22.33 实测）：
 *   - syslog-rsyslog-* 的 log_level 字段为坏模板变量（%{syslog_severity}），
 *     → OS 类级别过滤必须走消息模式匹配（query_string），不依赖 log_level；
 *   - oracle-* 的 log_level 正常（小写 error 等），host.name 与 server.hostname
 *     双字段并存，统一用 host.name.keyword；
 *   - 日志留存按 7 天评估（用户定稿），时间窗起点不得早于 now-7d。
 */

// ── 类型 ──────────────────────────────────────────────

export type DeviceCategory = 'os' | 'db' | 'network' | 'storage';

export interface LogEvidenceSummary {
  /** false = ES 未配置/不可用/零命中之外的失败，调用方静默降级 */
  available: boolean;
  reason?: string;
  hostName: string;
  category: DeviceCategory;
  index: string;
  window: { fromMs: number; toMs: number };
  totalHits: number;
  tookMs: number;
  levelStats: Array<{ key: string; count: number }>;
  patternStats: Array<{ pattern: string; count: number }>;
  samples: Array<{ timestamp?: string; level?: string; message: string }>;
}

// ── 配置（settings 可覆盖，均有默认值，无 schema 变更） ──

function settingStr(key: string, fallback: string): string {
  const v = settingsRepository.getValue(key);
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

function settingInt(key: string, fallback: number): number {
  const n = parseInt(settingStr(key, String(fallback)), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 日志留存天数（用户 2026-11-19 定稿先按 7 天，按需调整） */
function retentionDays(): number {
  return settingInt('ES_LOG_RETENTION_DAYS', 7);
}

/** 告警上下文时间窗：告警前 N 分钟 ~ 告警后 M 分钟 */
export function alarmWindowMinutes(): { before: number; after: number } {
  return {
    before: settingInt('ES_ALARM_WINDOW_BEFORE_MIN', 30),
    after: settingInt('ES_ALARM_WINDOW_AFTER_MIN', 10),
  };
}

/** 设备类别判定规则（hostname 子串匹配，小写比较；settings 存 JSON 数组） */
interface CategoryRule { pattern: string; category: DeviceCategory }

const DEFAULT_CATEGORY_RULES: CategoryRule[] = [
  { pattern: 'db', category: 'db' },
  { pattern: 'ora', category: 'db' },
];

export function classifyDevice(hostName: string): DeviceCategory {
  let rules = DEFAULT_CATEGORY_RULES;
  try {
    const raw = settingStr('ES_DEVICE_CATEGORY_RULES', '');
    if (raw) {
      const parsed = JSON.parse(raw) as CategoryRule[];
      if (Array.isArray(parsed) && parsed.length > 0) rules = parsed;
    }
  } catch {
    // 配置非法时用默认规则
  }
  const lower = hostName.toLowerCase();
  for (const r of rules) {
    if (r.pattern && lower.includes(r.pattern.toLowerCase())) return r.category;
  }
  return 'os';
}

// ── 类别 → 索引族与默认模式 ────────────────────────────

interface CategoryProfile {
  index: string;
  patterns: string[];
}

/**
 * 模式匹配基于实证：syslog 的 log_level 坏损，所有类别统一走消息模式。
 * 纯单词/星号模式不引号，含特殊字符的短语加引号（query_string 语法安全）。
 */
const CATEGORY_PROFILES: Record<DeviceCategory, CategoryProfile> = {
  os: {
    index: 'syslog-rsyslog-*',
    patterns: [
      'error', 'warn*', 'fatal', 'crit*', 'fail*',
      'denied', 'refused', 'segfault', 'out of memory',
    ],
  },
  db: {
    index: 'oracle-*',
    patterns: ['ORA-', 'TNS-', 'deadlock', 'checkpoint incomplete', 'instance terminated'],
  },
  network: {
    index: 'networklog-*',
    patterns: ['down', 'flap', 'reject', 'deny'],
  },
  storage: {
    index: 'backup',
    patterns: ['failed', 'abort'],
  },
};

/** 告警标题关键词 → 附加模式（去噪后最多 5 个） */
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'not', 'is', 'are', 'was', 'were',
  '的', '了', '在', '是', '告警', '报警', '异常', '问题', '服务器', '主机',
  'high', 'low', 'too', 'very', 'alert', 'alarm', 'warning', 'error', 'critical',
]);

export function patternsFromTitle(title: string): string[] {
  return [...new Set(
    title
      .split(/[^A-Za-z0-9_\-\u4e00-\u9fa5]+/)
      .filter(t => t.length >= 3 && t.length <= 40 && !TITLE_STOPWORDS.has(t.toLowerCase()))
      .map(t => t.toLowerCase()),
  )].slice(0, 5);
}

/** query_string 安全化：纯单词/星号直出，其余加引号 */
function toQueryStringTerm(pattern: string): string {
  if (/^[A-Za-z0-9*]+$/.test(pattern)) return pattern;
  return `"${pattern.replace(/"/g, '\\"')}"`;
}

// ── 缓存（容量铁律 4：每告警最多 1 次 ES 查询） ─────────

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const evidenceCache = new Map<string, { expires: number; value: LogEvidenceSummary }>();

function cacheKey(hostName: string, fromMs: number, toMs: number, category: DeviceCategory): string {
  return `${hostName}|${fromMs}|${toMs}|${category}`;
}

function cacheGet(key: string): LogEvidenceSummary | null {
  const hit = evidenceCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    evidenceCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: LogEvidenceSummary): void {
  if (evidenceCache.size >= CACHE_MAX) {
    // 淘汰最早过期的 20 条，避免逐条清理的开销
    const keys = [...evidenceCache.entries()]
      .sort((a, b) => a[1].expires - b[1].expires)
      .slice(0, 20);
    for (const [k] of keys) evidenceCache.delete(k);
  }
  evidenceCache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

// ── 主入口 ────────────────────────────────────────────

const MAX_SAMPLES = 20;
const MESSAGE_MAX_CHARS = 300;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 10000;

export interface LogEvidenceRequest {
  hostName: string;
  category?: DeviceCategory;
  /** 毫秒 epoch（窗口起点）；会被留存期钳制 */
  fromMs: number;
  toMs: number;
  /** 附加匹配模式（如告警标题关键词），与类别默认模式合并 */
  extraPatterns?: string[];
  maxSamples?: number;
  timeoutMs?: number;
}

/**
 * 获取主机日志证据摘要。任何失败都返回 available:false，绝不抛异常。
 */
export async function getLogEvidence(req: LogEvidenceRequest): Promise<LogEvidenceSummary> {
  const category = req.category ?? classifyDevice(req.hostName);
  const profile = CATEGORY_PROFILES[category];

  const base: LogEvidenceSummary = {
    available: false,
    hostName: req.hostName,
    category,
    index: profile.index,
    window: { fromMs: req.fromMs, toMs: req.toMs },
    totalHits: 0,
    tookMs: 0,
    levelStats: [],
    patternStats: [],
    samples: [],
  };

  try {
    const config = elasticsearchConnectionStore.get();
    if (!config) {
      return { ...base, reason: 'ES 未配置' };
    }

    // 时间窗钳制：起点不早于留存期，终点不晚于 now
    const now = Date.now();
    const retentionFloor = now - retentionDays() * 24 * 3600 * 1000;
    const fromMs = Math.max(req.fromMs, retentionFloor);
    const toMs = Math.min(req.toMs, now);
    if (fromMs >= toMs) {
      return { ...base, window: { fromMs, toMs }, reason: '时间窗为空（超出留存期）' };
    }
    const window = { fromMs, toMs };

    const key = cacheKey(req.hostName, fromMs, toMs, category);
    const cached = cacheGet(key);
    if (cached) return cached;

    // 模式合并：类别默认 + 附加，去重上限 12（防 query_string 过长）
    const patterns = [...new Set([...profile.patterns, ...(req.extraPatterns ?? [])])].slice(0, 12);
    const maxSamples = Math.min(Math.max(req.maxSamples ?? MAX_SAMPLES, 1), MAX_SAMPLES);
    const timeoutMs = Math.min(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const gte = new Date(fromMs).toISOString();
    const lte = new Date(toMs).toISOString();

    const filter: Array<Record<string, unknown>> = [
      { range: { '@timestamp': { gte, lte } } },
      { term: { 'host.name.keyword': req.hostName } },
    ];
    if (patterns.length > 0) {
      filter.push({
        bool: {
          should: patterns.map(p => ({ query_string: { query: toQueryStringTerm(p) } })),
          minimum_should_match: 1,
        },
      });
    }

    // filters 聚合：一次查询拿到每个模式的命中数（避免逐模式多查）
    const patternFilters: Record<string, unknown> = {};
    patterns.forEach((p, i) => {
      patternFilters[`p${i}`] = { query_string: { query: toQueryStringTerm(p) } };
    });

    const dsl: Record<string, unknown> = {
      size: maxSamples,
      track_total_hits: true,
      sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'date' } }],
      query: { bool: { filter } },
      aggs: {
        levels: { terms: { field: 'log_level.keyword', size: 10 } },
        ...(patterns.length > 0 ? { pats: { filters: { filters: patternFilters, other_bucket: false } } } : {}),
      },
    };

    const result = await rawSearch(
      { url: config.url, basicAuth: config.username ? { username: config.username, password: config.password ?? '' } : undefined, timeoutMs },
      profile.index,
      dsl,
    );
    if (!result.success || !result.data) {
      return { ...base, window, reason: result.error ?? 'ES 查询失败' };
    }

    const data = result.data as {
      took: number;
      hits: {
        total: { value: number };
        hits: Array<{ _source: Record<string, unknown> }>;
      };
      aggregations?: {
        levels?: { buckets: Array<{ key: string; doc_count: number }> };
        pats?: { buckets: Array<{ key: string; doc_count: number }> | Record<string, { doc_count: number }> };
      };
    };

    // filters 聚合带命名过滤器时返回对象（{p0:{doc_count}}），数组形态仅无名时出现——两者兼容
    const patsRaw = data.aggregations?.pats?.buckets;
    const patsEntries: Array<{ key: string; doc_count: number }> = Array.isArray(patsRaw)
      ? patsRaw
      : Object.entries(patsRaw ?? {}).map(([key, v]) => ({ key, doc_count: (v as { doc_count: number }).doc_count }));

    const summary: LogEvidenceSummary = {
      ...base,
      available: true,
      window,
      totalHits: data.hits.total.value,
      tookMs: data.took,
      levelStats: (data.aggregations?.levels?.buckets ?? []).map(b => ({ key: b.key, count: b.doc_count })),
      patternStats: patsEntries.map(b => ({
        pattern: patterns[parseInt(b.key.replace('p', ''), 10)] ?? b.key,
        count: b.doc_count,
      })),
      samples: data.hits.hits.map(h => {
        const s = h._source;
        const rawMsg = typeof s.message === 'string' ? s.message : JSON.stringify(s);
        return {
          timestamp: s['@timestamp'] as string | undefined,
          level: (s.log_level as string | undefined) ?? undefined,
          message: rawMsg.replace(/\s+/g, ' ').trim().substring(0, MESSAGE_MAX_CHARS),
        };
      }),
    };

    cacheSet(key, summary);
    logger.info(
      `📊 [logEvidence] ${req.hostName}(${category}) [${gte}~${lte}] hits=${summary.totalHits} patterns=${summary.patternStats.map(p => `${p.pattern}:${p.count}`).join(',')} took=${summary.tookMs}ms`,
    );
    return summary;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`⚠️ [logEvidence] 获取日志证据失败（静默降级）: ${msg}`);
    return { ...base, reason: msg };
  }
}

/**
 * 告警上下文专用入口：自动时间窗 + 标题关键词扩展 + 全局开关。
 * 供 RCA collectContext 调用；遵循告警链路 5s 超时预算。
 */
export async function getAlarmLogEvidence(input: {
  hostName: string;
  alertTitle: string;
  occurredAtMs: number;
}): Promise<LogEvidenceSummary> {
  if (settingStr('ES_LOG_EVIDENCE_ENABLED', 'true').toLowerCase() === 'false') {
    return {
      available: false,
      reason: 'ES 日志证据开关已关闭（ES_LOG_EVIDENCE_ENABLED=false）',
      hostName: input.hostName,
      category: classifyDevice(input.hostName),
      index: '',
      window: { fromMs: 0, toMs: 0 },
      totalHits: 0,
      tookMs: 0,
      levelStats: [],
      patternStats: [],
      samples: [],
    };
  }

  const { before, after } = alarmWindowMinutes();
  return getLogEvidence({
    hostName: input.hostName,
    fromMs: input.occurredAtMs - before * 60 * 1000,
    toMs: input.occurredAtMs + after * 60 * 1000,
    extraPatterns: patternsFromTitle(input.alertTitle),
  });
}
