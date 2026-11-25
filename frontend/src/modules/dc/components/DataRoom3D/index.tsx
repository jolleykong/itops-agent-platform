import { useState, useCallback, useMemo, useEffect, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardOverlay from './DashboardOverlay';
import RackFrontView from './RackFrontView';
import Room2DView from './Room2DView';
import useDataRoom from './useDataRoom';
import { getSchemeByKey, readColorSchemeKey, writeColorSchemeKey } from './theme';
import type { ViewMode } from './Scene';

// 3D 场景懒加载：默认纯 2D 模式下不加载 three.js（省体积也省 GPU）
const Scene = lazy(() => import('./Scene'));

/** 3D 模式开关的 localStorage 持久化键（默认关闭） */
const LS_KEY_3D = 'dc:3d-enabled';

function read3DEnabled(): boolean {
  try {
    return window.localStorage.getItem(LS_KEY_3D) === '1';
  } catch {
    return false;
  }
}

export default function DataRoom3D() {
  const navigate = useNavigate();
  const {
    loading,
    racks,
    overview,
    isReal,
    alerts,
    selectedRack,
    rackSlots,
    slotDetailOpen,
    startTime,
    fetchRackSlots,
    setSelectedRack,
    setSlotDetailOpen,
  } = useDataRoom();

  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredRackId, setHoveredRackId] = useState<string | null>(null);
  const [timeStr, setTimeStr] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('overview');
  // 3D 模式开关：默认关闭（纯 2D 平面视图），开启后挂载 Three.js 场景；偏好持久化
  const [threeDEnabled, setThreeDEnabled] = useState<boolean>(read3DEnabled);
  // 色彩方案：localStorage 持久化，默认深海蓝
  const [schemeKey, setSchemeKey] = useState<string>(readColorSchemeKey);
  const scheme = useMemo(() => getSchemeByKey(schemeKey), [schemeKey]);

  const handleToggle3D = useCallback(() => {
    setThreeDEnabled(prev => {
      const next = !prev;
      try {
        window.localStorage.setItem(LS_KEY_3D, next ? '1' : '0');
      } catch {
        // localStorage 不可用时仅内存态生效
      }
      return next;
    });
  }, []);

  const handleChangeScheme = useCallback((key: string) => {
    setSchemeKey(key);
    writeColorSchemeKey(key);
  }, []);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      const days = ['日', '一', '二', '三', '四', '五', '六'];
      setTimeStr(
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} 星期${days[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
      );
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  const uptime = useMemo(() => {
    const totalSec = Math.floor((Date.now() - startTime) / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    return `${days}天${hours}小时${mins}分`;
  }, [startTime, timeStr]);

  // 按视图模式过滤机柜（注意：Scene 内部按数组顺序算 col/row，过滤后位置会重排，因此 zoneA/zoneB 不再做区域过滤，由相机视角区分区域）
  const filteredRacks = useMemo(() => {
    let result = racks;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(r => r.name.toLowerCase().includes(q) || r.roomName?.toLowerCase().includes(q));
    }
    return result;
  }, [racks, searchQuery]);

  const handleRackClick = useCallback((rackId: string) => {
    const rack = racks.find(r => r.id === rackId);
    if (rack) {
      setSelectedRack(rack);
      setSlotDetailOpen(true);
      fetchRackSlots(rackId);
    }
  }, [racks, setSelectedRack, setSlotDetailOpen, fetchRackSlots]);

  const handleHoverChange = useCallback((rackId: string | null) => {
    setHoveredRackId(rackId);
  }, []);

  const handleNavigateDC = useCallback(() => {
    navigate('/dc-manage');
  }, [navigate]);

  const heatmapData = useMemo(() => {
    const map: Record<string, number> = {};
    racks.forEach(r => { map[r.id] = r.alertCount > 0 ? 1 : r.usedU / r.totalU; });
    return map;
  }, [racks]);

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center" style={{ background: scheme.bg }}>
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-20 h-20">
            <div className="absolute inset-0 border-2 rounded-full animate-spin"
              style={{ borderTopColor: scheme.accent, borderRightColor: scheme.accent, borderColor: `rgba(${scheme.accentRgb},0.15)` }} />
            <div className="absolute inset-2 border-2 rounded-full animate-spin-reverse"
              style={{ borderBottomColor: scheme.ok, borderLeftColor: scheme.ok, borderColor: `rgba(${scheme.okRgb},0.15)` }} />
            <div className="absolute inset-4 flex items-center justify-center">
              <span className="text-2xl" style={{ color: scheme.accent }}>◆</span>
            </div>
          </div>
          <span className="text-sm tracking-[4px]" style={{ color: scheme.muted }}>系统加载中</span>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative overflow-hidden" style={{ background: scheme.bg, backgroundImage: scheme.glow }}>
      <div className="absolute inset-0 pointer-events-none z-0"
        style={{
          backgroundImage: `linear-gradient(${scheme.grid} 1px, transparent 1px), linear-gradient(90deg, ${scheme.grid} 1px, transparent 1px)`,
          backgroundSize: '50px 50px',
        }}
      />

      <div className="absolute inset-0 z-10"
        style={{
          background: scheme.panelGradient,
          border: `1px solid ${scheme.panelBorder}`,
          borderRadius: '14px',
          overflow: 'hidden',
          margin: '8px',
          boxShadow: scheme.panelShadow,
        }}>
        {threeDEnabled ? (
          <Suspense fallback={null}>
            {/* scheme.key 作为 key：切换配色时重建场景，让 3D 材质/背景套用新方案 */}
            <Scene
              key={`scene-${schemeKey}`}
              racks={filteredRacks}
              onRackClick={handleRackClick}
              selectedRackId={selectedRack?.id || null}
              hoveredRackId={hoveredRackId}
              onHoverChange={handleHoverChange}
              heatmapData={heatmapData}
              viewMode={viewMode}
              scheme={scheme}
            />
          </Suspense>
        ) : (
          <Room2DView
            racks={filteredRacks}
            onRackClick={handleRackClick}
            selectedRackId={selectedRack?.id || null}
            hoveredRackId={hoveredRackId}
            onHoverChange={handleHoverChange}
            scheme={scheme}
          />
        )}
      </div>

      <DashboardOverlay
        overview={overview}
        racks={racks}
        alerts={alerts}
        timeStr={timeStr}
        uptime={uptime}
        isReal={isReal}
        searchQuery={searchQuery}
        viewMode={viewMode}
        threeDEnabled={threeDEnabled}
        scheme={scheme}
        onSearchChange={setSearchQuery}
        onViewModeChange={setViewMode}
        onToggle3D={handleToggle3D}
        onSchemeChange={handleChangeScheme}
        onNavigateDC={handleNavigateDC}
      />

      {slotDetailOpen && selectedRack && (
        <RackFrontView
          rack={selectedRack}
          slots={rackSlots}
          onClose={() => { setSlotDetailOpen(false); setSelectedRack(null); }}
          scheme={scheme}
        />
      )}
    </div>
  );
}
