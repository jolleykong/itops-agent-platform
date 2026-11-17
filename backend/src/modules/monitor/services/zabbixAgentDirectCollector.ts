/**
 * Zabbix Agent 直连采集器（conn_type='zabbix_agent'，v064）
 *
 * 绕过 Zabbix API，平台后端直接与目标主机 Zabbix Agent（被动检查，默认 10050 端口）
 * 通信获取指标与状态。协议（被动检查）：
 *   请求：`<key>\n`
 *   响应：`ZBXD\x01` + 8 字节小端长度 + payload（新版），或纯文本 `value\n`（旧版）
 *
 * 重要限制（必须在 UI 提示）：
 *   1. Agent 的 `Server=` 白名单必须包含平台后端出口 IP，否则 TCP 能连上但 Agent
 *      静默拒绝（连接建立后直接 EOF，无任何响应）——这是 Agent 的安全设计；
 *   2. 目标主机 10050 端口必须对平台网络可达（防火墙/安全组放行）；
 *   3. 虚机经 vCenter 监控、无 Agent 的主机无法使用本通道。
 */

import { Socket } from 'net';
import { v4 as uuidv4 } from 'uuid';
import { serversRepo } from '../../../repositories/serverRepository';
import { detectOSType } from '../../scripts/services/commandDispatcher';
import { logger } from '../../../utils/logger';

const AGENT_DEFAULT_PORT = 10050;
const QUERY_TIMEOUT_MS = 5000;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export class ZabbixAgentDirectError extends Error {}

interface AgentDirectServerRef {
  id: string;
  name: string;
  conn_type?: string;
  hostname: string;
  ip_address?: string | null;
  port?: number;
}

/** 解析被动检查响应：兼容 ZBXD 帧（v2.2+）与纯文本两种格式 */
function parseAgentResponse(buf: Buffer): string {
  if (buf.length >= 13 && buf.slice(0, 4).toString('latin1') === 'ZBXD') {
    // ZBXD\x01 + 8 字节小端数据长度
    const low = buf.readUInt32LE(5);
    const high = buf.readUInt32LE(9);
    const len = low + high * 2 ** 32;
    return buf.slice(13, Math.min(13 + Number(len), buf.length)).toString('utf-8').replace(/\0+$/, '').trim();
  }
  return buf.toString('utf-8').replace(/\0+$/, '').trim();
}

/** 单次被动检查：发送 key，返回字符串值。失败/超时抛 ZabbixAgentDirectError */
function agentQuery(host: string, port: number, key: string, timeoutMs = QUERY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buf = Buffer.alloc(0);
    let settled = false;

    const finish = (err: ZabbixAgentDirectError | null, value?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? '');
    };

    socket.setTimeout(timeoutMs);
    socket.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED') {
        finish(new ZabbixAgentDirectError(`目标 ${host}:${port} 连接被拒绝（Agent 未安装、未启用被动监听或端口不是 ${port}）`));
      } else if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') {
        finish(new ZabbixAgentDirectError(`目标 ${host}:${port} 网络不可达（检查路由/防火墙）`));
      } else {
        finish(new ZabbixAgentDirectError(`连接失败：${e.message}`));
      }
    });
    socket.once('timeout', () => {
      finish(new ZabbixAgentDirectError(`目标 ${host}:${port} 连接/响应超时（${timeoutMs}ms，检查防火墙是否放行 10050）`));
    });
    socket.connect(port, host, () => {
      socket.write(key + '\n');
    });
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      // ZBXD 帧模式：凑够头部后按声明长度收满
      if (buf.length >= 13 && buf.slice(0, 4).toString('latin1') === 'ZBXD') {
        if (buf.length >= 13) {
          const low = buf.readUInt32LE(5);
          const high = buf.readUInt32LE(9);
          const len = low + high * 2 ** 32;
          if (buf.length >= 13 + Number(len)) {
            finish(null, parseAgentResponse(buf));
          }
        }
      } else if (buf.length > 0 && buf[buf.length - 1] === 0x0a) {
        // 纯文本模式：换行结尾即完成
        finish(null, parseAgentResponse(buf));
      }
    });
    socket.on('close', () => {
      // 白名单拒绝的典型表现：连接建立但立即 EOF，无任何字节
      if (!settled) {
        if (buf.length === 0) {
          finish(new ZabbixAgentDirectError(
            `Agent 接受了连接但未返回任何数据（目标 ${host}:${port}）。` +
            '最常见原因：目标机 agent 配置的 Server= 白名单未包含平台后端出口 IP，被动检查被静默拒绝；' +
            '需在目标机 zabbix_agentd.conf 的 Server= 中加入平台 IP 并重启 agent，或改用 Zabbix API 通道。'
          ));
        } else {
          finish(null, parseAgentResponse(buf));
        }
      }
    });
  });
}

/** 值转数字；ZBX_NOTSUPPORTED / 空串 → 0 */
function toNum(v: string | undefined): number {
  if (!v) return 0;
  if (/ZBX_NOTSUPPORTED/i.test(v)) return 0;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

/** 并发查询一组 key；单项失败按 0 处理（记录日志） */
async function queryKeys(host: string, port: number, keys: string[]): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  await Promise.all(keys.map(async (k) => {
    try {
      results[k] = await agentQuery(host, port, k);
    } catch (err) {
      logger.warn(`Agent 直连查询 ${host}:${port} key=${k} 失败: ${(err as Error).message}`);
      results[k] = '';
    }
  }));
  return results;
}

/** 解析目标地址：优先 ip_address，其次 hostname 为 IPv4 的情况 */
function resolveTarget(server: AgentDirectServerRef): { host: string; port: number } {
  const ip = (server.ip_address ?? '').trim();
  const hostname = (server.hostname ?? '').trim();
  const host = IPV4_RE.test(ip) ? ip : (IPV4_RE.test(hostname) ? hostname : '');
  if (!host) {
    throw new ZabbixAgentDirectError('无法确定直连目标：ip_address 缺失且 hostname 不是 IPv4 地址（直连通道要求填写主机 IP）');
  }
  // 表单里 zabbix/zabbix_agent 通道 port 存 10050；历史数据兜底默认值
  const port = server.port && server.port > 0 ? server.port : AGENT_DEFAULT_PORT;
  return { host, port };
}

class ZabbixAgentDirectCollector {
  /** 连接可用性检测：agent.ping → 期望 '1' */
  async checkAvailability(serverId: string): Promise<{ success: boolean; message: string }> {
    const server = serversRepo.getById(serverId) as unknown as (AgentDirectServerRef & { enabled?: number }) | undefined;
    if (!server) return { success: false, message: 'Server not found' };
    if (server.conn_type !== 'zabbix_agent') {
      return { success: false, message: '该服务器不是 Zabbix Agent 直连通道' };
    }
    let host: string, port: number;
    try {
      ({ host, port } = resolveTarget(server));
    } catch (e) {
      return { success: false, message: (e as Error).message };
    }
    try {
      const val = await agentQuery(host, port, 'agent.ping');
      if (val === '1') {
        return { success: true, message: `Zabbix Agent 直连可用（${host}:${port}，agent.ping=1）` };
      }
      return { success: false, message: `Agent 响应异常（agent.ping=${val || '<空>'}）` };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }

  /** 采集静态信息并更新 servers */
  async collectServerInfo(serverId: string): Promise<{ success: boolean; error?: string }> {
    const server = serversRepo.getById(serverId) as unknown as AgentDirectServerRef | undefined;
    if (!server) return { success: false, error: 'Server not found' };
    if (server.conn_type !== 'zabbix_agent') return { success: false, error: '非 Zabbix Agent 直连通道服务器' };

    try {
      const { host, port } = resolveTarget(server);
      const r = await queryKeys(host, port, ['system.uname', 'system.cpu.num', 'vm.memory.size[total]', 'vfs.fs.size[/,total]']);

      // 关键项全部缺失 → 视为链路不通（白名单/防火墙），返回明确错误
      if (!r['system.uname'] && !r['system.cpu.num'] && !r['vm.memory.size[total]']) {
        throw new ZabbixAgentDirectError(
          `Agent 直连采集失败：所有关键监控项均无响应（目标 ${host}:${port}）。` +
          '请检查目标机 Server= 白名单是否包含平台后端 IP、10050 端口是否放行。'
        );
      }

      const uname = (r['system.uname'] || '').trim();
      const existing = serversRepo.getById(serverId);
      const ipAddress = (existing?.ip_address ?? '').trim() || (IPV4_RE.test(host) ? host : null);

      serversRepo.updateSystemInfo(serverId, {
        os: uname || existing?.os || 'Unknown',
        cpu_cores: Math.round(toNum(r['system.cpu.num'])) || existing?.cpu_cores || 0,
        memory_gb: Math.round((toNum(r['vm.memory.size[total]']) / 1024 ** 3) * 10) / 10 || existing?.memory_gb || 0,
        disk_gb: Math.round((toNum(r['vfs.fs.size[/,total]']) / 1024 ** 3) * 10) / 10 || existing?.disk_gb || 0,
        ip_address: ipAddress,
        private_ip: ipAddress,
        os_type: detectOSType(uname || 'linux'),
      });
      logger.info(`Agent 直连 info collected for ${server.name} (${serverId}) via ${host}:${port}`);
      return { success: true };
    } catch (err) {
      if (err instanceof ZabbixAgentDirectError) return { success: false, error: err.message };
      logger.error(`Agent direct info collection failed for ${serverId}:`, err);
      return { success: false, error: err instanceof Error ? err.message : 'Agent 直连采集失败' };
    }
  }

  /** 采集实时指标并写入 server_metrics */
  async collectServerMetrics(serverId: string): Promise<{ success: boolean; error?: string }> {
    const server = serversRepo.getById(serverId) as unknown as AgentDirectServerRef | undefined;
    if (!server) return { success: false, error: 'Server not found' };
    if (server.conn_type !== 'zabbix_agent') return { success: false, error: '非 Zabbix Agent 直连通道服务器' };

    try {
      const { host, port } = resolveTarget(server);
      const r = await queryKeys(host, port, [
        'system.cpu.util',
        'system.cpu.load[all,avg1]', 'system.cpu.load[all,avg5]', 'system.cpu.load[all,avg15]',
        'vm.memory.size[total]', 'vm.memory.size[available]', 'vm.memory.size[pavailable]',
        'vfs.fs.size[/,total]', 'vfs.fs.size[/,used]', 'vfs.fs.size[/,pused]',
        'system.uptime',
      ]);

      if (!r['system.cpu.util'] && !r['vm.memory.size[total]']) {
        throw new ZabbixAgentDirectError(
          `Agent 直连采集失败：关键指标均无响应（目标 ${host}:${port}）。请检查 Server= 白名单与防火墙。`
        );
      }

      const memTotalBytes = toNum(r['vm.memory.size[total]']);
      const memAvailBytes = toNum(r['vm.memory.size[available]']);
      const pavailable = toNum(r['vm.memory.size[pavailable]']);
      const memory_total_gb = Math.round((memTotalBytes / 1024 ** 3) * 10) / 10;
      let memory_used_gb = memTotalBytes > 0 ? (memTotalBytes - memAvailBytes) / 1024 ** 3 : 0;
      let memory_usage = memTotalBytes > 0 && memAvailBytes > 0 ? ((memTotalBytes - memAvailBytes) / memTotalBytes) * 100 : 0;
      if (pavailable > 0 && memTotalBytes > 0) {
        memory_usage = 100 - Math.min(100, pavailable);
        memory_used_gb = (memTotalBytes * memory_usage) / 100 / 1024 ** 3;
      }

      const diskTotalBytes = toNum(r['vfs.fs.size[/,total]']);
      const diskUsedBytes = toNum(r['vfs.fs.size[/,used]']);
      const diskPused = toNum(r['vfs.fs.size[/,pused]']);
      const disk_usage = diskPused > 0 ? diskPused : (diskTotalBytes > 0 ? (diskUsedBytes / diskTotalBytes) * 100 : 0);

      const data = {
        cpu_usage: Math.min(100, Math.max(0, toNum(r['system.cpu.util']))),
        memory_usage: Math.min(100, Math.max(0, memory_usage)),
        memory_total_gb,
        memory_used_gb: Math.round(memory_used_gb * 10) / 10,
        disk_usage: Math.min(100, Math.max(0, disk_usage)),
        disk_total_gb: Math.round((diskTotalBytes / 1024 ** 3) * 10) / 10,
        disk_used_gb: Math.round((diskUsedBytes / 1024 ** 3) * 10) / 10,
        network_in_mbps: 0, // 直连模式无网卡发现上下文，暂不采集
        network_out_mbps: 0,
        load_1min: toNum(r['system.cpu.load[all,avg1]']),
        load_5min: toNum(r['system.cpu.load[all,avg5]']),
        load_15min: toNum(r['system.cpu.load[all,avg15]']),
        uptime_seconds: toNum(r['system.uptime']),
      };

      serversRepo.insertMetrics({ id: uuidv4(), server_id: serverId, ...data });
      logger.info(`Agent direct metrics collected for ${server.name} (${serverId}): CPU=${data.cpu_usage.toFixed(1)}% MEM=${data.memory_usage.toFixed(1)}%`);
      return { success: true };
    } catch (err) {
      if (err instanceof ZabbixAgentDirectError) return { success: false, error: err.message };
      logger.error(`Agent direct metrics collection failed for ${serverId}:`, err);
      return { success: false, error: err instanceof Error ? err.message : 'Agent 直连采集失败' };
    }
  }
}

export const zabbixAgentDirectCollector = new ZabbixAgentDirectCollector();
