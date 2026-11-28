/**
 * relationRegistry — CMDB 上级关系的**声明式**规则表（2026-11-28 治理第一批）
 *
 * 目的：把「哪个类的哪个字段指向哪个类、属于哪条关系轴」从散落的 if/else
 * 收敛成一张表，ciChainService（逐台展开）与 ciRelationGraphService（全量展开）
 * 共用。新增一条关系 = 加一行，不需要在两处写两遍。
 *
 * 关联方式（治理核心）：
 *   优先用**数字外键**（idField，iTop 表里的 int 列）精确 join；
 *   仅当数字外键缺失/为 0 时才降级用友好名文本（nameField）兜底，
 *   并且降级次数会被统计上报（stats.nameFallback），让「还在靠文本匹配」
 *   这件事始终可见，而不是被悄悄掩盖。
 *
 * 注意：这里只描述**上级**（parents）方向。下级的反查是 OQL 表达式，
 * 形状不同，仍由 ciChainService 的 CHILDREN_QUERIES 负责。
 */
import type { RelAxis } from './ciFilters';

export interface ParentRule {
  /** 关系轴 */
  axis: RelAxis;
  /** 本端 iTop 类 */
  fromClass: string;
  /** 数字外键字段名（精确 join 首选） */
  idField: string;
  /** 友好名兜底字段（数字外键缺失时降级） */
  nameField: string;
  /** 目标类候选，按顺序优先匹配 */
  toClasses: string[];
  /** 关系展示文案 */
  relation: string;
}

/** 全部上级关系规则（顺序无关，同 fromClass 可有多条） */
export const PARENT_RULES: readonly ParentRule[] = [
  // ── 宿主轴：VM → 虚拟化宿主 → 物理机 ──
  {
    axis: 'host',
    fromClass: 'VirtualMachine',
    idField: 'virtualhost_id',
    nameField: 'virtualhost_id_friendlyname',
    toClasses: ['Hypervisor'],
    relation: '虚拟化宿主',
  },
  {
    axis: 'host',
    fromClass: 'Hypervisor',
    idField: 'server_id',
    nameField: 'server_id_friendlyname',
    toClasses: ['Server'],
    relation: '物理服务器',
  },
  // ── 数据库：实例 → 承载对象（可为物理机或虚拟机）──
  {
    axis: 'db',
    fromClass: 'DBServer',
    idField: 'system_id',
    nameField: 'system_id_friendlyname',
    toClasses: ['Server', 'VirtualMachine', 'Hypervisor'],
    relation: '承载对象',
  },
  // ── 位置轴：设备 → 机柜 ──
  ...(['Server', 'NetworkDevice', 'StorageSystem', 'PDU', 'UPS'] as const).map(
    (cls): ParentRule => ({
      axis: 'rack',
      fromClass: cls,
      idField: 'rack_id',
      nameField: 'rack_id_friendlyname',
      toClasses: ['Rack'],
      relation: '所在机柜',
    }),
  ),
  // ── 存储轴（2026-11-28）：卷 → 所属存储系统 ──
  // 由 cipipe `storage push` 从 Zabbix 采集的 LUN/卷写入 LogicalVolume。
  // 注意：**卷 → 主机**的挂载关系（lnkServerToVolume）仍未采集，
  // 所以存储轴只能到「存储系统 ← 卷」，到不了主机；缺口由 aiops gaps 显式报出。
  {
    axis: 'storage',
    fromClass: 'LogicalVolume',
    idField: 'storagesystem_id',
    nameField: 'storagesystem_id_friendlyname',
    toClasses: ['StorageSystem'],
    relation: '所属存储系统',
  },
];

/** 取某类的全部上级规则 */
export function parentRulesFor(cls: string): ParentRule[] {
  return PARENT_RULES.filter(r => r.fromClass === cls);
}

/**
 * 每类需要拉取的 iTop 字段集（全量展开用）：
 * 基础字段 + 该类的数字外键 + 对应友好名（兜底与展示都需）。
 * 只列确认存在的字段，避免个别类缺列导致整查失败。
 */
const BASE_FIELDS = ['name', 'status'];

const EXTRA_FIELDS: Record<string, string[]> = {
  Server: ['managementip', 'brand_name', 'model_name', 'serialnumber'],
  Hypervisor: ['managementip'],
  VirtualMachine: ['managementip', 'osfamily_name'],
  DBServer: [],
  NetworkDevice: ['managementip', 'brand_name', 'model_name'],
  StorageSystem: ['brand_name', 'model_name'],
  Rack: [],
  LogicalVolume: ['lun_id', 'size'],
  PDU: [],
  UPS: [],
};

/** 组装某类的 output_fields */
export function fieldsForClass(cls: string, withRelations = true): string {
  const set = new Set<string>([...BASE_FIELDS, ...(EXTRA_FIELDS[cls] ?? [])]);
  if (withRelations) {
    for (const r of parentRulesFor(cls)) {
      set.add(r.idField);
      set.add(r.nameField);
    }
  }
  return [...set].join(',');
}

/**
 * 关系轴展示定义（前端与后端共用语义，后端用于统计与缺口提示）
 */
export const AXIS_META: Record<RelAxis, { label: string; desc: string }> = {
  network: { label: '网络轴', desc: '本机 → 观测交换机 → 上联 → 核心/出口' },
  storage: { label: '存储轴', desc: '本机 → 存储卷 → 存储系统' },
  host: { label: '宿主轴', desc: '虚拟机 → 虚拟化宿主 → 物理机' },
  db: { label: '数据库', desc: '数据库实例 → 承载对象' },
  rack: { label: '位置', desc: '设备 → 所在机柜' },
  os: { label: '运行层', desc: '物理机 → 操作系统（Zabbix）' },
};
