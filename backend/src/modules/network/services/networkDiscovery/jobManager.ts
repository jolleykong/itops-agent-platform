/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 扫描任务生命周期管理
 * 从 networkDiscoveryService.ts 提取的任务创建、启动、管理、导入逻辑
 */

import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { exec, execSync } from 'child_process';
import { logger } from '../../../../utils/logger';
import { decrypt } from '../../../auth/services/encryptionService';
import { getErrorMessage } from '../../../../utils/errorHelpers';
import { networkDeviceRepository, snmpCredentialsRepo } from '../../../../repositories';
import type { SnmpCredentialRecord } from '../../../../repositories/snmpRepository';
import { buildPingCommand, isPingSuccess, calculateIpRange, generateIpList } from './icmpDiscovery';
import { trySnmpConnect } from './snmpDiscovery';
import type { DiscoveryJob, DiscoveryResult } from './networkDiscoveryService';

const execAsync = promisify(exec);

export interface JobManagerDeps {
  activeJobs: Map<string, AbortController>;
}

// ping 二进制可用性（容器内可能未安装 iputils-ping，结果进程内缓存一次）
let pingAvailable: boolean | null = null;
function isPingAvailable(): boolean {
  if (pingAvailable !== null) return pingAvailable;
  if (process.platform === 'win32') {
    pingAvailable = true; // Windows 自带 ping
    return pingAvailable;
  }
  try {
    execSync('command -v ping >/dev/null 2>&1', { stdio: 'ignore' });
    pingAvailable = true;
  } catch {
    pingAvailable = false;
    logger.warn('📡 ping binary not found in this environment — ICMP probe disabled, SNMP-only discovery');
  }
  return pingAvailable;
}

/**
 * Ping IP 并尝试 SNMP 发现
 *
 * 2026-11-17 修复：原实现「ping 通才尝试 SNMP」，容器内无 ping 命令时
 * 所有 IP 均被误判 offline，SNMP 探测从未执行。现改为：
 * - ping 仅作为辅助状态（不可用/ENOENT 时标记 unknown 并跳过）
 * - SNMP 探测对每个 IP 无条件执行（这是 SNMP 设备发现的主通道）
 */
async function pingAndDiscover(
  jobId: string, ip: string, credentials: SnmpCredentialRecord[], signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;

  const startTime = Date.now();
  // 'online' = ping 通；'offline' = ping 失败；'unknown' = 无 ping 二进制，跳过 ICMP
  let pingStatus: 'online' | 'offline' | 'unknown' = 'unknown';

  if (isPingAvailable()) {
    try {
      // 跨平台 Ping 检测
      const { stdout } = await execAsync(buildPingCommand(ip), { timeout: 3000 });
      pingStatus = isPingSuccess(stdout) ? 'online' : 'offline';
    } catch (err: unknown) {
      // ENOENT（ping 消失）按 unknown 处理，超时按 offline
      const code = (err as { code?: string })?.code;
      pingStatus = code === 'ENOENT' ? 'unknown' : 'offline';
      if (code === 'ENOENT') pingAvailable = false;
    }
  }

  const responseTimeMs = Date.now() - startTime;

  // 无论 ping 结果如何，都尝试 SNMP（发现的主通道）
  let snmpResult: any = null;
  let usedCredential: any = null;

  for (const cred of credentials) {
    if (signal.aborted) return false;
    try {
      const snmpInfo = await trySnmpConnect(ip, cred);
      if (snmpInfo) {
        snmpResult = snmpInfo;
        usedCredential = cred;
        break;
      }
    } catch {
      continue;
    }
  }

  // 保存结果（SNMP 不通且 ping 不通/不可用 → offline）
  const resultId = randomUUID();
  networkDeviceRepository.insertDiscoveryResultOnline({
    id: resultId,
    job_id: jobId,
    ip_address: ip,
    status: snmpResult ? 'snmp_ok' : pingStatus === 'online' ? 'online' : 'offline',
    sys_name: snmpResult?.sysName || null,
    sys_descr: snmpResult?.sysDescr || null,
    sys_location: snmpResult?.sysLocation || null,
    sys_object_id: snmpResult?.sysObjectID || null,
    snmp_version: usedCredential?.snmp_version || null,
    community: usedCredential?.community || null,
    interface_count: snmpResult?.interfaceCount || null,
    vendor: snmpResult?.vendor || null,
    model: snmpResult?.model || null,
    response_time_ms: responseTimeMs,
  });

  return !!snmpResult;
}

/**
 * 创建扫描任务
 */
export function createJob(name: string, startIp: string, endIp: string, credentialIds: string[]): DiscoveryJob {
  const totalHosts = calculateIpRange(startIp, endIp);
  const job: DiscoveryJob = {
    id: randomUUID(),
    name,
    start_ip: startIp,
    end_ip: endIp,
    status: 'pending',
    progress: 0,
    total_hosts: totalHosts,
    scanned_hosts: 0,
    found_devices: 0,
    credential_ids: JSON.stringify(credentialIds),
    created_at: new Date().toISOString(),
  };

  networkDeviceRepository.createDiscoveryJob({
    id: job.id,
    name: job.name,
    start_ip: job.start_ip,
    end_ip: job.end_ip,
    status: job.status,
    progress: job.progress,
    total_hosts: job.total_hosts,
    scanned_hosts: job.scanned_hosts,
    found_devices: job.found_devices,
    credential_ids: job.credential_ids,
    created_at: job.created_at,
  });

  logger.info(`📡 Discovery job created: ${name} (${startIp} - ${endIp}, ${totalHosts} hosts)`);
  return job;
}

/**
 * 启动扫描任务
 */
export async function startJob(deps: JobManagerDeps, jobId: string): Promise<void> {
  const job = networkDeviceRepository.getDiscoveryJob(jobId) as DiscoveryJob | undefined;
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== 'pending' && job.status !== 'completed') throw new Error(`Job ${jobId} is ${job.status}, cannot start`);

  // 更新状态
  networkDeviceRepository.updateDiscoveryJobStatus(jobId, 'running');
  networkDeviceRepository.deleteDiscoveryResultsByJob(jobId);

  const abortController = new AbortController();
  deps.activeJobs.set(jobId, abortController);

  const ips = generateIpList(job.start_ip, job.end_ip);
  const credentialIds: string[] = JSON.parse(job.credential_ids || '[]');
  const credentials = credentialIds.map(id => {
    const cred = snmpCredentialsRepo.getById(id);
    if (!cred) return null;
    // 解密凭证字段，否则 SNMP 认证会用密文必然失败
    return {
      ...cred,
      community: cred.community ? decrypt(cred.community) : null,
      snmp_auth_key: cred.snmp_auth_key ? decrypt(cred.snmp_auth_key) : null,
      snmp_priv_key: cred.snmp_priv_key ? decrypt(cred.snmp_priv_key) : null,
    };
  }).filter(Boolean) as SnmpCredentialRecord[];

  logger.info(`📡 Starting scan job ${jobId}: ${ips.length} hosts, ${credentials.length} credentials`);

  // 分批 Ping 扫描（每批 20 个 IP）
  const BATCH_SIZE = 20;
  let scanned = 0;
  let foundDevices = 0;

  for (let i = 0; i < ips.length; i += BATCH_SIZE) {
    if (abortController.signal.aborted) {
      networkDeviceRepository.finishDiscoveryJob(jobId, 'cancelled');
      logger.info(`📡 Scan job ${jobId} cancelled`);
      return;
    }

    const batch = ips.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(ip => pingAndDiscover(jobId, ip, credentials, abortController.signal))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        foundDevices++;
      }
    }

    scanned += batch.length;
    const progress = Math.round((scanned / ips.length) * 100);

    networkDeviceRepository.updateDiscoveryJobProgress(jobId, progress, scanned, foundDevices);

    // 小延迟防止扫描过快
    await new Promise(r => setTimeout(r, 100));
  }

  networkDeviceRepository.finishDiscoveryJob(jobId, 'completed');
  deps.activeJobs.delete(jobId);
  logger.info(`📡 Scan job ${jobId} completed: ${foundDevices} devices found`);
}

/**
 * 获取扫描结果（支持分页和按 job_id 过滤）
 */
export function getResults(options: { jobId?: string; limit?: number; offset?: number; status?: string }): { results: DiscoveryResult[]; total: number } {
  const result = networkDeviceRepository.listDiscoveryResults(options);
  return { results: result.results as DiscoveryResult[], total: result.total };
}

/**
 * 获取所有扫描任务
 */
export function getJobs(): DiscoveryJob[] {
  return networkDeviceRepository.listDiscoveryJobs() as DiscoveryJob[];
}

/**
 * 获取单个任务
 */
export function getJob(jobId: string): DiscoveryJob | undefined {
  return networkDeviceRepository.getDiscoveryJob(jobId) as DiscoveryJob | undefined;
}

/**
 * 取消扫描任务
 */
export function cancelJob(deps: JobManagerDeps, jobId: string): void {
  const controller = deps.activeJobs.get(jobId);
  if (controller) {
    controller.abort();
    deps.activeJobs.delete(jobId);
  }
  networkDeviceRepository.cancelDiscoveryJob(jobId);
}

/**
 * 删除扫描任务及其结果
 */
export function deleteJob(deps: JobManagerDeps, jobId: string): void {
  cancelJob(deps, jobId);
  networkDeviceRepository.deleteDiscoveryJob(jobId);
}

/**
 * 将发现结果导入设备库
 */
export function importToDevices(resultIds: string[], sshUsername?: string, sshPassword?: string, sshPort?: number): { imported: number; errors: string[] } {
  const errors: string[] = [];
  let imported = 0;

  for (const resultId of resultIds) {
    try {
      const result = networkDeviceRepository.getDiscoveryResult(resultId) as DiscoveryResult | undefined;
      if (!result) {
        errors.push(`Result ${resultId} not found`);
        continue;
      }

      // 检查是否已存在（按 IP 去重）
      const existing = networkDeviceRepository.getIdByIp(result.ip_address);
      if (existing) {
        errors.push(`${result.ip_address} 已存在`);
        continue;
      }

      const deviceId = randomUUID();
      const vendor = result.vendor || 'Unknown';
      const model = result.model || '';

      networkDeviceRepository.createFromDiscovery({
        id: deviceId,
        name: result.sys_name || result.ip_address,
        ip_address: result.ip_address,
        vendor,
        model,
        username: sshUsername || 'admin',
        ssh_port: sshPort || 22,
        status: 'unknown',
        os_version: result.sys_descr || null,
      });

      imported++;
    } catch (err: unknown) {
      errors.push(`${resultId}: ${getErrorMessage(err)}`);
    }
  }

  return { imported, errors };
}