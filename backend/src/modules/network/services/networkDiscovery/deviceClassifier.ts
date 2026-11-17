/**
 * 发现设备自动分类
 *
 * 依据 sysObjectID（SNMP 企业 OID 树）+ sysDescr/sysName（文本特征）对发现结果打
 * device_type 标签，避免把服务器带外管理卡（BMC）、存储、打印机一律当网络设备入库。
 *
 * 分类优先级：BMC 关键字/OID → 存储关键字 → 网络 OID 前缀 → 打印机 → 服务器 OS → 网络关键字 → unknown
 */

export type DeviceType = 'network' | 'server-bmc' | 'server-os' | 'storage' | 'printer' | 'unknown';

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  network: '网络设备',
  'server-bmc': '服务器 BMC',
  'server-os': '服务器 OS',
  storage: '存储设备',
  printer: '打印机',
  unknown: '未知',
};

/** 网络设备厂商企业 OID 前缀（私有企业树 .1.3.6.1.4.1 下） */
const NETWORK_OID_PREFIXES = [
  '.1.3.6.1.4.1.9.',       // Cisco
  '.1.3.6.1.4.1.2011.',    // Huawei
  '.1.3.6.1.4.1.25506.',   // H3C
  '.1.3.6.1.4.1.2636.',    // Juniper
  '.1.3.6.1.4.1.4881.',    // Ruijie
  '.1.3.6.1.4.1.14988.',   // MikroTik
  '.1.3.6.1.4.1.11863.',   // TP-Link
  '.1.3.6.1.4.1.41112.',   // Ubiquiti
  '.1.3.6.1.4.1.171.',     // ZTE
  '.1.3.6.1.4.1.6527.',    // Nokia
  '.1.3.6.1.4.1.890.',     // Zyxel
  '.1.3.6.1.4.1.12356.',   // Fortinet（防火墙）
  '.1.3.6.1.4.1.3224.',    // Huawei CSP
  '.1.3.6.1.4.1.30065.',   // Aruba/HPE Networking
  '.1.3.6.1.4.1.1916.',    // Extreme Networks
  '.1.3.6.1.4.1.289.',     // Brocade
  '.1.3.6.1.4.1.1588.',    // Brocade/FC switch
  '.1.3.6.1.4.1.4413.',    // Allied Telesis
];

/** BMC（带外管理控制器）OID 前缀 */
const BMC_OID_PREFIXES = [
  '.1.3.6.1.4.1.674.10890.', // Dell BMC
  '.1.3.6.1.4.1.674.10892.', // Dell iDRAC/DRAC（实测 674.10892.5）
  '.1.3.6.1.4.1.674.10893.', // Dell Remote Access
  '.1.3.6.1.4.1.2.3.51.',    // IBM IMM / Lenovo（实测 IMM2 = 2.3.51.3）
  '.1.3.6.1.4.1.232.',       // HP iLO（实测 232.9.4.11）
  '.1.3.6.1.4.1.343.',       // IBM
  '.1.3.6.1.4.1.13318.',     // AMI MegaRAC
];

/** OID 黑名单：这些前缀绝不按 OID 归类（如 net-snmp agent，Linux 服务器常见） */
const OID_EXCLUSIONS = ['.1.3.6.1.4.1.8072.'];

/** BMC 文本特征（sysDescr / sysName） */
const BMC_KEYWORDS: RegExp[] = [
  /iDRAC|Integrated Dell Remote Access|Remote Access Controller/i,
  /\bIMM2?\b|Integrated Management Module|XClarity|\bXCC\b/i,
  /Integrated Lights-Out|\biLO\b/i,
  /MegaRAC|AMI\s/i,
  /\bIEIB\b/i,
  /Supermicro/i,
  /\bBMC\b/i,
];

/** 存储设备文本特征 */
const STORAGE_KEYWORDS: RegExp[] = [
  /NetApp|PowerVault|Synology|QNAP|TrueNAS|FreeNAS|Ceph|Harvest/i,
  /Disk Storage|Unified Storage|Storage System|存储/i,
  /\bDSM\b|\bQTS\b/i,
];

/** 服务器操作系统文本特征 */
const SERVER_OS_KEYWORDS: RegExp[] = [
  /\bLinux\b|kernel/i,
  /VMware\s*ESXi|ESXi|vCenter/i,
  /\bFreeBSD\b|\bOpenBSD\b|\bNetBSD\b/i,
  /\bWindows\b/i,
  /net-snmp/i,
];

/** 打印机文本特征 */
const PRINTER_KEYWORDS: RegExp[] = [/LaserJet|printer|\bMFP\b|Print Server/i];

/** 网络设备文本特征（OID 未命中时的兜底） */
const NETWORK_KEYWORDS: RegExp[] = [
  /Cisco IOS|NX-OS|IOS XR|CatOS/i,
  /Comware|Versatile Routing Platform|Huawei/i,
  /RouterOS|MikroTik/i,
  /ProCurve|Aruba|ProVision/i,
  /FortiOS|FortiGate|EdgeOS|Fireware/i,
  /Ruijie|ZTE|ZXR10/i,
];

function matchKeyword(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function matchOid(oid: string, prefixes: string[]): boolean {
  if (!oid) return false;
  // net-snmp 返回的 OID 无前导点（如 1.3.6.1.4.1.2.3.51.3），统一归一化再比对
  const o = oid.startsWith('.') ? oid.slice(1) : oid;
  for (const ex of OID_EXCLUSIONS) {
    if (o.startsWith(ex.startsWith('.') ? ex.slice(1) : ex)) return false;
  }
  return prefixes.some((p) => o.startsWith(p.startsWith('.') ? p.slice(1) : p));
}

/**
 * 分类一台 SNMP 可达的设备
 */
export function classifyDevice(
  sysObjectID?: string | null,
  sysDescr?: string | null,
  sysName?: string | null,
): DeviceType {
  const text = `${sysDescr || ''} ${sysName || ''}`;

  // 1. BMC：OID 优先，其次关键字（iDRAC/iLO/IMM2 等命中即判）
  if (matchOid(sysObjectID || '', BMC_OID_PREFIXES)) return 'server-bmc';
  if (matchKeyword(text, BMC_KEYWORDS)) return 'server-bmc';

  // 2. 存储
  if (matchKeyword(text, STORAGE_KEYWORDS)) return 'storage';

  // 3. 网络设备 OID（企业 OID 树，比文本更可靠）
  if (matchOid(sysObjectID || '', NETWORK_OID_PREFIXES)) return 'network';

  // 4. 打印机
  if (matchKeyword(text, PRINTER_KEYWORDS)) return 'printer';

  // 5. 服务器 OS（Linux/ESXi/Windows 等）
  if (matchKeyword(text, SERVER_OS_KEYWORDS)) return 'server-os';

  // 6. 网络设备关键字兜底
  if (matchKeyword(text, NETWORK_KEYWORDS)) return 'network';

  return 'unknown';
}
