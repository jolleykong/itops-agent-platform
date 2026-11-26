/**
 * 机房查看悬浮层（顶栏 + 指标 + 左侧机柜状态 + 配色 + 底部告警）
 *
 * 2026-11-26 性能改造：
 * - 移除 backdrop-filter 毛玻璃（大面板叠加时是最贵的合成操作）
 * - 移除 animate-ping / animate-pulse / 无限滚动跑马灯等常驻动画
 * - 移除 drop-shadow 滤镜
 * - 时钟与在线时长交给 LiveClock，本组件不再因秒级时间变化而重渲染
 */
import { memo, useMemo } from 'react';
import { COLOR_SCHEMES } from './theme';
import type { DcScheme } from './theme';
import type { OverviewData, OverviewSummary, Rack3D, AlertItem } from './types';
import { LiveClock, LiveUptime } from './LiveClock';

interface DashboardOverlayProps {
  overview: OverviewData | null;
  racks: Rack3D[];
  alerts: AlertItem[];
  isReal: boolean;
  /** 页面打开时间（用于在线时长） */
  startTime: number;
  searchQuery: string;
  /** 当前色彩方案 */
  scheme: DcScheme;
  onSearchChange: (q: string) => void;
  /** 切换色彩方案 */
  onSchemeChange: (key: string) => void;
  onNavigateDC: () => void;
}

function DashboardOverlay({
  overview,
  racks,
  alerts,
  isReal,
  startTime,
  searchQuery,
  scheme,
  onSearchChange,
  onSchemeChange,
  onNavigateDC,
}: DashboardOverlayProps) {
  const summary: OverviewSummary = overview?.summary || {
    totalDevices: 0, onlineDevices: 0, alertDevices: 0,
    offlineDevices: 0, avgTemp: 0, avgHumidity: 0, totalRacks: 0,
  };

  const pue = overview?.pue ?? 0;
  // 后端 overview 返回 totalPowerKw（已是 kW），直接用
  const totalPower = (overview as { totalPowerKw?: number } | undefined)?.totalPowerKw ?? overview?.totalPower ?? 0;
  const coolingPower = overview?.coolingPower ?? 0;
  const itPower = overview?.itPower ?? 0;

  // 左侧机柜状态列表（只取前 12 台，避免长列表拖慢首屏）
  const rackStatusList = useMemo(
    () => racks.slice(0, 12).map(r => ({
      name: r.name,
      pct: r.totalU > 0 ? Math.round((r.usedU / r.totalU) * 100) : 0,
      warn: r.alertCount > 0,
    })),
    [racks],
  );

  // 底部告警条：静态展示前 6 条（原为无限滚动，持续重绘）
  const alertItems = useMemo(
    () => alerts.slice(0, 6).map(a => ({
      time: a.time || '',
      msg: a.title || '',
      level: (a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'info') as 'critical' | 'warning' | 'info',
    })),
    [alerts],
  );

  // 仅保留 hover 态样式（不含任何常驻动画）
  const css = useMemo(() => `
    .dc-metric:hover { border-color: rgba(${scheme.accentRgb},0.4) !important; box-shadow: 0 0 16px rgba(${scheme.accentRgb},0.22) !important; }
    .dc-navbtn:hover { background: rgba(${scheme.accentRgb},0.15); }
  `, [scheme]);

  const metrics = [
    { label: 'PUE', value: pue > 0 ? pue.toFixed(2) : '--', icon: '⚡', color: scheme.accent, rgb: scheme.accentRgb },
    { label: '总功耗', value: totalPower > 0 ? `${totalPower.toFixed(1)} kW` : '--', icon: '🔌', color: scheme.accent, rgb: scheme.accentRgb },
    { label: '制冷功耗', value: coolingPower > 0 ? `${coolingPower.toFixed(1)} kW` : '--', icon: '❄', color: scheme.accent, rgb: scheme.accentRgb },
    { label: 'IT功耗', value: itPower > 0 ? `${itPower.toFixed(1)} kW` : '--', icon: '💻', color: scheme.accent, rgb: scheme.accentRgb },
    { label: '平均温度', value: summary.avgTemp > 0 ? `${summary.avgTemp.toFixed(1)}°C` : '--', icon: '🌡', color: scheme.ok, rgb: scheme.okRgb },
    { label: '平均湿度', value: summary.avgHumidity > 0 ? `${summary.avgHumidity}%` : '--', icon: '💧', color: scheme.accent, rgb: scheme.accentRgb },
    { label: '设备总数', value: summary.totalDevices.toLocaleString(), icon: '🖥', color: scheme.accent, rgb: scheme.accentRgb },
    { label: '在线', value: summary.onlineDevices.toLocaleString(), icon: '✅', color: scheme.ok, rgb: scheme.okRgb },
    { label: '告警', value: summary.alertDevices, icon: '⚠', color: scheme.warn, rgb: scheme.warnRgb },
    { label: '离线', value: summary.offlineDevices, icon: '❌', color: scheme.danger, rgb: scheme.dangerRgb },
  ];

  return (
    <>
      <style>{css}</style>

      {/* ── 顶部标题栏 ── */}
      <div
        className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-8 py-2.5 border-b"
        style={{ background: scheme.topBarGradient, borderColor: scheme.panelBorder }}
      >
        <div className="flex items-center gap-5">
          <LiveClock color={scheme.muted} />
          <span className="text-[11px] tracking-[0.5px]" style={{ color: scheme.modalTextMuted }}>
            在线 <LiveUptime startTime={startTime} color={scheme.muted} />
          </span>
        </div>

        <h1 className="text-2xl font-bold tracking-[5px]" style={{ color: scheme.text }}>
          机房查看
        </h1>

        <div className="flex items-center gap-4">
          <div
            className="flex items-center gap-1.5 px-3 py-1 rounded-full"
            style={{ background: `rgba(${scheme.okRgb},0.1)`, border: `1px solid rgba(${scheme.okRgb},0.3)` }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: scheme.ok }} />
            <span className="text-[11px]" style={{ color: scheme.ok }}>{isReal ? '系统运行正常' : '演示模式'}</span>
          </div>
          <button
            onClick={onNavigateDC}
            className="dc-navbtn px-4 py-1.5 rounded-full text-[11px] transition-colors"
            style={{ background: `rgba(${scheme.accentRgb},0.08)`, border: `1px solid rgba(${scheme.accentRgb},0.2)`, color: scheme.accent }}
          >
            数据中心管理
          </button>
        </div>
      </div>

      {/* ── 指标卡片行 ── */}
      <div className="absolute top-14 left-4 right-4 z-20 flex gap-2.5 overflow-x-auto">
        {metrics.map((m, i) => (
          <div
            key={i}
            className="dc-metric flex-1 min-w-[110px] flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-colors"
            style={{ background: scheme.surface, border: `1px solid ${scheme.surfaceBorder}` }}
          >
            <div className="flex items-center justify-center w-9 h-9 rounded-[10px] text-xl" style={{ background: `rgba(${m.rgb},0.08)` }}>
              {m.icon}
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-[0.5px]" style={{ color: scheme.muted }}>{m.label}</span>
              <span className="text-base font-bold font-mono" style={{ color: m.color }}>{m.value}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── 左侧面板 ── */}
      <div className="absolute left-4 top-36 bottom-20 z-20 w-[18%] flex flex-col gap-3">
        {/* 搜索 */}
        <div className="rounded-2xl p-3" style={{ background: scheme.surface, border: `1px solid ${scheme.surfaceBorder}` }}>
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: scheme.muted }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="搜索机柜名称..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg focus:outline-none transition-colors"
              style={{ background: scheme.inputBg, border: `1px solid rgba(${scheme.accentRgb},0.15)`, color: scheme.text }}
            />
          </div>
        </div>

        {/* 机柜状态 */}
        <div className="flex-1 rounded-2xl overflow-hidden flex flex-col" style={{ background: scheme.surface, border: `1px solid ${scheme.surfaceBorder}` }}>
          <div
            className="flex items-center gap-2 px-4 py-3 border-b"
            style={{ background: `linear-gradient(to right, rgba(${scheme.accentRgb},0.06), transparent)`, borderColor: scheme.panelBorder }}
          >
            <span className="text-sm">🗄</span>
            <h3 className="text-[13px] font-semibold tracking-[1px]" style={{ color: scheme.text }}>机柜状态</h3>
            <span className="ml-auto text-[10px]" style={{ color: scheme.muted }}>{racks.length} 台</span>
          </div>
          <div className="flex-1 p-4 flex flex-col gap-2.5 overflow-y-auto">
            {rackStatusList.length > 0 ? rackStatusList.map((r, i) => (
              <div key={i} className="flex items-center gap-2 py-1">
                <span className="w-10 text-[11px] font-mono font-medium truncate" style={{ color: scheme.muted }} title={r.name}>{r.name}</span>
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: scheme.barTrack }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${r.pct}%`,
                      background: r.warn
                        ? `linear-gradient(to right, rgba(${scheme.dangerRgb},0.9), rgba(${scheme.warnRgb},0.9))`
                        : `linear-gradient(to right, rgba(${scheme.accentRgb},0.6), ${scheme.accent})`,
                    }}
                  />
                </div>
                <span className="w-8 text-right text-[11px] font-mono" style={{ color: scheme.muted }}>{r.pct}%</span>
              </div>
            )) : (
              <div className="text-center text-[11px] py-4" style={{ color: scheme.muted }}>暂无数据</div>
            )}
          </div>
        </div>
      </div>

      {/* ── 配色方案切换 ── */}
      <div
        className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 py-1.5 rounded-full"
        style={{ background: scheme.surface, border: `1px solid ${scheme.surfaceBorder}` }}
      >
        <div className="flex items-center gap-1.5 px-1 py-1" title="切换配色方案">
          <span className="text-[10px] tracking-[0.5px] mr-0.5" style={{ color: scheme.muted }}>配色</span>
          {COLOR_SCHEMES.map(s => (
            <button
              key={s.key}
              onClick={() => onSchemeChange(s.key)}
              title={`${s.label}${scheme.key === s.key ? '（当前）' : ''}`}
              className="w-4 h-4 rounded-full"
              style={{
                background: `linear-gradient(135deg, ${s.bg} 55%, ${s.accent} 55%)`,
                border: scheme.key === s.key ? `2px solid ${s.accent}` : '1px solid rgba(128,128,128,0.5)',
              }}
            />
          ))}
        </div>
      </div>

      {/* ── 底部告警条（静态，不再滚动） ── */}
      <div
        className="absolute bottom-0 left-0 right-0 z-20 h-12 flex items-center border-t px-6"
        style={{ background: scheme.bottomBarGradient, borderColor: scheme.panelBorder }}
      >
        <div className="flex items-center gap-2 pr-3 flex-shrink-0" style={{ borderRight: `1px solid ${scheme.panelBorder}` }}>
          <span className="text-sm">🔔</span>
          <span className="text-xs font-semibold tracking-[0.5px]" style={{ color: scheme.danger }}>实时告警</span>
          <span className="px-2 py-0.5 rounded-full text-white text-[10px] font-bold" style={{ background: scheme.danger }}>{summary.alertDevices}</span>
        </div>
        <div className="flex-1 ml-3 overflow-hidden whitespace-nowrap">
          {alertItems.length > 0 ? (
            <div className="flex gap-6">
              {alertItems.map((a, i) => (
                <div
                  key={i}
                  className="inline-flex items-center gap-1.5 text-[11px] flex-shrink-0 max-w-[320px]"
                  style={{ color: a.level === 'critical' ? scheme.danger : a.level === 'warning' ? scheme.warn : scheme.accent }}
                >
                  <span className="font-mono" style={{ color: scheme.muted }}>{a.time}</span>
                  <span style={{ color: `rgba(${scheme.accentRgb},0.2)` }}>|</span>
                  <span className="truncate" title={a.msg}>{a.msg}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px]" style={{ color: scheme.muted }}>暂无告警</div>
          )}
        </div>
      </div>
    </>
  );
}

export default memo(DashboardOverlay);
