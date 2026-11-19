import { useState, useCallback } from 'react';
import { FileSearch, Play, Plug, ChevronDown, ChevronUp } from 'lucide-react';
import { message } from 'antd';
import api from '../../../lib/api';
import { getAxiosErrorMessage } from '../../../lib/errorHandler';
import { logger } from '../../../lib/logger';

interface AuthConfig {
  url: string;
  username: string;
  password: string;
  timeoutMs: string;
}

interface IndexFamily {
  family: string;
  indexCount: number;
  docCount: number;
  latestIndex?: string;
}

interface SearchHit {
  index: string;
  timestamp?: string;
  host?: string;
  level?: string;
  sid?: string;
  message: string;
}

interface SearchResponse {
  total: number;
  hits: SearchHit[];
  aggregations?: { group: Array<{ key: string; count: number }> };
  tookMs: number;
}

const LEVELS = ['error', 'critical', 'warn', 'fatal', 'info', 'debug', 'trace'] as const;

/**
 * 响应归一：api 实例的响应拦截器已把 { success, data } 信封解包为内层 data，
 * 但 success=false（HTTP 2xx 特例）或旧结构时 data 可能仍是信封——两种形态都兼容。
 */
function asPayload<T>(data: unknown): T | null {
  if (data && typeof data === 'object' && 'success' in (data as Record<string, unknown>)) {
    const env = data as { success: boolean; data?: T; error?: string };
    if (env.success) return (env.data ?? null) as T | null;
    // 信封失败分支：交给 catch/错误提示路径，此处以 null 表示失败
    throw new Error(env.error || '请求失败');
  }
  return (data ?? null) as T | null;
}

const RANGE_OPTIONS = [
  { label: '1 小时', value: 1 },
  { label: '6 小时', value: 6 },
  { label: '24 小时', value: 24 },
  { label: '3 天', value: 72 },
  { label: '7 天', value: 168 },
  { label: '30 天', value: 720 },
];

const GROUP_OPTIONS = [
  { label: '主机 (host.name)', value: 'host' },
  { label: '级别 (log_level)', value: 'level' },
  { label: 'SID (oracle_sid)', value: 'sid' },
  { label: '不聚合', value: 'none' },
];

export default function ElasticsearchQuery() {
  const [auth, setAuth] = useState<AuthConfig>({
    url: 'http://10.240.22.33:9200',
    username: 'itopsuser',
    password: '',
    timeoutMs: '15000',
  });
  const [families, setFamilies] = useState<IndexFamily[]>([]);
  const [index, setIndex] = useState<string>('oracle-2026.11');
  const [rangeHours, setRangeHours] = useState<number>(24);
  const [queryString, setQueryString] = useState<string>('');
  const [levels, setLevels] = useState<string[]>([]);
  const [hostName, setHostName] = useState<string>('');
  const [sid, setSid] = useState<string>('');
  const [groupBy, setGroupBy] = useState<string>('host');
  const [size, setSize] = useState<string>('50');
  const [rawMode, setRawMode] = useState(false);
  const [rawDsl, setRawDsl] = useState<string>('{\n  "query": { "match_all": {} }\n}');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [rawResult, setRawResult] = useState<Array<Record<string, unknown>> | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const updateAuth = (key: keyof AuthConfig, value: string) => {
    setAuth((prev) => ({ ...prev, [key]: value }));
  };

  const buildAuthPayload = useCallback(() => ({
    url: auth.url.trim(),
    username: auth.username.trim() || undefined,
    password: auth.password || undefined,
    timeoutMs: parseInt(auth.timeoutMs, 10) || 15000,
  }), [auth]);

  const handleTest = async () => {
    if (!auth.url.trim()) {
      message.warning('请输入 Elasticsearch URL');
      return;
    }
    setTesting(true);
    try {
      const { data } = await api.post('/monitor/elasticsearch/test', buildAuthPayload());
      const payload = asPayload<{ totalDocs: number; indexFamilies: number }>(data);
      if (payload) {
        message.success(`连接成功：${payload.indexFamilies} 个索引族，可读文档 ${payload.totalDocs.toLocaleString()} 条`);
        // 顺带拉取索引族列表供选择
        const { data: idxData } = await api.post('/monitor/elasticsearch/indices', buildAuthPayload());
        const families = asPayload<IndexFamily[]>(idxData);
        if (families) {
          setFamilies(families);
        }
      } else {
        message.error('连接失败');
      }
    } catch (err) {
      const msg = getAxiosErrorMessage(err, '连接失败');
      message.error(msg);
      logger.error('[ElasticsearchQuery] test failed:', err);
    } finally {
      setTesting(false);
    }
  };

  const handleLoadFamilies = async () => {
    try {
      const { data } = await api.post('/monitor/elasticsearch/indices', buildAuthPayload());
      const families = asPayload<IndexFamily[]>(data);
      if (families) {
        setFamilies(families);
        message.success(`已加载 ${families.length} 个索引族`);
      } else {
        message.error('索引族枚举失败');
      }
    } catch (err) {
      message.error(getAxiosErrorMessage(err, '索引族枚举失败'));
    }
  };

  const handleQuery = async () => {
    if (!auth.url.trim()) {
      message.warning('请输入 Elasticsearch URL');
      return;
    }
    if (!index.trim()) {
      message.warning('请输入索引名或索引模式（如 oracle-2026.11 或 oracle-*）');
      return;
    }
    setLoading(true);
    setResult(null);
    setRawResult(null);
    try {
      if (rawMode) {
        let dsl: Record<string, unknown>;
        try {
          dsl = JSON.parse(rawDsl);
        } catch {
          message.error('DSL 不是合法的 JSON');
          setLoading(false);
          return;
        }
        const { data } = await api.post('/monitor/elasticsearch/raw-search', {
          ...buildAuthPayload(),
          index: index.trim(),
          dsl,
        });
        const payload = asPayload<{ hits?: { hits?: Array<{ _source: Record<string, unknown> }> }; took?: number }>(data);
        if (payload) {
          const hits = (payload.hits?.hits ?? []).map((h) => h._source);
          setRawResult(hits);
          message.success(`查询成功，共 ${hits.length} 条（耗时 ${payload.took ?? '?'}ms）`);
        } else {
          message.error('查询失败');
        }
      } else {
        const { data } = await api.post('/monitor/elasticsearch/search', {
          ...buildAuthPayload(),
          index: index.trim(),
          queryString: queryString.trim() || undefined,
          logLevel: levels.length > 0 ? levels : undefined,
          hostName: hostName.trim() || undefined,
          sid: sid.trim() || undefined,
          rangeHours,
          size: parseInt(size, 10) || 50,
          groupBy,
        });
        const payload = asPayload<SearchResponse>(data);
        if (payload) {
          setResult(payload);
          message.success(`查询成功，命中 ${payload.total.toLocaleString()} 条（耗时 ${payload.tookMs}ms）`);
        } else {
          message.error('查询失败');
        }
      }
    } catch (err) {
      const msg = getAxiosErrorMessage(err, '查询失败');
      message.error(msg);
      logger.error('[ElasticsearchQuery] query failed:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-6">
      <div className="space-y-4">
        {/* 标题 */}
        <div className="flex items-center gap-3">
          <FileSearch className="w-7 h-7 text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Elasticsearch 查询</h1>
            <p className="text-text-secondary text-sm">查询聚合日志（OS syslog / Oracle / 网络设备 / 备份），用于日志巡检与问题排查</p>
          </div>
        </div>

        {/* 连接配置 */}
        <section className="bg-surface rounded-xl p-5 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Plug className="w-4 h-4 text-primary" />
              连接配置
            </h2>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 disabled:opacity-50 transition-colors"
            >
              {testing ? (
                <span className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              ) : (
                <Plug className="w-3.5 h-3.5" />
              )}
              测试连接
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <label className="block text-xs text-text-secondary mb-1">Elasticsearch URL *</label>
              <input
                type="text"
                value={auth.url}
                onChange={(e) => updateAuth('url', e.target.value)}
                placeholder="http://es-host:9200"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-primary/50"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">用户名</label>
              <input
                type="text"
                value={auth.username}
                onChange={(e) => updateAuth('username', e.target.value)}
                placeholder="可选（Basic Auth）"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm focus:outline-none focus:border-primary/50"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">密码</label>
              <input
                type="password"
                value={auth.password}
                onChange={(e) => updateAuth('password', e.target.value)}
                placeholder="可选"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm focus:outline-none focus:border-primary/50"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleLoadFamilies}
              className="px-3 py-1.5 rounded-lg bg-background border border-border text-text-secondary text-xs hover:text-text-primary transition-colors"
            >
              加载索引族列表
            </button>
            {families.length > 0 && (
              <span className="text-xs text-text-secondary">
                共 {families.length} 个索引族，文档总量 {families.reduce((s, f) => s + f.docCount, 0).toLocaleString()}
              </span>
            )}
          </div>

          {families.length > 0 && (
            <div className="overflow-auto max-h-48 rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-background sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-text-secondary font-medium">索引族</th>
                    <th className="text-right px-3 py-2 text-text-secondary font-medium">索引数</th>
                    <th className="text-right px-3 py-2 text-text-secondary font-medium">文档数</th>
                    <th className="text-left px-3 py-2 text-text-secondary font-medium">最新索引</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {families.map((f) => (
                    <tr key={f.family} className="border-t border-border/50">
                      <td className="px-3 py-1.5 font-mono text-text-primary">{f.family}</td>
                      <td className="px-3 py-1.5 text-right text-text-secondary">{f.indexCount}</td>
                      <td className="px-3 py-1.5 text-right text-text-secondary">{f.docCount.toLocaleString()}</td>
                      <td className="px-3 py-1.5 font-mono text-text-secondary">{f.latestIndex}</td>
                      <td className="px-3 py-1.5">
                        <button
                          type="button"
                          onClick={() => setIndex(f.latestIndex ?? f.family)}
                          className="text-primary hover:underline text-[11px]"
                        >
                          使用最新
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 查询条件 */}
        <section className="bg-surface rounded-xl p-5 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">查询条件</h2>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-background rounded-lg p-0.5 border border-border">
                <button
                  type="button"
                  onClick={() => setRawMode(false)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${!rawMode ? 'bg-primary/15 text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  结构化
                </button>
                <button
                  type="button"
                  onClick={() => setRawMode(true)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${rawMode ? 'bg-primary/15 text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  原生 DSL
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">索引名 / 模式 *（如 oracle-2026.11、oracle-*、syslog-rsyslog-*）</label>
              <input
                type="text"
                value={index}
                onChange={(e) => setIndex(e.target.value)}
                placeholder="oracle-2026.11"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-primary/50"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">时间窗</label>
              <select
                value={rangeHours}
                onChange={(e) => setRangeHours(parseInt(e.target.value, 10))}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm focus:outline-none focus:border-primary/50"
              >
                {RANGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          {!rawMode && (
            <>
              <div>
                <label className="block text-xs text-text-secondary mb-1">关键字（query_string 语法，如 &quot;ORA-00600&quot; 或 &quot;error AND timeout&quot;）</label>
                <input
                  type="text"
                  value={queryString}
                  onChange={(e) => setQueryString(e.target.value)}
                  placeholder="例如：ORA-00600"
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-primary/50"
                />
              </div>

              <div>
                <label className="block text-xs text-text-secondary mb-1">日志级别</label>
                <div className="flex flex-wrap gap-1.5">
                  {LEVELS.map((lv) => {
                    const active = levels.includes(lv);
                    return (
                      <button
                        key={lv}
                        type="button"
                        onClick={() => setLevels((prev) => active ? prev.filter((l) => l !== lv) : [...prev, lv])}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                          active
                            ? 'bg-primary/15 text-primary border-primary/40'
                            : 'bg-background text-text-secondary border-border hover:text-text-primary'
                        }`}
                      >
                        {lv}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
              >
                {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {showAdvanced ? '收起' : '展开'}高级过滤（主机名 / SID / 聚合维度 / 返回条数）
              </button>

              {showAdvanced && (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-1">
                  <div>
                    <label className="block text-xs text-text-secondary mb-1">主机名（host.name）</label>
                    <input
                      type="text"
                      value={hostName}
                      onChange={(e) => setHostName(e.target.value)}
                      placeholder="zydb11"
                      className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-primary/50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-text-secondary mb-1">SID（oracle_sid）</label>
                    <input
                      type="text"
                      value={sid}
                      onChange={(e) => setSid(e.target.value)}
                      placeholder="CTCNZQF"
                      className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-primary/50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-text-secondary mb-1">聚合维度</label>
                    <select
                      value={groupBy}
                      onChange={(e) => setGroupBy(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm focus:outline-none focus:border-primary/50"
                    >
                      {GROUP_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-text-secondary mb-1">返回条数（≤500）</label>
                    <input
                      type="number"
                      value={size}
                      onChange={(e) => setSize(e.target.value)}
                      min={1}
                      max={500}
                      className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm focus:outline-none focus:border-primary/50"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {rawMode && (
            <div>
              <label className="block text-xs text-text-secondary mb-1">ES DSL（JSON，仅 _search；size 将被限制到 ≤500）</label>
              <textarea
                value={rawDsl}
                onChange={(e) => setRawDsl(e.target.value)}
                rows={6}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-primary/50 resize-y"
              />
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleQuery}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              查询
            </button>
          </div>
        </section>

        {/* 结果 */}
        {result && (
          <section className="bg-surface rounded-xl p-5 border border-border space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">查询结果</h2>
              <span className="text-xs text-text-secondary">
                命中 {result.total.toLocaleString()} 条 · 展示 {result.hits.length} 条 · {result.tookMs}ms
              </span>
            </div>

            {result.aggregations && result.aggregations.group.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-text-secondary mb-1.5">聚合分布（Top {result.aggregations.group.length}）</h3>
                <div className="space-y-1">
                  {(() => {
                    const max = Math.max(...result.aggregations.group.map((b) => b.count), 1);
                    return result.aggregations.group.map((b) => (
                      <div key={b.key} className="flex items-center gap-2 text-xs">
                        <span className="w-40 truncate font-mono text-text-primary" title={b.key}>{b.key || '(空)'}</span>
                        <div className="flex-1 h-3 bg-background rounded overflow-hidden border border-border/50">
                          <div
                            className="h-full bg-primary/60 rounded"
                            style={{ width: `${Math.max((b.count / max) * 100, 2)}%` }}
                          />
                        </div>
                        <span className="w-24 text-right text-text-secondary">{b.count.toLocaleString()}</span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}

            <div className="overflow-auto max-h-96 rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-background sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-text-secondary font-medium">时间</th>
                    <th className="text-left px-3 py-2 text-text-secondary font-medium">主机</th>
                    <th className="text-left px-3 py-2 text-text-secondary font-medium">级别</th>
                    <th className="text-left px-3 py-2 text-text-secondary font-medium">SID</th>
                    <th className="text-left px-3 py-2 text-text-secondary font-medium">消息</th>
                  </tr>
                </thead>
                <tbody>
                  {result.hits.map((h, i) => (
                    <tr key={i} className="border-t border-border/50 align-top">
                      <td className="px-3 py-1.5 text-text-secondary whitespace-nowrap font-mono">{h.timestamp?.replace('T', ' ').slice(0, 19)}</td>
                      <td className="px-3 py-1.5 font-mono text-text-primary">{h.host ?? '-'}</td>
                      <td className="px-3 py-1.5">
                        {h.level && (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            h.level === 'error' || h.level === 'critical' || h.level === 'fatal'
                              ? 'bg-red-500/10 text-red-400'
                              : h.level === 'warn'
                                ? 'bg-amber-500/10 text-amber-400'
                                : 'bg-sky-500/10 text-sky-400'
                          }`}>
                            {h.level}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-text-secondary">{h.sid ?? '-'}</td>
                      <td className="px-3 py-1.5 text-text-primary" title={h.message}>
                        {h.message.length > 200 ? `${h.message.slice(0, 200)}…` : h.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {rawResult && (
          <section className="bg-surface rounded-xl p-5 border border-border space-y-2">
            <h2 className="text-sm font-semibold text-text-primary">DSL 结果（{rawResult.length} 条）</h2>
            <div className="overflow-auto max-h-96 rounded-lg border border-border bg-background p-3">
              <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap">
                {JSON.stringify(rawResult, null, 2).slice(0, 20000)}
              </pre>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
