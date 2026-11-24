/**
 * 服务器资产分层（2026-11-24 定稿，与 iTop/台账数据治理口径一致）
 *
 * servers 表是混合数据源（iTop cmdb-sync 同步 + 手动添加 + Zabbix 导入），
 * 按「硬件层 / 操作系统层 / 存储设备」三个视图分流展示（数据不移动，仅分类过滤）：
 *
 *   hardware  硬件层（服务器设备页默认视图）
 *     - BMC 管理命名（svr-MGMT-/svr-iLo-/svr-idrac-/svr-bmc-/svr-imm-）→ 命名即硬件证据
 *     - description 含「台账登记」（台账导入的硬件 CI）
 *     注意优先级最高：如 svr-iLo-...-印章中心存储服务器 是 Dell R740xd 服务器，
 *     名字带「存储」也必须留在硬件层。
 *
 *   storage   存储设备（存储设备页）
 *     - name 为存储产品命名（Unity/OceanStor/Storwize/VNX/NetApp/MSA/3PAR/Ceph...）
 *     - 非 BMC 命名且 description 含「存储」（如台账登记的 NBU 存储/备份存储）
 *
 *   os        操作系统层（操作系统管理页）
 *     - 其余全部：zbx 管理对象（description zbx: 前缀）、业务命名 OS 主机、纯 IP、
 *       手动添加的 SSH 管理对象等——本质都是 OS 层主机
 */

const HARDWARE_NAME_RE = /^svr-(mgmt|ilo|idrac|bmc|imm)-/i;

const STORAGE_NAME_RE = /^(unity|oceanstor|storwize|vnx|netapp|msa|3par|datadomain|celerra|ceph|gluster|fujitsu.*eternus|huawei.*ocean)/i;

export type ServerAssetCategory = 'hardware' | 'os' | 'storage';

export function classifyServerAsset(
  name: string,
  description?: string | null,
): ServerAssetCategory {
  const desc = (description ?? '').trim();

  // 1) BMC 硬件命名优先（硬件层证据最硬）
  if (HARDWARE_NAME_RE.test(name)) return 'hardware';

  // 2) 存储产品命名 / 非 BMC 命名但描述含「存储」
  if (STORAGE_NAME_RE.test(name)) return 'storage';
  if (desc.includes('存储')) return 'storage';

  // 3) 台账登记的硬件 CI（无 BMC 命名的登记型硬件）
  if (desc.includes('台账登记')) return 'hardware';

  // 4) 其余全部归操作系统层
  return 'os';
}

export function classifyServerAssetRow(row: {
  name: string;
  description?: string | null;
}): ServerAssetCategory {
  return classifyServerAsset(row.name, row.description);
}
