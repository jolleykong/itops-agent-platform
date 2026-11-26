/* ========== 机房看板类型定义 ========== */

/** 机柜 3D 数据 */
export interface Rack3D {
  id: string;
  name: string;
  roomName: string;
  roomLabel: string;
  row: number;
  totalU: number;
  usedU: number;
  deviceCount: number;
  alertCount: number;
  deviceStatus: string;
  /** 3D 场景 X 坐标 */
  sceneX?: number;
  /** 3D 场景 Z 坐标 */
  sceneZ?: number;
}

/** 机柜 U 位设备 */
export interface SlotInfo {
  id: string;
  startU: number;
  endU: number;
  deviceName: string;
  /** 平台设备 id（servers/network_devices/dc_pdus 主键；other 占位=设备名） */
  deviceId?: string;
  deviceType: string;
  deviceStatus: string | null;
  cpuUsage: number | null;
  memUsage: number | null;
  diskUsage: number | null;
}

/** 概览统计 */
export interface OverviewSummary {
  totalDevices: number;
  onlineDevices: number;
  alertDevices: number;
  offlineDevices: number;
  avgTemp: number;
  avgHumidity: number;
  totalRacks: number;
  usedU?: number;
}

export interface OverviewData {
  summary: OverviewSummary;
  pue?: number;
  totalPower?: number;
  coolingPower?: number;
  itPower?: number;
  rackData?: Rack3D[];
  [key: string]: unknown;
}

/** 告警项 */
export interface AlertItem {
  id: string;
  title: string;
  severity: string;
  source?: string;
  time?: string;
}
