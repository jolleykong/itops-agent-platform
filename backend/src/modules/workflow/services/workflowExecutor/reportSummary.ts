/**
 * workflowExecutor/reportSummary.ts — 工作流执行报告汇总层
 *
 * 职责：把各节点（尤其是巡检类 Agent）拼合式的原始输出解析为结构化发现（Finding），
 * 按严重程度分级排序，生成"汇总摘要"区块；并可选调用 LLM 生成执行结论。
 * 所有解析均为纯函数，LLM 调用失败不影响报告生成（降级为规则化结论）。
 */

import { logger } from '../../../../utils/logger';
import { generateCompletion } from '../../../ai/services/llm/llmService';
import type { WorkflowNode, NodeResult } from '../../../../types';

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** 影响对象：服务器名(hostname) 或节点名 */
  target: string;
  /** 检查项或问题来源 */
  item: string;
  /** 原始细节 */
  detail: string;
  /** 建议动作 */
  advice: string;
}

export interface NodeSummaryStats {
  totalNodes: number;
  successNodes: number;
  failedNodes: number;
  inspectedServers: number;
  serverConnectErrors: number;
  checksPassed: number;
  checksFailed: number;
}

export interface SummaryResult {
  findings: Finding[];
  stats: NodeSummaryStats;
}

// ── 严重度规则（按检查项关键字，命中即分级，未命中归为 info）──
const CRITICAL_KEYWORDS = [
  'disk', 'memory', 'cpu', 'service', '服务', '备份', 'backup',
  'connect', '连接', 'refused', 'timeout', 'unreachable',
];
const WARNING_KEYWORDS = [
  'ssh', 'firewall', 'user', 'package', 'update', 'cron', 'login',
  '用户', '防火墙', '安全', '合规', '补丁', '登录', '口令', '密码',
];

// ── 建议动作映射（按检查项，未命中给通用建议）──
const ADVICE_MAP: Array<[RegExp, string]> = [
  [/disk|磁盘/i, '清理大文件/日志或扩容，磁盘水位超阈值需优先处理（df -h 定位挂载点）'],
  [/memory|内存/i, '排查内存占用 Top 进程，确认是否存在泄漏；必要时调整参数或扩容'],
  [/cpu/i, '用 top 定位高 CPU 进程，区分异常进程与正常业务负载高峰'],
  [/service|服务/i, '确认关键服务状态并尝试恢复（systemctl restart <name>），排查启动失败原因'],
  [/backup|备份/i, '立即核查备份任务失败原因，确认备份链完整性，避免恢复点缺失'],
  [/ssh config/i, '核查 sshd 配置基线（口令策略、Root 登录限制、协议版本）'],
  [/firewall|防火墙/i, '核查防火墙规则是否按基线开启，避免端口裸露'],
  [/user|用户/i, '核查账号列表中的新增/异常账号，清理无关用户并复核权限'],
  [/package|update|补丁/i, '评估安全补丁影响面，安排更新窗口'],
  [/cron/i, '核查定时任务是否存在异常项或失效任务'],
  [/login|登录/i, '核查最近登录来源是否异常，必要时封禁来源 IP'],
  [/network|网络/i, '核查网卡/路由配置是否发生非预期变更'],
  [/connect|连接|refused|timeout/i, '检查 SSH 连通性、凭证有效期与网络策略（安全组/防火墙）'],
];
const DEFAULT_ADVICE = '查看原始输出定位失败原因，必要时人工介入处理';

function classifySeverity(item: string): Severity {
  const lower = item.toLowerCase();
  if (CRITICAL_KEYWORDS.some((k) => lower.includes(k))) return 'critical';
  if (WARNING_KEYWORDS.some((k) => lower.includes(k))) return 'warning';
  return 'info';
}

function adviceFor(item: string): string {
  for (const [re, advice] of ADVICE_MAP) {
    if (re.test(item)) return advice;
  }
  return DEFAULT_ADVICE;
}

// 连接类错误 → 严重；其余节点错误 → 警告
function severityForNodeError(msg: string): Severity {
  const lower = msg.toLowerCase();
  if (/connect|refused|timeout|unreachable|auth|认证|连接|超时|拒绝/.test(lower)) return 'critical';
  return 'warning';
}

/**
 * 解析巡检类 Markdown 输出（inspectionAgent 格式）。
 * 格式约定：
 *   ### 🖥️ 服务器名 (hostname)
 *   **检查结果**: x ✅, y ❌
 *   ✅/**检查项**: 通过|失败
 *   **错误**: ...
 * 同时兜底捕获任意节点输出的 ❌ 行与 **错误** 行。
 */
export function summarizeNodeResults(
  nodes: WorkflowNode[],
  nodeResults: Record<string, NodeResult>
): SummaryResult {
  const findings: Finding[] = [];
  const stats: NodeSummaryStats = {
    totalNodes: Object.keys(nodeResults).length,
    successNodes: 0,
    failedNodes: 0,
    inspectedServers: 0,
    serverConnectErrors: 0,
    checksPassed: 0,
    checksFailed: 0,
  };

  for (const nodeId of Object.keys(nodeResults)) {
    const node = nodes.find((n) => n.id === nodeId);
    const nodeLabel = node?.data?.label || nodeId;
    const result = nodeResults[nodeId];

    if (result?.status === 'success') stats.successNodes++;
    if (result?.status === 'failed') stats.failedNodes++;

    const output: string = result?.output || '';

    // ── 1) 按"### 🖥️ 服务器 (host)"分节解析巡检输出 ──
    const sectionRe = /^#{2,4}\s*🖥️\s*(.+?)\s*\(([^)]+)\)\s*$/gm;
    const sections: Array<{ name: string; host: string; start: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = sectionRe.exec(output)) !== null) {
      sections.push({ name: m[1].trim(), host: m[2].trim(), start: m.index });
    }

    if (sections.length > 0) {
      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const end = i + 1 < sections.length ? sections[i + 1].start : output.length;
        const body = output.slice(sec.start, end);
        stats.inspectedServers++;

        const statMatch = body.match(/\*\*检查结果\*\*:\s*(\d+)\s*✅,\s*(\d+)\s*❌/);
        if (statMatch) {
          stats.checksPassed += parseInt(statMatch[1], 10);
          stats.checksFailed += parseInt(statMatch[2], 10);
        } else {
          // 无统计行时按逐行累加
          const passLines = body.match(/✅\s*\*\*.+?\*\*:/g);
          const failLines = body.match(/❌\s*\*\*.+?\*\*:/g);
          stats.checksPassed += passLines ? passLines.length : 0;
          stats.checksFailed += failLines ? failLines.length : 0;
        }

        // 失败检查项 → Finding
        const checkRe = /❌\s*\*\*(.+?)\*\*:\s*(.*)/g;
        let cm: RegExpExecArray | null;
        while ((cm = checkRe.exec(body)) !== null) {
          const item = cm[1].trim();
          findings.push({
            severity: classifySeverity(item),
            target: `${sec.name} (${sec.host})`,
            item,
            detail: cm[2]?.trim() || '检查失败',
            advice: adviceFor(item),
          });
        }

        // 服务器级错误（多为 SSH 连接失败）
        const errMatch = body.match(/\*\*错误\*\*:\s*(.+)/);
        if (errMatch) {
          stats.serverConnectErrors++;
          findings.push({
            severity: severityForNodeError(errMatch[1]),
            target: `${sec.name} (${sec.host})`,
            item: '服务器连接/巡检失败',
            detail: errMatch[1].trim(),
            advice: adviceFor('connect'),
          });
        }
      }
    } else {
      // ── 2) 通用兜底：非分节输出中的 ❌ 行 ──
      const checkRe = /❌\s*\*\*(.+?)\*\*:\s*(.*)/g;
      let cm: RegExpExecArray | null;
      while ((cm = checkRe.exec(output)) !== null) {
        const item = cm[1].trim();
        findings.push({
          severity: classifySeverity(item),
          target: nodeLabel,
          item,
          detail: cm[2]?.trim() || '检查失败',
          advice: adviceFor(item),
        });
      }
    }

    // ── 3) 节点级错误（error 字段优先）──
    const nodeError = result?.error || (output.match(/\*\*错误\*\*:\s*(.+)/)?.[1] ?? '');
    if (nodeError && sections.length === 0) {
      findings.push({
        severity: severityForNodeError(nodeError),
        target: nodeLabel,
        item: '节点执行失败',
        detail: nodeError.trim(),
        advice: adviceFor('connect'),
      });
    }
  }

  // 排序：severity 权重升序，同级保持出现顺序
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return { findings, stats };
}

const SEVERITY_META: Record<Severity, { icon: string; title: string }> = {
  critical: { icon: '🔴', title: '严重问题（需立即处理）' },
  warning: { icon: '🟠', title: '警告（需关注）' },
  info: { icon: '🟡', title: '提示' },
};

/**
 * 生成"汇总摘要"Markdown 区块（按重要程度排序的问题清单 + 总览统计）。
 */
export function buildSummarySection(result: SummaryResult): string {
  const { findings, stats } = result;

  const totalChecks = stats.checksPassed + stats.checksFailed;
  const healthRate = totalChecks > 0
    ? ((stats.checksPassed / totalChecks) * 100).toFixed(1)
    : '-';
  const inspectedTotal = stats.inspectedServers + stats.serverConnectErrors;

  const lines: string[] = [];
  lines.push('### 总览');
  lines.push(
    `- **节点执行**: 共 ${stats.totalNodes} 个节点，成功 ${stats.successNodes}，失败 ${stats.failedNodes}`
  );
  if (inspectedTotal > 0) {
    lines.push(
      `- **巡检范围**: ${inspectedTotal} 台服务器，检查项 ${totalChecks} 项，通过 ${stats.checksPassed}，失败 ${stats.checksFailed}（健康率 ${healthRate}%）`
    );
    if (stats.serverConnectErrors > 0) {
      lines.push(`- **连接失败**: ${stats.serverConnectErrors} 台服务器无法完成巡检`);
    }
  }
  lines.push(`- **发现问题**: ${findings.length} 条`);

  if (findings.length === 0) {
    lines.push('');
    lines.push('✅ **本次执行未发现异常**，所有检查项均通过。');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('### 问题清单（按重要程度排序）');
  for (const severity of ['critical', 'warning', 'info'] as Severity[]) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    const meta = SEVERITY_META[severity];
    lines.push('');
    lines.push(`#### ${meta.icon} ${meta.title}（${group.length} 条）`);
    for (const f of group) {
      lines.push(`- **${f.target}** — ${f.item}：${f.detail}`);
      lines.push(`  - 建议：${f.advice}`);
    }
  }

  return lines.join('\n');
}

/**
 * LLM 执行结论（可选增强）：把排序后的发现交给 LLM 生成简明结论与建议。
 * 任何失败（无可用模型/超时/解析异常）都降级为 null，由调用方回退到规则化结论。
 */
export async function generateLlmConclusion(
  workflowName: string,
  result: SummaryResult
): Promise<string | null> {
  const { findings, stats } = result;
  if (findings.length === 0 && stats.totalNodes === 0) return null;

  // 只喂给 LLM 排序后的前 40 条发现，控制 token
  const findingsText = findings.slice(0, 40)
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.target} — ${f.item}: ${f.detail}`)
    .join('\n');

  const prompt = `以下是运维工作流「${workflowName}」的执行结果汇总。

执行统计：${stats.totalNodes} 个节点（成功 ${stats.successNodes}/失败 ${stats.failedNodes}）${stats.inspectedServers > 0 ? `，巡检 ${stats.inspectedServers + stats.serverConnectErrors} 台服务器，检查项通过 ${stats.checksPassed}/失败 ${stats.checksFailed}` : ''}。

按重要程度排序的发现：
${findingsText || '（无具体发现，节点全部成功）'}

请用中文输出一段 100~200 字的执行结论，要求：
1. 第一句话给出整体健康度的定性判断；
2. 按 严重→警告→提示 的优先级概括关键问题（点出最需要立即处理的对象与事项）；
3. 结尾给出 1~2 条最优先的处理建议。
不要罗列全部条目，不要输出标题和列表以外的格式。`;

  try {
    const conclusion = await generateCompletion(
      prompt,
      '你是一名资深运维专家，负责为自动化巡检/工作流报告撰写简明扼要的执行结论。回答要专业、直接、有优先级。',
      0.4,
      undefined,
      'workflow-report',
      'workflow-report'
    );
    const trimmed = conclusion.trim();
    if (!trimmed) return null;
    return trimmed.length > 600 ? `${trimmed.substring(0, 600)}…` : trimmed;
  } catch (err) {
    logger.warn('⚠️ 工作流报告 LLM 结论生成失败（降级为规则化结论）:', err instanceof Error ? err.message : err);
    return null;
  }
}
