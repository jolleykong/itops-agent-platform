/**
 * agents/inspectionAgent.ts — 自动巡检 Agent
 *
 * 负责真实执行服务器合规检查，支持多台服务器
 */

import { serversRepo } from '../../../../repositories';
import { logger } from '../../../../utils/logger';
import { runComplianceCheck } from '../../../servers/services/sshService';
import type { Server } from '../../../../types';
import type { AgentExecutionContext } from './agentCore';

type ServerRow = Pick<Server, 'id' | 'name' | 'hostname'>;

function getEnabledServers(): ServerRow[] {
  return serversRepo.listEnabled() as unknown as ServerRow[];
}

// ── 规模化（容量基准：几千台节点，2026-11-19）──
// 并发上限与分片大小可由环境变量覆盖；默认片内并发 20、每片 100 台。
function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const INSPECTION_CONCURRENCY = envInt('INSPECTION_CONCURRENCY', 20);
const INSPECTION_SHARD_SIZE = envInt('INSPECTION_SHARD_SIZE', 100);

/**
 * 简单并发池：worker 消费任务队列，限制同时在飞的 promise 数。
 * worker 收到 (item, index)（index 为 items 内下标）；单个任务异常不会中断整池。
 */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const current = cursor++;
      await worker(items[current], current);
    }
  });
  await Promise.all(lanes);
}

/**
 * 自动巡检 Agent：真实执行服务器合规检查（支持多台服务器）
 */
export async function executeAutoInspectionAgent(input: string, context?: AgentExecutionContext): Promise<string> {
  logger.info('🔍 executeAutoInspectionAgent called with:', { input, context });
  
  let serverIds: string[] | undefined;
  if (context) {
    if (Array.isArray(context.serverIds)) {
      serverIds = context.serverIds.map(String);
    }
    if (context.serverId) {
      serverIds = [String(context.serverId)];
    }
  }
  
  logger.info('🔍 Selected server IDs for inspection:', serverIds);
  
  const servers = getEnabledServers();
  if (servers.length === 0) {
    return '## 无法执行巡检\n\n**错误**: 没有找到可用的服务器。请先在服务器管理中添加服务器。';
  }
  
  if (!serverIds || serverIds.length === 0) {
    // 未指定范围（如定时任务）→ 巡检全部启用服务器；此前只取第一台，
    // 导致"日常健康检查"每天只检查 created_at 最新的那台
    serverIds = servers.map(s => s.id);
  }
  
  let totalSuccessChecks = 0;
  let totalFailChecks = 0;
  const targets = serverIds
    .map(id => servers.find(s => s.id === id))
    .filter((s): s is ServerRow => Boolean(s));

  // 分片 + 并发池：串行逐台在几千台规模下不可用（5000 台 ≈ 5 小时）。
  // 片内并发执行（上限 INSPECTION_CONCURRENCY），片间顺序执行以控制对主机网络的瞬时压力；
  // 结果按 targets 顺序回填，输出顺序稳定（与串行版本一致）。
  const details: string[] = new Array(targets.length).fill('');
  const startTime = Date.now();
  logger.info(`🔍 巡检执行计划: ${targets.length} 台, 分片大小 ${INSPECTION_SHARD_SIZE}, 片内并发 ${INSPECTION_CONCURRENCY}`);

  for (let shardStart = 0; shardStart < targets.length; shardStart += INSPECTION_SHARD_SIZE) {
    const shard = targets.slice(shardStart, shardStart + INSPECTION_SHARD_SIZE);
    const shardBase = shardStart;
    await runPool(shard, INSPECTION_CONCURRENCY, async (server, shardIdx) => {
      const idx = shardBase + shardIdx;
      try {
        const { successCount, failCount, detail } = await inspectSingleServer(server);
        details[idx] = detail;
        totalSuccessChecks += successCount;
        totalFailChecks += failCount;
      } catch (error: unknown) {
        // 双保险：池内任务异常不应中断整轮巡检
        const msg = error instanceof Error ? error.message : String(error);
        details[idx] = `\n### 🖥️ ${server.name} (${server.hostname})\n\n**错误**: ${msg}\n\n---\n`;
        totalFailChecks += 1;
        logger.error(`❌ 巡检任务异常 ${server.name}: ${msg}`);
      }
    });
    logger.info(`📦 巡检分片完成: ${Math.min(shardStart + INSPECTION_SHARD_SIZE, targets.length)}/${targets.length} 台, 累计耗时 ${Math.round((Date.now() - startTime) / 1000)}s`);
  }

  let report = `## 服务器自动巡检报告\n\n**检查时间**: ${new Date().toLocaleString()}\n**目标服务器**: ${targets.length} 台\n**执行方式**: 分片并发（并发 ${INSPECTION_CONCURRENCY}，分片 ${INSPECTION_SHARD_SIZE}）, 总耗时 ${Math.round((Date.now() - startTime) / 1000)}s\n\n---\n`;
  report += details.filter(Boolean).join('');

  report += `\n**总体统计**: ${totalSuccessChecks} 项成功, ${totalFailChecks} 项失败\n`;
  return report;
}

/**
 * 检查单台服务器并返回结果详情
 */
async function inspectSingleServer(server: ServerRow): Promise<{
  successCount: number;
  failCount: number;
  detail: string;
}> {
  let successCount = 0;
  let failCount = 0;
  let detail = `\n### 🖥️ ${server.name} (${server.hostname})\n\n`;
  
  try {
    logger.info(`🔍 对服务器 ${server.name}(${server.hostname}) 执行自动巡检...`);
    const results = await runComplianceCheck(server.id);
    
    for (const [, result] of Object.entries(results)) {
      if (result.success) successCount++;
      else failCount++;
    }
    
    detail += `**检查结果**: ${successCount} ✅, ${failCount} ❌\n\n`;

    for (const [checkName, result] of Object.entries(results)) {
      if (result.success) {
        detail += `✅ **${checkName}**: 通过\n`;
      } else {
        // 失败必须携带原因：区分「未取得数据（权限/通道/超时）」与「检查不通过」。
        // 此前只输出"失败"，报告层无法判断，导致权限不足被误判为严重告警。
        const reason = (result.error || result.stderr || '')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 160);
        detail += `❌ **${checkName}**: 失败${reason ? ` — 原因: ${reason}` : ''}\n`;
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    detail += `**错误**: ${errorMessage}\n\n`;
  }
  
  detail += '\n---\n';
  return { successCount, failCount, detail };
}