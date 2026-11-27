import { lazy } from 'react';

/**
 * CMDB 驾驶舱原型模块路由（2026-11-27 demo）。
 * 四个 CIO 大屏 + 六个功能页，内容与样式移植自用户原型
 * /AI_Project/CMDB前端UI原型.html，演示数据，待评审后接真实数据源。
 */
const ScreenResource = lazy(() =>
  import('./pages').then((m) => ({ default: m.ScreenResource })));
const ScreenCostCapacity = lazy(() =>
  import('./pages').then((m) => ({ default: m.ScreenCostCapacity })));
const ScreenServiceRisk = lazy(() =>
  import('./pages').then((m) => ({ default: m.ScreenServiceRisk })));
const ScreenCompliance = lazy(() =>
  import('./pages').then((m) => ({ default: m.ScreenCompliance })));
const WorkbenchPage = lazy(() =>
  import('./pages').then((m) => ({ default: m.WorkbenchPage })));
const TopoCanvasPage = lazy(() =>
  import('./pages').then((m) => ({ default: m.TopoCanvasPage })));
const IpamPage = lazy(() =>
  import('./pages').then((m) => ({ default: m.IpamPage })));
const ImpactAnalysisPage = lazy(() =>
  import('./pages').then((m) => ({ default: m.ImpactAnalysisPage })));
const CiDetailPage = lazy(() =>
  import('./pages').then((m) => ({ default: m.CiDetailPage })));
const OpsObjectsPage = lazy(() =>
  import('./pages').then((m) => ({ default: m.OpsObjectsPage })));

export const cmdbPortalRoutes = [
  { path: 'screens/resource', element: ScreenResource },
  { path: 'screens/cost-capacity', element: ScreenCostCapacity },
  { path: 'screens/service-risk', element: ScreenServiceRisk },
  { path: 'screens/compliance', element: ScreenCompliance },
  { path: 'workbench', element: WorkbenchPage },
  { path: 'topo-canvas', element: TopoCanvasPage },
  { path: 'ipam', element: IpamPage },
  { path: 'impact-analysis', element: ImpactAnalysisPage },
  { path: 'ci-detail', element: CiDetailPage },
  { path: 'ops-objects', element: OpsObjectsPage },
];
