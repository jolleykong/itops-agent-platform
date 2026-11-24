import { lazy } from 'react';

const DataCenterManage = lazy(() => import('./pages/DataCenterManage'));
const DataRoom = lazy(() => import('./pages/DataRoom'));
const CmdbTopology = lazy(() => import('./pages/CmdbTopology'));

export const dcRoutes = [
  { path: 'dc-manage', element: DataCenterManage },
  { path: 'data-room', element: DataRoom },
  // CMDB 拓扑结构：占位页（展示方式待规划，2026-11-24）
  { path: 'cmdb-topology', element: CmdbTopology },
];
