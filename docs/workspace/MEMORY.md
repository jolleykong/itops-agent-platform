# ITOps 平台项目长期备注（workspace 级，2026-11-27 精简版）

> 过程细节与完整踩坑记录见 .workbuddy/memory/2026-11-*.md 每日日志。**不要在此堆过程细节**。

## 工作区路径与跨工具协作（2026-11-27）
- **唯一工作区**：`/Users/kongyan/AI_Project`（日期层已剔除，根目录即工作区）；旧路径 `/Users/kongyan/WorkBuddy/2026-11-13-17-09-26` 与中间态 `AI_Project/2026-11-13-17-09-26` 均已停用
- 子项目（当前 3 个）：`projects/itops-fork`（aiops 平台 fork，main 直推 GitHub）、`projects/iTop`（iTop 定制，kk-dev）、`projects/cipipe`（CI 治理）；根目录 3 份台账 CSV + `output/` 报告。旧记录中的 `projects/vecmdb` 当前已不存在
- 用户称谓映射：`itop`→`projects/iTop`；`aitop`/`aiop`/`aiops`/`aitops` 及相近叫法→`projects/itops-fork`；`sync`/`资产治理单元`→通常指 `projects/cipipe`。遇到陌生或不确定叫法先回问确认，不猜。`sync` 尤其可能指已停用的旧 `itop-sync`/`cmdb-sync/sync.py` 或 itops-fork 的 cmdb-sync 模块，必须区分。
- 记忆位置：`.workbuddy/memory/MEMORY.md`（长期结论）+ `2026-11-*.md`（过程日志，append-only）；根目录 `AGENTS.md` 供 OpenCode 读取，WorkBuddy 读 `.workbuddy/memory/`
- 历史日志中出现的旧绝对路径统一按上面的新路径解读；**不改写历史记录**
- ⚠️ 移动工作区后 `projects/cipipe/.venv/bin/{pip,pip3,pip3.13,activate,activate.fish,activate.csh}` 与 `.venv/pyvenv.cfg` 的硬编码路径会失效，必须同步替换（本次已修）

## 部署与发布
- 服务器 kksvr 10.0.1.116；expect 脚本 /tmp/sshrun.sh + /tmp/scprun.sh（<redacted>；/tmp 定期清理需重建；连续建连过多触发 sshd 限流，等 5~10 分钟）
- 源码 /root/kk/itops-agent-platform-main；生产 /opt/itops（backend/frontend），前端宿主 8080；**restart 不换镜像，up -d 才换**
- 构建：`docker build -f docker/Dockerfile.backend(-frontend) -t itops-{backend,frontend}:kkv-<版本> .`（chown 阶段 2-3 分钟，1.07GB）
- **发布纪律（用户铁律）**：itops-backend/frontend、itop-sync、itop-web 每次调整刷新小版本 + 打 tag `kkv-<版本>` + 基于 tag 构建；提交前凭据扫描。当前 **kkv-3.2.4**（iTop 侧 kkv-3.1.1）
- 切换：改 /opt/{itops,itop}/docker-compose.yml 的 image tag → `docker compose up -d`（旧文件留 .bak）
- scp 逐个传 + sleep 1 + 双端 MD5 校验（expect 连续快速调用会丢文件）
- 本地 fork：workspace/projects/itops-fork（main 直推 github.com:jolleykong/itops-agent-platform）；iTop 仓库 workspace/projects/iTop（kk-dev）
- PG 开发实例 itops-pg:5433（宿主 5432 是 Zabbix 系统 PG，不可动）

## 数据库与 MySQL 兼容层（kkv-3.2.0）
- backend 生产已切 MariaDB（SQLite /app/data/app.db 仅回滚）；tsx 直读 /app/src（热修 docker cp + restart）；端口 3001
- 统一实例 aiops-mariadb（mariadb:10.11，宿主 23306）：iTop 库 `itop`（<redacted>）、aiops 库 `aiops`（<redacted>）；容器挂 bridge + itop_default（alias aiops-mariadb），itops backend 需额外接入 itop_default 才能按名解析；iTop 内置 db 降级 `profiles:["bundled-db"]`
- 兼容层：不改 1016 处 db.prepare，加 better-sqlite3 同形门面；mysql2 在 worker_threads，主线程 `receiveMessageOnPort`+`Atomics.wait`；SQL 方言在 dialect.ts。`DB_DRIVER=mysql` 触发
- 已踩平：`sql` 保留字要反引号 / `databases` 表名 / pragma_table_info / 剥列级 REFERENCES / 派生表补别名 / 相关子查询改聚合（无 LATERAL）/ `datetime('now',...)`→DATE_ADD / `start of day`→CURDATE / run().changes 需 `flags:['FOUND_ROWS']`
- 迁移 62 个全过；v012/v058/v059/v063 SQLite 专有跳过；运行时懒建表（automata_trust 等）搬迁前手工补齐
- 搬迁工具在 /tmp（会被清理，可重写）：db_migrate.js / delta_import.js / cmp_cols.js / verify_rows.js

## ⚠️ Atomics.wait 冻结 event loop（kkv-3.2.2 已缓解）
- 大量同步 DB 操作冻结 event loop → 期间 socket FIN 读不到 → `socket hang up`。**判据：两个不同远端同时 socket hang up = 本端 event loop 阻塞，不要查远端**
- cmdb-sync 缓解：HTTP 重试（ECONNRESET/EPIPE/ETIMEDOUT/EAI_AGAIN/ECONNABORTED+5xx，3 次退避）+ 每 200 条分批事务 + 批间 `await setImmediate` + 日志多行 INSERT。Server 1556 条 18.8s/2错 → 9.6s/0错
- **写新代码规矩**：循环里 db.prepare().run() 超过几十次必须分批 + 批间让出 event loop
- 未修：syncDriver.ts 的 `Atomics.store` 在 wait 之后有 lost-wakeup，每次查询可能白等 25ms
- 限流：middleware/rateLimiter.ts 挂 `app.use(mod.path, rateLimiter, router)`，匹配用 **`req.baseUrl + req.path`**；/dc、/cmdb-sync、/monitor、/topology 只读 6000/60s

## iTop CMDB（10.0.1.116:8081）
- jolleykong/iTop 3.3.0-1，栈 /opt/itop，DB itop，口令只在 /opt/itop/.env；已裁剪为纯 CMDB（45→29 模块，kkv-3.1.0），工具 docker/tools/mkcrop.php（setup 选项不驱动卸载，必须手写 selected_modules 跑 unattended-install.php，必须 uid 33）
- REST：POST json_data；外键友好名 `_id_friendlyname`；不存在字段静默忽略；OQL 无 LIMIT；`SELECT DatacenterDevice` 含子类 Server 需 `WHERE finalclass != 'Server'`
- **两个 OQL 铁坑**：不支持 `IS NULL`；`status != 'x'` 连 NULL 一起排除 → 含 NULL 只能在代码层过滤
- DBServer status 是定制 active/inactive（无 obsolete）→ 残渣清理用 core/update status=inactive；Job1 synchro_exec 内联跑淘汰（full_load_periodicity 必须 >0，5 个 DS 已设 14400）
- itop-sync 改码三处同步：/root/kk/iTop/docker/cmdb-sync（构建源）、/opt/itop/cmdb-sync（部署+mount）、本地 projects/iTop；镜像内置 vc_sn_map.json 且保留 bind mount
- ⚠️ iTop REST 字段铁坑：IP 键是 `managementip`，写 `managementip_name` 被静默忽略（曾修 22 处）
- 行级错误看 priv_sync_replica.status_last_error；字段分表（name 在 functionalci、status 在叶表）

## zbx2itop / CI 链路（kk-dev v3.21）
- 分类：模板证据优先（VM/ODBC→DBServer/BMC·ESXi→Server/SNMP网络→网络/存储→存储/无证据→Server phys:unverified）
- BMC 钥匙 `svr-iLo-{带外IP}-{OS名}`；宿主→物理机 SN 四级兜底：vmware item → vc_sn_map.json → uuid-decode → **bmc-auto**（宿主 10.240.48.N ↔ BMC 10.240.0.N，唯一命中才用）；30/30 与 vCenter SN 一致
- ESXi 6.5 不吐 SN（vCenter 侧限制），6 台 x3650 M5 只开 443；BMC FRU 主 item inspur.fru.value.walk + 3 依赖项
- 宿主未挂 6 台：4 台托管平台（跳过）+ 2 台无 Server CI（BMC 未纳管）
- DB→OS：Oracle by ODBC 模板依赖 oracle.instance_hostname 回填 inventory.name（inventory_link=3，79 台开自动）；**gv$instance_map**（item 5712112，1h，text，11g 模板 12240 也已克隆）→ zabbixDbMapService（TTL 5min）→ OsHost children=全集群 DBServer；DBServer parents=OsHost 全节点（跳过占位符）
- 铁坑：ODBC 凭据在 item username/password 字段（连接串不含）；SCAN 不在节点网卡，纯 IP 匹配不可行；inventory.name 会随 SCAN 路由漂移；ODBC item SQL 在 params 字段
- 命名规范：OS 可见名 `svr-<hostname>-<备注>`；硬件 `svr-MGMT-{IP}-{OS名}`；匹配 osNameMatchesHost 三规则（裸名/svr-前缀备注/剥-数字尾巴）。改名闭环：restart itop-sync → Job1 淘汰 → itops 拉取 → 清 servers 残留（先备份）
- Zabbix 治理：36 台 LLD 主机 serialno_a 回填 34 台；inventory_mode manual + LLD delay 60s 触发传播；线上 Zabbix 10.240.22.34 只能 API Bearer token（从 itops credentials 解密）；35 台 guest 未带 -VM（LLD 收敛中）
- 残渣清理：110 台 DB 主机改 DB-ORA-*；99 个旧命名 DBServer 标 inactive；ci-chain 代码层过滤 inactive/obsolete（isStaleDbServer，OQL 层不可行）

## Zabbix 监控终态（7.4.16）
- 网络设备组 gid=31（25 台）；token 在 itops credentials 表 zabbix_api_token（credentialService 解密）；SNMP 团体 public 在 snmp_credentials 表
- Cisco 模板 10218 为主力（8 条依赖式 LLD）；Brocade 光交 ×2 静态 24 端口；S-4500X-1-2 已换 10218（11→2385 items）；SNMP 不通主机挂 ICMP 模板 10564
- 残渣清理基线：unsupported 触发器 1400+→0、项 973→0、Problem 54→36；17296 启用项/16212 新鲜/7273 触发器
- **根因分类**：虚拟接口无计数器（SVI/隧道 ifType≠6，设备不吐数据）/ 累计计数器误写 max>0（应 (max-min)>0）/ 采集间隔>函数窗口 / 温度阈值过紧（FPGA/IFE 加宏 70/80）/ IOS-XE 版本正则 / 历史禁用项。LLD 不重新启用被手动禁用的触发器（禁用可持续，删原型会重建）
- API 坑：触发器存储格式是 {functionid} 但 create/update 必须传函数式语法（`rate(/host/key,15m)>1`）；configuration.import rules 键 `discoveryRules`；模板组 uuid 缺失整包报错；无 usermacro.createmany；countOutput 返回字符串（Python 真值）；换模板必须 templates_clear 否则 inventory 撞车；lastcheck 不存在于 item.get
- LLD 坑：**只要 JS(type=21) 一步输出 `[{...}]`，多余空 JSONPath 步骤必失败**；preprocessing 在 64KB 截断前执行可绕过 text 上限；改原型后必须 `trigger.delete`(flags=4) 重跑 LLD 才更新表达式
- Unity 3 台（.205/.210/.211）：模板副本 11068/11069/11070 + 基础 10629，新 HTTP-LLD 模板 12663（pool/lun/filesystem/hostInitiator + disk/fan/psu/ssd/memoryModule/storageProcessor 6 类）；Unity-03 因 loginSessionInfo 被 CAS 拦已改挂 12663；**REST 会话式认证，HTTP agent Basic Auth 对数据端点可用，登录端点 302**；URL 坑：`?fields=a,b&per_page=N` 必须 `&`、fields 必须含 health、slotNumber/parent.type 会 422；健康枚举 5/7 OK、`>7` 告警，running 正常 5/6/8 → `>=10`，**link 正常 10/11 → `<10`**
- ⚠️ secret 宏改 type=0 会清空值（曾致 Unity-03 静默中断 100 分钟）；验证采集健康看 lastclock 不看 state；需要密码直接问用户
- Unity trap 模板 12459：master `snmptrap["xioEventTrap|emc\.103\.1\.18"]`（必须 MIB 名形态）；按源 IP 匹配主机；Zabbix 不会因 item 无新数据重算触发器（fallback 僵尸告警需 acknowledge close）
- XtremIO 2 台（.200/.206）：SNMP 161 不通但 REST 443 通；trap 模板 12661（`snmptrap["xioEventTrap"]`，**item 必须绑 161 interface**）+ REST 模板 12662（Basic Auth，248 项/89 触发器，xio.cluster.full 5m + LLD vol/init/ssd + xio.alive REST 探活）；JSONPath 铁坑：`$['content']['rd-iops']` 连字符字段不能写 `$.content.rd-iops`；SSD 用 fru-lifecycle-state / diagnostic-health-state；01=25 盘/02=13 盘由 LLD 适配；终态 01=268 项/02=172 项，0 unsupported/0 problem
- 可控触发 XtremIO 真 trap：`curl -sk -u admin:<invalid> https://<xms>/api/json/v2/types/clusters`
- 触发器 A 方案：时延类统一 `$,15m` 窗口（01 219 个、02 59 个）；累计计数器用 (max-min)>0

## 前端机房看板（DataRoomView / 路由 /data-room）
- 3D 已永久移除；纯 2D Room2DView，每排 8 台（数组下标分组）；i18n `dcRoom3D`=机房看板、`cmdbTopology`=CMDB看板
- CPU 治理：LiveClock 剥秒级 state / CSS :hover / 全删 backdrop-filter / 删常驻动画 / content-visibility:auto / 卡片 memo
- 点机柜 → RackFrontView（按 startU 倒序，batch 与 fetchRackSlots 双路径都要 sort）
- 层级链 ciChainService：机柜→Server→Hypervisor→VM(-VM)→**VmOs（本地虚拟类=操作系统层）**→DBServer；vmCounterparts 名称优先（剥/加 -VM）+ managementip 并行，**有具名对端就剔除纯 IP 残渣项**；VmOs children 需别名归并（DB-ORA-Finedb-ODBC ↔ VS-finedb）
- 3D 挂柜（方案 A）：Server/DatacenterDevice 拉 rack_id 写 dc_rack_slots；iTop 无 rack → DELETE 槽位；台账 U 优先→冲突顺延→自动占位；默认 server=2U/network=1U/存储留空；终态 258 槽位（server 176/other 71/network 11）；OS 层（"zbx:" 前缀 42 台）rack 清零
- **重复空白机柜（kkv-3.1.1）**：根因=建柜幂等只依赖 itop_id_map，映射丢失后每轮重建（19 组同名柜/38 条）。修法 upsertRack() 双重兜底：existingId 指向已删行先判 alive + create 前按 (room_id,name) 回查转更新
- **退役 CI 过滤（kkv-3.2.4）**：iTop 侧 cipipe 治理产生 1955 个 `__DUP_*`+obsolete；同步 OQL 原本无 status 过滤 → 2085 条 DUP 入库、占 78 槽位。修法：`RETIRE_ENABLED_CI_TYPES={Server,DatacenterDevice}`，`status==='obsolete' || name含__DUP_` → `retirePlatformCI()` 删平台记录（仅无凭证/无 zabbix 绑定）+槽位+摘 idMap。**两个易漏点**：① 还有 233 台名称正常但 obsolete 的 Server，不能只按名字过滤；② 无 IP 设备的 `device_type='other'` 槽位 device_id 是**设备名**，必须按 ciName 再删一次（kkv-3.2.4 补丁）
- ⚠️ 遗留：Server 同步每轮 ~455 条 `UNIQUE constraint failed: servers.ip_address`（iTop 多台 Server 共用 managementip），待产品决策谁胜出

## 前端联调与安全
- axios 拦截器统一解包 `{success,data}`：调用方 response.data 即业务载荷；dc_rack_slots 主键是 id 不是 slot_id
- 排查交互用 Playwright(channel=chrome) 无头直测线上（/Users/kongyan/node_modules）；容器 DB 可临时建 bcryptjs cost12 账号（测完删）
- 容器内签临时 JWT（JWT_SECRET + jsonwebtoken）即可调 /api/v1/*，users.id 是 TEXT 主键（漏 id → 401）
- 剪贴板（http 内网 IP 非安全上下文）：copy 事件 + clipboardData.setData 主降级 + textarea execCommand 兜底（utils/clipboard.ts）
- 安全现状：凭证 AES-256-GCM（密钥与密文同库=弱点）；serverCommandAgent 可下发任意 shell；servers 存生产高权限凭证。方向：监控走 Zabbix 只读零信任，AI 处置走白名单剧本+受限账号+审批

## 工作流与代码权威源（2026-11-27 用户定调）
- **本地 macOS 是代码唯一权威源，10.0.1.116 只是构建/运行/调试环境。** 用户明确表示 1.116 有可能不可靠，因此任何最终产出必须先在本地落地并验证，再谈推送和部署。
- 顺序：本地改码/验证 → 升版本 + commit + tag（`git status` 干净、tag 指向 HEAD）→ 推 GitHub（commit + tag）→ 从本地 tag 产物 scp/sync 到 1.116（逐文件 + sleep 1 + 双端 MD5，旧 compose 留 `.bak`）→ 服务器按 tag 构建 + `docker compose up -d` + 冒烟/调试。
- 服务器上为调试做的临时改动**不算交付**；若确需改代码，必须回本地重走完整版本流程再部署，不允许服务器反向成为源。
- 汇报必须同时给出：本地版本/tag/commit、GitHub 推送结果、服务器部署版本与验证证据；任一步缺失不得声称发布完成。
- cipipe 运行时数据例外：数据只在服务器卷，本地 `var/snapshot-server.db` 是只读快照，不回推；这与“代码本地优先”不冲突。
- 工作区级文档的 Git 副本：`projects/itops-fork/docs/workspace/`。其中 `MEMORY.md` 是脱敏版；本地 `.workbuddy/memory/MEMORY.md` 保留真实凭据，不进 Git。根目录 `AGENTS.md` 与 `2026-11-27.md` 是指向仓库副本的软链接。
