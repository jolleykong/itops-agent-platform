/**
 * CMDB 拓扑结构（占位页，2026-11-24）
 *
 * 规划目标：层级化展示 CI 关系（机房 → 机柜 → 硬件 → OS/VM → 应用 等
 * 或按 iTop 关系图组织）。具体展示方式待规划，当前为占位视图。
 */
export default function CmdbTopology() {
  const items = [
    { title: '层级化 CI 关系展示', desc: '按 机房/位置 → 机柜 → 硬件设备 → 操作系统/虚拟机 → 数据库实例 的层级组织 CI 树或关系图' },
    { title: '数据来源', desc: 'iTop CMDB（zbx2itop 同步链路已维护 1400+ Server / 500+ VM / 200+ BMC 硬件 / 存储 / 网络设备及其关系）' },
    { title: '展示方式（待定）', desc: '候选：可折叠层级树 / 力导向关系图 / 依赖拓扑画布，待需求明确后实现' },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-text-primary mb-2">CMDB 拓扑结构</h1>
      <p className="text-text-secondary mb-6">层级化展示 CI 关系（规划中）</p>

      <div className="rounded-xl border border-dashed border-cyan-500/30 bg-cyan-500/5 p-8 text-center mb-6">
        <div className="text-5xl mb-3">🗺️</div>
        <p className="text-text-primary font-semibold mb-1">功能规划中</p>
        <p className="text-[13px] text-text-secondary">
          该页面为占位视图，展示方式确定后在此实现
        </p>
      </div>

      <div className="space-y-3">
        {items.map((it) => (
          <div key={it.title} className="bg-surface rounded-lg border border-border p-4">
            <h3 className="text-[13px] font-semibold text-text-primary mb-1">{it.title}</h3>
            <p className="text-[12px] text-text-secondary leading-relaxed">{it.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
