import DataRoomView from '../../../modules/dc/components/DataRoomView';

/**
 * 机房看板页面入口
 *
 * 2026-11-26：原「机房3D监控」更名为「机房看板」，永久移除 3D/WebGL 场景，
 * 因此不再需要 WebGL 能力检测与降级提示（2D 平面视图在任意浏览器均可运行）。
 *
 * 同时去掉 big-screen-scope 包裹：该 class 用 !important 强制深色背景，
 * 会覆盖「素白」等浅色配色方案，且整页 radial-gradient 会带来额外合成开销。
 */
export default function DataRoom() {
  return (
    <div className="relative w-full h-full overflow-hidden">
      <DataRoomView />
    </div>
  );
}
