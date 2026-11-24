import Servers from './servers/index';

/**
 * 操作系统管理（2026-11-24 资产分层）
 * 复用服务器管理页面组件，仅默认过滤 OS 层设备：
 * zbx 管理对象（description zbx: 前缀）、业务命名 OS 主机、手动添加的 SSH 管理对象等。
 * 分类规则见后端 serverAssetCategory.ts；数据不移动，仅视图分流。
 */
export default function OSManagement() {
  return <Servers category="os" title="操作系统管理" />;
}
