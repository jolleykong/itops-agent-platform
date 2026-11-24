import { lazy } from 'react';

const SSHKeys = lazy(() => import('./pages/SSHKeys'));
const TerminalPage = lazy(() => import('./pages/TerminalPage'));
const RemoteDesktop = lazy(() => import('./pages/RemoteDesktop'));
const StorageDevices = lazy(() => import('./pages/StorageDevices'));
const OSManagement = lazy(() => import('./pages/OSManagement'));
// /servers 收窄为硬件层视图（原「服务器」子项改名「服务器设备」）
const HardwareServers = lazy(() => import('./pages/HardwareServers'));

export const serverRoutes = [
  { path: 'servers', element: HardwareServers },
  // 资产分层视图（2026-11-24）：OS 层与存储设备从服务器列表分流展示
  { path: 'os-management', element: OSManagement },
  { path: 'storage-devices', element: StorageDevices },
  { path: 'ssh-keys', element: SSHKeys },
  { path: 'terminal', element: TerminalPage },
  { path: 'remote-desktop', element: RemoteDesktop },
  { path: 'remote-desktop/:serverId', element: RemoteDesktop },
];
