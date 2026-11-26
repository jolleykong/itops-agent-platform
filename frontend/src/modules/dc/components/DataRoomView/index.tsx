/**
 * 机房看板（原「机房3D监控」）
 *
 * 2026-11-26 改造：
 * - 永久移除 3D/WebGL 场景与 three.js 依赖，只保留 2D 平面视图
 * - 页面级状态收敛：时钟/在线时长下沉到 LiveClock，鼠标悬停改为纯 CSS，
 *   避免「每秒一次全量重渲染」与「鼠标划过即重渲染」
 * - 去除 backdrop-filter 毛玻璃、无限循环动画、drop-shadow 滤镜等
 *   在 2D 场景里没有视觉收益、但持续吃 CPU/GPU 的效果
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardOverlay from './DashboardOverlay';
import RackFrontView from './RackFrontView';
import Room2DView from './Room2DView';
import useDataRoom from './useDataRoom';
import { getSchemeByKey, readColorSchemeKey, writeColorSchemeKey } from './theme';

export default function DataRoomView() {
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
  // 色彩方案：localStorage 持久化，默认深海蓝
  const [schemeKey, setSchemeKey] = useState<string>(readColorSchemeKey);
  const scheme = useMemo(() => getSchemeByKey(schemeKey), [schemeKey]);

  const handleChangeScheme = useCallback((key: string) => {
    setSchemeKey(key);
    writeColorSchemeKey(key);
  }, []);

  const filteredRacks = useMemo(() => {
    if (!searchQuery.trim()) return racks;
    const q = searchQuery.toLowerCase();
    return racks.filter(r => r.name.toLowerCase().includes(q) || r.roomName?.toLowerCase().includes(q));
  }, [racks, searchQuery]);

  const handleRackClick = useCallback((rackId: string) => {
    const rack = racks.find(r => r.id === rackId);
    if (rack) {
      setSelectedRack(rack);
      setSlotDetailOpen(true);
      fetchRackSlots(rackId);
    }
  }, [racks, setSelectedRack, setSlotDetailOpen, fetchRackSlots]);

  const handleCloseRack = useCallback(() => {
    setSlotDetailOpen(false);
    setSelectedRack(null);
  }, [setSlotDetailOpen, setSelectedRack]);

  const handleNavigateDC = useCallback(() => {
    navigate('/dc-manage');
  }, [navigate]);

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center" style={{ background: scheme.bg }}>
        <div className="flex flex-col items-center gap-4">
          <div
            className="w-16 h-16 rounded-full border-2 animate-spin"
            style={{ borderTopColor: scheme.accent, borderRightColor: scheme.accent, borderColor: `rgba(${scheme.accentRgb},0.15)` }}
          />
          <span className="text-sm tracking-[4px]" style={{ color: scheme.muted }}>系统加载中</span>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative overflow-hidden" style={{ background: scheme.bg }}>
      <div
        className="absolute inset-0 z-10"
        style={{
          background: scheme.panelGradient,
          border: `1px solid ${scheme.panelBorder}`,
          borderRadius: '14px',
          overflow: 'hidden',
          margin: '8px',
        }}
      >
        <Room2DView
          racks={filteredRacks}
          onRackClick={handleRackClick}
          selectedRackId={selectedRack?.id || null}
          scheme={scheme}
        />
      </div>

      <DashboardOverlay
        overview={overview}
        racks={racks}
        alerts={alerts}
        isReal={isReal}
        startTime={startTime}
        searchQuery={searchQuery}
        scheme={scheme}
        onSearchChange={setSearchQuery}
        onSchemeChange={handleChangeScheme}
        onNavigateDC={handleNavigateDC}
      />

      {slotDetailOpen && selectedRack && (
        <RackFrontView
          rack={selectedRack}
          slots={rackSlots}
          onClose={handleCloseRack}
          scheme={scheme}
        />
      )}
    </div>
  );
}
