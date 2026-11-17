/**
 * Zabbix Agent 通道指标采集器（v062）
 *
 * 为 conn_type='zabbix' 的服务器提供与 SSH 通道对等的采集能力：
 *   - collectServerMetrics：CPU/内存/磁盘/网络/load/uptime → server_metrics（复用 insertMetrics，前端图表无感）
 *   - collectServerInfo：OS/CPU 核数/内存/磁盘总量 → servers 静态信息字段
 *   - checkAvailability：Zabbix Agent 接口 available 状态作为连接测试
 *
 * 数据来源：Zabbix item.get 最新值（lastvalue/lastclock/units），经 key_ 模式映射。
 * 仅调用只读 API（host.get / item.get），不触碰 EnableRemoteCommands/system.run。
 */

import { v4 as uuidv4 } from 'uuid';
import { serversRepo } from '../../../repositories/serverRepository';
import { zabbixService, type ZabbixItem } from './zabbixService';
import { zabbixConnectionStore } from './zabbixConnectionStore';
import { detectOSType } from '../../scripts/services/commandDispatcher';
import { logger } from '../../../utils/logger';

/** item 最新值超过该秒数视为陈旧（Agent 掉线/模板禁用），按 0 处理 */
const STALE_SECONDS = 900;

export interface ZabbixServerRef {
  id: string;
  name: string;
  conn_type: string;
  zabbix_hostid: string | null;
}

export class ZabbixChannelError extends Error {}

/** 单位换算：字节 → GB */
function bytesToGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** item 值转数字（Zabbix 可能返回空串/''） */
function toNum(item: ZabbixItem | undefined): number {
  if (!item?.lastvalue) return 0;
  const n = parseFloat(item.lastvalue);
  return isNaN(n) ? 0 : n;
}

/** 项目是否新鲜（lastclock 缺失视为可接受） */
function isFresh(item: ZabbixItem | undefined): boolean {
  if (!item?.lastclock) return true;
  const clock = parseInt(item.lastclock, 10);
  if (!clock) return true;
  return Date.now() / 1000 - clock <= STALE_SECONDS;
}

/** 在 items 中按 key 前缀筛选 */
function findByKey(items: ZabbixItem[], pattern: RegExp): ZabbixItem[] {
  return items.filter((it) => pattern.test(it.key_ ?? ''));
}

/** 取第一个匹配且新鲜的 item */
function pick(items: ZabbixItem[], pattern: RegExp, opts: { prefer?: (key: string) => boolean; avoid?: (key: string) => boolean } = {}): ZabbixItem | undefined {
  const matched = findByKey(items, pattern);
  if (matched.length === 0) return undefined;
  const fresh = matched.filter(isFresh);
  const pool = fresh.length > 0 ? fresh : []; // 陈旧项直接视为缺失 → 0
  if (pool.length === 0) return undefined;
  if (opts.prefer) {
    const preferred = pool.filter((it) => opts.prefer!(it.key_));
    if (preferred.length > 0) return preferred[0];
  }
  if (opts.avoid) {
    const avoided = pool.filter((it) => !opts.avoid!(it.key_));
    if (avoided.length > 0) return avoided[0];
  }
  return pool[0];
}

/** 磁盘路径排序权重：'/' 最优，/dev /sys /run /proc tmpfs 排除 */
function diskPathWeight(key: string): number {
  const m = key.match(/^vfs\.fs\.size\[([^,\]]*)/i);
  const path = (m?.[1] ?? '').trim();
  if (path === '/') return 0;
  if (/^\/(dev|sys|proc|run)/i.test(path) || /tmpfs|overlay|squashfs/i.test(path)) return 100;
  return 10 + path.length / 1000;
}

/** 网卡选择：取吞吐最大的主网卡（单网卡场景即唯一值） */
function pickNetInterface(items: ZabbixItem[], direction: 'in' | 'out'): ZabbixItem | undefined {
  const matched = findByKey(items, new RegExp(`^net\\.if\\.${direction}\\[`, 'i')).filter(isFresh);
  if (matched.length === 0) return undefined;
  return matched.reduce((best, cur) =>
    (parseFloat(cur.lastvalue ?? '0') || 0) > (parseFloat(best.lastvalue ?? '0') || 0) ? cur : best
  );
}

/** 网络速率 → Mbps（units: bps / Bps / 无） */
function netToMbps(item: ZabbixItem | undefined): number {
  if (!item) return 0;
  const v = toNum(item);
  const units = (item.units ?? '').toLowerCase();
  if (units === 'bps') return v / 1e6;
  if (units === 'mbps') return v;
  return (v * 8) / 1e6; // Bps 或无单位（默认字节/秒）
}

class ZabbixMetricCollector {
  /** 取认证 + 校验 hostid；失败抛 ZabbixChannelError（上层转为友好错误） */
  private async getContext(server: ZabbixServerRef): Promise<{ auth: string; hostid: string }> {
    if (server.conn_type !== 'zabbix') {
      throw new ZabbixChannelError('非 Zabbix 通道服务器');
    }
    if (!server.zabbix_hostid) {
      throw new ZabbixChannelError('该服务器未关联 Zabbix hostid，请先在监控模块完成关联');
    }
    const config = zabbixConnectionStore.get();
    if (!config) {
      throw new ZabbixChannelError('后端未配置 Zabbix 连接（监控 → Zabbix 查询 → 连接配置），无法采集');
    }
    const auth = await zabbixConnectionStore.resolveAuth(config);
    if (!auth) {
      throw new ZabbixChannelError('Zabbix 认证失败（token 无效或用户名/密码错误）');
    }
    return { auth, hostid: server.zabbix_hostid };
  }

  /** 拉取一个主机的全部监控项最新值 */
  private async fetchItems(auth: string, hostid: string): Promise<ZabbixItem[]> {
    const result = await zabbixService.getItems(auth, [hostid], {
      // 必须显式带 URL（rpcRequest 无 url 直接报「Zabbix URL 未配置」）
      url: zabbixConnectionStore.get()?.url ?? '',
      output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'units', 'state', 'status', 'type'],
    });
    if (!result.success || !result.data) {
      throw new ZabbixChannelError(result.error ?? 'item.get 失败');
    }
    // 只保留已启用且支持的数值型监控项
    return (result.data as ZabbixItem[]).filter((it) => it.status !== '1' && it.state !== '1');
  }

  /**
   * 采集实时指标并写入 server_metrics。
   * 返回结构与 SSH 通道 ServerMetricsResult.data 一致。
   */
  async collectServerMetrics(serverId: string): Promise<{ success: boolean; error?: string }> {
    const server = serversRepo.getById(serverId) as unknown as ZabbixServerRef | undefined;
    if (!server) return { success: false, error: 'Server not found' };

    try {
      const { auth, hostid } = await this.getContext(server);
      const items = await this.fetchItems(auth, hostid);

      // ── CPU 使用率：system.cpu.util 系，优先 avg1 ──
      const cpuItem = pick(items, /^system\.cpu\.util/i, {
        prefer: (k) => /avg1/i.test(k) || /all/i.test(k),
        avoid: (k) => /avg5|avg15|guest/i.test(k),
      });
      let cpu_usage = isFresh(cpuItem) ? Math.min(100, Math.max(0, toNum(cpuItem))) : 0;

      // ── 内存 ──
      const memTotal = pick(items, /^vm\.memory\.size\[.*total/i);
      const memUsed = pick(items, /^vm\.memory\.size\[.*used/i);
      const memPavail = pick(items, /^vm\.memory\.size\[.*pavailable/i);
      let memory_total_gb = bytesToGb(toNum(memTotal));
      let memory_used_gb = bytesToGb(toNum(memUsed));
      let memory_usage = memory_total_gb > 0 ? (memory_used_gb / memory_total_gb) * 100 : 0;
      if (memPavail && isFresh(memPavail)) {
        const pused = 100 - Math.min(100, Math.max(0, toNum(memPavail)));
        memory_usage = pused;
        if (memory_total_gb > 0) memory_used_gb = (memory_total_gb * pused) / 100;
      }

      // ── 磁盘（根分区优先）──
      const diskUsageItem = pick(items, /^vfs\.fs\.size\[.*pused/i, { prefer: () => false, avoid: () => false });
      const diskTotalItem = pick(items, /^vfs\.fs\.size\[.*total/i, {
        prefer: (k) => diskPathWeight(k) <= 1,
        avoid: (k) => diskPathWeight(k) >= 100,
      });
      const diskUsedItem = pick(items, /^vfs\.fs\.size\[.*used/i, {
        prefer: (k) => diskPathWeight(k) <= 1,
        avoid: (k) => diskPathWeight(k) >= 100,
      });
      const diskTotalBytes = toNum(diskTotalItem);
      const diskUsedBytes = toNum(diskUsedItem);
      const disk_usage = diskUsageItem && isFresh(diskUsageItem)
        ? Math.min(100, Math.max(0, toNum(diskUsageItem)))
        : diskTotalBytes > 0 ? (diskUsedBytes / diskTotalBytes) * 100 : 0;

      // ── 网络 ──
      let netIn = pickNetInterface(items, 'in');
      let netOut = pickNetInterface(items, 'out');

      // ── load：system.cpu.load 系 ──
      const loadItem = (mode: string) => pick(items, /^system\.cpu\.load/i, {
        prefer: (k) => new RegExp(`avg${mode}`).test(k) && !/cpu\d+/.test(k),
      });
      const load1 = loadItem('1');
      const load5 = loadItem('5');
      const load15 = loadItem('15');

      // ── uptime ──
      const uptimeItem = pick(items, /^system\.uptime/i);
      let uptime_seconds = toNum(uptimeItem);

      // ── VMware vCenter 回退映射（vmware.vm.*：虚机经 vCenter 监控、无 Agent 接口时
      //    没有任何经典 Agent key，必须从此类项取值，否则全部记 0）──
      const vmCpuPerf = pick(items, /^vmware\.vm\.cpu\.usage\.perf\[/i);
      if (cpu_usage === 0 && vmCpuPerf) cpu_usage = Math.min(100, Math.max(0, toNum(vmCpuPerf)));

      const vmMemTotal = findByKey(items, /^vmware\.vm\.memory\.size\[/i)[0];
      const vmMemUsed = pick(items, /^vmware\.vm\.memory\.size\.usage\.guest\[/i);
      if (memory_total_gb === 0 && vmMemTotal) {
        memory_total_gb = bytesToGb(toNum(vmMemTotal));
        memory_used_gb = bytesToGb(toNum(vmMemUsed));
        if (memory_total_gb > 0 && memory_used_gb > 0) memory_usage = (memory_used_gb / memory_total_gb) * 100;
      }

      if (!netIn) netIn = pick(items, /^vmware\.vm\.net\.if\.in\[.*bps\]/i);
      if (!netOut) netOut = pick(items, /^vmware\.vm\.net\.if\.out\[.*bps\]/i);

      if (uptime_seconds === 0) {
        const vmUptime = pick(items, /^vmware\.vm\.uptime\[/i);
        if (vmUptime) uptime_seconds = toNum(vmUptime);
      }

      const data = {
        cpu_usage,
        memory_usage: Math.min(100, Math.max(0, memory_usage)),
        memory_total_gb,
        memory_used_gb,
        disk_usage,
        disk_total_gb: bytesToGb(diskTotalBytes),
        disk_used_gb: bytesToGb(diskUsedBytes),
        network_in_mbps: Math.round(netToMbps(netIn) * 100) / 100,
        network_out_mbps: Math.round(netToMbps(netOut) * 100) / 100,
        load_1min: toNum(load1),
        load_5min: toNum(load5),
        load_15min: toNum(load15),
        uptime_seconds,
      };

      serversRepo.insertMetrics({ id: uuidv4(), server_id: serverId, ...data });
      logger.info(`Zabbix metrics collected for ${server.name} (${serverId}): CPU=${data.cpu_usage?.toFixed(1)}% MEM=${data.memory_usage?.toFixed(1)}%`);
      return { success: true };
    } catch (err) {
      if (err instanceof ZabbixChannelError) return { success: false, error: err.message };
      logger.error(`Zabbix metrics collection failed for ${serverId}:`, err);
      return { success: false, error: err instanceof Error ? err.message : 'Zabbix 采集失败' };
    }
  }

  /** 采集静态系统信息（OS/CPU 核数/内存/磁盘总量）并更新 servers */
  async collectServerInfo(serverId: string): Promise<{ success: boolean; error?: string }> {
    const server = serversRepo.getById(serverId) as unknown as ZabbixServerRef | undefined;
    if (!server) return { success: false, error: 'Server not found' };

    try {
      const { auth, hostid } = await this.getContext(server);
      const items = await this.fetchItems(auth, hostid);

      const unameItem = pick(items, /^(system\.uname|system\.hostname)/i, { avoid: (k) => /sw\.os/i.test(k) });
      const uname = unameItem?.lastvalue?.trim() ?? '';
      const osType = detectOSType(uname || 'linux');

      const cpuNumItem = pick(items, /^system\.cpu\.num/i);
      const memTotalItem = pick(items, /^vm\.memory\.size\[.*total/i);
      const diskTotalItem = pick(items, /^vfs\.fs\.size\[.*total/i, {
        prefer: (k) => diskPathWeight(k) <= 1,
        avoid: (k) => diskPathWeight(k) >= 100,
      });

      // VMware 回退：虚机无 Agent 项时从 vmware.vm.* 取核数/内存。
      // memory.size / cpu.num 是容量型配置项（更新频率低），不做新鲜度过滤
      const vmCpuNum = findByKey(items, /^vmware\.vm\.cpu\.num\[/i)[0];
      const vmMemTotal = findByKey(items, /^vmware\.vm\.memory\.size\[/i)[0];

      const existing = serversRepo.getById(serverId);
      // 不用 hostname 兜底 IP 字段（VMware 虚机无接口 IP 时 hostname 是可见名）
      const ipAddress = existing?.ip_address || null;
      const os = uname || existing?.os || 'Unknown';

      serversRepo.updateSystemInfo(serverId, {
        os,
        cpu_cores: Math.round(toNum(cpuNumItem)) || Math.round(toNum(vmCpuNum)) || existing?.cpu_cores || 0,
        memory_gb: bytesToGb(toNum(memTotalItem)) || bytesToGb(toNum(vmMemTotal)) || existing?.memory_gb || 0,
        disk_gb: bytesToGb(toNum(diskTotalItem)) || existing?.disk_gb || 0,
        ip_address: ipAddress,
        private_ip: ipAddress,
        os_type: osType,
      });

      logger.info(`Zabbix server info collected for ${server.name} (${serverId}), OS: ${osType}`);
      return { success: true };
    } catch (err) {
      if (err instanceof ZabbixChannelError) return { success: false, error: err.message };
      logger.error(`Zabbix info collection failed for ${serverId}:`, err);
      return { success: false, error: err instanceof Error ? err.message : 'Zabbix 采集失败' };
    }
  }

  /** Zabbix Agent 接口可用性检测（作为 conn_type='zabbix' 的连接测试） */
  async checkAvailability(serverId: string): Promise<{ success: boolean; message: string }> {
    const server = serversRepo.getById(serverId) as unknown as ZabbixServerRef | undefined;
    if (!server) return { success: false, message: 'Server not found' };

    try {
      const { auth, hostid } = await this.getContext(server);
      const result = await zabbixService.getHostsDetail(auth, [hostid], {
        url: zabbixConnectionStore.get()?.url ?? '',
      });
      if (!result.success || !result.data || result.data.length === 0) {
        return { success: false, message: result.error ?? 'Zabbix host.get 失败（主机可能已删除）' };
      }
      const ifs = Array.isArray(result.data[0].interfaces) ? result.data[0].interfaces : [];
      const agentIfs = ifs.filter((i) => i.type === '1');
      const target = agentIfs.length > 0 ? agentIfs : ifs;
      const hasAvailable = target.some((i) => String(i.available ?? '0') === '1');
      if (hasAvailable) {
        return { success: true, message: 'Zabbix Agent 可用（接口 available=1）' };
      }
      // VMware 虚机/应用级监控主机没有真正的 Agent 接口（available 恒 0），
      // 改用监控项新鲜度判断采集链路是否正常
      const itemsRes = await zabbixService.getItems(auth, [hostid], {
        url: zabbixConnectionStore.get()?.url ?? '',
        output: ['itemid', 'lastclock'],
      });
      const clocks = ((itemsRes.data ?? []) as Array<{ lastclock?: string }>)
        .map((i) => parseInt(i.lastclock ?? '0', 10))
        .filter((n) => n > 0);
      const newest = clocks.length > 0 ? Math.max(...clocks) : 0;
      if (newest > 0 && Date.now() / 1000 - newest <= 1800) {
        return { success: true, message: 'Zabbix 数据采集中（VMware/应用级监控项，无 Agent 接口）' };
      }
      return { success: false, message: 'Zabbix Agent 接口不可用（available≠1）且监控项无新鲜数据，Agent 未上线或监控项全部异常' };
    } catch (err) {
      if (err instanceof ZabbixChannelError) return { success: false, message: err.message };
      return { success: false, message: err instanceof Error ? err.message : 'Zabbix 可用性检测失败' };
    }
  }
}

export const zabbixMetricCollector = new ZabbixMetricCollector();
