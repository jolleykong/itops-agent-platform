# 工作区交接说明（2026-11-27）

本目录是 ITOps / iTop CMDB / Zabbix 监控的开发与运维工作区：
`/Users/kongyan/AI_Project`
（2026-11-27 从 `/Users/kongyan/WorkBuddy/2026-11-13-17-09-26` 整体迁入；同日用户又将内容从
`AI_Project/2026-11-13-17-09-26` 上提一层，**本目录即最终工作区根，无日期层**。原 WorkBuddy 会话已归档。
历史文档与日志里出现的旧路径，一律按新路径解读。）

## 双 harness 协作协议（WorkBuddy ⇄ OpenCode）

用户会在 WorkBuddy 与 OpenCode 两侧交替推进本工作区，并尽量避免两边同时做同类工作。以下规则让切换无冲突；**两个 harness 必须共同遵守**。

- **共享交接板**：根目录 `HANDOFF.md`（**不属于任何 git 仓库**，写它不会弄脏仓库）。开工第一步读它，确认占用锁、git 基线、服务器/tag 占用；收工/切换前更新它（当前 harness、时间、改了哪些文件、新 HEAD、下一步）。模板在文件内。
- **独占写边界**：WorkBuddy 独占 `.workbuddy/memory/**`（MEMORY.md、MEMORY-details.md、每日日志）；OpenCode 独占源码与项目内文档。跨边界只读、不直接改对方文件；需要对方改就在 HANDOFF「下一步」留言。注意 `AGENTS.md` 与 `2026-11-27.md` 根目录副本是软链，实体在 `docs/workspace/`，**任一侧改动都直接改实体**，改完由该侧提交。
- **git 是交接真值**：开工先核对三仓库 `git status` 与 HANDOFF 基线。遇到脏仓库且 HANDOFF 未声明归属 → **停手问用户**，不猜、不清理、不 `checkout --` / `reset --hard` / `clean`。谁改的谁提交；提交前做凭据扫描。文档提交可不升版本，代码提交按下方发布纪律升版本+tag。
- **发布/服务器串行化**：tag（`kkv-*`）与服务器 `10.0.1.116` 是全局互斥资源。发布或上服务器操作前，必须在 HANDOFF 登记占用；另一侧见到占用就只做本地只读工作或等待。不得两边同时切镜像、同时 scp、同时打同名 tag。
- **记忆写入**：过程日志 append-only、只追加自己那段，不覆写对方条目；长期结论写入前先读现有段落，避免重复矛盾。`MEMORY.md` 只留高频结论，专项细节在 `.workbuddy/memory/MEMORY-details.md`，按需读取。
- **冲突即停**：任何不一致（HEAD 对不上、文件被对方改过、HANDOFF 时间戳异常）都先停下，向用户报告后再动。宁可多问一句，不覆盖对方工作。

## 记忆与文档入口

- **长期结论**：`.workbuddy/memory/MEMORY.md` — 按主题收录部署、数据库兼容层、iTop、zbx2itop、Zabbix、机房看板、安全等结论与铁律。先读它。
- **过程日志**：`.workbuddy/memory/2026-11-*.md` — append-only，包含完整踩坑与证据链，不要覆写。
- **cipipe 治理史**：`projects/cipipe/docs/governance-log.md`
- **报告/导出**：`output/`；根目录 3 份机柜台账 CSV。
- WorkBuddy 使用 `.workbuddy/memory/`；OpenCode 使用本文件作为入口，两者指向同一套事实源。
- 版本副本：工作区级文档的 Git 副本在 `projects/itops-fork/docs/workspace/`；其中 `MEMORY.md` 是脱敏版，本地 `.workbuddy/memory/MEMORY.md` 是真实版（含生产凭据，不进 Git）。根目录的本文件和 `2026-11-27.md` 是指向仓库副本的软链接。

## 子项目

| 目录 | 用途 | 分支 / 远端 |
|---|---|---|
| `projects/itops-fork` | aiops 平台后端与前端 | main → github.com:jolleykong/itops-agent-platform |
| `projects/iTop` | iTop 定制（纯 CMDB 裁剪、db 外置） | kk-dev |
| `projects/cipipe` | CI 治理与快照（Python 3.13 venv） | main |

## 称谓映射与歧义处理

- `itop` / `iTop` → `projects/iTop`（iTop CMDB 定制）
- `aitop` / `aiop` / `aiops` / `aitops` 及相近叫法 → `projects/itops-fork`（aiops 平台）。注意与 `iTop` 仅一字之差，不要混为一谈。
- `sync` / `资产治理单元` → 通常指 `projects/cipipe`。但 `sync` 也可能指已被 cipipe 接管的旧 `itop-sync` / `cmdb-sync/sync.py`，或 itops-fork 里的 cmdb-sync 模块；**不确定时必须先问用户确认，不得猜。**
- 用户临时用了陌生或不确定叫法 → 先用一句话回问确认对象，再动手。

## 操作纪律（摘要，完整版见 MEMORY.md）

1. **发布**：itops-backend/frontend、itop-sync、itop-web 每次改动必须升小版本 + 打 tag `kkv-<版本>` + 基于 tag 构建；提交前做凭据扫描。当前 itops 侧 `kkv-3.2.4`，iTop 侧 `kkv-3.1.1`。
2. **切换镜像**：改 `/opt/{itops,itop}/docker-compose.yml` 的 image tag 后 `docker compose up -d`；`restart` 不换镜像；旧 compose 留 `.bak`。
3. **远程操作**：服务器 `10.0.1.116`，expect 脚本 `/tmp/sshrun.sh`、`/tmp/scprun.sh`（`/tmp` 会清理，需重建）；scp 逐文件传 + sleep 1 + 双端 MD5 校验。
4. **数据库兼容层**：生产用 MariaDB（`aiops` + `itop` 同实例），SQLite 仅回滚；循环里同步 DB 写入超几十次必须分批 + 批间让出 event loop，否则冻结 event loop 引发 `socket hang up`。
5. **iTop OQL**：不支持 `IS NULL`；`status != 'x'` 会连 NULL 一起排除；REST 的 IP 字段是 `managementip`。同步必须过滤 obsolete / `__DUP_` 退役对象。
6. **Oracle 访问**：MCP / node-oracledb 必须走 Thick 客户端（Instant Client 23.26 + node 22.22.2），Thin 不支持 10G/11G verifier 与 11g 协议；破坏性操作前必查 `DBA_HIST_SQL_PLAN` + `V$SQL_PLAN` + 约束关联。
7. **安全**：不要在源码、文档、日志里写明文口令；密钥与密文同库是已知弱点，生产凭证在生产环境读取。

## 环境提示

- 移动工作区后，`projects/cipipe/.venv` 中 7 个脚本会残留旧绝对路径（pip 系列 shebang、activate 系列、`pyvenv.cfg`），需批量替换后 venv 才可用。
- `projects/cipipe/scripts/kk-release.sh` 用 `$(BASH_SOURCE)` 动态定位，不依赖工作区位置。
-  conncheck：3 个 git 仓库（cipipe / iTop / itops-fork）移动前均干净，HEAD 分别为 `11de443`、`76879bb`、`f8c4137`。

## 工作流与代码权威源（2026-11-27 用户定调）

- **铁律：本地 macOS 先落地，服务器后验证。** `10.0.1.116` 只承担构建、运行、调试，不承担代码权威；不得把服务器上的临时改动当作最终产出，也不得在本地尚无提交/标签时先改服务器。
- 标准顺序：
  1. 本地实现 + 验证（lint/tsc/测试/凭据扫描）→ 升版本 → commit + tag → `git status` 干净且 tag 指向 HEAD。**这一步是本地可靠检查点。**
  2. 推送 commit 和 tag 到 GitHub，核对远端一致。
  3. 从本地已打 tag 的产物 scp/sync 到 `10.0.1.116`；逐文件传 + sleep 1 + 双端 MD5；保留旧 compose `.bak`。
  4. 服务器按 tag 构建镜像、`docker compose up -d`、冒烟/调试。
  5. 若调试产生代码变更，必须回到本地重做第 1-2 步再重新部署；服务器临时热修只用于定位，不进最终版本。
- cipipe 的运行时数据仍只在服务器卷；本地 `var/snapshot-server.db` 是只读排查快照，不回推，也不视为代码产出。
- 汇报必须给出：本地版本/tag、commit、GitHub 推送结果、服务器部署版本与验证证据；任一步未完成不得声称“已完成发布”。
