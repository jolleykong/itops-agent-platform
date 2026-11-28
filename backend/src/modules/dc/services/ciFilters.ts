/**
 * ciFilters — CMDB 关系展开的**唯一**过滤与命名规则源（2026-11-28 治理第一批）
 *
 * 背景：ciChainService（逐台展开）与 ciRelationGraphService（全量展开）曾各自
 * 复制一份正则与判断函数，已经出现行为漂移。本文件把规则收敛为一处，
 * 两个服务一律从这里引用 —— 改规则只改这里。
 *
 * 规则分类：
 *   · 残渣   __DUP_* 同步重复对象（cipipe itop-dedup 同类产物）
 *   · 弃用   status = inactive / obsolete（改名闭环淘汰的旧命名）
 *   · 占位   未关联时 iTop 写入的假关联值（ZBX-*-Unassigned）
 *   · LLD    -LLD 后缀为自动发现建的重复对象（与手工建档并存）
 *   · 命名   物理机硬件后缀、带外管理口命名
 */

// ============================================================
// 关系轴（基础类型，供 registry / graph / chain 共用，避免循环依赖）
// ============================================================

export type RelAxis = 'host' | 'storage' | 'network' | 'db' | 'rack' | 'os';

// ============================================================
// 残渣 / 弃用
// ============================================================

/** 同步重复残渣命名：`<原名>__DUP_<CLASS>_<序号>` */
export const RE_DUP_RESIDUE =
  /__DUP_(?:SERVER|VIRTUALMACHINE|HYPERVISOR|DBSERVER|NETWORKDEVICE|STORAGESYSTEM)_\d+$/;

/** LLD 自动发现对象后缀（与手工建档对象常并存为两份） */
export const RE_LLD_SUFFIX = /-LLD$/i;

/**
 * 弃用状态判定：status 未设置（NULL）/production/active 为正常；
 * inactive/obsolete 为改名闭环淘汰的旧命名或同步残渣。
 *
 * 注意：判定必须在代码层做，不能写进 OQL —— iTop 的 `!=` 会把 NULL 一起排除。
 */
export function isStaleStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').trim().toLowerCase();
  return s === 'inactive' || s === 'obsolete';
}

/** 残渣判定（命名层面） */
export function isDupResidue(name: string | null | undefined): boolean {
  return RE_DUP_RESIDUE.test(name ?? '');
}

/**
 * 链路可见性总判定：残渣或弃用状态的对象不进链路/关系图。
 * @param includeStale 仅供治理页「含残渣」视图使用
 */
export function isHiddenFromChain(
  name: string | null | undefined,
  status: string | null | undefined,
  includeStale = false,
): boolean {
  if (includeStale) return false;
  return isDupResidue(name) || isStaleStatus(status);
}

// ============================================================
// 占位关联（未关联时的假值）
// ============================================================

/** 未关联虚拟机/数据库时 iTop 写入的占位宿主名 */
export const PLACEHOLDER_HOSTS: ReadonlySet<string> = new Set([
  'ZBX-VM-Unassigned-Host',
  'ZBX-DB-Host-Unassigned',
]);

/** 是否为占位关联值（不产生关系边） */
export function isPlaceholderName(name: string | null | undefined): boolean {
  return !!name && PLACEHOLDER_HOSTS.has(name);
}

// ============================================================
// 物理机 / 操作系统层命名
// ============================================================

/** 带外管理口与通用前缀（这些前缀的对象不作为「硬件服务器」参与运行层匹配） */
const BAND_PREFIX = /^svr-(?:MGMT|iLo|idrac|bmc|imm)-[\d.]+-/i;

/**
 * 物理机硬件后缀：去掉 `svr-MGMT-<ip>-` 之类前缀后的机型标识，
 * 用于与 Zabbix OS 主机名做匹配。
 */
export function hardwareOsSuffix(serverName: string): string {
  return serverName.replace(BAND_PREFIX, '');
}

/** 是否为带外管理口命名（不参与运行层 OS 匹配） */
export function isBandManagementName(serverName: string): boolean {
  return BAND_PREFIX.test(serverName);
}

/** 物理机名是否为 svr-* 形态（运行层匹配的前置条件） */
export function isHardwareStyleName(serverName: string): boolean {
  return /^svr-/i.test(serverName);
}

// ============================================================
// 通用
// ============================================================

/** 字段取字符串（去空白；非字符串或空串返回 undefined） */
export function fieldStr(
  fields: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = fields[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 字段取数字（iTop 外键在 REST 中以整数返回；非数字返回 undefined） */
export function fieldNum(
  fields: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = fields[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** iTop REST 对象键 `Class::<id>` → 数字对象 id */
export function parseObjectId(key: string | number | undefined): number | undefined {
  if (typeof key === 'number') return key;
  if (!key) return undefined;
  const m = String(key).match(/::(\d+)$/);
  return m ? Number(m[1]) : undefined;
}
