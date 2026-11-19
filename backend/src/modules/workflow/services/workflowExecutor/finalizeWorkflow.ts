import { randomUUID } from 'crypto';
import { getIOInstance } from '../../../../shared/websocket/io';
import { logger } from '../../../../utils/logger';
import { knowledgeRepository, tasksRepo, reportsRepo, aiRemediationRepository } from '../../../../repositories';
import { executeAgentNode } from '../../../ai/services/agents/agentExecutor';
import { reportService } from '../../../monitor/services/reportService';
import { notificationService } from '../../../notification/services/notificationService';
import { createAuditLog } from '../../../audit/services/auditService';
import type {
  WorkflowNode,
  NodeResult,
  WorkflowParsed,
} from '../../../../types';
import { addTaskLog, isDuplicateKnowledgeBase } from './helpers';
import {
  summarizeNodeResults,
  buildSummarySection,
  generateLlmConclusion,
} from './reportSummary';

/** 工作流执行报告模板 v2：新增汇总摘要（优先级排序）与 LLM 执行结论 */
const WORKFLOW_REPORT_TEMPLATE_V2 = `# 工作流执行报告

## 基本信息
- **工作流名称**: {{workflow_name}}
- **执行任务ID**: {{task_id}}
- **执行状态**: {{execution_status}}
- **开始时间**: {{start_time}}
- **结束时间**: {{end_time}}

## 汇总摘要
{{summary_section}}

{{llm_conclusion}}

## 执行总结
{{execution_summary}}

## 执行顺序（附录）
{{execution_order}}

## 节点执行详情（附录）
{{node_details}}

{{error_section}}

---
报告生成时间: {{generated_time}}`;

const WORKFLOW_REPORT_TEMPLATE_VARIABLES = [
  'workflow_name', 'task_id', 'execution_status', 'start_time', 'end_time',
  'summary_section', 'llm_conclusion', 'execution_summary',
  'execution_order', 'node_details', 'error_section', 'generated_time',
];

export async function finalizeWorkflow(
  taskId: string,
  workflow: WorkflowParsed,
  nodes: WorkflowNode[],
  nodeResults: Record<string, NodeResult>,
  executionOrder: string[],
  status: 'completed' | 'failed',
  errorMessage?: string
) {
  const io = getIOInstance();

  tasksRepo.finalizeTask(taskId, status, JSON.stringify(nodeResults));

  // 故障案例自动存入知识库
  try {
    const failedNodes = Object.entries(nodeResults)
      .filter(([_, result]) => result.status === 'failed')
      .map(([nodeId, result]) => {
        const node = nodes.find((n) => n.id === nodeId);
        return { ...result, nodeId, node };
      });

    if (failedNodes.length > 0) {
      failedNodes.forEach((nodeResult) => {
        const title = `${workflow.name} - 故障案例`;
        const content = `**故障节点**: ${nodeResult.node?.data?.label || nodeResult.nodeId}\n**错误**: ${nodeResult.error}\n**分析时间**: ${new Date().toISOString()}`;

        const duplicateId = isDuplicateKnowledgeBase(content);
        if (duplicateId) {
          logger.info(`ℹ️ 跳过重复的故障案例，已存在相似条目: ${duplicateId}`);
          return;
        }

        knowledgeRepository.createMinimal({
          id: randomUUID(),
          title,
          category: '故障处理',
          content,
        });
      });
      logger.info('✅ 故障案例已自动存入知识库');
    }
  } catch (insertError) {
    logger.error('Failed to insert into knowledge_base:', insertError);
  }

  try {
    await generateWorkflowExecutionReport(taskId, workflow, nodes, nodeResults, executionOrder, status, errorMessage);
  } catch (reportError) {
    logger.error('Failed to generate workflow report:', reportError);
  }

  // ── 验证失败时自动回滚 ──
  const verificationNode = nodes.find(n =>
    n.data?.label?.includes('验证') && n.type === 'agent'
  );
  const verificationFailed = verificationNode &&
    nodeResults[verificationNode.id]?.status === 'failed';

  if (verificationFailed) {
    logger.warn(`⚠️ 验证节点 "${verificationNode.data.label}" 执行失败，尝试自动回滚...`);
    const rollbackNode = nodes.find(n =>
      n.data?.label?.includes('回滚') && n.type === 'agent'
    );

    if (rollbackNode) {
      try {
        addTaskLog(taskId, {
          type: 'output',
          content: '⚠️ 验证失败，正在执行自动回滚...',
          nodeId: rollbackNode.id,
        });
        io?.to(`task:${taskId}`).emit('task:node:started', {
          taskId, nodeId: rollbackNode.id, nodeName: rollbackNode.data.label,
        });

        const rollbackOutput = await executeAgentNode(
          rollbackNode.data.agentId || 'server-command-agent',
          rollbackNode.data.prompt || '执行回滚操作',
          {}
        );

        nodeResults[rollbackNode.id] = {
          status: 'success',
          output: rollbackOutput,
          metadata: { executionTime: Date.now() },
        };

        io?.to(`task:${taskId}`).emit('task:node:output', {
          taskId, nodeId: rollbackNode.id, output: rollbackOutput,
        });
        io?.to(`task:${taskId}`).emit('task:node:completed', {
          taskId, nodeId: rollbackNode.id, status: 'success', output: rollbackOutput,
        });
        addTaskLog(taskId, {
          type: 'output',
          content: `✅ 自动回滚完成: ${rollbackOutput.substring(0, 200)}`,
          nodeId: rollbackNode.id,
        });

        try {
          const ctxJson = tasksRepo.getContext(taskId);
          const ctx = ctxJson ? JSON.parse(ctxJson) : {};
          if (ctx.remediation_id) {
            aiRemediationRepository.updateStatusFields(
              ctx.remediation_id,
              'failed',
              JSON.stringify({ verification: 'failed', rollback: 'executed', rollback_output: rollbackOutput.substring(0, 500) })
            );
          }
        } catch { /* ai_remediations 表可能不存在 */ }

        logger.info(`✅ 自动回滚执行完成 (task: ${taskId})`);
      } catch (rollbackError) {
        const rollbackErrMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        nodeResults[rollbackNode.id] = {
          status: 'failed',
          error: rollbackErrMsg,
          metadata: { executionTime: Date.now() },
        };
        addTaskLog(taskId, {
          type: 'error',
          content: `❌ 自动回滚失败: ${rollbackErrMsg}`,
          nodeId: rollbackNode.id,
        });
        logger.error(`❌ 自动回滚执行失败: ${rollbackErrMsg}`);

        try {
          const ctxJson = tasksRepo.getContext(taskId);
          const ctx = ctxJson ? JSON.parse(ctxJson) : {};
          if (ctx.remediation_id) {
            aiRemediationRepository.updateStatusFields(
              ctx.remediation_id,
              'failed',
              undefined,
              `验证失败且回滚失败: ${rollbackErrMsg}`
            );
          }
        } catch { /* ai_remediations 表可能不存在 */ }
      }

      tasksRepo.updateNodeResults(taskId, JSON.stringify(nodeResults));
    }
  }

  // ── 反馈通知 ──
  const successCount = Object.values(nodeResults).filter(r => r.status === 'success').length;
  const failedCount = Object.values(nodeResults).filter(r => r.status === 'failed').length;

  try {
    await notificationService.sendTaskNotification(
      { id: taskId, name: workflow.name, workflow_id: workflow.id },
      status
    );
  } catch (notifyError) {
    logger.warn('⚠️ 工作流完成通知发送失败（非致命错误）:', notifyError);
  }

  if (verificationFailed) {
    try {
      await notificationService.sendNotification({
        type: 'remediation_rollback',
        title: `⚠️ AI 修复验证失败并已回滚: ${workflow.name}`,
        content: `**工作流**: ${workflow.name}\n**验证结果**: 失败\n**回滚操作**: 已自动执行\n**任务ID**: ${taskId}\n\n请登录系统查看详细信息`,
        related_task_id: taskId,
      });
    } catch (notifyError) {
      logger.warn('⚠️ 回滚通知发送失败:', notifyError);
    }
  }

  // ── 审计日志 ──
  createAuditLog({
    action: status === 'completed' ? 'workflow_completed' : 'workflow_failed',
    resource_type: 'task',
    resource_id: taskId,
    details: {
      workflowName: workflow.name,
      workflowId: workflow.id,
      successCount: String(successCount),
      failedCount: String(failedCount),
      verificationFailed: String(!!verificationFailed),
      errorMessage: errorMessage ?? '',
    },
  });

  if (verificationFailed) {
    createAuditLog({
      action: 'remediation_rollback_triggered',
      resource_type: 'task',
      resource_id: taskId,
      details: {
        workflowName: workflow.name,
        reason: '验证节点执行失败，自动触发回滚',
        rollbackResult: nodeResults[nodes.find(n => n.data?.label?.includes('回滚'))?.id || '']?.status || 'unknown',
      },
    });
  }

  if (status === 'completed') {
    io?.to(`task:${taskId}`).emit('task:completed', { taskId, status: 'completed', nodeResults });
  }
}

export async function generateWorkflowExecutionReport(
  taskId: string,
  workflow: WorkflowParsed,
  nodes: WorkflowNode[],
  nodeResults: Record<string, NodeResult>,
  executionOrder: string[],
  status: 'completed' | 'failed',
  errorMessage?: string
) {
  logger.info('📄 开始生成工作流执行报告（v2：汇总摘要 + 优先级排序）...');

  // ── 报告模板：若已存在的模板是 v1（无汇总变量），升级为 v2 ──
  const templates = reportService.getTemplates();
  let workflowTemplate = templates.find(t => t.name.includes('工作流执行报告'));

  if (!workflowTemplate) {
    logger.info('📄 未找到工作流执行报告模板，正在创建...');
    workflowTemplate = reportService.createTemplate({
      name: '工作流执行报告',
      description: '工作流执行完成后自动生成的执行报告',
      type: 'inspection',
      content: WORKFLOW_REPORT_TEMPLATE_V2,
      variables: WORKFLOW_REPORT_TEMPLATE_VARIABLES,
      is_preset: true
    });
    logger.info('✅ 工作流执行报告模板创建成功:', workflowTemplate.id);
  } else if (!workflowTemplate.variables.includes('summary_section')) {
    logger.info('📄 检测到 v1 模板，升级为 v2（含汇总摘要）:', workflowTemplate.id);
    workflowTemplate = reportService.updateTemplate(workflowTemplate.id, {
      content: WORKFLOW_REPORT_TEMPLATE_V2,
      variables: WORKFLOW_REPORT_TEMPLATE_VARIABLES,
    }) ?? workflowTemplate;
    logger.info('✅ 工作流执行报告模板已升级');
  } else {
    logger.info('✅ 使用已存在的工作流执行报告模板:', workflowTemplate.id);
  }

  const task = tasksRepo.getStartEndTime(taskId);

  const startTime = task?.start_time ?? undefined;
  const endTime = task?.end_time ?? undefined;

  const executionOrderDesc = executionOrder.map((nodeId, index) => {
    const node = nodes.find(n => n.id === nodeId);
    const nodeResult = nodeResults[nodeId];
    const nodeStatus = nodeResult?.status || 'pending';
    return `${index + 1}. ${node?.data?.label || nodeId} (${nodeStatus})`;
  }).join('\n');

  const nodeDetails = executionOrder.map((nodeId, index) => {
    const node = nodes.find(n => n.id === nodeId);
    const nodeResult = nodeResults[nodeId];

    let detail = `### ${index + 1}. ${node?.data?.label || nodeId}\n`;
    detail += `- **状态**: ${nodeResult?.status || 'pending'}\n`;

    if (nodeResult?.output) {
      detail += `- **输出**: \n${nodeResult.output.substring(0, 800)}${nodeResult.output.length > 800 ? '…（详见报告汇总与原始输出）' : ''}\n`;
    }

    if (nodeResult?.error) {
      detail += `- **错误**: ${nodeResult.error}\n`;
    }

    return detail;
  }).join('\n\n');

  // ── 结构化汇总：解析节点输出 → 分级排序的问题清单 + 总览统计 ──
  const summaryResult = summarizeNodeResults(nodes, nodeResults);
  const summarySection = buildSummarySection(summaryResult);

  // ── LLM 执行结论（可选增强，失败自动降级）──
  let llmConclusion = '';
  if (summaryResult.findings.length > 0) {
    const conclusion = await generateLlmConclusion(workflow.name, summaryResult);
    llmConclusion = conclusion
      ? `## 执行结论\n\n${conclusion}`
      : `## 执行结论\n\n（AI 结论暂不可用）请优先处理"汇总摘要"中 🔴 严重问题，其次 🟠 警告项。`;
  }

  let errorSection = '';
  if (status === 'failed' && errorMessage) {
    errorSection = `## 错误信息\n\n${errorMessage}`;
  }

  const variables: Record<string, string> = {
    workflow_name: workflow.name,
    task_id: taskId,
    execution_status: status === 'completed' ? '成功完成' : '执行失败',
    start_time: startTime ? new Date(startTime).toLocaleString() : '-',
    end_time: endTime ? new Date(endTime).toLocaleString() : '-',
    summary_section: summarySection,
    llm_conclusion: llmConclusion,
    execution_order: executionOrderDesc,
    node_details: nodeDetails,
    execution_summary: summaryResult.findings.length > 0
      ? `共执行 ${summaryResult.stats.totalNodes} 个节点，成功 ${summaryResult.stats.successNodes} 个，失败 ${summaryResult.stats.failedNodes} 个；发现 ${summaryResult.findings.length} 条问题（严重 ${summaryResult.findings.filter(f => f.severity === 'critical').length} / 警告 ${summaryResult.findings.filter(f => f.severity === 'warning').length} / 提示 ${summaryResult.findings.filter(f => f.severity === 'info').length}），详见汇总摘要。`
      : `共执行 ${summaryResult.stats.totalNodes} 个节点，成功 ${summaryResult.stats.successNodes} 个，失败 ${summaryResult.stats.failedNodes} 个，未发现异常。`,
    error_section: errorSection,
    generated_time: new Date().toLocaleString()
  };

  try {
    logger.info('📄 正在使用报告服务生成报告...');
    const generatedReport = reportService.generateReport(workflowTemplate.id, variables, 'markdown');
    logger.info('✅ 报告已通过服务生成:', generatedReport.id);

    try {
      logger.info('📄 正在向 reports 表插入报告...');
      reportsRepo.create({
        id: generatedReport.id,
        name: generatedReport.name,
        type: 'generated',
        content: generatedReport.content,
        format: 'markdown',
        task_id: taskId,
        created_at: new Date().toISOString(),
      });

      logger.info('📄 正在更新 tasks 表的 report_id 字段...');
      tasksRepo.updateReportId(taskId, generatedReport.id);

      logger.info('✅ 工作流执行报告已生成并关联到任务:', generatedReport.id);

      const savedReport = reportsRepo.getById(generatedReport.id);
      logger.info('✅ 验证：从数据库中读取到的报告:', savedReport ? '存在' : '不存在');

    } catch (e) {
      logger.error('❌ 报告关联失败:', e);
    }
  } catch (generateError) {
    logger.error('❌ 报告生成过程出错:', generateError);
  }
}
