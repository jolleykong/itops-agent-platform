/**
 * 机房纯 2D 平面视图（默认展示模式）
 * - 不挂载 Three.js/WebGL，零 GPU 消耗
 * - 布局与 3D 场景一致：每 8 台一排（Scene 中 col = i % 8）
 * - 机柜卡片：竖向容量条（U1 在底部，与物理机柜一致）、利用率、设备数、告警状态
 * - 点击机柜 → 打开机柜正视图弹窗（与 3D 模式行为一致）
 * - 全部颜色来自 DcScheme 色彩方案 token
 */
import { useMemo } from 'react';
import type { Rack3D } from './types';
import type { DcScheme } from './theme';

interface Room2DViewProps {
  racks: Rack3D[];
  onRackClick: (rackId: string) => void;
  selectedRackId?: string | null;
  hoveredRackId?: string | null;
  onHoverChange?: (rackId: string | null) => void;
  scheme: DcScheme;
}

/** 每排机柜数，与 Scene.tsx 3D 布局保持一致 */
const COLS = 8;

export default function Room2DView({
  racks,
  onRackClick,
  selectedRackId,
  hoveredRackId,
  onHoverChange,
  scheme,
}: Room2DViewProps) {
  /** 按序号每 8 台分一排，与 3D 场景行列布局一致 */
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
    const total = racks.length;
    const warn = racks.filter(r => r.alertCount > 0).length;
    return { total, warn };
  }, [racks]);

  return (
    <div
      className="absolute inset-0 overflow-y-auto overflow-x-hidden"
      style={{ paddingLeft: '21%', paddingRight: 20, paddingTop: 128, paddingBottom: 100 }}
    >
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
          <div key={ri} className="flex items-stretch gap-3">
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
                  hovered={hoveredRackId === rack.id}
                  onClick={() => onRackClick(rack.id)}
                  onHover={onHoverChange}
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

/** 单个机柜 2D 卡片 */
function RackCard2D({
  rack,
  selected,
  hovered,
  onClick,
  onHover,
  scheme,
}: {
  rack: Rack3D;
  selected: boolean;
  hovered: boolean;
  onClick: () => void;
  onHover?: (rackId: string | null) => void;
  scheme: DcScheme;
}) {
  const pct = rack.totalU > 0 ? Math.min(100, Math.round((rack.usedU / rack.totalU) * 100)) : 0;
  const warn = rack.alertCount > 0;
  const active = selected || hovered;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => onHover?.(rack.id)}
      onMouseLeave={() => onHover?.(null)}
      className="relative flex flex-col items-center rounded-xl border transition-all duration-200 cursor-pointer"
      style={{
        width: 96,
        padding: '8px 6px 7px',
        background: active ? scheme.cardBgActive : scheme.cardBg,
        borderColor: warn ? scheme.cardWarnBorder : active ? scheme.cardBorderActive : scheme.cardBorder,
        boxShadow: active ? scheme.cardGlow : warn ? `0 0 10px rgba(${scheme.dangerRgb},0.15)` : 'none',
        transform: active ? 'translateY(-2px)' : 'none',
      }}
    >
      {/* 告警角标 */}
      {warn && (
        <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full animate-pulse" style={{ background: scheme.danger }} />
      )}

      {/* 机柜名 */}
      <span
        className="text-[11px] font-mono font-bold mb-1.5 truncate max-w-full"
        style={{ color: warn ? scheme.danger : active ? scheme.accent : scheme.text }}
        title={rack.name}
      >
        {rack.name}
      </span>

      {/* 机柜主体：竖向容量条，U1 在底部 */}
      <div
        className="relative w-full rounded-md overflow-hidden"
        style={{ height: 96, background: scheme.wellBg, border: `1px solid ${scheme.wellBorder}` }}
      >
        {/* U 位横线纹理 */}
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: scheme.texture }} />
        {/* 已用容量（自底部向上填充） */}
        <div
          className="absolute left-0 right-0 bottom-0 transition-all duration-500"
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
}
