/**
 * 机房 2D 平面视图（唯一展示形态）
 *
 * 2026-11-26 性能改造：
 * - 组件级 memo：父组件任何无关重渲染（如搜索输入）都不再重算整张网格
 * - 卡片 memo + 稳定回调：只有真正变化的机柜卡片重渲染
 * - 鼠标悬停改为纯 CSS（:hover），不再由 React state 驱动（原实现每次鼠标移动都重渲染整个页面）
 * - 每排容器启用 content-visibility: auto，屏幕外整排跳过绘制，258 台机柜滚动/重绘成本大幅下降
 * - 布局与 3D 场景保持一致：每 8 台一排
 */
import { memo, useMemo, type CSSProperties } from 'react';
import type { Rack3D } from './types';
import type { DcScheme } from './theme';

interface Room2DViewProps {
  racks: Rack3D[];
  onRackClick: (rackId: string) => void;
  selectedRackId?: string | null;
  scheme: DcScheme;
}

/** 每排机柜数（与历史 3D 布局一致，便于与既有台账对照） */
const COLS = 8;

/** 配色 token → CSS 变量，供 :hover 生效（内联样式优先级高于 class，故颜色统一走变量） */
function schemeVars(s: DcScheme): CSSProperties {
  return {
    '--c-bg': s.cardBg,
    '--c-bg-active': s.cardBgActive,
    '--c-border': s.cardBorder,
    '--c-border-active': s.cardBorderActive,
    '--c-warn-border': s.cardWarnBorder,
    '--c-glow': s.cardGlow,
    '--c-accent': s.accent,
    '--c-danger': s.danger,
  } as CSSProperties;
}

const CARD_CSS = `
.rack-card { background: var(--c-bg); border: 1px solid var(--c-border); }
.rack-card.is-warn { border-color: var(--c-warn-border); }
.rack-card:hover,
.rack-card.is-selected { background: var(--c-bg-active); border-color: var(--c-border-active); box-shadow: var(--c-glow); transform: translateY(-2px); }
.rack-card.is-warn:hover { border-color: var(--c-warn-border); }
.rack-card:hover .rack-name,
.rack-card.is-selected .rack-name { color: var(--c-accent); }
.rack-card.is-warn .rack-name { color: var(--c-danger); }
`;

function Room2DView({ racks, onRackClick, selectedRackId, scheme }: Room2DViewProps) {
  /** 按序号每 8 台分一排 */
  const rows = useMemo(() => {
    const groups: Rack3D[][] = [];
    racks.forEach((r, i) => {
      const row = Math.floor(i / COLS);
      if (!groups[row]) groups[row] = [];
      groups[row].push(r);
    });
    return groups;
  }, [racks]);

  const stats = useMemo(() => {
    const warn = racks.reduce((n, r) => n + (r.alertCount > 0 ? 1 : 0), 0);
    return { total: racks.length, warn };
  }, [racks]);

  const vars = useMemo(() => schemeVars(scheme), [scheme]);

  return (
    <div
      className="absolute inset-0 overflow-y-auto overflow-x-hidden"
      style={{ paddingLeft: '21%', paddingRight: 20, paddingTop: 128, paddingBottom: 100, ...vars }}
    >
      <style>{CARD_CSS}</style>

      {/* 图例 */}
      <div className="flex items-center gap-4 mb-3 pl-1">
        <span className="text-[11px] tracking-[1px]" style={{ color: scheme.muted }}>
          机房平面视图 · 共 {stats.total} 台机柜
        </span>
        {stats.warn > 0 && (
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: scheme.danger }}>
            <span
              className="w-2 h-2 rounded-sm"
              style={{ background: `rgba(${scheme.dangerRgb},0.5)`, border: `1px solid rgba(${scheme.dangerRgb},0.8)` }}
            />
            告警 {stats.warn}
          </span>
        )}
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: scheme.muted }}>
          <span className="w-2 h-2 rounded-sm" style={{ background: scheme.capFill }} />
          已用 U 位（自下而上）
        </span>
      </div>

      <div className="flex flex-col gap-5">
        {rows.map((row, ri) => (
          <div
            key={ri}
            className="flex items-stretch gap-3"
            style={{ contentVisibility: 'auto', containIntrinsicSize: '182px' }}
          >
            {/* 排标签 */}
            <div
              className="flex flex-col justify-center items-center w-12 shrink-0 rounded-lg"
              style={{ background: scheme.rowBg, border: `1px solid ${scheme.rowBorder}` }}
            >
              <span className="text-[11px] font-mono font-bold tracking-[1px]" style={{ color: scheme.accent }}>
                R{ri + 1}
              </span>
              <span className="text-[9px] mt-0.5" style={{ color: scheme.muted }}>
                {row.length}台
              </span>
            </div>

            {/* 机柜卡片行 */}
            <div className="flex flex-wrap gap-3 flex-1">
              {row.map(rack => (
                <RackCard2D
                  key={rack.id}
                  rack={rack}
                  selected={selectedRackId === rack.id}
                  onRackClick={onRackClick}
                  scheme={scheme}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 单个机柜 2D 卡片（memo：回调与 scheme 稳定时不随页面重渲染） */
const RackCard2D = memo(function RackCard2D({
  rack,
  selected,
  onRackClick,
  scheme,
}: {
  rack: Rack3D;
  selected: boolean;
  onRackClick: (rackId: string) => void;
  scheme: DcScheme;
}) {
  const pct = rack.totalU > 0 ? Math.min(100, Math.round((rack.usedU / rack.totalU) * 100)) : 0;
  const warn = rack.alertCount > 0;

  return (
    <button
      onClick={() => onRackClick(rack.id)}
      className={`rack-card relative flex flex-col items-center rounded-xl cursor-pointer transition-[transform,box-shadow,border-color,background] duration-200${warn ? ' is-warn' : ''}${selected ? ' is-selected' : ''}`}
      style={{ width: 96, padding: '8px 6px 7px' }}
    >
      {/* 告警角标（静态，不再脉冲动画） */}
      {warn && (
        <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full" style={{ background: scheme.danger }} />
      )}

      {/* 机柜名 */}
      <span
        className="rack-name text-[11px] font-mono font-bold mb-1.5 truncate max-w-full"
        style={{ color: scheme.text }}
        title={rack.name}
      >
        {rack.name}
      </span>

      {/* 机柜主体：竖向容量条，U1 在底部 */}
      <div
        className="relative w-full rounded-md overflow-hidden"
        style={{ height: 96, background: scheme.wellBg, border: `1px solid ${scheme.wellBorder}` }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: scheme.texture }} />
        <div
          className="absolute left-0 right-0 bottom-0"
          style={{ height: `${pct}%`, background: warn ? scheme.capWarnFill : scheme.capFill }}
        />
      </div>

      {/* 利用率 + 设备数 */}
      <span className="mt-1.5 text-[10px] font-mono font-bold" style={{ color: warn ? scheme.warn : scheme.accent }}>
        {pct}%
      </span>
      <span className="text-[9px] font-mono" style={{ color: scheme.muted }}>
        {rack.usedU}/{rack.totalU}U · {rack.deviceCount}台
      </span>
    </button>
  );
});

export default memo(Room2DView);
