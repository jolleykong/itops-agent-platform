# SQLite → PostgreSQL 双驱动切换设计（P1）

> 状态：设计稿 v1（2026-11-19）
> 背景容量基准：**几千台节点**（物理/虚机几百台、iLO/BMC SNMP 100+、数据库实例近 1000、存储 100+）
> 原则：开发/测试/预览继续用 SQLite（零部署成本），生产规模化配置 `DB_DRIVER=pg` 即切换，业务代码不感知。

## 1. 现状盘点（脚本 `backend/scripts/dbDialectScan.ts` 可随时重扫）

| 方言/API 点 | 数量 | PG 对应 |
|---|---|---|
| `db.prepare`（better-sqlite3 同步 API） | 842 处 / 约 80 个 repo 文件 | pg 异步 Pool；**调用侧全部 async/await 化**（最大工作量） |
| `datetime('now','localtime')` | 437 处 | `now()` / `localtimestamp`，时区统一 UTC 存储或明确 localtimestamp |
| `INSERT OR IGNORE / REPLACE` | 59 处 | `ON CONFLICT (cols) DO NOTHING / DO UPDATE`（注意 OR REPLACE 语义差异） |
| `PRAGMA`（WAL/busy_timeout 等） | core.ts 集中 | PG 服务端参数承担，应用侧删除 |
| 其他（AUTOINCREMENT / sqlite_master / last_insert_rowid / BOOLEAN 0-1） | 少量 | 逐条映射（见扫描器 note） |

**关键结论：切换 PG 的唯一硬性前置 = repository 层同步 → 异步收口。** 这不是 SQL 方言问题，而是 API 模型问题（better-sqlite3 同步 vs node-pg 异步）。

## 2. 目标架构（切换完成后）

```
repositories/*.ts（业务 SQL，全部 async 签名）
        │  只调用统一接口
        ▼
models/database/driver.ts —— 驱动适配接口
  ├── SQLiteDriver（better-sqlite3，同步实现塞进 async 签名，零成本）
  └── PgDriver（node-pg Pool，事务/参数占位符 $1 转换）
        ▼
DB_DRIVER=sqlite | pg   DB_URL=postgres://...
```

适配接口（最小面）：

```ts
interface DbDriver {
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;          // DDL/多语句
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
```

- SQL 统一写 **ANSI 兼容子集**，方言差异集中在 `dialect.ts` 翻译层：
  - `?` 占位符 ↔ `$1..$n`
  - `datetime('now','localtime')` ↔ `localtimestamp`（翻译层 regex 替换，与扫描器同一套规则表）
  - `INSERT OR IGNORE/REPLACE` ↔ `ON CONFLICT`（需建表时提供唯一键信息，逐步人工确认）
- BOOLEAN：PG schema 用 BOOLEAN，翻译层把 `= 0/1` 重写为 `= false/true`（或 SQLite 侧保持 0/1、PG 侧 SMALLINT 过渡）

## 3. 分阶段实施（每步可独立交付、可回滚）

| 阶段 | 内容 | 产出 |
|---|---|---|
| **S1（已完成）** | 驱动选择入口 `DB_DRIVER`（core.ts resolveDriver，pg 时明确报错）+ 方言扫描器 | 配置入口预留 + 工作量基线 |
| **S2** | `driver.ts` 适配接口落地，SQLiteDriver 先行；选取 1 个低流量 repo（如 dbHealthRepository）试点 async 签名 | 接口验证 + 迁移样板 |
| **S3** | 按文件批量 async 收口（80 文件 × 平均 10 处），`?`→`$n` 与时间函数由翻译层处理；每批跑全量测试 | 双驱动可用的 repositories |
| **S4** | PgDriver（node-pg）+ PG DDL 迁移脚本（v001_schema 转换）+ 数据迁移工具（pgloader 或导出-导入脚本） | `DB_DRIVER=pg` 可启动 |
| **S5** | 切流：预览环境 PG 跑 1-2 周对比验证 → 生产切换；SQLite 保留为开发默认 | 生产 PG |

## 4. 风险与决策点

- **事务语义**：better-sqlite3 同步事务 vs PG 事务绑定连接——PgDriver.transaction 从 Pool 单独 checkout 连接，S3 期间 repo 内禁止嵌套 transaction。
- **`OR REPLACE` 语义陷阱**：PG `ON CONFLICT DO UPDATE` 需显式列清单，59 处需逐条确认唯一键。
- **时间语义**：437 处 localtime 建议借迁移统一为 UTC 存储 + 展示层本地化（一次性还清技术债，否则两库时区行为不一致）。
- **JSON 列**：SQLite TEXT JSON → PG JSONB（查询能力提升，索引需重建）。
- **大表**：compliance_checks / server_metrics / audit_logs 是增长主力，PG 后可分区；监控时序仍以 Zabbix 为真源，平台不重复自存。

## 5. 与容量基准的衔接

- 几千台规模下平台 DB 只存**结论性元数据**（巡检结果、告警、审计、任务），写入压力主力已被 P0（LLM 前置过滤 + 时序不自存）削掉；
- PG 化后剩余写入（结果 JSON/审计）≈ 每天万级行，单 PG 实例轻松承载；
- sudo 日志/全量输出 → ELK（已有栈，需独立容量评估），平台不存。
