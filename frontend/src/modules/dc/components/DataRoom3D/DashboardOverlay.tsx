import { COLOR_SCHEMES } from './theme';
import type { DcScheme } from './theme';
import type { OverviewData, OverviewSummary, Rack3D, AlertItem } from './types';
import type { ViewMode } from './Scene';

interface DashboardOverlayProps {
  overview: OverviewData | null;
  racks: Rack3D[];
  alerts: AlertItem[];
  timeStr: string;
  uptime: string;
  isReal: boolean;
  searchQuery: string;
  viewMode: ViewMode;
  /** 3D 模式开关状态（默认关闭，纯 2D 平面视图） */
  threeDEnabled: boolean;
  /** 当前色彩方案 */
  scheme: DcScheme;
  onSearchChange: (q: string) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onToggle3D: () => void;
  /** 切换色彩方案 */
  onSchemeChange: (key: string) => void;
  onNavigateDC: () => void;
}

export default function DashboardOverlay({
  overview,
  racks,
  alerts,
  timeStr,
  isReal,
  searchQuery,
  viewMode,
  threeDEnabled,
  scheme,
  onSearchChange,
  onViewModeChange,
  onToggle3D,
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

  // 使用真实机柜数据生成左侧机柜状态列表
  const rackStatusList = racks.slice(0, 12).map(r => ({
    name: r.name,
    pct: r.totalU > 0 ? Math.round((r.usedU / r.totalU) * 100) : 0,
    warn: r.alertCount > 0,
  }));

  // 使用真实告警数据生成底部告警条
  const alertItems = alerts.length > 0
    ? alerts.slice(0, 10).map(a => ({
        time: a.time || '',
        msg: a.title || '',
        level: (a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'info') as 'critical' | 'warning' | 'info',
      }))
    : [];

  const viewModes: { key: ViewMode; label: string }[] = [
    { key: 'overview', label: '总览' },
    { key: 'zoneA', label: 'A区' },
    { key: 'zoneB', label: 'B区' },
  ];

  return (
    <>
      <style>{`
        .dc-metric:hover { border-color: rgba(${scheme.accentRgb},0.4) !important; box-shadow: 0 0 20px rgba(${scheme.accentRgb},0.3) !important; transform: translateY(-2px); }
        .dc-navbtn:hover { background: rgba(${scheme.accentRgb},0.15); }
        .dc-viewbtn-active { background: linear-gradient(to right, rgba(${scheme.accentRgb},0.2), rgba(${scheme.accentRgb},0.08)); color: ${scheme.accent}; box-shadow: 0 0 12px rgba(${scheme.accentRgb},0.15); }
        .dc-viewbtn:hover { color: ${scheme.accent}; background: rgba(${scheme.accentRgb},0.1); }
        @keyframes gradient {
          0%, 100% { background-position: 0% center; }
          50% { background-position: 200% center; }
        }
        .animate-gradient { animation: gradient 4s ease infinite; }
        @keyframes scroll-alerts {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .animate-scroll-alerts { animation: scroll-alerts 30s linear infinite; }
      `}</style>

      {/* ── 顶部标题栏 ── */}
      <div
        className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-8 py-2.5 backdrop-blur-xl border-b"
        style={{ background: scheme.topBarGradient, borderColor: scheme.panelBorder }}
      >
        <div className="flex items-center gap-5">
          <span className="text-[12px] font-mono tracking-[0.5px]" style={{ color: scheme.muted }}>{timeStr}</span>
        </div>

        <h1 className="text-2xl font-bold tracking-[5px]" style={{ color: scheme.accent }}>
          <span className="text-xs animate-pulse" style={{ color: scheme.ok }}>◆</span>
          {' '}
          <span style={{ color: scheme.text }}>机房数字孪生监控平台</span>
          {' '}
          <span className="text-xs animate-pulse" style={{ color: scheme.ok }}>◆</span>
        </h1>

        <div className="flex items-center gap-4">
          <div
            className="flex items-center gap-1.5 px-3 py-1 rounded-full"
            style={{ background: `rgba(${scheme.okRgb},0.1)`, border: `1px solid rgba(${scheme.okRgb},0.3)` }}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute w-full h-full rounded-full animate-ping opacity-60" style={{ background: scheme.ok }} />
              <span className="relative w-full h-full rounded-full" style={{ background: scheme.ok }} />
            </span>
            <span className="text-[11px]" style={{ color: scheme.ok }}>{isReal ? '系统运行正常' : '演示模式'}</span>
          </div>
          <button
            onClick={onNavigateDC}
            className="dc-navbtn px-4 py-1.5 rounded-full text-[11px] transition-all"
            style={{ background: `rgba(${scheme.accentRgb},0.08)`, border: `1px solid rgba(${scheme.accentRgb},0.2)`, color: scheme.accent }}
          >
            数据中心管理
          </button>
        </div>
      </div>

      {/* ── 指标卡片行 ── */}
      <div className="absolute top-14 left-4 right-4 z-20 flex gap-2.5 overflow-x-auto">
        {[
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
        ].map((m, i) => (
          <div
            key={i}
            className="dc-metric flex-1 min-w-[110px] flex items-center gap-2.5 px-3 py-2.5 rounded-xl backdrop-blur-xl transition-all"
            style={{ background: scheme.surface, border: `1px solid ${scheme.surfaceBorder}` }}
          >
            <div
              className="flex items-center justify-center w-9 h-9 rounded-[10px] text-xl"
              style={{ background: `rgba(${m.rgb},0.08)` }}
            >
              {m.icon}
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-[0.5px]" style={{ color: scheme.muted }}>{m.label}</span>
              <span className="text-base font-bold font-mono" style={{ color: m.color, filter: `drop-shadow(0 0 6px rgba(${m.rgb},0.3))` }}>
                {m.value}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* ── 左侧面板 ── */}
      <div className="absolute left-4 top-36 bottom-20 z-20 w-[18%] flex flex-col gap-3">
        {/* 搜索 */}
        <div className="rounded-2xl backdrop-blur-xl p-3" style={{ background: scheme.surface, border: `1px solid ${scheme.surfaceBorder}` }}>
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: scheme.muted }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="搜索机柜名称..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg focus:outline-none transition-all"
              style={{
                background: scheme.inputBg,
                border: `1px solid rgba(${scheme.accentRgb},0.15)`,
                color: scheme.text,
              }}
            />
          </div>
        </div>

        {/* 机柜状态 */}
        <div className="flex-1 rounded-2xl backdrop-blur-xl overflow-hidden flex flex-col" style={{ background: scheme.surface, border: `1px solid ${scheme.surfaceBorder}` }}>
          <div
            className="flex items-center gap-2 px-4 py-3 border-b"
            style={{ background: `linear-gradient(to right, rgba(${scheme.accentRgb},0.06), transparent)`, borderColor: scheme.panelBorder }}
          >
            <span className="text-sm">🗄</span>
            <h3 className="text-[13px] font-semibold tracking-[1px]" style={{ color: scheme.text }}>机柜状态</h3>
          </div>
          <div className="flex-1 p-4 flex flex-col gap-2.5 overflow-y-auto">
            {rackStatusList.length > 0 ? rackStatusList.map((r, i) => (
              <div key={i} className="flex items-center gap-2 py-1">
                <span className="w-10 text-[11px] font-mono font-medium" style={{ color: scheme.muted }}>{r.name}</span>
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: scheme.barTrack }}>
                  <div
                    className="h-full rounded-full transition-all duration-800"
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

      {/* ── 场景控制条：3D 模式开关（常驻）+ 配色方案 + 视角切换（仅 3D 开启时） ── */}
      <div
        className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-2 py-1 rounded-full backdrop-blur-xl"
        style={{ background: scheme.surface, border: `1px solid ${scheme.surfaceBorder}` }}
      >
        {threeDEnabled && viewModes.map((v) => (
          <button
            key={v.key}
            onClick={() => onViewModeChange(v.key)}
            className={`px-4 py-2 rounded-full text-xs font-medium tracking-[0.5px] transition-all ${
              viewMode === v.key ? 'dc-viewbtn-active' : 'dc-viewbtn'
            }`}
            style={viewMode === v.key ? undefined : { color: scheme.muted }}
          >
            {v.label}
          </button>
        ))}

        {/* 配色方案切换 */}
        <div className="flex items-center gap-1.5 px-2 py-1" title="切换配色方案">
          <span className="text-[10px] tracking-[0.5px] mr-0.5" style={{ color: scheme.muted }}>配色</span>
          {COLOR_SCHEMES.map(s => (
            <button
              key={s.key}
              onClick={() => onSchemeChange(s.key)}
              title={`${s.label}${scheme.key === s.key ? '（当前）' : ''}`}
              className="w-4 h-4 rounded-full transition-all"
              style={{
                background: s.dark
                  ? `linear-gradient(135deg, ${s.bg} 55%, ${s.accent} 55%)`
                  : `linear-gradient(135deg, ${s.bg} 55%, ${s.accent} 55%)`,
                border: scheme.key === s.key ? `2px solid ${s.accent}` : '1px solid rgba(128,128,128,0.5)',
                boxShadow: scheme.key === s.key ? `0 0 8px rgba(${s.accentRgb},0.5)` : 'none',
              }}
            />
          ))}
        </div>

        <button
          onClick={onToggle3D}
          title={threeDEnabled ? '切换到 2D 平面视图（更省资源）' : '开启 3D 立体场景'}
          className="flex items-center gap-2 px-3 py-1.5 rounded-full transition-all dc-navbtn"
        >
          <span
            className="text-xs font-medium tracking-[0.5px]"
            style={{ color: threeDEnabled ? scheme.accent : scheme.muted }}
          >
            3D 模式
          </span>
          <span
            className="relative inline-block w-9 h-5 rounded-full transition-all duration-200"
            style={{
              background: threeDEnabled ? `rgba(${scheme.accentRgb},0.35)` : scheme.barTrack,
              boxShadow: threeDEnabled ? `0 0 8px rgba(${scheme.accentRgb},0.3)` : 'none',
            }}
          >
            <span
              className="absolute top-0.5 w-4 h-4 rounded-full transition-all duration-200"
              style={{
                left: threeDEnabled ? 18 : 2,
                background: threeDEnabled ? scheme.accent : scheme.muted,
              }}
            />
          </span>
        </button>
      </div>

      {/* ── 底部告警条 ── */}
      <div
        className="absolute bottom-0 left-0 right-0 z-20 h-12 flex items-center backdrop-blur-xl border-t px-6"
        style={{ background: scheme.bottomBarGradient, borderColor: scheme.panelBorder }}
      >
        <div className="flex items-center gap-2 pr-3 flex-shrink-0" style={{ borderRight: `1px solid ${scheme.panelBorder}` }}>
          <span className="text-sm">🔔</span>
          <span className="text-xs font-semibold tracking-[0.5px]" style={{ color: scheme.danger }}>实时告警</span>
          <span className="px-2 py-0.5 rounded-full text-white text-[10px] font-bold" style={{ background: scheme.danger }}>{summary.alertDevices}</span>
        </div>
        <div className="flex-1 ml-3 overflow-hidden relative"
          style={{ maskImage: 'linear-gradient(90deg, transparent, black 2%, black 98%, transparent)' }}>
          {alertItems.length > 0 ? (
            <div className="flex gap-6 animate-scroll-alerts whitespace-nowrap">
              {[...alertItems, ...alertItems].map((a, i) => (
                <div
                  key={i}
                  className="inline-flex items-center gap-1.5 text-[11px] flex-shrink-0"
                  style={{ color: a.level === 'critical' ? scheme.danger : a.level === 'warning' ? scheme.warn : scheme.accent }}
                >
                  <span className="font-mono" style={{ color: scheme.muted }}>{a.time}</span>
                  <span style={{ color: `rgba(${scheme.accentRgb},0.2)` }}>|</span>
                  <span>{a.msg}</span>
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
