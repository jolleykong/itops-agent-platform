/**
 * CMDB 前端 UI 原型移植内容（自动生成，勿手改）。
 * 来源：/AI_Project/CMDB前端UI原型.html（2026-11-27）
 * 演示数据，实际数值以对接数据源为准。
 */
export const SCREEN_RESOURCE = `
  <div class="note"><b>大屏 01 · 全局资源态势</b>　面向 CIO 的资源全景与健康度总览。口径：CI 总数含全部纳管配置项；多云=阿里云/华为云/腾讯云，站点含 2 个自建 IDC 与办公室小机房。以下为<b>演示数据</b>，实际数值以对接数据源为准。</div>
  <div class="screen">
    <div class="sc-head">
      <div><h2>全局资源态势驾驶舱</h2><div class="sub">RESOURCE LANDSCAPE · 多云 / 多数据中心 / 办公室机房统一视图</div></div>
      <div class="clock"><b id="clk1">--:--:--</b>2026-11-27　数据延迟 &lt; 5 min</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="k">纳管配置项 CI</div><div class="v">12,847</div><div class="d">↑ 2.4% 较上周</div></div>
      <div class="kpi"><div class="k">云 / 租户</div><div class="v">3 <span class="u">云</span> 7 <span class="u">租户</span></div><div class="d">阿里 / 华为 / 腾讯</div></div>
      <div class="kpi"><div class="k">物理站点</div><div class="v">14</div><div class="d">2 IDC + 12 办公室机房</div></div>
      <div class="kpi"><div class="k">活跃告警</div><div class="v" style="color:var(--amber)">127</div><div class="d bad">高优 9 条待处置</div></div>
      <div class="kpi"><div class="k">服务 SLA 达成</div><div class="v" style="color:var(--green)">99.93%</div><div class="d">近 30 天口径</div></div>
    </div>
    <div class="grid3">
      <div class="panel">
        <h3>多云资源分布 <span class="tag">按 CI 数</span></h3>
        <div class="bar-row"><span class="nm">阿里云</span><div class="track"><div class="fill" style="width:100%;background:var(--amber)"></div></div><span class="val">4,820</span></div>
        <div class="bar-row"><span class="nm">华为云</span><div class="track"><div class="fill" style="width:65%;background:var(--red)"></div></div><span class="val">3,150</span></div>
        <div class="bar-row"><span class="nm">腾讯云</span><div class="track"><div class="fill" style="width:51%;background:var(--blue)"></div></div><span class="val">2,480</span></div>
        <div class="bar-row"><span class="nm">自建 IDC</span><div class="track"><div class="fill" style="width:40%;background:var(--cyan)"></div></div><span class="val">1,920</span></div>
        <div class="bar-row"><span class="nm">办公室机房</span><div class="track"><div class="fill" style="width:10%;background:var(--purple)"></div></div><span class="val">477</span></div>
        <div class="sec-t" style="color:var(--d-sub);font-size:11px;margin-top:18px">主要资源类型</div>
        <div class="legend">
          <span><i style="background:var(--cyan)"></i>微服务 7,821</span>
          <span><i style="background:var(--blue)"></i>虚拟机 2,940</span>
          <span><i style="background:var(--green)"></i>应用 1,120</span>
          <span><i style="background:var(--amber)"></i>物理服务器 386</span>
          <span><i style="background:var(--purple)"></i>数据库 580</span>
        </div>
      </div>
      <div class="panel">
        <h3>资源健康度趋势 <span class="tag">近 7 天</span></h3>
        <svg viewBox="0 0 420 200" width="100%" height="180" role="img" aria-label="资源健康度7天趋势折线图，从98.2%上升至99.4%">
          <line x1="34" y1="160" x2="410" y2="160" stroke="rgba(90,160,235,.3)"/>
          <line x1="34" y1="20" x2="34" y2="160" stroke="rgba(90,160,235,.3)"/>
          <g fill="#7f9dc4" font-size="10"><text x="6" y="164">96%</text><text x="6" y="110">98%</text><text x="6" y="56">100%</text></g>
          <g stroke="rgba(90,160,235,.12)"><line x1="34" y1="108" x2="410" y2="108"/><line x1="34" y1="54" x2="410" y2="54"/></g>
          <polyline points="34,108 96,92 158,120 220,72 282,64 344,78 406,58" fill="none" stroke="#22d3ee" stroke-width="2.5"/>
          <g fill="#22d3ee"><circle cx="34" cy="108" r="3.5"/><circle cx="96" cy="92" r="3.5"/><circle cx="158" cy="120" r="3.5"/><circle cx="220" cy="72" r="3.5"/><circle cx="282" cy="64" r="3.5"/><circle cx="344" cy="78" r="3.5"/><circle cx="406" cy="58" r="3.5"/></g>
          <g fill="#7f9dc4" font-size="10" text-anchor="middle"><text x="34" y="178">11/21</text><text x="96" y="178">11/22</text><text x="158" y="178">11/23</text><text x="220" y="178">11/24</text><text x="282" y="178">11/25</text><text x="344" y="178">11/26</text><text x="406" y="178">11/27</text></g>
        </svg>
        <div class="flow"><span class="node">采集接入</span><span class="arw">→</span><span class="node">身份识别</span><span class="arw">→</span><span class="node">对账治理</span><span class="arw">→</span><span class="node">图谱关联</span></div>
      </div>
      <div class="panel">
        <h3>站点地理分布 <span class="tag">按资源数</span></h3>
        <table class="tbl"><thead><tr><th>站点</th><th>类型</th><th>CI</th><th>健康</th></tr></thead><tbody>
          <tr><td>杭州 · 华东1</td><td>阿里云</td><td>2,100</td><td><span class="pill ok">正常</span></td></tr>
          <tr><td>上海</td><td>腾讯云</td><td>1,480</td><td><span class="pill warn">关注</span></td></tr>
          <tr><td>广州</td><td>华为云</td><td>1,650</td><td><span class="pill ok">正常</span></td></tr>
          <tr><td>北京 IDC-01</td><td>自建</td><td>1,120</td><td><span class="pill ok">正常</span></td></tr>
          <tr><td>深圳 IDC-02</td><td>自建</td><td>800</td><td><span class="pill bad">异常</span></td></tr>
          <tr><td>总部/分支机房</td><td>办公室</td><td>477</td><td><span class="pill ok">正常</span></td></tr>
        </tbody></table>
      </div>
    </div>
    <div class="panel" style="margin-top:14px">
      <h3>实时风险事件 <span class="tag">滚动</span></h3>
      <div class="grid2">
        <div class="scroll-list">
          <div class="ev"><span class="dot" style="background:var(--red)"></span><span class="t">10:07</span><span class="m">MySQL001 活跃连接数超阈值（180/500）</span><span class="r">影响候选 6</span></div>
          <div class="ev"><span class="dot" style="background:var(--amber)"></span><span class="t">10:02</span><span class="m">证书 *.corp.cn 30 天后到期</span><span class="r">运维</span></div>
          <div class="ev"><span class="dot" style="background:var(--amber)"></span><span class="t">09:48</span><span class="m">检测到 IP 冲突 10.10.1.20（跨系统）</span><span class="r">网络</span></div>
        </div>
        <div class="scroll-list">
          <div class="ev"><span class="dot" style="background:var(--blue)"></span><span class="t">09:31</span><span class="m">CHG001 数据库连接参数调整已完成</span><span class="r">变更</span></div>
          <div class="ev"><span class="dot" style="background:var(--purple)"></span><span class="t">09:15</span><span class="m">配置漂移：max_connections 超基线</span><span class="r">合规</span></div>
          <div class="ev"><span class="dot" style="background:var(--green)"></span><span class="t">08:56</span><span class="m">发现任务完成：新增候选 CI 34 项</span><span class="r">发现</span></div>
        </div>
      </div>
    </div>
  </div>
`;
export const SCREEN_COST = `
  <div class="note"><b>大屏 02 · 多云成本与容量治理</b>　面向 CIO 的资源投入与容量水位视图。IP 利用率口径 = 已分配地址 ÷ 可用地址；成本为<b>演示数据</b>，实际按云账单接口对接。</div>
  <div class="screen">
    <div class="sc-head">
      <div><h2>多云成本与容量治理</h2><div class="sub">COST &amp; CAPACITY · 7 租户 · IPAM 地址治理</div></div>
      <div class="clock"><b id="clk2">--:--:--</b>2026-11-27　财务口径：本月累计</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="k">本月云支出（估算）</div><div class="v">286.4<span class="u">万元</span></div><div class="d warn">环比 ↑ 6.2%</div></div>
      <div class="kpi"><div class="k">资源平均利用率</div><div class="v">63.8%</div><div class="d">目标 ≥ 65%</div></div>
      <div class="kpi"><div class="k">IP 地址利用率</div><div class="v">72.4%</div><div class="d warn">2 个网段 &gt; 90%</div></div>
      <div class="kpi"><div class="k">机柜 U 位占用</div><div class="v">78.5%</div><div class="d">IDC-01 余量紧张</div></div>
      <div class="kpi"><div class="k">超授权项</div><div class="v" style="color:var(--red)">3</div><div class="d bad">许可证合规风险</div></div>
    </div>
    <div class="grid3">
      <div class="panel">
        <h3>各云租户资源与支出 <span class="tag">Top 6</span></h3>
        <table class="tbl"><thead><tr><th>云 / 租户</th><th>CI</th><th>支出(万)</th><th>利用率</th></tr></thead><tbody>
          <tr><td>阿里云 · 生产</td><td>2,310</td><td>96.2</td><td><span class="pill ok">71%</span></td></tr>
          <tr><td>华为云 · 核心</td><td>1,880</td><td>78.5</td><td><span class="pill ok">68%</span></td></tr>
          <tr><td>腾讯云 · 订单</td><td>1,520</td><td>64.1</td><td><span class="pill warn">59%</span></td></tr>
          <tr><td>阿里云 · 测试</td><td>1,140</td><td>21.8</td><td><span class="pill warn">42%</span></td></tr>
          <tr><td>腾讯云 · 大数据</td><td>960</td><td>18.4</td><td><span class="pill ok">67%</span></td></tr>
          <tr><td>华为云 · 灾备</td><td>600</td><td>7.4</td><td><span class="pill bad">28%</span></td></tr>
        </tbody></table>
      </div>
      <div class="panel">
        <h3>IP 地址池利用率 <span class="tag">按网段</span></h3>
        <div class="bar-row"><span class="nm">10.10.1.0/24</span><div class="track"><div class="fill" style="width:94%;background:var(--red)"></div></div><span class="val">94%</span></div>
        <div class="bar-row"><span class="nm">10.10.2.0/24</span><div class="track"><div class="fill" style="width:91%;background:var(--amber)"></div></div><span class="val">91%</span></div>
        <div class="bar-row"><span class="nm">10.20.0.0/16</span><div class="track"><div class="fill" style="width:68%;background:var(--cyan)"></div></div><span class="val">68%</span></div>
        <div class="bar-row"><span class="nm">172.16.5.0/24</span><div class="track"><div class="fill" style="width:55%;background:var(--blue)"></div></div><span class="val">55%</span></div>
        <div class="bar-row"><span class="nm">VPC-A</span><div class="track"><div class="fill" style="width:47%;background:var(--purple)"></div></div><span class="val">47%</span></div>
        <div class="bar-row"><span class="nm">VPC-B</span><div class="track"><div class="fill" style="width:33%;background:var(--green)"></div></div><span class="val">33%</span></div>
        <div class="notice" style="color:#fca5a5;background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.3);margin-top:16px">建议：10.10.1.0/24 剩余 15 个地址，需扩容或回收闲置 IP。</div>
      </div>
      <div class="panel">
        <h3>容量水位与趋势</h3>
        <svg viewBox="0 0 400 210" width="100%" height="190" role="img" aria-label="过去6个月资源利用率与支出趋势组合图">
          <line x1="32" y1="168" x2="390" y2="168" stroke="rgba(90,160,235,.3)"/>
          <g fill="#7f9dc4" font-size="10"><text x="4" y="60">100%</text><text x="10" y="116">60%</text><text x="10" y="172">20%</text></g>
          <g fill="rgba(79,140,255,.55)">
            <rect x="48" y="106" width="34" height="62" rx="3"/><rect x="106" y="98" width="34" height="70" rx="3"/>
            <rect x="164" y="92" width="34" height="76" rx="3"/><rect x="222" y="84" width="34" height="84" rx="3"/>
            <rect x="280" y="80" width="34" height="88" rx="3"/><rect x="338" y="72" width="34" height="96" rx="3"/>
          </g>
          <polyline points="65,100 123,94 181,88 239,79 297,74 355,66" fill="none" stroke="#22d3ee" stroke-width="2.5"/>
          <g fill="#22d3ee"><circle cx="65" cy="100" r="3"/><circle cx="123" cy="94" r="3"/><circle cx="181" cy="88" r="3"/><circle cx="239" cy="79" r="3"/><circle cx="297" cy="74" r="3"/><circle cx="355" cy="66" r="3"/></g>
          <g fill="#7f9dc4" font-size="10" text-anchor="middle"><text x="65" y="186">6月</text><text x="123" y="186">7月</text><text x="181" y="186">8月</text><text x="239" y="186">9月</text><text x="297" y="186">10月</text><text x="355" y="186">11月</text></g>
        </svg>
        <div class="legend"><span><i style="background:#4f8cff"></i>支出</span><span><i style="background:#22d3ee"></i>利用率</span></div>
      </div>
    </div>
    <div class="panel" style="margin-top:14px">
      <h3>容量优化建议 <span class="tag">基于 CMDB 关系与运行状态</span></h3>
      <div class="grid2">
        <div class="ev"><span class="dot" style="background:var(--amber)"></span><span class="m">华为云 · 灾备租户利用率仅 28%，建议评估缩容或合并</span><span class="r">预计月省 3.2 万</span></div>
        <div class="ev"><span class="dot" style="background:var(--cyan)"></span><span class="m">测试环境 1,140 CI 可夜间降配，复用统一调度</span><span class="r">预计月省 5.8 万</span></div>
      </div>
    </div>
  </div>
`;
export const SCREEN_SERVICE_RISK = `
  <div class="note"><b>大屏 03 · 业务服务与风险态势</b>　面向 CIO 的业务连续性与风险视图。风险评分 R = Wc·C + Wd·D + Ws·S（业务重要度/依赖强度/异常程度，0~5 分）；SLA 达成率排除计划内维护窗口。<b>演示数据</b>。</div>
  <div class="screen">
    <div class="sc-head">
      <div><h2>业务服务与风险态势</h2><div class="sub">SERVICE &amp; RISK · 业务服务目录 · 故障影响传播</div></div>
      <div class="clock"><b id="clk3">--:--:--</b>2026-11-27　影响分析：候选而非已发生</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="k">业务服务</div><div class="v">48</div><div class="d">4 层服务目录</div></div>
      <div class="kpi"><div class="k">SLA 达成率</div><div class="v" style="color:var(--green)">99.93%</div><div class="d">2 项低于目标</div></div>
      <div class="kpi"><div class="k">高风险服务</div><div class="v" style="color:var(--red)">3</div><div class="d bad">R ≥ 4.0</div></div>
      <div class="kpi"><div class="k">待处置事件</div><div class="v" style="color:var(--amber)">17</div><div class="d">事件→工单→变更</div></div>
      <div class="kpi"><div class="k">影响链路</div><div class="v">6</div><div class="d">当前分析中</div></div>
    </div>
    <div class="grid3">
      <div class="panel">
        <h3>服务健康度矩阵 <span class="tag">业务重要度 × 健康</span></h3>
        <table class="tbl"><thead><tr><th>业务服务</th><th>重要度</th><th>健康</th><th>SLA</th></tr></thead><tbody>
          <tr><td>订单服务</td><td>★★★★★</td><td><span class="pill bad">降级</span></td><td>99.82%</td></tr>
          <tr><td>支付网关</td><td>★★★★★</td><td><span class="pill ok">正常</span></td><td>99.99%</td></tr>
          <tr><td>用户中心</td><td>★★★★</td><td><span class="pill warn">关注</span></td><td>99.91%</td></tr>
          <tr><td>物流调度</td><td>★★★★</td><td><span class="pill ok">正常</span></td><td>99.97%</td></tr>
          <tr><td>数据报表</td><td>★★★</td><td><span class="pill ok">正常</span></td><td>99.88%</td></tr>
          <tr><td>内部 OA</td><td>★★</td><td><span class="pill ok">正常</span></td><td>99.95%</td></tr>
        </tbody></table>
      </div>
      <div class="panel">
        <h3>故障影响传播链 <span class="tag">HOST001</span></h3>
        <svg viewBox="0 0 400 230" width="100%" height="210" role="img" aria-label="故障影响链：物理服务器HOST001到虚拟机VM001到MySQL001到订单服务的传播路径">
          <defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="#22d3ee" stroke-width="1.5"/></marker></defs>
          <rect x="20" y="30" width="150" height="38" rx="7" fill="rgba(248,113,113,.14)" stroke="rgba(248,113,113,.6)" stroke-width="0.8"/>
          <text x="95" y="47" fill="#fca5a5" font-size="12" text-anchor="middle">HOST001 · 物理服务器</text>
          <text x="95" y="61" fill="#7f9dc4" font-size="10" text-anchor="middle">故障源 · 监控中断</text>
          <line x1="170" y1="49" x2="228" y2="49" stroke="#22d3ee" stroke-width="1.5" marker-end="url(#ar)"/>
          <rect x="230" y="30" width="150" height="38" rx="7" fill="rgba(251,191,36,.12)" stroke="rgba(251,191,36,.55)" stroke-width="0.8"/>
          <text x="305" y="47" fill="#fcd34d" font-size="12" text-anchor="middle">VM001 · 虚拟机</text>
          <text x="305" y="61" fill="#7f9dc4" font-size="10" text-anchor="middle">承载 · 异常</text>
          <line x1="305" y1="68" x2="305" y2="108" stroke="#22d3ee" stroke-width="1.5" marker-end="url(#ar)"/>
          <rect x="230" y="110" width="150" height="38" rx="7" fill="rgba(79,140,255,.12)" stroke="rgba(79,140,255,.55)" stroke-width="0.8"/>
          <text x="305" y="127" fill="#93c5fd" font-size="12" text-anchor="middle">MySQL001 · 实例</text>
          <text x="305" y="141" fill="#7f9dc4" font-size="10" text-anchor="middle">运行于 · 连接数升高</text>
          <line x1="230" y1="129" x2="172" y2="129" stroke="#22d3ee" stroke-width="1.5" marker-end="url(#ar)"/>
          <rect x="20" y="110" width="150" height="38" rx="7" fill="rgba(167,139,250,.12)" stroke="rgba(167,139,250,.55)" stroke-width="0.8"/>
          <text x="95" y="127" fill="#c4b5fd" font-size="12" text-anchor="middle">订单服务 · 应用</text>
          <text x="95" y="141" fill="#7f9dc4" font-size="10" text-anchor="middle">依赖 · P95 升高</text>
          <text x="200" y="182" fill="#7f9dc4" font-size="10" text-anchor="middle">候选影响范围，须结合冗余/主备/健康状态验证</text>
          <rect x="118" y="196" width="164" height="24" rx="6" fill="rgba(34,211,238,.1)" stroke="rgba(34,211,238,.4)" stroke-width="0.6"/>
          <text x="200" y="212" fill="#22d3ee" font-size="11" text-anchor="middle">风险评分 R = 4.7 · 高</text>
        </svg>
      </div>
      <div class="panel">
        <h3>风险评分 TOP <span class="tag">R = Wc·C+Wd·D+Ws·S</span></h3>
        <table class="tbl"><thead><tr><th>对象</th><th>C/D/S</th><th>R</th><th>等级</th></tr></thead><tbody>
          <tr><td>订单服务</td><td>5/4/3</td><td>4.7</td><td><span class="pill bad">高</span></td></tr>
          <tr><td>支付网关</td><td>5/3/2</td><td>4.1</td><td><span class="pill bad">高</span></td></tr>
          <tr><td>用户中心</td><td>4/4/2</td><td>3.8</td><td><span class="pill warn">中</span></td></tr>
          <tr><td>物流调度</td><td>4/3/1</td><td>3.1</td><td><span class="pill warn">中</span></td></tr>
          <tr><td>数据报表</td><td>3/2/1</td><td>2.3</td><td><span class="pill ok">低</span></td></tr>
        </tbody></table>
        <div class="legend"><span>权重 Wc=0.5 · Wd=0.3 · Ws=0.2</span></div>
      </div>
    </div>
    <div class="panel" style="margin-top:14px">
      <h3>变更与事件关联链 <span class="tag">完整事件链</span></h3>
      <div class="flow" style="font-size:12px">
        <span class="node">10:00 CHG001 参数变更</span><span class="arw">→</span>
        <span class="node">10:05 告警 EVT001</span><span class="arw">→</span>
        <span class="node">10:06 事件单</span><span class="arw">→</span>
        <span class="node">10:08 故障工单</span><span class="arw">→</span>
        <span class="node">候选根因 MEDIUM</span><span class="arw">→</span>
        <span class="node">人工确认/回退审批</span>
      </div>
    </div>
  </div>
`;
export const SCREEN_COMPLIANCE = `
  <div class="note"><b>大屏 04 · 资产合规与生命周期治理</b>　面向 CIO 的资产全生命周期与合规视图。覆盖证书/维保/许可证/配置基线/软删除回收站。凭据仅存密码库引用 ID，不存口令。<b>演示数据</b>。</div>
  <div class="screen">
    <div class="sc-head">
      <div><h2>资产合规与生命周期治理</h2><div class="sub">COMPLIANCE &amp; LIFECYCLE · 证书 / 维保 / 许可证 / 基线</div></div>
      <div class="clock"><b id="clk4">--:--:--</b>2026-11-27　审计日志留存 ≥180 天</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="k">30 天内到期证书</div><div class="v" style="color:var(--amber)">23</div><div class="d bad">7 天内 5 张</div></div>
      <div class="kpi"><div class="k">维保到期设备</div><div class="v">14</div><div class="d">90 天内</div></div>
      <div class="kpi"><div class="k">许可证合规率</div><div class="v" style="color:var(--green)">96.7%</div><div class="d warn">3 项超授权</div></div>
      <div class="kpi"><div class="k">配置漂移项</div><div class="v" style="color:var(--amber)">38</div><div class="d">基线核查</div></div>
      <div class="kpi"><div class="k">回收站待处理</div><div class="v">26</div><div class="d">软删除 CI</div></div>
    </div>
    <div class="grid3">
      <div class="panel">
        <h3>证书到期倒计时 <span class="tag">Top 6</span></h3>
        <table class="tbl"><thead><tr><th>域名</th><th>到期日</th><th>剩余</th></tr></thead><tbody>
          <tr><td>pay.corp.cn</td><td>11-29</td><td><span class="pill bad">2 天</span></td></tr>
          <tr><td>api-gw.corp.cn</td><td>12-01</td><td><span class="pill bad">4 天</span></td></tr>
          <tr><td>order.corp.cn</td><td>12-03</td><td><span class="pill warn">6 天</span></td></tr>
          <tr><td>*.yun.corp.cn</td><td>12-08</td><td><span class="pill warn">11 天</span></td></tr>
          <tr><td>oa.corp.cn</td><td>12-15</td><td><span class="pill ok">18 天</span></td></tr>
          <tr><td>mail.corp.cn</td><td>12-20</td><td><span class="pill ok">23 天</span></td></tr>
        </tbody></table>
      </div>
      <div class="panel">
        <h3>生命周期分布 <span class="tag">CI 状态</span></h3>
        <svg viewBox="0 0 220 200" width="100%" height="190" role="img" aria-label="CI生命周期状态环形图，在用占82%">
          <g fill="none" stroke-width="22">
            <circle cx="110" cy="100" r="66" stroke="#34d399" stroke-dasharray="340 415" transform="rotate(-90 110 100)"/>
            <circle cx="110" cy="100" r="66" stroke="#fbbf24" stroke-dasharray="42 415" stroke-dashoffset="-340" transform="rotate(-90 110 100)"/>
            <circle cx="110" cy="100" r="66" stroke="#4f8cff" stroke-dasharray="25 415" stroke-dashoffset="-382" transform="rotate(-90 110 100)"/>
            <circle cx="110" cy="100" r="66" stroke="#a78bfa" stroke-dasharray="8 415" stroke-dashoffset="-407" transform="rotate(-90 110 100)"/>
          </g>
          <text x="110" y="96" fill="#eaf3ff" font-size="24" text-anchor="middle">12,847</text>
          <text x="110" y="116" fill="#7f9dc4" font-size="11" text-anchor="middle">纳管 CI 总数</text>
        </svg>
        <div class="legend" style="justify-content:center">
          <span><i style="background:#34d399"></i>在用 82%</span><span><i style="background:#fbbf24"></i>维护/异常 10%</span>
          <span><i style="background:#4f8cff"></i>待确认 6%</span><span><i style="background:#a78bfa"></i>下线/归档 2%</span>
        </div>
      </div>
      <div class="panel">
        <h3>合规检查项 <span class="tag">基线 + 许可证</span></h3>
        <div class="bar-row"><span class="nm">配置基线</span><div class="track"><div class="fill" style="width:88%;background:var(--green)"></div></div><span class="val">88%</span></div>
        <div class="bar-row"><span class="nm">证书有效</span><div class="track"><div class="fill" style="width:94%;background:var(--cyan)"></div></div><span class="val">94%</span></div>
        <div class="bar-row"><span class="nm">维保在保</span><div class="track"><div class="fill" style="width:91%;background:var(--blue)"></div></div><span class="val">91%</span></div>
        <div class="bar-row"><span class="nm">许可证</span><div class="track"><div class="fill" style="width:97%;background:var(--purple)"></div></div><span class="val">97%</span></div>
        <div class="bar-row"><span class="nm">凭据引用</span><div class="track"><div class="fill" style="width:100%;background:var(--green)"></div></div><span class="val">100%</span></div>
        <div class="sec-t" style="color:var(--d-sub);font-size:11px;margin-top:18px">近期审计动作</div>
        <div class="ev"><span class="dot" style="background:var(--blue)"></span><span class="m" style="font-size:11px">权威规则变更 2 次（已审批）</span></div>
        <div class="ev"><span class="dot" style="background:var(--green)"></span><span class="m" style="font-size:11px">对账自动裁决 148 项</span></div>
      </div>
    </div>
    <div class="panel" style="margin-top:14px">
      <h3>合规风险提示 <span class="tag">需关注</span></h3>
      <div class="grid2">
        <div class="ev"><span class="dot" style="background:var(--red)"></span><span class="m">MySQL 许可证授权 16 核 / 已用 20 核 — 超授权 4 核</span><span class="r">法务/采购</span></div>
        <div class="ev"><span class="dot" style="background:var(--amber)"></span><span class="m">38 项配置漂移未闭环，其中高危 6 项</span><span class="r">SRE</span></div>
      </div>
    </div>
  </div>
`;
export const PAGE_WORKBENCH = `
  <div class="note"><b>功能页 05 · 资源工作台</b>　日常查询与维护入口。列表受作用域权限过滤（云/租户/站点），支持组合筛选、批量导入导出与保存视图。<b>演示数据</b>。</div>
  <div class="workspace">
    <div class="ws-head">
      <div><h2>资源工作台</h2><p>统一资源配置管理 · 12,847 项 CI · 权限过滤后可见 8,412 项</p></div>
      <div><input class="search" placeholder="搜索主机名 / IP / CI编码 / 资产编号"><button class="btn primary">查询</button> <button class="btn">批量导入</button> <button class="btn">导出</button></div>
    </div>
    <div class="ws-body">
      <aside class="sidebar">
        <div class="grp-t">工作台</div>
        <a class="on" href="#">资源总览</a><a href="#">我的待办 (12)</a><a href="#">最近访问</a>
        <div class="grp-t">资源管理</div>
        <a href="#">CI 模型管理</a><a href="#">CI 实例</a><a href="#">关系管理</a><a href="#">作用域管理</a>
        <div class="grp-t">治理</div>
        <a href="#">发现任务</a><a href="#">对账中心</a><a href="#">IPAM 管理</a><a href="#">回收站</a>
        <div class="grp-t">分析</div>
        <a href="#">拓扑画布</a><a href="#">影响分析</a><a href="#">根因分析</a>
      </aside>
      <div class="content">
        <div class="mcards">
          <div class="mcard"><div class="l">可见 CI</div><div class="n">8,412</div><div class="s">授权作用域内</div></div>
          <div class="mcard"><div class="l">今日新增</div><div class="n">34</div><div class="s">发现任务入库</div></div>
          <div class="mcard"><div class="l">待确认候选</div><div class="n">18</div><div class="s">暂存区待处理</div></div>
          <div class="mcard"><div class="l">异常资源</div><div class="n" style="color:#b91c1c">9</div><div class="s">运行状态异常</div></div>
        </div>
        <div class="sec-t">资源列表</div>
        <div style="font-size:12px;color:var(--l-sub);margin-bottom:10px">筛选：环境=生产　云厂商=全部　作用域=我可见　生命周期=在用</div>
        <table class="ltbl"><thead><tr><th>CI 编码</th><th>名称</th><th>类型</th><th>云/租户</th><th>站点</th><th>环境</th><th>生命周期</th><th>运行状态</th><th>责任人</th></tr></thead><tbody>
          <tr><td>RSC-PS-001</td><td>db-host-01</td><td>物理服务器</td><td>自建 IDC</td><td>北京 IDC-01</td><td><span class="badge b">生产</span></td><td>在用</td><td><span class="badge g">正常</span></td><td>张工</td></tr>
          <tr><td>RSC-VM-021</td><td>order-app-01</td><td>虚拟机</td><td>阿里云/生产</td><td>华东1 杭州</td><td><span class="badge b">生产</span></td><td>在用</td><td><span class="badge g">正常</span></td><td>李工</td></tr>
          <tr><td>RSC-MYSQL-001</td><td>order-mysql-01</td><td>MySQL 实例</td><td>阿里云/生产</td><td>华东1 杭州</td><td><span class="badge b">生产</span></td><td>在用</td><td><span class="badge r">异常</span></td><td>DBA 组</td></tr>
          <tr><td>RSC-REDIS-014</td><td>cart-redis-01</td><td>Redis 实例</td><td>腾讯云/订单</td><td>上海</td><td><span class="badge b">生产</span></td><td>维护中</td><td><span class="badge g">正常</span></td><td>王工</td></tr>
          <tr><td>RSC-SVC-118</td><td>order-service</td><td>微服务</td><td>华为云/核心</td><td>广州</td><td><span class="badge b">生产</span></td><td>在用</td><td><span class="badge o">关注</span></td><td>陈工</td></tr>
          <tr><td>RSC-PS-088</td><td>branch-sw-03</td><td>网络设备</td><td>自建</td><td>总部 MDF</td><td><span class="badge">办公</span></td><td>待确认</td><td><span class="badge g">正常</span></td><td>行政 IT</td></tr>
        </tbody></table>
        <div style="font-size:12px;color:var(--l-sub);margin-top:12px">每页 20 条 · 共 8,412 条　[上一页] 1 2 3 … 421 [下一页]</div>
      </div>
    </div>
  </div>
`;
export const PAGE_TOPO_CANVAS = `
  <div class="note"><b>功能页 06 · 资源拓扑画布</b>　静态拓扑（CMDB 配置）+ 动态拓扑（Trace/网络观测）+ 历史拓扑（时间轴回溯）。无权限节点折叠为「受限节点」，不展开详情。</div>
  <div class="workspace">
    <div class="ws-head">
      <div><h2>拓扑画布</h2><p>根节点：HOST001 · 方向 DOWNSTREAM · 深度 5 · 节点 24 / 边 31</p></div>
      <div><select class="search" style="min-width:130px"><option>静态+动态</option><option>仅静态</option><option>仅动态</option></select> <button class="btn">时间回溯</button> <button class="btn">导出</button></div>
    </div>
    <div class="ws-body">
      <aside class="sidebar">
        <div class="grp-t">关系类型</div>
        <a class="on" href="#">HOSTS 承载</a><a class="on" href="#">RUNS_ON 运行</a><a class="on" href="#">DEPENDS_ON 依赖</a>
        <a href="#">CONNECTS_TO 连接</a><a href="#">MEMBER_OF 集群</a><a href="#">BELONGS_TO 归属</a>
        <div class="grp-t">动态边</div>
        <a href="#">OBSERVED_CALL 调用</a><a href="#">NETWORK_CONNECTION</a>
        <div class="grp-t">布局</div>
        <a href="#">力导向</a><a href="#">层次</a><a href="#">环形</a>
      </aside>
      <div class="content">
        <div class="split">
          <div>
            <div class="topo-wrap">
              <svg viewBox="0 0 760 500" width="100%" height="100%" role="img" aria-label="资源拓扑图，展示物理服务器承载虚拟机，虚拟机运行数据库，应用依赖数据库的关系链">
                <defs><marker id="ta" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="#94a3b8" stroke-width="1.2"/></marker></defs>
                <g stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ta)" fill="none">
                  <line x1="380" y1="95" x2="230" y2="180"/><line x1="380" y1="95" x2="530" y2="180"/>
                  <line x1="230" y1="212" x2="150" y2="300"/><line x1="530" y1="212" x2="610" y2="300"/>
                  <line x1="150" y1="332" x2="300" y2="410"/><line x1="610" y1="332" x2="470" y2="410"/>
                </g>
                <g font-size="11" text-anchor="middle">
                  <rect x="290" y="52" width="180" height="44" rx="9" fill="#fee2e2" stroke="#f87171"/><text x="380" y="71" fill="#991b1b">HOST001</text><text x="380" y="86" fill="#b91c1c" font-size="10">物理服务器·异常</text>
                  <rect x="140" y="180" width="180" height="44" rx="9" fill="#fef3c7" stroke="#fbbf24"/><text x="230" y="199" fill="#92400e">VM001</text><text x="230" y="214" fill="#b45309" font-size="10">虚拟机</text>
                  <rect x="440" y="180" width="180" height="44" rx="9" fill="#dbeafe" stroke="#60a5fa"/><text x="530" y="199" fill="#1e40af">VM002</text><text x="530" y="214" fill="#1d4ed8" font-size="10">虚拟机</text>
                  <rect x="60" y="300" width="180" height="44" rx="9" fill="#e0e7ff" stroke="#818cf8"/><text x="150" y="319" fill="#3730a3">MySQL001</text><text x="150" y="334" fill="#4338ca" font-size="10">实例·连接数高</text>
                  <rect x="520" y="300" width="180" height="44" rx="9" fill="#f3e8ff" stroke="#c084fc"/><text x="610" y="319" fill="#6b21a8">Redis001</text><text x="610" y="334" fill="#7e22ce" font-size="10">实例</text>
                  <rect x="210" y="408" width="180" height="44" rx="9" fill="#d1fae5" stroke="#34d399"/><text x="300" y="427" fill="#065f46">订单服务</text><text x="300" y="442" fill="#047857" font-size="10">应用·P95 升高</text>
                  <rect x="380" y="408" width="180" height="44" rx="9" fill="#e2e8f0" stroke="#94a3b8" stroke-dasharray="4 3"/><text x="470" y="435" fill="#64748b" font-size="10">受限节点 ×3</text>
                </g>
              </svg>
            </div>
            <div class="timeline">历史拓扑：<input type="range" min="0" max="7" value="7"> <b id="tl">当前</b>　拖动回到故障时间点，查看当时的关系快照</div>
          </div>
          <div>
            <div class="mini-card"><h4>节点详情 · HOST001</h4>
              <div class="kv"><span class="k">CI 编码</span><span class="v">RSC-PS-001</span></div>
              <div class="kv"><span class="k">类型</span><span class="v">物理服务器</span></div>
              <div class="kv"><span class="k">作用域</span><span class="v">北京 IDC-01 / RACK03</span></div>
              <div class="kv"><span class="k">生命周期</span><span class="v">在用</span></div>
              <div class="kv"><span class="k">运行状态</span><span class="v"><span class="badge r">异常</span></span></div>
            </div>
            <div class="mini-card"><h4>关系边</h4>
              <div class="kv"><span class="k">HOSTS → VM001</span><span class="v">ACTIVE</span></div>
              <div class="kv"><span class="k">来源</span><span class="v">虚拟化平台</span></div>
              <div class="kv"><span class="k">置信度</span><span class="v">0.95</span></div>
              <div class="kv"><span class="k">生效</span><span class="v">11-01 至今</span></div>
            </div>
            <div class="mini-card"><h4>动态观测</h4>
              <div class="kv"><span class="k">OBSERVED_CALL</span><span class="v">12 条</span></div>
              <div class="kv"><span class="k">最近观测</span><span class="v">2 分钟前</span></div>
              <div class="kv"><span class="k">冲突关系</span><span class="v">1 条待确认</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
`;
export const PAGE_IPAM = `
  <div class="note"><b>功能页 07 · IP 地址管理（IPAM）</b>　网段/地址池管理、分配回收、冲突检测、利用率统计。IP 状态机 FREE→RESERVED→ALLOCATED→IN_USE→RELEASED→FREE；已绑定在用 CI 的 IP 禁止直接回收。</div>
  <div class="workspace">
    <div class="ws-head">
      <div><h2>IPAM 管理台</h2><p>作用域：阿里云 / 生产租户 · 网段 24 个 · 地址 86,432 个 · 利用率 72.4%</p></div>
      <div><button class="btn primary">申请 IP</button> <button class="btn">新建网段</button> <button class="btn">IP 扫描</button> <button class="btn">冲突检测</button></div>
    </div>
    <div class="ws-body">
      <aside class="sidebar">
        <div class="grp-t">网段树</div>
        <a class="on" href="#">10.10.0.0/16　父网段</a>
        <a href="#">　└ 10.10.1.0/24　94%</a>
        <a href="#">　└ 10.10.2.0/24　91%</a>
        <a href="#">　└ 10.10.3.0/24　68%</a>
        <div class="grp-t">其他作用域</div>
        <a href="#">10.20.0.0/16　VPC-A</a>
        <a href="#">172.16.5.0/24　IDC-01</a>
        <a href="#">192.168.1.0/24　总部 MDF</a>
        <div class="grp-t">治理</div>
        <a href="#">冲突记录 (3)</a><a href="#">扫描任务</a><a href="#">分配审批</a>
      </aside>
      <div class="content">
        <div class="mcards">
          <div class="mcard"><div class="l">总地址</div><div class="n">254</div><div class="s">10.10.1.0/24</div></div>
          <div class="mcard"><div class="l">已分配</div><div class="n">239</div><div class="s">ALLOCATED/IN_USE</div></div>
          <div class="mcard"><div class="l">剩余可用</div><div class="n" style="color:#b45309">15</div><div class="s">建议扩容</div></div>
          <div class="mcard"><div class="l">冲突</div><div class="n" style="color:#b91c1c">1</div><div class="s">待人工裁决</div></div>
        </div>
        <div class="sec-t">地址列表 · 10.10.1.0/24</div>
        <table class="ltbl"><thead><tr><th>IP 地址</th><th>状态</th><th>绑定 CI</th><th>MAC</th><th>用途</th><th>DHCP 保留</th><th>操作</th></tr></thead><tbody>
          <tr><td>10.10.1.1</td><td><span class="badge o">网关</span></td><td>—</td><td>—</td><td>网关</td><td>—</td><td>—</td></tr>
          <tr><td>10.10.1.20</td><td><span class="badge r">冲突</span></td><td>order-app-01</td><td>00:11:22:3A</td><td>应用节点</td><td>是</td><td><button class="btn">裁决</button></td></tr>
          <tr><td>10.10.1.50</td><td><span class="badge g">IN_USE</span></td><td>order-mysql-01</td><td>00:11:22:4B</td><td>数据库私网</td><td>是</td><td><button class="btn">解绑后回收</button></td></tr>
          <tr><td>10.10.1.51</td><td><span class="badge b">ALLOCATED</span></td><td>cart-redis-01</td><td>00:11:22:4C</td><td>缓存节点</td><td>否</td><td><button class="btn">回收</button></td></tr>
          <tr><td>10.10.1.88</td><td><span class="badge">VIP</span></td><td>3 节点（is_vip）</td><td>—</td><td>数据库入口</td><td>—</td><td>一对多不判冲突</td></tr>
          <tr><td>10.10.1.240</td><td><span class="badge g">FREE</span></td><td>—</td><td>—</td><td>—</td><td>—</td><td><button class="btn primary">分配</button></td></tr>
        </tbody></table>
        <div class="notice">冲突说明：不同租户的相同内网 IP 不算冲突（作用域隔离）；10.10.1.20 为同租户内两来源不一致，需人工裁决后写入权威来源。</div>
      </div>
    </div>
  </div>
`;
export const PAGE_IMPACT = `
  <div class="note"><b>功能页 08 · 故障影响分析</b>　从故障源沿关系遍历，输出候选影响范围 + 风险评分 + 证据。结果标注「候选而非已发生」，须结合冗余/主备/集群切换与运行状态验证。</div>
  <div class="workspace">
    <div class="ws-head">
      <div><h2>故障影响分析</h2><p>分析 ID：IMP-20261120-001 · 故障源 HOST001 · 时间点 2026-11-20 10:05</p></div>
      <div><button class="btn">重新分析</button> <button class="btn primary">导出报告</button></div>
    </div>
    <div class="ws-body">
      <aside class="sidebar">
        <div class="grp-t">分析视图</div>
        <a class="on" href="#">影响分析报告</a><a href="#">根因候选</a><a href="#">历史事件链</a>
        <div class="grp-t">故障源</div>
        <a href="#">HOST001 · 物理服务器</a><a href="#">MySQL001 · 实例</a><a href="#">最近分析 (8)</a>
        <div class="grp-t">评分权重</div>
        <a href="#">Wc 业务重要度 0.5</a><a href="#">Wd 依赖强度 0.3</a><a href="#">Ws 异常程度 0.2</a>
      </aside>
      <div class="content">
        <div class="mcards">
          <div class="mcard"><div class="l">候选影响对象</div><div class="n">12</div><div class="s">过滤失效关系后</div></div>
          <div class="mcard"><div class="l">最高风险评分</div><div class="n" style="color:#b91c1c">4.7</div><div class="s">订单服务</div></div>
          <div class="mcard"><div class="l">受影响业务服务</div><div class="n">3</div><div class="s">订单/支付/用户中心</div></div>
          <div class="mcard"><div class="l">待验证项</div><div class="n" style="color:#b45309">5</div><div class="s">冗余/主备待确认</div></div>
        </div>
        <div class="notice">⚠ 以下为候选影响范围，非已发生故障。拓扑传播仅提供候选，实际影响须结合冗余关系、主备切换、多实例负载均衡与容灾降级判断。</div>
        <div class="sec-t">候选影响链路（按风险评分排序）</div>
        <table class="ltbl"><thead><tr><th>链路</th><th>C</th><th>D</th><th>S</th><th>R 评分</th><th>冗余/主备</th><th>验证状态</th></tr></thead><tbody>
          <tr><td>HOST001 → VM001 → MySQL001 → 订单服务</td><td>5</td><td>4</td><td>3</td><td><b style="color:#b91c1c">4.7</b></td><td>同宿主机有冗余实例</td><td><span class="badge o">待验证</span></td></tr>
          <tr><td>HOST001 → VM002 → Redis001 → 支付网关</td><td>5</td><td>3</td><td>2</td><td><b style="color:#b45309">4.1</b></td><td>Redis 主从已切换</td><td><span class="badge o">待验证</span></td></tr>
          <tr><td>HOST001 → VM001 → MySQL001 → 用户中心</td><td>4</td><td>4</td><td>2</td><td><b>3.8</b></td><td>无同构冗余</td><td><span class="badge r">优先核查</span></td></tr>
          <tr><td>HOST001 → VM002 → 数据报表</td><td>3</td><td>2</td><td>1</td><td><b>2.3</b></td><td>批处理可延迟</td><td><span class="badge g">低优先</span></td></tr>
        </tbody></table>
        <div class="sec-t">根因候选（AI 辅助 · 需人工确认）</div>
        <div class="mini-card">
          <div class="kv"><span class="k">候选原因</span><span class="v">数据库连接参数调整可能导致连接行为变化</span></div>
          <div class="kv"><span class="k">关联变更</span><span class="v">CHG001（10:00）</span></div>
          <div class="kv"><span class="k">置信度</span><span class="v"><span class="badge o">MEDIUM</span></span></div>
          <div class="kv"><span class="k">证据 1</span><span class="v">变更时间早于异常（10:05）</span></div>
          <div class="kv"><span class="k">证据 2</span><span class="v">连接数持续增长 180/500</span></div>
          <div class="kv"><span class="k">证据 3</span><span class="v">订单服务 P95 同步升高</span></div>
          <div class="kv"><span class="k">verificationRequired</span><span class="v"><span class="badge r">true</span></span></div>
        </div>
        <div class="notice">回退变更须经权限校验与变更审批；诊断 Agent 无执行权限，仅提供建议。</div>
      </div>
    </div>
  </div>
`;
export const PAGE_CI_DETAIL = `
  <div class="note"><b>功能页 09 · CI 详情（作用域视角）</b>　展示多云多租户作用域路径、双状态（生命周期/运行状态）、属性与关系、关联事件。作用域权限不达标时关联 CI 折叠为受限节点。</div>
  <div class="workspace">
    <div class="ws-head">
      <div><h2>CI 详情 · order-mysql-01</h2><p>RSC-MYSQL-001 · MySQL 实例 · 版本 V7</p></div>
      <div><button class="btn">编辑</button> <button class="btn">建关系</button> <button class="btn">查看历史</button> <button class="btn">下线申请</button></div>
    </div>
    <div class="ws-body">
      <aside class="sidebar">
        <div class="grp-t">详情导航</div>
        <a class="on" href="#">概览</a><a href="#">属性</a><a href="#">关系 (12)</a><a href="#">关联事件</a>
        <a href="#">历史版本</a><a href="#">审计日志</a>
        <div class="grp-t">同作用域资源</div>
        <a href="#">阿里云 / 生产</a><a href="#">华东1 杭州</a><a href="#">同集群节点 (3)</a>
      </aside>
      <div class="content">
        <div class="crumb">作用域路径：<b>阿里云</b> › <b>租户：生产账号</b> › <b>华东1（杭州）</b> › 可用区 H › <b>VPC-A</b> › 实例</div>
        <div class="split">
          <div>
            <div class="mini-card"><h4>基本信息 + 双状态</h4>
              <div class="kv"><span class="k">CI 编码</span><span class="v">RSC-MYSQL-001</span></div>
              <div class="kv"><span class="k">实例 UUID</span><span class="v">MYSQL001</span></div>
              <div class="kv"><span class="k">连接入口</span><span class="v">10.10.1.88:3306（VIP）</span></div>
              <div class="kv"><span class="k">实际节点</span><span class="v">10.10.1.50 / .51 / .52</span></div>
              <div class="kv"><span class="k">版本</span><span class="v">8.0.36</span></div>
              <div class="kv"><span class="k">生命周期状态</span><span class="v"><span class="badge g">在用</span></span></div>
              <div class="kv"><span class="k">运行状态</span><span class="v"><span class="badge r">异常</span></span></div>
              <div class="kv"><span class="k">权威来源</span><span class="v">数据库采集器</span></div>
              <div class="kv"><span class="k">责任人</span><span class="v">DBA 组</span></div>
            </div>
            <div class="sec-t">关系（按类型分组）</div>
            <table class="ltbl"><thead><tr><th>关系类型</th><th>方向</th><th>目标 CI</th><th>状态</th><th>生效区间</th></tr></thead><tbody>
              <tr><td>RUNS_ON</td><td>→</td><td>VM001</td><td><span class="badge g">ACTIVE</span></td><td>11-01 至今</td></tr>
              <tr><td>MEMBER_OF</td><td>→</td><td>MYSQL-CLUSTER-01</td><td><span class="badge g">ACTIVE</span></td><td>09-15 至今</td></tr>
              <tr><td>DEPENDS_ON（来自）</td><td>←</td><td>订单服务</td><td><span class="badge g">ACTIVE</span></td><td>10-20 至今</td></tr>
              <tr><td>DEPENDS_ON（来自）</td><td>←</td><td>用户中心</td><td><span class="badge g">ACTIVE</span></td><td>10-22 至今</td></tr>
              <tr><td>CONNECTS_TO</td><td>→</td><td>受限节点 ×2</td><td><span class="badge">权限过滤</span></td><td>—</td></tr>
            </tbody></table>
          </div>
          <div>
            <div class="mini-card"><h4>运行状态指标</h4>
              <div class="kv"><span class="k">活跃连接数</span><span class="v" style="color:#b91c1c">180</span></div>
              <div class="kv"><span class="k">最大连接数</span><span class="v">500</span></div>
              <div class="kv"><span class="k">等待连接</span><span class="v">24</span></div>
              <div class="kv"><span class="k">主从角色</span><span class="v">PRIMARY</span></div>
            </div>
            <div class="mini-card"><h4>关联事件链</h4>
              <div class="kv"><span class="k">告警</span><span class="v">EVT001 连接数高</span></div>
              <div class="kv"><span class="k">变更</span><span class="v">CHG001 参数调整</span></div>
              <div class="kv"><span class="k">工单</span><span class="v">INC001 处理中</span></div>
              <div class="kv"><span class="k">案例</span><span class="v">SIMILAR_TO 历史 2 例</span></div>
            </div>
            <div class="mini-card"><h4>凭据关联（仅引用）</h4>
              <div class="kv"><span class="k">账号</span><span class="v">cmdb_ro</span></div>
              <div class="kv"><span class="k">类型</span><span class="v">PASSWORD</span></div>
              <div class="kv"><span class="k">密码库引用</span><span class="v">vault://db/mysql001</span></div>
              <div class="kv"><span class="k">轮换周期</span><span class="v">90 天</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
`;
export const PAGE_OPS_OBJECTS = `
  <div class="note"><b>功能页 10 · 运维对象管理</b>　证书 / 维保合同 / 软件许可证 / 巡检 / 配置基线的统一管理，到期预警与合规核查。凭据仅在密码库存引用 ID。</div>
  <div class="workspace">
    <div class="ws-head">
      <div><h2>运维对象管理</h2><p>证书 186 张 · 维保合同 92 份 · 许可证 45 项 · 巡检模板 18 套 · 基线 12 套</p></div>
      <div><button class="btn primary">新增对象</button> <button class="btn">到期预警配置</button> <button class="btn">合规核查</button></div>
    </div>
    <div class="ws-body">
      <aside class="sidebar">
        <div class="grp-t">对象类型</div>
        <a class="on" href="#">证书管理 (186)</a><a href="#">维保合同 (92)</a><a href="#">软件许可证 (45)</a>
        <a href="#">凭据引用 (128)</a>
        <div class="grp-t">运维任务</div>
        <a href="#">备份策略</a><a href="#">巡检记录</a><a href="#">配置基线</a>
        <div class="grp-t">预警</div>
        <a href="#">即将到期 (23)</a><a href="#">超授权 (3)</a><a href="#">漂移项 (38)</a>
      </aside>
      <div class="content">
        <div class="tabs"><span class="on">证书</span><span>维保合同</span><span>许可证</span><span>凭据引用</span><span>巡检</span><span>配置基线</span></div>
        <div class="mcards">
          <div class="mcard"><div class="l">证书总数</div><div class="n">186</div><div class="s">有效 163 / 到期 23</div></div>
          <div class="mcard"><div class="l">7 天内到期</div><div class="n" style="color:#b91c1c">5</div><div class="s">需立即处理</div></div>
          <div class="mcard"><div class="l">维保在保率</div><div class="n">91%</div><div class="s">14 项 90 天内到期</div></div>
          <div class="mcard"><div class="l">许可证合规</div><div class="n" style="color:#b45309">96.7%</div><div class="s">3 项超授权</div></div>
        </div>
        <div class="sec-t">证书到期预警</div>
        <table class="ltbl"><thead><tr><th>证书名称</th><th>域名</th><th>签发机构</th><th>到期日</th><th>剩余</th><th>绑定 CI</th><th>订阅通知</th></tr></thead><tbody>
          <tr><td>pay-tls-2025</td><td>pay.corp.cn</td><td>DigiCert</td><td>2026-11-29</td><td><span class="badge r">2 天</span></td><td>pay-gateway-01</td><td>邮件+IM</td></tr>
          <tr><td>apigw-tls</td><td>api-gw.corp.cn</td><td>GlobalSign</td><td>2026-12-01</td><td><span class="badge r">4 天</span></td><td>apigw-prod-02</td><td>邮件+IM</td></tr>
          <tr><td>order-tls</td><td>order.corp.cn</td><td>DigiCert</td><td>2026-12-03</td><td><span class="badge o">6 天</span></td><td>order-service</td><td>邮件</td></tr>
          <tr><td>wildcard-yun</td><td>*.yun.corp.cn</td><td>腾讯云</td><td>2026-12-08</td><td><span class="badge o">11 天</span></td><td>多个</td><td>IM</td></tr>
          <tr><td>oa-tls</td><td>oa.corp.cn</td><td>内部 CA</td><td>2026-12-15</td><td><span class="badge b">18 天</span></td><td>oa-app-01</td><td>邮件</td></tr>
        </tbody></table>
        <div class="sec-t">软件许可证合规</div>
        <table class="ltbl"><thead><tr><th>产品</th><th>授权数量</th><th>已用数量</th><th>合规状态</th><th>到期日</th><th>操作</th></tr></thead><tbody>
          <tr><td>MySQL Enterprise</td><td>16 核</td><td>20 核</td><td><span class="badge r">超授权</span></td><td>2027-03-31</td><td><button class="btn">发起采购</button></td></tr>
          <tr><td>Redis 企业版</td><td>32 实例</td><td>28 实例</td><td><span class="badge g">合规</span></td><td>2027-01-15</td><td>—</td></tr>
          <tr><td>某监控平台 License</td><td>500 节点</td><td>512 节点</td><td><span class="badge r">超授权</span></td><td>2026-12-31</td><td><button class="btn">发起采购</button></td></tr>
        </tbody></table>
      </div>
    </div>
  </div>
`;
