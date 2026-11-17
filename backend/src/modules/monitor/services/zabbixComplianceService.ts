/**
 * Zabbix 通道合规检查（2026-11-17）
 *
 * 为 conn_type='zabbix'（Zabbix API）与 conn_type='zabbix_agent'（直连）服务器
 * 提供与 SSH 通道对等的合规检查能力。
 *
 * 设计边界：
 *   - Zabbix 通道是只读监控通道（不持有 SSH 凭据，SSH 执行已被连接池守卫拒绝），
 *     因此合规检查只覆盖「监控项级」数据；命令类检查（SSH 配置/防火墙/登录记录等）
 *     在 Agent 官方监控项中不存在，明确标记为不适用而非伪造数据。
 *   - 仅调用只读 API（host.get / item.get）与 Agent 被动检查查询，
 *     不触碰 EnableRemoteCommands / system.run。
 *   - AI 分析与合规历史保存复用 sshComplianceService 的统一入口（runComplianceCheck）。
 */

import { serversRepo } from '../../../repositories/serverRepository';
import { logger } from '../../../utils/logger';
import { zabbixMetricCollector } from './zabbixMetricCollector';
import { zabbixAgentDirectCollector } from './zabbixAgentDirectCollector';
import type { CommandResult } from '../../servers/services/sshService/sshTypes';

/** 格式化秒数为人类可读 uptime */
function formatUptime(seconds: number): string {
  if (!seconds || seconds <= 0) return '0';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}天${h}小时${m}分` : h > 0 ? `${h}小时${m}分` : `${m}分`;
}

function bytesToGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** 命令类检查项：Zabbix 监控项体系中不存在对应数据源 */
const COMMAND_ONLY_CHECKS = ['SSH Config', 'Firewall Status', 'Last Logins', 'Cron Jobs', 'Package Updates', 'Running Services'];

function naResult(checkName: string, channelLabel: string): CommandResult {
  const cmd = COMMAND_ONLY_CHECKS.includes(checkName)
    ? `(不适用) ${checkName} 需要主机内命令执行能力`
    : `(不适用) ${checkName}`;
  return {
    success: false,
    stdout: 'N/A',
    stderr: `Zabbix 通道（只读监控）无法执行命令类检查。该检查项需要 SSH 通道，或检查 Zabbix 侧是否有对应监控项模板。`,
    command: cmd,
    duration: 0,
    error: `检查项在 ${channelLabel} 下不可用`,
  };
}

// ============================================================================
//  conn_type='zabbix'：Zabbix API item.get 监控项级检查
// ============================================================================

interface ApiItem { key: string; value: string; units: string; clock?: string }

function fmtItem(items: Record<string, ApiItem>, re: RegExp): ApiItem | undefined {
  const hit = Object.values(items).find((it) => re.test(it.key));
  return hit;
}

/** 从 items 构造各检查项结果；缺数据的项给出明确的缺失原因而非 0 伪造 */
function buildApiCheckResults(
  serverName: string,
  items: Record<string, ApiItem>,
): Record<string, CommandResult> {
  const results: Record<string, CommandResult> = {};
  const mk = (name: string, ok: boolean, stdout: string, cmd: string, stderr = '', missing = false): void => {
    results[name] = {
      success: ok && !missing,
      stdout: ok && !missing ? stdout : 'N/A',
      stderr: missing ? `未在 Zabbix 中找到匹配的监控项（模板未配置或主机未采集）。command-only=${COMMAND_ONLY_CHECKS.includes(name)}` : stderr,
      command: cmd,
      duration: 0,
      error: missing ? '监控项缺失' : undefined,
    };
  };

  // CPU Usage
  const cpu = fmtItem(items, /^system\.cpu\.util/);
  if (cpu) mk('CPU Usage', true, `CPU 使用率: ${cpu.value}${cpu.units || '%'}`, cpu.key);
  else mk('CPU Usage', false, '', 'system.cpu.util[...]', '', true);

  // Memory Usage
  const memTotal = fmtItem(items, /^vm\.memory\.size\[.*total/i);
  const memAvail = fmtItem(items, /^vm\.memory\.size\[.*available/i);
  if (memTotal && memAvail) {
    const total = parseFloat(memTotal.value) || 0;
    const avail = parseFloat(memAvail.value) || 0;
    const pct = total > 0 ? ((total - avail) / total * 100).toFixed(1) : '0';
    mk('Memory Usage', true, `内存使用率: ${pct}%（总计 ${bytesToGb(total)}GB / 可用 ${bytesToGb(avail)}GB）`, `${memTotal.key} + ${memAvail.key}`);
  } else mk('Memory Usage', false, '', 'vm.memory.size[total] + [available]', '', true);

  // Disk Usage（根分区优先，兼容 vfs.fs.size / vfs.fs.dependent.size）
  const diskMatch = Object.values(items).filter((it) => /^vfs\.fs\.(?:dependent\.)?size\[.*pused\]/i.test(it.key))
    .sort((a, b) => {
      const w = (k: string) => (/\[\//.test(k) && !/\[\/(dev|sys|proc|run)/i.test(k) ? 0 : 10);
      return w(a.key) - w(b.key);
    })[0];
  if (diskMatch) mk('Disk Usage', true, `根分区使用率: ${diskMatch.value}${diskMatch.units || '%'}`, diskMatch.key);
  else mk('Disk Usage', false, '', 'vfs.fs.size[*,pused]', '', true);

  // Network Info（取吞吐最大的主网卡）
  const netIn = Object.values(items).filter((it) => /^net\.if\.in\[/.test(it.key))
    .reduce((best, cur) => (parseFloat(cur.value) || 0) > (parseFloat(best?.value) || 0) ? cur : best, undefined as ApiItem | undefined);
  const netOut = Object.values(items).filter((it) => /^net\.if\.out\[/.test(it.key))
    .reduce((best, cur) => (parseFloat(cur.value) || 0) > (parseFloat(best?.value) || 0) ? cur : best, undefined as ApiItem | undefined);
  if (netIn && netOut) {
    mk('Network Info', true, `入口 ${netIn.value}${netIn.units || 'bps'} / 出口 ${netOut.value}${netOut.units || 'bps'}`, `${netIn.key} + ${netOut.key}`);
  } else mk('Network Info', false, '', 'net.if.in[...] + net.if.out[...]', '', true);

  // User List：监控项只有数量
  const users = fmtItem(items, /^system\.users\.num/);
  if (users) mk('User List', true, `系统用户数: ${users.value}（完整用户清单需 SSH 通道）`, users.key);
  else mk('User List', false, '', 'system.users.num', '', true);

  // Uptime
  const uptime = fmtItem(items, /^system\.uptime/);
  if (uptime) mk('Uptime', true, `运行时长: ${formatUptime(parseFloat(uptime.value))}（${uptime.value}s）`, uptime.key);
  else mk('Uptime', false, '', 'system.uptime', '', true);

  // OS Info
  const uname = fmtItem(items, /^system\.uname/) ?? fmtItem(items, /^system\.sw\.os/);
  if (uname) mk('OS Info', true, uname.value, uname.key);
  else mk('OS Info', false, '', 'system.uname / system.sw.os', '', true);

  // 命令类检查：明确不适用
  for (const name of COMMAND_ONLY_CHECKS) {
    results[name] = naResult(name, 'Zabbix API');
  }
  return results;
}

// ============================================================================
//  conn_type='zabbix_agent'：Agent 直连被动检查
// ============================================================================

const DIRECT_KEYS = [
  'system.uname',
  'system.cpu.util',
  'system.cpu.num',
  'vm.memory.size[total]',
  'vm.memory.size[available]',
  'vfs.fs.size[/,total]',
  'vfs.fs.size[/,used]',
  'vfs.fs.size[/,pused]',
  'system.uptime',
  'system.users.num',
];

function buildDirectCheckResults(serverName: string, values: Record<string, string>, host: string, port: number): Record<string, CommandResult> {
  const results: Record<string, CommandResult> = {};
  const v = (k: string): string => (values[k] ?? '').trim();
  const has = (k: string): boolean => v(k) !== '' && !/ZBX_NOTSUPPORTED/i.test(v(k));
  const mk = (name: string, ok: boolean, stdout: string, cmd: string, missing = false): void => {
    results[name] = {
      success: ok && !missing,
      stdout: ok && !missing ? stdout : 'N/A',
      stderr: missing ? `目标 Agent 未返回该 key（模板未配置或 Agent 版本不支持）` : '',
      command: cmd,
      duration: 0,
      error: missing ? '监控项缺失' : undefined,
    };
  };

  // OS Info
  if (has('system.uname')) mk('OS Info', true, v('system.uname'), 'system.uname');
  else mk('OS Info', false, '', 'system.uname', true);

  // CPU
  if (has('system.cpu.util')) mk('CPU Usage', true, `CPU 使用率: ${parseFloat(v('system.cpu.util')).toFixed(1)}%`, 'system.cpu.util');
  else mk('CPU Usage', false, '', 'system.cpu.util', true);

  // Memory
  if (has('vm.memory.size[total]') && has('vm.memory.size[available]')) {
    const total = parseFloat(v('vm.memory.size[total]')) || 0;
    const avail = parseFloat(v('vm.memory.size[available]')) || 0;
    const pct = total > 0 ? ((total - avail) / total * 100).toFixed(1) : '0';
    mk('Memory Usage', true, `内存使用率: ${pct}%（总计 ${bytesToGb(total)}GB / 可用 ${bytesToGb(avail)}GB）`, 'vm.memory.size[total] + [available]');
  } else mk('Memory Usage', false, '', 'vm.memory.size[...]', true);

  // Disk
  if (has('vfs.fs.size[/,pused]')) {
    mk('Disk Usage', true, `根分区使用率: ${parseFloat(v('vfs.fs.size[/,pused]')).toFixed(1)}%（总计 ${bytesToGb(parseFloat(v('vfs.fs.size[/,total]')))}GB / 已用 ${bytesToGb(parseFloat(v('vfs.fs.size[/,used]')))}GB）`, 'vfs.fs.size[/,pused]');
  } else mk('Disk Usage', false, '', 'vfs.fs.size[/,pused]', true);

  // Users
  if (has('system.users.num')) mk('User List', true, `系统用户数: ${v('system.users.num')}（完整用户清单需 SSH 通道）`, 'system.users.num');
  else mk('User List', false, '', 'system.users.num', true);

  // Uptime
  if (has('system.uptime')) mk('Uptime', true, `运行时长: ${formatUptime(parseFloat(v('system.uptime')))}（${v('system.uptime')}s）`, 'system.uptime');
  else mk('Uptime', false, '', 'system.uptime', true);

  // CPU cores 附加信息合入 OS Info
  if (has('system.cpu.num')) {
    results['OS Info'].stdout += `\nCPU 核数: ${v('system.cpu.num')}`;
  }

  // Network Info：直连协议无发现机制，标准监控项不存在通用 key
  results['Network Info'] = naResult('Network Info', 'Agent 直连');

  for (const name of COMMAND_ONLY_CHECKS) {
    if (!results[name]) results[name] = naResult(name, 'Agent 直连');
  }
  return results;
}

class ZabbixComplianceService {
  /**
   * 按通道执行合规检查（纯数据采集，不含 AI 分析与历史保存——由 runComplianceCheck 统一处理）
   */
  async executeChecks(serverId: string): Promise<Record<string, CommandResult>> {
    const server = serversRepo.getById(serverId);
    if (!server) return { 'Zabbix 通道': { success: false, stdout: '', stderr: 'Server not found', command: '-', duration: 0, error: 'not found' } };

    const t0 = Date.now();
    if (server.conn_type === 'zabbix') {
      try {
        const { items } = await zabbixMetricCollector.getLatestItems(serverId);
        const itemMap: Record<string, { key: string; value: string; units: string; clock?: string }> = {};
        for (const it of items) {
          itemMap[it.itemid ?? it.key_] = { key: it.key_ ?? '', value: it.lastvalue ?? '', units: it.units ?? '', clock: it.lastclock as string | undefined };
        }
        const results = buildApiCheckResults(server.name, itemMap);
        logger.info(`🛡️ [Compliance Check] Zabbix API 通道检查完成: ${server.name}，items=${Object.keys(items).length}，耗时 ${Date.now() - t0}ms`);
        return results;
      } catch (err) {
        const msg = (err as Error).message;
        logger.warn(`🛡️ [Compliance Check] Zabbix API 通道检查失败: ${server.name}: ${msg}`);
        return { 'Zabbix 通道': { success: false, stdout: '', stderr: msg, command: 'zabbix item.get', duration: Date.now() - t0, error: msg } };
      }
    }

    if (server.conn_type === 'zabbix_agent') {
      try {
        const { host, port, values } = await zabbixAgentDirectCollector.queryItems(serverId, DIRECT_KEYS);
        const results = buildDirectCheckResults(server.name, values, host, port);
        logger.info(`🛡️ [Compliance Check] Agent 直连通道检查完成: ${server.name}（${host}:${port}），耗时 ${Date.now() - t0}ms`);
        return results;
      } catch (err) {
        const msg = (err as Error).message;
        logger.warn(`🛡️ [Compliance Check] Agent 直连通道检查失败: ${server.name}: ${msg}`);
        return { 'Agent 直连': { success: false, stdout: '', stderr: msg, command: 'zabbix agent passive check', duration: Date.now() - t0, error: msg } };
      }
    }

    return { 'Zabbix 通道': { success: false, stdout: '', stderr: `不支持的通道类型: ${server.conn_type}`, command: '-', duration: 0, error: 'unsupported' } };
  }
}

export const zabbixComplianceService = new ZabbixComplianceService();
