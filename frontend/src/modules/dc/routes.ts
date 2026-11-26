import { lazy } from 'react';

const DataCenterManage = lazy(() => import('./pages/DataCenterManage'));
const DataRoom = lazy(() => import('./pages/DataRoom'));
const CmdbTopology = lazy(() => import('./pages/CmdbTopology'));

export const dcRoutes = [
  { path: 'dc-manage', element: DataCenterManage },
  { path: 'data-room', element: DataRoom },
  // CMDB 看板：占位页（展示方式待规划，2026-11-24；2026-11-26 由「CMDB拓扑结构」更名）
  { path: 'cmdb-topology', element: CmdbTopology },
];
