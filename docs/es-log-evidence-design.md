# ES 日志证据层设计（零信任日志上下文 / log-evidence）

> 2026-11-19 定稿。容量基准：几千台节点。核心思想与「监控时序数据留在 Zabbix」同理：
> **日志明细留在 ELK，平台只取证据、只存结论，绝不经 SSH 到主机上翻日志文件。**

## 1. 问题陈述

当前三个断点：

| 断点 | 现状 | 证据 |
|---|---|---|
| 报警后 AI 分析拿不到日志 | RCA `collectContext()` 只采集拓扑/变更/服务器状态/关联告警，无日志 | `rcaAnalyzer.ts:283` |
| 巡检无日志项 | 巡检 = SSH 合规检查，`sshComplianceService` 无任何 /var/log 类检查 | 全量 grep 无 /var/log |
| ES 是孤岛 | ES 能力只有人工查询页；预设里 `alert_source='elasticsearch'` 的映射无采集器喂入，空转 | `initAlertMappings.ts:97` |

ES 侧已具备的条件（S0 探查 + 查询模块已上线）：
- 索引族：`syslog-rsyslog-YYYY.MM`（2100万）、`oracle-YYYY.MM`（3300万）、`networklog-YYYY.MM.DD`、`system-*`、`backup`
- `host.name` 与平台 `servers.name` 同源（已实测 zydb11）
- ECS 字段全 keyword，level 四级；viewer 角色可用 `size=0` terms agg 绕过 cluster monitor
- `elasticsearchService`（search/rawSearch/聚合）+ `elasticsearchConnectionStore`（凭据 AES 加密持久化）已就绪

## 2. 核心抽象：logEvidenceService

新服务（`backend/src/modules/monitor/services/logEvidenceService.ts`），统一回答一个问题：

```
给定 (主机名, 时间窗, 设备类别)，返回该主机在这段时间里"值得关注"的日志证据摘要。
```

```ts
interface LogEvidenceRequest {
  hostName: string;            // 关联键：host.name == servers.name
  fromMs: number; toMs: number; // 毫秒 epoch，统一 UTC
  category?: 'os'|'db'|'network'|'storage';
  levelMin?: string;           // os 默认 warning；db 默认 error（ORA-）
  patterns?: string[];         // 领域关键词扩展（ORA-/segfault/OOM…）
  maxSamples?: number;         // 代表样本条数，默认 20
}

interface LogEvidenceResult {
  available: boolean;          // ES 不可用/未配置 → false，调用方静默降级
  familiesQueried: string[];
  levelStats: Record<string, number>;   // 聚合：级别分布
  topPatterns: { pattern: string; count: number }[];  // 聚合：错误模式 top N
  samples: { timestamp: string; host: string; level: string; message: string }[]; // 截断样本
  totalHits: number;
  tookMs: number;
}
```

**铁律（容量红线）：**
1. 输出永远是「聚合摘要 + 截断样本」，绝不把原始日志整段喂给 LLM；
2. 强制时间窗 + host.name term 过滤（networklog 日量巨大，裸查会打死 ES）；
3. 单次查询 timeout 5s、size ≤ 100（样本 ≤ 20）、超时/异常静默降级为 `available:false`，绝不阻塞告警/巡检主流程；
4. 每个告警/巡检项最多触发 1 次 ES 查询。

## 3. 设备类别路由（category → 索引族）

| 类别 | 索引族 | 默认 levelMin | 默认 patterns |
|---|---|---|---|
| os | `syslog-rsyslog-*`（主）+ `system-*`（辅） | warning | segfault, OOM, killed, refused, fail* |
| db | `oracle-*` | error | ORA-, TNS-, deadlock, checkpoint |
| network | `networklog-*` | warning | down, flap, reject, deny |
| storage/backup | `backup`（覆盖面待确认） | warning | failed, abort |

**类别判定 `classifyDevice(server)`（v1 规则，v2 演进）：**
- v1：可配置的 hostname 规则映射（settings 表存 JSON），如 `zydb*→db`、`^(sw|rt|fw|net)→network`；未命中默认 os；
- v2：Zabbix 主机组同步 + DB 实例关联表自动归类。

**注意**：网络设备/存储/iLO 可能不在 servers 表里，但 ES 里有其日志。logEvidenceService 以 **hostname 为唯一关联键**，不强依赖 servers 表 —— 这正是 ES 方案优于 SSH 方案的一点。

## 4. 场景 A：报警 → 自动关联 ES 日志（最高优先）

**挂点**：`rcaAnalyzer.collectContext()` 增加一个分支（与 topology/recentChanges 同级、同 try/catch 降级风格）：

```
告警(source=zabbix/prometheus) 有 server_id 或主机名
  → classifyDevice
  → 时间窗：告警前 30min ~ 告警后 10min（可配 settings）
  → levelMin + 告警标题关键词扩展（patterns = 领域默认 + 标题分词）
  → logEvidenceService → context.esLogs = 聚合摘要
```

**语义**：等价于「工程师收到告警后 SSH 上去 `grep -i error /var/log/messages`」，但零 SSH、零主机负载、毫秒级、可审计。

**防滥用**：同一告警幂等（RCA 重跑不重复查询，告警 id 作缓存键，TTL 10min）；ES 结果在 context 里限长（摘要 + 样本合计 ≤ 4KB 字符）。

**降级矩阵**：ES 未配置 / 超时 / viewer 无该索引权限 / 0 命中 → `esLogs: null` + warn 日志，RCA 照常进行。

**同样挂到工作流 agent**：故障诊断（faultWf）与日志分析（logWf）的 agent 节点入参里注入同一份 esLogs 摘要（经 workflow params 透传），保证 RCA 与工作流两条链路看到同样的证据。

## 5. 场景 B：巡检日志项走 ES（log_check 检查项）

现状巡检只有 SSH 合规检查。新增检查项类型 **log_check**，执行通道二选一：

| 通道 | 行为 | 适用 |
|---|---|---|
| `es`（默认） | logEvidenceService 查过去 24h（可配），级别统计 + 错误模式 → finding | 全量主机，零 SSH |
| `ssh`（兜底） | 保持传统 SSH grep（仅当 ES 未配置或该主机确认不在 ES 覆盖内） | 兼容 |

- finding 分级复用现有体系；**查不到数据 = no_data**（不等于异常），复用 reportSummary 的 no_data 分类，健康率剔除；
- 容量：ES 通道下几千台 = 每台 1 次 5s 超时内的聚合查询，并入巡检并发池（INSPECTION_CONCURRENCY 复用）；SSH 通道维持现状不计入新规模假设；
- 平台不存日志明细，只存 finding（级别、模式计数、代表样本前 N 条）。

## 6. 场景 C：ES 日志巡检规则引擎（log_check 定时任务，原待办）

**规则表** `log_check_rules`：
```
id, name, enabled, host_pattern, category, level_min,
patterns(JSON), window_hours, threshold, severity, advice, created_at
```

**调度与批量优化（几千台关键点）**：不逐台查 —— 按 hostname 前缀/分组，用 **terms 聚合一次查一批主机**（size=0，termsagg on host.name + level agg），先筛出「命中阈值」的主机，再对命中者细查样本。一轮几千台 = 几十次批量查询。

**告警回流**：命中规则 → 写告警表（source=elasticsearch, severity=规则定义）→ 现有 `initAlertMappings` 的 ES 映射与「ES 日志异常自动分析修复」preset 立即不再是空转预设，自动接入工作流/审批链。

**LLM 前置**：规则命中才触发 AI 分析（同 sshComplianceService 全通过跳过 AI 的先例）。

## 7. 场景 D（顺手）：ES 查询页「按主机排查」快捷模式

查询页增加快捷入口：输入主机名 + 时间范围 → 一键展示 logEvidenceService 同款摘要（级别分布 / top 模式 / 样本）。保证「AI 所见 = 人工可复现所见」，便于信任校验。

## 8. 实施顺序

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| S1 | logEvidenceService + collectContext 挂点（场景 A） | 制造一条测试告警 → RCA 报告里出现 esLogs 摘要；停 ES 后 RCA 照常 |
| S2 | 巡检 log_check 检查项 ES 通道（场景 B） | 巡检报告出现日志检查项；ES 停机时该项显示 no_data 而非 critical |
| S3 | 规则引擎 + 定时调度 + 告警回流（场景 C） | 规则命中产生 source=elasticsearch 告警并自动触发工作流 |
| S4 | 查询页快捷模式（场景 D） | 手动按主机+时间窗复现 AI 证据 |

S1 独立可上线；S2/S3 都依赖 S1 的 logEvidenceService；S4 任意时机可做。

## 9. 风险与待确认项

> **实证更正（2026-11-19 S1 实施时实测）**：
> 1. `syslog-rsyslog-*` 的 `log_level` 字段为坏模板变量（全部是 `%{syslog_severity}`）——OS 类级别过滤**不能**依赖该字段，统一改为消息模式匹配（query_string），实测可行（zydb11 近 1 天 error/warn 类 2 条，量级合理）；
> 2. `oracle-*` 的 `log_level` 正常（小写 info/error 等），且 `host.name.keyword` 与 `server.hostname.keyword` 双字段并存，统一用 `host.name.keyword`（zydb11/zydb41 等均命中）；
> 3. ES `filters` 聚合带命名过滤器时返回**对象**（`{p0:{doc_count}}`）而非数组，解析需兼容；
> 4. 留存期按 **7 天**计算（用户定稿：先跑着，按需调整），服务内 `ES_LOG_RETENTION_DAYS` 可配，时间窗起点自动钳制；
> 5. storage 类别（backup 索引）字段结构仍未探查，v1 不启用。

| # | 风险/待确认 | 处置 |
|---|---|---|
| 1 | networklog 日量巨大（索引族总量 90 亿级） | 强制 host.name+时间窗双过滤已在铁律；S1 阶段不碰 networklog |
| 2 | 索引留存期未知（影响巡检 window_hours 上限） | S0 已知 syslog/oracle 按月索引；实施前 `_cat/indices` 确认保留策略 |
| 3 | backup 索引族字段结构未探查 | storage 类别 v1 先不启用，待探查 |
| 4 | 网络设备主机名是否与平台同源 | 同 zydb11 验证法，实施 S3 前抽查 |
| 5 | 告警时间戳时区 | 统一毫秒 epoch；@timestamp 为 UTC，窗口计算单点收敛在 logEvidenceService |
| 6 | ES 成为告警链路新依赖 | 全链路静默降级 + 告警链路超时预算 5s；ES 健康纳入平台自监控 |
| 7 | 清理空转预设 | S3 上线前不删 `elasticsearch` 映射（即将被喂活）；S3 上线后核对行为 |
