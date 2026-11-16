/**
 * Zabbix 主动查询页面
 *
 * 提供对 Zabbix API 的主动查询能力：
 *   - Hosts / Items / Triggers / Problems / History / 测试连接
 *
 * 请求统一走全局 api 实例（lib/api），后端封装在 /api/v1/monitor/zabbix/*。
 * 响应格式：{ success, data: { result: any[] }, error }。
 */

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  Activity,
  Server,
  ListChecks,
  AlertTriangle,
  Database,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Play,
  Plug,
  Download,
  type LucideIcon,
} from 'lucide-react';
import { message } from 'antd';
import api from '../../../lib/api';
import { getAxiosErrorMessage } from '../../../lib/errorHandler';
import { ResultsTable } from './zabbix/ResultsTable';
import {
  buildPayload,
  HOST_COLUMNS,
  ITEM_COLUMNS,
  TRIGGER_COLUMNS,
  PROBLEM_COLUMNS,
  HISTORY_COLUMNS,
} from './zabbix/types';
import type {
  ConnectionConfig,
  TabKey,
  ZabbixHost,
  ZabbixItem,
  ZabbixTrigger,
  ZabbixProblem,
  ZabbixHistoryRow,
  ZabbixImportRow,
} from './zabbix/types';

// ==================== 常量 ====================

const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'hosts', label: 'Hosts', icon: Server },
  { key: 'items', label: 'Items', icon: ListChecks },
  { key: 'triggers', label: 'Triggers', icon: AlertCircle },
  { key: 'problems', label: 'Problems', icon: AlertTriangle },
  { key: 'history', label: 'History', icon: Database },
  { key: 'import', label: '导入主机', icon: Download },
  { key: 'test', label: '测试', icon: Activity },
];

async function callZabbix<T>(endpoint: string, payload: Record<string, unknown>): Promise<T[]> {
  // 后端 /monitor/zabbix/* 统一返回 { success, data } 信封：
  //   - 查询类接口（hosts/items/triggers/problems/history）：data 为 T[]
  //   - test：data 为 { reachable, authenticated }
  // axios 拦截器已解包（response.data = 信封的 data 字段）。
  const { data } = await api.post(endpoint, payload);
  if (data == null) {
    throw new Error('Zabbix 请求失败：响应为空');
  }
  if (Array.isArray(data)) {
    return data as T[];
  }
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.error === 'string' && obj.error) {
      throw new Error(obj.error);
    }
    if (Array.isArray(obj.result)) {
      return obj.result as T[];
    }
  }
  return [];
}

// ==================== 主组件 ====================

export default function ZabbixQuery() {
  const [cfg, setCfg] = useState<ConnectionConfig>({
    url: '',
    username: '',
    password: '',
    apiToken: '',
    authMode: 'password',
    timeoutMs: 15000,
  });
  const [tab, setTab] = useState<TabKey>('hosts');
  const [loading, setLoading] = useState(false);
  const [hosts, setHosts] = useState<ZabbixHost[]>([]);
  const [items, setItems] = useState<ZabbixItem[]>([]);
  const [triggers, setTriggers] = useState<ZabbixTrigger[]>([]);
  const [problems, setProblems] = useState<ZabbixProblem[]>([]);
  const [history, setHistory] = useState<ZabbixHistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedHostId, setSelectedHostId] = useState<string>('');
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [timeFrom, setTimeFrom] = useState<string>('');
  const [timeTill, setTimeTill] = useState<string>('');
  const [historyLimit, setHistoryLimit] = useState<number>(100);

  const [importRows, setImportRows] = useState<ZabbixImportRow[]>([]);
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [importDone, setImportDone] = useState<string | null>(null);

  // 后端持久化连接配置（Zabbix Agent 通道定时采集用）
  const [backendHint, setBackendHint] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/monitor/zabbix/config');
        if (data?.url) {
          setBackendHint(`后端已配置：${data.url}${data.hasApiToken ? `（Token ${data.apiTokenHint}）` : data.username ? `（用户 ${data.username}）` : '（无凭据）'}`);
          setCfg((prev) => (prev.url ? prev : { ...prev, url: data.url }));
        }
      } catch {
        // 后端未配置/无权限时静默
      }
    })();
  }, []);

  const saveConfigToBackend = async () => {
    if (!cfg.url.trim()) {
      message.warning('请先填写 Zabbix URL');
      return;
    }
    setSavingConfig(true);
    try {
      const payload: Record<string, unknown> = { url: cfg.url.trim(), timeoutMs: cfg.timeoutMs };
      if (cfg.authMode === 'token' && cfg.apiToken) payload.apiToken = cfg.apiToken;
      if (cfg.authMode === 'password') {
        if (cfg.username) payload.username = cfg.username;
        if (cfg.password) payload.password = cfg.password;
      }
      await api.post('/monitor/zabbix/config', payload);
      message.success('已保存到后端：Zabbix Agent 通道采集将使用此配置');
      const { data } = await api.get('/monitor/zabbix/config');
      setBackendHint(data?.url ? `后端已配置：${data.url}${data.hasApiToken ? `（Token ${data.apiTokenHint}）` : ''}` : null);
    } catch (err) {
      message.error(getAxiosErrorMessage(err, '保存后端配置失败（需要 admin 角色）'));
    } finally {
      setSavingConfig(false);
    }
  };

  const canQuery = useMemo(() => cfg.url.trim().length > 0, [cfg.url]);

  // ============ 导入主机 ============

  const fetchImportPreview = async () => {
    setImportBusy(true);
    setError(null);
    setImportDone(null);
    try {
      const { data } = await api.post('/monitor/zabbix/import', {
        ...buildPayload(cfg),
        dryRun: true,
      });
      const rows: ZabbixImportRow[] = data?.details ?? [];
      setImportRows(rows);
      // 默认全选可导入项（跳过已存在）
      setImportSelected(
        new Set(rows.filter((r) => r.status !== 'duplicate' && r.status !== 'failed').map((r) => r.hostid)),
      );
      if (rows.length === 0) {
        message.info('Zabbix 未返回任何主机');
      }
    } catch (err) {
      const msg = getAxiosErrorMessage(err, '获取导入预览失败');
      setError(msg);
      message.error(msg);
    } finally {
      setImportBusy(false);
    }
  };

  const doImport = async () => {
    if (importSelected.size === 0) {
      message.warning('请至少勾选一台主机');
      return;
    }
    setImportBusy(true);
    setError(null);
    try {
      const { data } = await api.post('/monitor/zabbix/import', {
        ...buildPayload(cfg),
        dryRun: false,
        hostIds: [...importSelected],
      });
      const summary = data
        ? `导入成功 ${data.imported} 台${data.backfilled ? `，回填 ${data.backfilled} 台` : ''}，跳过 ${data.skipped} 台${data.failed ? `，失败 ${data.failed} 台` : ''}`
        : '导入完成';
      setImportDone(summary);
      // 刷新预览，已导入的会显示为 duplicate
      await fetchImportPreview();
      message.success(summary);
    } catch (err) {
      const msg = getAxiosErrorMessage(err, '导入失败');
      setError(msg);
      message.error(msg);
    } finally {
      setImportBusy(false);
    }
  };

  const handleTest = async () => {
    if (!canQuery) {
      message.warning('请填写 Zabbix URL');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await callZabbix<unknown>('/monitor/zabbix/test', buildPayload(cfg));
      message.success('连接成功');
    } catch (err) {
      const msg = getAxiosErrorMessage(err, '连接失败');
      setError(msg);
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const runQuery = async () => {
    if (!canQuery) {
      message.warning('请填写 Zabbix URL');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload = buildPayload(cfg);
      switch (tab) {
        case 'hosts':
          setHosts(await callZabbix<ZabbixHost>('/monitor/zabbix/hosts', payload));
          break;
        case 'items': {
          if (!selectedHostId) {
            message.warning('请选择 Host');
            setLoading(false);
            return;
          }
          setItems(
            await callZabbix<ZabbixItem>('/monitor/zabbix/items', {
              ...payload,
              hostIds: [selectedHostId],
            }),
          );
          break;
        }
        case 'triggers':
          setTriggers(await callZabbix<ZabbixTrigger>('/monitor/zabbix/triggers', payload));
          break;
        case 'problems':
          setProblems(await callZabbix<ZabbixProblem>('/monitor/zabbix/problems', payload));
          break;
        case 'history': {
          if (!selectedItemId) {
            message.warning('请选择 Item');
            setLoading(false);
            return;
          }
          setHistory(
            await callZabbix<ZabbixHistoryRow>('/monitor/zabbix/history', {
              ...payload,
              itemIds: [selectedItemId],
              timeFrom: timeFrom || undefined,
              timeTill: timeTill || undefined,
              limit: historyLimit,
            }),
          );
          break;
        }
        default:
          break;
      }
    } catch (err) {
      const msg = getAxiosErrorMessage(err, '查询失败');
      setError(msg);
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-6 space-y-6 bg-background text-text-primary">
      <div className="flex items-center gap-3">
        <Activity size={26} className="text-emerald-400" />
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Zabbix 主动查询</h1>
          <p className="text-sm text-text-tertiary">直接对接 Zabbix JSON-RPC API，无需安装 Agent</p>
        </div>
      </div>

      <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-secondary flex items-center gap-2">
            <Plug size={16} /> 连接配置
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveConfigToBackend}
              disabled={!canQuery || savingConfig}
              title="保存到后端数据库，供 Zabbix Agent 通道服务器定时采集使用（需要 admin 角色）"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border text-text-secondary text-xs font-medium hover:bg-background disabled:opacity-50"
            >
              {savingConfig ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
              保存到后端
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={!canQuery || loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 disabled:opacity-50"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              测试连接
            </button>
          </div>
        </div>
        {backendHint && (
          <p className="text-xs text-emerald-500 flex items-center gap-1">
            <CheckCircle2 size={12} /> {backendHint}
          </p>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2">
            <label className="block text-xs text-text-secondary mb-1">Zabbix API URL</label>
            <input
              type="text"
              placeholder="http://zabbix.example.com/api_jsonrpc.php"
              value={cfg.url}
              onChange={(e) => setCfg({ ...cfg, url: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">超时 (ms)</label>
            <input
              type="number"
              min={1000}
              value={cfg.timeoutMs}
              onChange={(e) => setCfg({ ...cfg, timeoutMs: Number(e.target.value) || 15000 })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary/50"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setCfg({ ...cfg, authMode: 'password' })}
            className={clsx(
              'px-3 py-1 rounded-md border',
              cfg.authMode === 'password'
                ? 'bg-primary/15 border-primary text-primary'
                : 'border-border text-text-secondary',
            )}
          >
            用户名密码
          </button>
          <button
            type="button"
            onClick={() => setCfg({ ...cfg, authMode: 'token' })}
            className={clsx(
              'px-3 py-1 rounded-md border',
              cfg.authMode === 'token'
                ? 'bg-primary/15 border-primary text-primary'
                : 'border-border text-text-secondary',
            )}
          >
            API Token
          </button>
        </div>

        {cfg.authMode === 'password' ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">Username</label>
              <input
                type="text"
                value={cfg.username}
                onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary/50"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Password</label>
              <input
                type="password"
                value={cfg.password}
                onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary/50"
              />
            </div>
          </div>
        ) : (
          <div>
            <label className="block text-xs text-text-secondary mb-1">API Token</label>
            <input
              type="text"
              value={cfg.apiToken}
              onChange={(e) => setCfg({ ...cfg, apiToken: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary/50"
            />
          </div>
        )}
      </section>

      <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={clsx(
                  'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border transition',
                  active
                    ? 'bg-primary/15 border-primary text-primary'
                    : 'border-border text-text-secondary hover:text-text-primary',
                )}
              >
                <Icon size={14} />
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === 'items' && (
          <div>
            <label className="block text-xs text-text-secondary mb-1">选择 Host</label>
            <select
              value={selectedHostId}
              onChange={(e) => setSelectedHostId(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary"
            >
              <option value="">-- 请先获取 Hosts --</option>
              {hosts.map((h) => (
                <option key={h.hostid} value={h.hostid}>
                  {h.host} ({h.name})
                </option>
              ))}
            </select>
          </div>
        )}

        {tab === 'history' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            <div className="lg:col-span-2">
              <label className="block text-xs text-text-secondary mb-1">选择 Item</label>
              <select
                value={selectedItemId}
                onChange={(e) => setSelectedItemId(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary"
              >
                <option value="">-- 请先获取 Items --</option>
                {items.map((it) => (
                  <option key={it.itemid} value={it.itemid}>
                    {it.name} ({it.key_})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">timeFrom (Unix)</label>
              <input
                type="text"
                placeholder="0 = 不限"
                value={timeFrom}
                onChange={(e) => setTimeFrom(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">timeTill (Unix)</label>
              <input
                type="text"
                placeholder="留空 = 当前"
                value={timeTill}
                onChange={(e) => setTimeTill(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Limit</label>
              <input
                type="number"
                min={1}
                value={historyLimit}
                onChange={(e) => setHistoryLimit(Number(e.target.value) || 100)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary"
              />
            </div>
          </div>
        )}

        {tab === 'import' ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={fetchImportPreview}
              disabled={!canQuery || importBusy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {importBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              获取导入预览
            </button>
            <button
              type="button"
              onClick={doImport}
              disabled={!canQuery || importBusy || importSelected.size === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {importBusy ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              导入选中（{importSelected.size}）
            </button>
            {importDone && (
              <span className="text-xs text-text-secondary">{importDone}</span>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={runQuery}
            disabled={!canQuery || loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            执行查询
          </button>
        )}
      </section>

      <section className="bg-surface border border-border rounded-xl p-5">
        {error && (
          <div className="mb-3 flex items-center gap-2 text-status-failed text-sm">
            <AlertCircle size={16} /> {error}
          </div>
        )}
        {tab === 'hosts' && (
          <ResultsTable<ZabbixHost> rows={hosts} loading={loading} columns={HOST_COLUMNS} />
        )}
        {tab === 'items' && (
          <ResultsTable<ZabbixItem> rows={items} loading={loading} columns={ITEM_COLUMNS} />
        )}
        {tab === 'triggers' && (
          <ResultsTable<ZabbixTrigger>
            rows={triggers}
            loading={loading}
            columns={TRIGGER_COLUMNS}
          />
        )}
        {tab === 'problems' && (
          <ResultsTable<ZabbixProblem>
            rows={problems}
            loading={loading}
            columns={PROBLEM_COLUMNS}
          />
        )}
        {tab === 'history' && (
          <ResultsTable<ZabbixHistoryRow>
            rows={history}
            loading={loading}
            columns={HISTORY_COLUMNS}
          />
        )}
        {tab === 'import' && (
          <div className="space-y-2">
            {importRows.length === 0 && !importBusy && (
              <div className="text-text-secondary text-sm py-4">
                填好连接配置后，点击「获取导入预览」拉取 Zabbix 主机清单（不会写库）。确认后勾选并导入到平台服务器管理。
              </div>
            )}
            {importRows.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-text-secondary border-b border-border">
                    <th className="py-2 pr-2 w-8">
                      <input
                        type="checkbox"
                        checked={importSelected.size === importRows.filter((r) => r.status !== 'duplicate').length && importSelected.size > 0}
                        onChange={(e) =>
                          setImportSelected(
                            e.target.checked
                              ? new Set(importRows.filter((r) => r.status !== 'duplicate').map((r) => r.hostid))
                              : new Set(),
                          )
                        }
                      />
                    </th>
                    <th className="py-2 pr-2">名称</th>
                    <th className="py-2 pr-2">地址（IP/DNS）</th>
                    <th className="py-2 pr-2">主机组</th>
                    <th className="py-2 pr-2">OS</th>
                    <th className="py-2 pr-2">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {importRows.map((r) => (
                    <tr key={r.hostid} className="border-b border-border/50">
                      <td className="py-2 pr-2">
                        {r.status === 'duplicate' ? (
                          <span className="text-text-tertiary">—</span>
                        ) : (
                          <input
                            type="checkbox"
                            checked={importSelected.has(r.hostid)}
                            onChange={(e) => {
                              const next = new Set(importSelected);
                              if (e.target.checked) next.add(r.hostid);
                              else next.delete(r.hostid);
                              setImportSelected(next);
                            }}
                          />
                        )}
                      </td>
                      <td className="py-2 pr-2">{r.name}</td>
                      <td className="py-2 pr-2 font-mono text-xs">{r.hostname}</td>
                      <td className="py-2 pr-2 text-xs text-text-secondary">{r.groups.join(', ') || '—'}</td>
                      <td className="py-2 pr-2 text-xs">{r.os || '—'}</td>
                      <td className="py-2 pr-2 text-xs">
                        {r.status === 'duplicate' ? (
                          <span className="text-text-tertiary">已存在，跳过</span>
                        ) : r.status === 'backfill' ? (
                          <span className="text-amber-500">已存在，将回填为 Zabbix 通道</span>
                        ) : r.status === 'failed' ? (
                          <span className="text-status-failed">{r.error ?? '失败'}</span>
                        ) : (
                          <span className="text-emerald-500">可导入（Zabbix Agent 通道）</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-text-tertiary">
              导入说明：主机以 Zabbix Agent 通道（conn_type=zabbix）写入「服务器管理」，监控数据经 Zabbix API 只读采集，
              平台不持有 SSH 凭据；终端/命令执行对此类设备不可用。标签带 zabbix 与所属主机组。
              此前旧版导入的记录（SSH 占位）会被自动回填为 Zabbix 通道。
            </p>
          </div>
        )}
        {tab === 'test' && !loading && (
          <div className="text-text-secondary text-sm py-4">
            点击上方「测试连接」按钮验证 Zabbix 配置。
          </div>
        )}
      </section>
    </div>
  );
}
