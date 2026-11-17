/**
 * BigScreenDashboard - Left Column（2026-07-21 拆分）
 *
 * 从原 BigScreenDashboard.tsx L290-561 抽出左列 4 个 panel：
 * - 系统资源监控（4 张指标卡：CPU/内存/网络/磁盘）
 * - 告警趋势 (24h)（线图）
 * - 任务趋势 (24h)（线图）
 * - 自动修复统计（4 项数据 + 4 条 recent_executions）
 *
 * 拆分原则遵循 architecture.md §3.4.1 + 第 3 条「向后兼容的 import 路径」
 */
import { useState, useEffect, useRef } from 'react';
import { Cpu, MemoryStick, HardDrive, Wifi, AlertCircle, Play, ChevronDown, Search } from 'lucide-react';
import AnimatedLineChart from '../../components/AnimatedLineChart';

export interface BigScreenLeftColumnProps {
  selectedServerId: string;
  setSelectedServerId: (id: string) => void;
  aggregatedMetrics: {
    cpu: number | null | undefined;
    memory: number | null | undefined;
    networkIn?: number | null;
    networkOut?: number | null;
    disk: number | null | undefined;
  };
  serverMetricsData:
    | {
        available_servers?: Array<{ id: string; name: string; is_local?: boolean }>;
        has_real_data?: boolean;
      }
    | null
    | undefined;
  alertTrendData: Array<{ timestamp: number; value: number }>;
  taskTrendData: Array<{ timestamp: number; value: number }>;
  remediationStats:
    | {
        today: { total: number; success_rate: number; failed: number };
        waiting_approval: number;
        recent_executions: ReadonlyArray<{
          id: string;
          policy_name: string;
          status: string;
        }>;
      }
    | null
    | undefined;
  onNavigate: (path: string) => void;
}

interface MetricConfig {
  label: string;
  fullLabel: string;
  value: number | null | undefined;
  unit: string;
  Icon: typeof Cpu;
  bar: string;
  valColor: string;
  iconBg: string;
  iconColor: string;
  fmt: (v: number) => string;
}

const STATUS_COLOR_MAP: Record<string, string> = {
  success: 'bg-status-success',
  failed: 'bg-status-failed',
  rolled_back: 'bg-yellow-500',
  waiting_approval: 'bg-blue-500',
  running: 'bg-status-running',
};

const STATUS_TEXT_MAP: Record<string, string> = {
  success: '成功',
  failed: '失败',
  rolled_back: '回滚',
  waiting_approval: '待审批',
  running: '执行中',
  pending: '待处理',
  skipped: '已跳过',
};

export default function BigScreenLeftColumn({
  selectedServerId,
  setSelectedServerId,
  aggregatedMetrics,
  serverMetricsData,
  alertTrendData,
  taskTrendData,
  remediationStats,
  onNavigate,
}: BigScreenLeftColumnProps) {
  const servers = serverMetricsData?.available_servers || [];
  const local = servers.find((s) => s.is_local);

  // ===== 服务器可搜索下拉（数百台规模下原生 select 无法滚动/搜索） =====
  const [ddOpen, setDdOpen] = useState(false);
  const [ddQuery, setDdQuery] = useState('');
  const ddRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ddOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setDdOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [ddOpen]);

  const currentLabel =
    selectedServerId === 'auto'
      ? local
        ? `本机（${local.name}）`
        : '本机（自动检测）'
      : selectedServerId === '__all__'
        ? '所有服务器（聚合）'
        : servers.find((s) => s.id === selectedServerId)?.name || selectedServerId;
  const filteredServers = servers.filter(
    (s) => !ddQuery || s.name.toLowerCase().includes(ddQuery.toLowerCase()),
  );

  const pick = (id: string) => {
    setSelectedServerId(id);
    setDdOpen(false);
    setDdQuery('');
  };

  const metricConfigs: MetricConfig[] = [
    {
      label: 'CPU',
      fullLabel: 'CPU使用率',
      value: aggregatedMetrics.cpu,
      unit: '%',
      Icon: Cpu,
      bar: 'bg-sky-400',
      valColor: 'text-sky-300',
      iconBg: 'bg-sky-500/15',
      iconColor: 'text-sky-400',
      fmt: (v: number) => v.toFixed(1),
    },
    {
      label: '内存',
      fullLabel: '内存使用率',
      value: aggregatedMetrics.memory,
      unit: '%',
      Icon: MemoryStick,
      bar: 'bg-violet-400',
      valColor: 'text-violet-300',
      iconBg: 'bg-violet-500/15',
      iconColor: 'text-violet-400',
      fmt: (v: number) => v.toFixed(1),
    },
    {
      label: '网络',
      fullLabel: '网络流量',
      value: (aggregatedMetrics.networkIn ?? 0) + (aggregatedMetrics.networkOut ?? 0),
      unit: 'MB/s',
      Icon: Wifi,
      bar: 'bg-emerald-400',
      valColor: 'text-emerald-300',
      iconBg: 'bg-emerald-500/15',
      iconColor: 'text-emerald-400',
      fmt: (v: number) => v.toFixed(1),
    },
    {
      label: '磁盘',
      fullLabel: '磁盘使用率',
      value: aggregatedMetrics.disk,
      unit: '%',
      Icon: HardDrive,
      bar: 'bg-amber-400',
      valColor: 'text-amber-300',
      iconBg: 'bg-amber-500/15',
      iconColor: 'text-amber-400',
      fmt: (v: number) => v.toFixed(1),
    },
  ];

  return (
    <div className="col-span-3 flex flex-col gap-4">
      {/* 系统资源监控（relative z-20：本面板含下拉弹出列表，须压过后续 backdrop-blur 面板的堆叠上下文） */}
      <div className="bg-slate-800/40 backdrop-blur-md rounded-2xl p-5 border border-border relative z-20">
        <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            系统资源监控
          </div>
          <div className="flex items-center gap-2">
            {/* 服务器选择：可搜索下拉（原生 select 的弹出列表由 OS 渲染，数百台无法使用） */}
            <div className="relative" ref={ddRef}>
              <button
                type="button"
                onClick={() => setDdOpen((v) => !v)}
                className="appearance-none bg-slate-900/60 border border-border rounded-md pl-2 pr-7 py-1 text-xs text-text-primary hover:border-blue-500/40 focus:outline-none focus:border-blue-500/60 cursor-pointer max-w-[220px] flex items-center justify-between gap-1"
                title="选择要监控的服务器"
              >
                <span className="truncate">{currentLabel}</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-text-tertiary shrink-0 transition-transform ${ddOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {ddOpen && (
                <div className="absolute right-0 top-full mt-1 w-72 bg-slate-900 border border-border rounded-lg shadow-xl z-50 overflow-hidden">
                  <div className="relative p-2 border-b border-border">
                    <Search className="w-3.5 h-3.5 text-text-tertiary absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      autoFocus
                      type="text"
                      value={ddQuery}
                      onChange={(e) => setDdQuery(e.target.value)}
                      placeholder="搜索服务器名称..."
                      className="w-full bg-slate-800/60 border border-border rounded-md pl-7 pr-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-blue-500/60"
                    />
                  </div>
                  <div className="max-h-72 overflow-y-auto scrollbar-thin py-1">
                    <button
                      type="button"
                      onClick={() => pick('auto')}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 ${
                        selectedServerId === 'auto' ? 'text-blue-400 bg-slate-800/50' : 'text-text-primary'
                      }`}
                    >
                      {local ? `本机（${local.name}）` : '本机（自动检测）'}
                    </button>
                    {servers.length > 1 && (
                      <button
                        type="button"
                        onClick={() => pick('__all__')}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 ${
                          selectedServerId === '__all__' ? 'text-blue-400 bg-slate-800/50' : 'text-text-primary'
                        }`}
                      >
                        所有服务器（聚合）
                      </button>
                    )}
                    {filteredServers.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => pick(s.id)}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 truncate ${
                          selectedServerId === s.id ? 'text-blue-400 bg-slate-800/50' : 'text-text-primary'
                        }`}
                        title={s.name}
                      >
                        {s.name}
                        {s.is_local ? ' ★' : ''}
                      </button>
                    ))}
                    {filteredServers.length === 0 && (
                      <div className="px-3 py-3 text-xs text-text-tertiary text-center">
                        无匹配的服务器
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {serverMetricsData?.has_real_data ? (
              <span className="text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30">
                实时数据
              </span>
            ) : (
              <span
                className="text-xs px-2 py-0.5 rounded bg-slate-700/50 text-text-secondary border border-slate-600/30"
                title="该服务器暂无采集数据"
              >
                {selectedServerId === '__all__' ? '聚合数据' : '暂无数据'}
              </span>
            )}
          </div>
        </h2>

        {/* 4 张并排指标卡 */}
        <div className="grid grid-cols-4 gap-2">
          {metricConfigs.map((m) => {
            const pct = m.value ?? 0;
            const isPct = m.unit === '%';
            const widthPct = isPct ? Math.min(pct, 100) : Math.min(pct * 10, 100);
            return (
              <div
                key={m.label}
                className="bg-slate-700/40 border border-border rounded-xl px-2.5 py-2.5 flex flex-col gap-1.5 transition-colors hover:border-blue-500/40 overflow-hidden"
                title={m.fullLabel}
              >
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-6 h-6 rounded-md ${m.iconBg} ${m.iconColor} flex items-center justify-center shrink-0`}
                  >
                    <m.Icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="text-xs font-medium text-text-primary whitespace-nowrap truncate">
                    {m.label}
                  </div>
                </div>
                <div className="flex items-baseline gap-1 leading-none">
                  <span
                    className={`text-lg font-bold font-mono tabular-nums ${m.valColor} whitespace-nowrap`}
                  >
                    {m.value !== null && m.value !== undefined && Number.isFinite(m.value)
                      ? m.fmt(m.value)
                      : '--'}
                  </span>
                  <span className="text-[10px] text-text-tertiary font-medium whitespace-nowrap">
                    {m.unit}
                  </span>
                </div>
                <div className="relative h-1.5 bg-white/90 rounded-full overflow-hidden">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${m.bar}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 告警趋势 (24h) */}
      <div className="bg-slate-800/40 backdrop-blur-md rounded-2xl p-4 border border-border">
        <h2 className="text-base font-semibold text-text-primary mb-2 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400" />
          告警趋势 (24h)
        </h2>
        {alertTrendData.length > 0 ? (
          <AnimatedLineChart data={alertTrendData} color="#ef4444" height={100} />
        ) : (
          <div className="flex items-center justify-center h-[100px] text-slate-500 text-sm">
            暂无告警数据
          </div>
        )}
      </div>

      {/* 任务趋势 (24h) */}
      <div className="bg-slate-800/40 backdrop-blur-md rounded-2xl p-4 border border-border">
        <h2 className="text-base font-semibold text-text-primary mb-2 flex items-center gap-2">
          <Play className="w-4 h-4 text-green-400" />
          任务趋势 (24h)
        </h2>
        {taskTrendData.length > 0 ? (
          <AnimatedLineChart data={taskTrendData} color="#22c55e" height={100} />
        ) : (
          <div className="flex items-center justify-center h-[100px] text-slate-500 text-sm">
            暂无任务数据
          </div>
        )}
      </div>

      {/* 自动修复统计 */}
      <div className="bg-slate-800/40 backdrop-blur-md rounded-2xl p-4 border border-border">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            自动修复统计
          </h2>
          <span
            className="text-xs text-text-secondary bg-slate-700/50 px-2 py-1 rounded-full cursor-pointer hover:bg-slate-600/50"
            onClick={() => onNavigate('/remediation-executions')}
          >
            详情 →
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="bg-emerald-500/10 rounded-xl p-2.5 border border-emerald-500/25">
            <div className="text-xl font-bold text-emerald-300">
              {remediationStats?.today.total || 0}
            </div>
            <div className="text-xs text-emerald-300/80">今日执行</div>
          </div>
          <div className="bg-blue-500/10 rounded-xl p-2.5 border border-blue-500/25">
            <div className="text-xl font-bold text-blue-300">
              {remediationStats?.today.success_rate || 0}%
            </div>
            <div className="text-xs text-blue-300/80">成功率</div>
          </div>
          <div className="bg-amber-500/10 rounded-xl p-2.5 border border-amber-500/25">
            <div className="text-xl font-bold text-amber-300">
              {remediationStats?.waiting_approval || 0}
            </div>
            <div className="text-xs text-amber-300/80">待审批</div>
          </div>
          <div className="bg-red-500/10 rounded-xl p-2.5 border border-red-500/25">
            <div className="text-xl font-bold text-red-300">
              {remediationStats?.today.failed || 0}
            </div>
            <div className="text-xs text-red-300/80">失败/回滚</div>
          </div>
        </div>
        <div className="space-y-1.5 max-h-[120px] overflow-y-auto scrollbar-thin">
          {remediationStats?.recent_executions?.slice(0, 4).map((exec) => (
            <div
              key={exec.id}
              className="flex items-center justify-between p-1.5 bg-slate-700/30 rounded-lg border border-slate-700/40"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLOR_MAP[exec.status] || 'bg-slate-500'} ${exec.status === 'running' ? 'animate-pulse' : ''}`}
                />
                <span className="text-xs text-white truncate">{exec.policy_name}</span>
              </div>
              <div className="flex items-center gap-1.5 ml-2 shrink-0">
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${exec.status === 'success' ? 'bg-green-500/20 text-green-400' : exec.status === 'failed' ? 'bg-red-500/20 text-red-400' : exec.status === 'rolled_back' ? 'bg-yellow-500/20 text-yellow-400' : exec.status === 'waiting_approval' ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-700/50 text-slate-400'}`}
                >
                  {STATUS_TEXT_MAP[exec.status] || exec.status}
                </span>
              </div>
            </div>
          ))}
          {(!remediationStats?.recent_executions ||
            remediationStats.recent_executions.length === 0) && (
            <div className="flex items-center justify-center h-[80px] text-slate-500 text-xs">
              暂无修复记录
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
