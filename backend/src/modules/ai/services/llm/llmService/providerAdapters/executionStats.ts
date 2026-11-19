/**
 * providerAdapters 执行记录与统计子模块（2026-07-21 拆分）
 *
 * 把原 providerAdapters.ts L195-228 的 2 个统计函数抽出：
 * - recordAgentExecution: 写 agent_executions 库
 * - updateAgentStats: 递增 agent 使用次数
 *
 * 拆分原则遵循 architecture.md §3.3.1 + 第 3 条「向后兼容的 import 路径」
 */

import { randomUUID } from 'crypto';
import { logger } from '../../../../../../utils/logger';
import { agentExecutionRepository, agentRepository } from '../../../../../../repositories';
import type { AgentExecutionMetadata } from './types';

/**
 * 系统占位 Agent（enabled=0）：非 Agent 的 LLM 调用（compliance-batch /
 * copilot / RCA / multiAgent 等）的 agentId 是标签而非 agents.id，直接写
 * agent_executions 会触发 FOREIGN KEY 约束失败 → 统计被丢弃并刷错误日志。
 * 此类调用统一挂到占位 Agent，原始标签保留在 agent_name 列。
 */
const SYSTEM_AGENT_ID = '00000000-0000-4000-8000-000000000001';
const SYSTEM_AGENT_NAME = '系统内部调用';

/** 校验 agentId 可落库；不可（不存在/为空）时归一到系统占位 Agent */
function resolveAgentId(agentId: string): string {
  if (agentId) {
    try {
      if (agentRepository.getById(agentId)) return agentId;
    } catch { /* fall through to system agent */ }
  }
  try {
    agentRepository.ensureSystemAgent(SYSTEM_AGENT_ID, SYSTEM_AGENT_NAME);
  } catch { /* ignore */ }
  return SYSTEM_AGENT_ID;
}

/** 记录一次 Agent 执行（含 input/output/status/executionTimeMs 等） */
export function recordAgentExecution(
  agentId: string,
  agentName: string,
  inputText: string,
  outputText: string,
  status: 'success' | 'failure',
  errorMessage?: string,
  executionTimeMs?: number,
  metadata?: AgentExecutionMetadata,
): void {
  try {
    agentExecutionRepository.create({
      id: randomUUID(),
      agentId: resolveAgentId(agentId),
      agentName: agentName || SYSTEM_AGENT_NAME,
      inputText,
      outputText,
      status,
      errorMessage: errorMessage || null,
      executionTimeMs: executionTimeMs ?? null,
      metadata: metadata ?? null,
    });
  } catch (error) {
    logger.error('Failed to record agent execution:', error);
  }
}

/** 递增 Agent 的使用统计（usage_count + last_used_at） */
export function updateAgentStats(agentId: string): void {
  try {
    agentRepository.incrementUsageStats(agentId);
  } catch (error) {
    logger.error('Failed to update agent stats:', error);
  }
}
