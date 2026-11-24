import Servers from './servers/index';

/**
 * 服务器设备（2026-11-24 资产分层，原「服务器」子项改名并收窄为硬件层视图）
 * 仅显示硬件层设备：BMC 管理命名（svr-MGMT-/svr-iLo- 等）+ 台账登记的硬件 CI。
 * OS 层主机分流到 /os-management，存储设备分流到 /storage-devices。
 * 分类规则见后端 serverAssetCategory.ts；数据不移动，仅视图分流。
 */
export default function HardwareServers() {
  return <Servers category="hardware" title="服务器设备" />;
}
