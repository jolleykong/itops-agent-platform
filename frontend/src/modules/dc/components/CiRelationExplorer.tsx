/**
 * CiRelationExplorer — 多维度 CI 关系拓扑（数据中心 · CMDB 看板）
 *
 * 设计取舍（2026-11-28 用户反馈驱动）：
 *   旧版是把关系轴做成"切换器"，一次只看一条轴 —— 维度之间泾渭分明，
 *   也看不到"这台机器同时属于哪个机柜、哪条网络、哪个宿主"。
 *   本版改为**以 CI 为中心的径向辐射**：中心是本机，向外一圈是它的全部
 *   直接关系（各轴同时在场，用颜色/线型区分），再外一圈是二级关系。
 *   点任意节点即可把它挪到中心继续探索 —— 这才能"系统地、完整地"看关系。
 *
 * 维度编码：
 *   宿主轴  紫   网络轴  青   存储轴  橙   数据库  蓝   位置  灰   运行层  绿
 *   实线 = CMDB 数字外键精确关联；虚线 = 观测/本地推导
 *
 * 交互：搜索定位 / 深度 1-3 / 按轴过滤 / 滚轮缩放 / 拖拽平移 / 全屏 / 点击重定中心
 * 刻意不做力导向：CI 关系本身层级化，力导向在千级节点上既慢又乱。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type RelAxis = 'host' | 'storage' | 'network' | 'db' | 'rack' | 'os';

interface RelNode {
  key: string;
  class: string;
  name: string;
  ip?: string;
  status?: string;
  dup: boolean;
  children: number;
  parents: number;
  axes: RelAxis[];
  dims?: { network?: string; host?: string; storage?: string };
  netObserverCount?: number;
  netLayer?: number;
  netVia?: { host: string; switchName?: string; port?: string };
}

interface RelEdge {
  from: string;
  to: string;
  axis: RelAxis;
  relation: string;
  origin: 'itop' | 'observed' | 'topology' | 'local';
  exact: boolean;
}

const AXIS_COLOR: Record<RelAxis, string> = {
  host: '#534AB7',
  network: '#1D9E75',
  storage: '#993C1D',
  db: '#185FA5',
  rack: '#888780',
  os: '#3B6D11',
};

const AXIS_LABEL: Record<RelAxis, string> = {
  host: '宿主轴',
  network: '网络轴',
  storage: '存储轴',
  db: '数据库',
  rack: '位置',
  os: '运行层',
};

const CLASS_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  Server: { fill: '#E6F1FB', stroke: '#185FA5', text: '#042C53' },
  Hypervisor: { fill: '#EEEDFE', stroke: '#534AB7', text: '#26215C' },
  VirtualMachine: { fill: '#E1F5EE', stroke: '#0F6E56', text: '#04342C' },
  OsHost: { fill: '#EAF3DE', stroke: '#3B6D11', text: '#173404' },
  DBServer: { fill: '#FAEEDA', stroke: '#854F0B', text: '#412402' },
  NetworkDevice: { fill: '#FBEAF0', stroke: '#993556', text: '#4B1528' },
  StorageSystem: { fill: '#FAECE7', stroke: '#993C1D', text: '#4A1B0C' },
  Rack: { fill: '#F1EFE8', stroke: '#5F5E5A', text: '#2C2C2A' },
  PDU: { fill: '#FAEEDA', stroke: '#BA7517', text: '#412402' },
  UPS: { fill: '#FAEEDA', stroke: '#BA7517', text: '#412402' },
};

const CLASS_LABEL: Record<string, string> = {
  Server: '物理服务器',
  Hypervisor: '虚拟化宿主',
  VirtualMachine: '虚拟机',
  OsHost: '操作系统',
  DBServer: '数据库实例',
  NetworkDevice: '网络设备',
  StorageSystem: '存储系统',
  Rack: '机柜',
  PDU: 'PDU',
  UPS: 'UPS',
};

const NODE_W = 116;
const NODE_H = 30;
const RING_GAP = 155;

interface Placed {
  key: string;
  node: RelNode;
  x: number;
  y: number;
  level: number;
  /** 与本层父节点的连接轴（中心层为 null） */
  axisFromParent: RelAxis | null;
}

export default function CiRelationExplorer({
  nodes, edges, initialKey,
}: {
  nodes: RelNode[];
  edges: RelEdge[];
  initialKey?: string;
}) {
  const [centerKey, setCenterKey] = useState<string | null>(initialKey ?? null);
  const [depth, setDepth] = useState(2);
  const [activeAxes, setActiveAxes] = useState<Set<RelAxis>>(
    new Set(['host', 'network', 'storage', 'db', 'rack', 'os'] as RelAxis[]),
  );
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const nodeByKey = useMemo(() => new Map(nodes.map(n => [n.key, n])), [nodes]);

  /** 邻接表：只保留启用轴的边 */
  const adj = useMemo(() => {
    const m = new Map<string, { other: string; axis: RelAxis; edge: RelEdge; dir: 'up' | 'down' }[]>();
    for (const e of edges) {
      if (!activeAxes.has(e.axis)) continue;
      (m.get(e.from) ?? m.set(e.from, []).get(e.from)!).push(
        { other: e.to, axis: e.axis, edge: e, dir: 'up' });
      (m.get(e.to) ?? m.set(e.to, []).get(e.to)!).push(
        { other: e.from, axis: e.axis, edge: e, dir: 'down' });
    }
    return m;
  }, [edges, activeAxes]);

  /** 无中心时，挑一个连接最多的 CI 作为默认中心 */
  const defaultCenter = useMemo(() => {
    let best: { key: string; n: number } | null = null;
    for (const n of nodes) {
      const deg = (adj.get(n.key) ?? []).length;
      if (!best || deg > best.n) best = { key: n.key, n: deg };
    }
    return best?.key;
  }, [nodes, adj]);

  const center = centerKey && nodeByKey.has(centerKey) ? centerKey : defaultCenter;

  /** 径向布局：BFS 分层 + 每层按父角度扇区展开，同轴相邻 */
  const layout = useMemo(() => {
    if (!center) return { placed: [] as Placed[], hidden: 0 };
    const placed: Placed[] = [];
    const visited = new Map<string, number>([[center, 0]]);
    const centerNode = nodeByKey.get(center);
    if (!centerNode) return { placed: [], hidden: 0 };
    placed.push({ key: center, node: centerNode, x: -NODE_W / 2, y: -NODE_H / 2, level: 0, axisFromParent: null });

    interface Item { key: string; parentAngle: number; axis: RelAxis }
    let frontier: Item[] = [{ key: center, parentAngle: 0, axis: 'host' }];
    let hidden = 0;

    for (let level = 1; level <= depth; level++) {
      const next: Item[] = [];
      const ringItems: { key: string; angle: number; axis: RelAxis }[] = [];
      const radius = level * RING_GAP;

      // 汇总本层候选，按轴聚类后均匀铺满圆周
      const cands: { key: string; axis: RelAxis; parentAngle: number }[] = [];
      const seenThisLevel = new Set<string>();
      for (const f of frontier) {
        for (const link of adj.get(f.key) ?? []) {
          if (visited.has(link.other)) continue;
          if (seenThisLevel.has(link.other)) continue;
          seenThisLevel.add(link.other);
          cands.push({ key: link.other, axis: link.axis, parentAngle: f.parentAngle });
        }
      }
      if (cands.length === 0) break;

      // 每层最多容纳 40 个节点，超出折叠（避免视觉爆炸）
      const MAX_RING = 40;
      if (cands.length > MAX_RING) { hidden += cands.length - MAX_RING; cands.length = MAX_RING; }

      cands.sort((a, b) => a.axis.localeCompare(b.axis));
      const n = cands.length;
      cands.forEach((c, i) => {
        // 第 1 层：整圈均匀；第 2 层起：按父节点角度做小幅偏移，保持从属视觉
        const baseAngle = level === 1
          ? (2 * Math.PI * i) / n - Math.PI / 2
          : c.parentAngle + ((i % 5) - 2) * 0.32;
        ringItems.push({ key: c.key, angle: baseAngle, axis: c.axis });
      });

      for (const it of ringItems) {
        const node = nodeByKey.get(it.key);
        if (!node) continue;
        visited.set(it.key, level);
        placed.push({
          key: it.key, node,
          x: Math.cos(it.angle) * radius - NODE_W / 2,
          y: Math.sin(it.angle) * radius - NODE_H / 2,
          level, axisFromParent: it.axis,
        });
        next.push({ key: it.key, parentAngle: it.angle, axis: it.axis });
      }
      frontier = next;
    }
    return { placed, hidden };
  }, [center, depth, adj, nodeByKey]);

  const posOf = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const p of layout.placed) m.set(p.key, { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 });
    return m;
  }, [layout]);

  /** 画布内可见的边（两端都在场） */
  const visibleEdges = useMemo(() => {
    const keys = new Set(layout.placed.map(p => p.key));
    return edges.filter(e => activeAxes.has(e.axis) && keys.has(e.from) && keys.has(e.to));
  }, [edges, activeAxes, layout]);

  /** 层半径 → 用于世界坐标居中 */
  const viewSize = useMemo(() => {
    const r = (depth + 1) * RING_GAP;
    return { w: r * 2, h: r * 2, r };
  }, [depth]);

  const onWheel = useCallback((ev: React.WheelEvent) => {
    ev.preventDefault();
    setZoom(z => Math.min(3, Math.max(0.2, z * (ev.deltaY > 0 ? 0.9 : 1.1))));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && fullscreen) setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const centerOn = (key: string) => { setCenterKey(key); setSelected(key); reset(); };

  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes
      .filter(n => n.name.toLowerCase().includes(q) || (n.ip ?? '').includes(q))
      .slice(0, 8);
  }, [nodes, query]);

  const selNode = selected ? nodeByKey.get(selected) : undefined;
  const selLinks = selected ? (adj.get(selected) ?? []) : [];

  const shellStyle: React.CSSProperties = fullscreen
    ? { position: 'fixed', inset: 0, zIndex: 9999, background: '#fff', padding: 12, display: 'flex', flexDirection: 'column' }
    : {};

  return (
    <div style={shellStyle}>
      {/* 工具条 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <div style={{ position: 'relative' }}>
          <input
            className="search"
            placeholder="搜索 CI 名称 / IP，回车定位为中心"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && searchHits[0]) centerOn(searchHits[0].key);
            }}
            style={{ width: 260 }}
          />
          {searchHits.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
              background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
              boxShadow: '0 6px 20px rgba(16,24,40,.12)', marginTop: 4, overflow: 'hidden',
            }}>
              {searchHits.map(h => (
                <div
                  key={h.key}
                  onClick={() => { centerOn(h.key); setQuery(''); }}
                  style={{ padding: '6px 10px', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                >
                  <span style={{ color: '#6b7280', marginRight: 6 }}>{CLASS_LABEL[h.class] ?? h.class}</span>
                  {h.name}
                </div>
              ))}
            </div>
          )}
        </div>

        <span style={{ fontSize: 12, color: '#6b7280' }}>深度</span>
        {[1, 2, 3].map(d => (
          <button
            key={d}
            className={`btn${depth === d ? ' primary' : ''}`}
            style={{ fontSize: 11.5, padding: '4px 9px' }}
            onClick={() => setDepth(d)}
          >
            {d} 层
          </button>
        ))}

        <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>维度</span>
        {(Object.keys(AXIS_LABEL) as RelAxis[]).map(a => {
          const on = activeAxes.has(a);
          return (
            <button
              key={a}
              onClick={() => {
                setActiveAxes(prev => {
                  const s = new Set(prev);
                  if (s.has(a)) s.delete(a); else s.add(a);
                  return s;
                });
              }}
              style={{
                fontSize: 11.5, padding: '4px 9px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${on ? AXIS_COLOR[a] : '#e5e7eb'}`,
                background: on ? `${AXIS_COLOR[a]}14` : '#fff',
                color: on ? AXIS_COLOR[a] : '#9ca3af',
              }}
            >
              {AXIS_LABEL[a]}
            </button>
          );
        })}

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={() => setZoom(z => Math.min(3, z * 1.2))}>放大</button>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={() => setZoom(z => Math.max(0.2, z * 0.83))}>缩小</button>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={reset}>复位</button>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={() => setFullscreen(f => !f)}>
            {fullscreen ? '退出全屏' : '全屏'}
          </button>
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 250px', gap: 10, flex: fullscreen ? 1 : undefined, minHeight: 0 }}>
        {/* 画布：userSelect:none 防止拖拽时选中文本 */}
        <div
          style={{
            position: 'relative', height: fullscreen ? '100%' : 600, minHeight: 0,
            background: 'radial-gradient(circle at 50% 50%, #fafcff, #f1f4f8)',
            border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden',
            userSelect: 'none', WebkitUserSelect: 'none', cursor: dragRef.current ? 'grabbing' : 'grab',
          }}
          onWheel={onWheel}
          onMouseDown={e => {
            if ((e.target as Element).closest('g[data-node]')) return;
            dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
          }}
          onMouseMove={e => {
            const d = dragRef.current;
            if (!d) return;
            setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
          }}
          onMouseUp={() => { dragRef.current = null; }}
          onMouseLeave={() => { dragRef.current = null; }}
        >
          {!center ? (
            <div style={{ padding: 24, fontSize: 12, color: '#6b7280' }}>暂无 CI 关系数据</div>
          ) : (
            <svg
              width="100%" height="100%"
              role="img"
              aria-label={`以 ${nodeByKey.get(center)?.name ?? ''} 为中心的多维度 CI 关系拓扑，${layout.placed.length} 个节点、${visibleEdges.length} 条关系`}
            >
              <g transform={`translate(${pan.x + 0},${pan.y + 0}) translate(${(viewSize.w) / 2 + 60},${(viewSize.h) / 2 + 40}) scale(${zoom})`}>
                {/* 同心环参考线 */}
                {Array.from({ length: depth }, (_, i) => (
                  <circle
                    key={`ring-${i}`}
                    cx={0} cy={0} r={(i + 1) * RING_GAP}
                    fill="none" stroke="#e5e7eb" strokeWidth={0.5} strokeDasharray="3 5"
                  />
                ))}

                {/* 边 */}
                {visibleEdges.map((e, i) => {
                  const a = posOf.get(e.from);
                  const b = posOf.get(e.to);
                  if (!a || !b) return null;
                  const dim = selected ? !(e.from === selected || e.to === selected) : false;
                  return (
                    <line
                      key={`e-${i}`}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke={AXIS_COLOR[e.axis]}
                      strokeWidth={e.exact ? 1.3 : 0.7}
                      strokeDasharray={e.exact ? undefined : '3 3'}
                      opacity={dim ? 0.06 : 0.42}
                    />
                  );
                })}

                {/* 节点 */}
                {layout.placed.map(p => {
                  const st = CLASS_STYLE[p.node.class] ?? { fill: '#F1EFE8', stroke: '#888780', text: '#2C2C2A' };
                  const isCenter = p.key === center;
                  const isSel = selected === p.key;
                  const short = p.node.name.length > 15 ? `${p.node.name.slice(0, 14)}…` : p.node.name;
                  return (
                    <g
                      key={p.key}
                      data-node="1"
                      style={{ cursor: 'pointer' }}
                      onClick={ev => { ev.stopPropagation(); setSelected(isSel ? null : p.key); }}
                      onDoubleClick={ev => { ev.stopPropagation(); centerOn(p.key); }}
                    >
                      <title>{`${CLASS_LABEL[p.node.class] ?? p.node.class} · ${p.node.name}${p.node.ip ? ` · ${p.node.ip}` : ''}\n双击：以此为中心展开`}</title>
                      <rect
                        x={p.x} y={p.y}
                        width={isCenter ? NODE_W + 16 : NODE_W}
                        height={isCenter ? NODE_H + 10 : NODE_H}
                        rx={isCenter ? 9 : 6}
                        fill={st.fill}
                        stroke={isCenter ? AXIS_COLOR.host : st.stroke}
                        strokeWidth={isCenter ? 2.2 : isSel ? 1.8 : 0.8}
                      />
                      <text
                        x={p.x + (isCenter ? (NODE_W + 16) / 2 : NODE_W / 2)}
                        y={p.y + (isCenter ? (NODE_H + 10) / 2 : NODE_H / 2)}
                        textAnchor="middle" dominantBaseline="central"
                        fontSize={isCenter ? 12.5 : 11}
                        fill={st.text}
                        style={{ pointerEvents: 'none' }}
                      >
                        {short}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}

          {/* 图例（画布内浮层） */}
          <div style={{
            position: 'absolute', left: 10, bottom: 10, background: 'rgba(255,255,255,.92)',
            border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 9px', fontSize: 10.5, color: '#6b7280',
          }}>
            <div style={{ marginBottom: 3 }}>
              {layout.placed.length} 节点 · {visibleEdges.length} 边
              {layout.hidden > 0 && <span style={{ color: '#b45309' }}> · 折叠 {layout.hidden}</span>}
            </div>
            <div>双击节点 = 以此为中心 ｜ 拖拽平移 ｜ 滚轮缩放</div>
            <div style={{ marginTop: 3 }}>实线 数字外键 ｜ 虚线 观测/推导</div>
          </div>
        </div>

        {/* 右栏：中心信息 + 选中详情 */}
        <div style={{ overflow: 'auto', maxHeight: fullscreen ? '100%' : 600 }}>
          {center && (
            <div className="mini-card">
              <h4 style={{ marginBottom: 6 }}>当前中心</h4>
              <div style={{ fontSize: 12, fontWeight: 500, wordBreak: 'break-all', marginBottom: 4 }}>
                {nodeByKey.get(center)?.name}
              </div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>
                {CLASS_LABEL[nodeByKey.get(center)?.class ?? ''] ?? nodeByKey.get(center)?.class}
                {nodeByKey.get(center)?.ip ? ` · ${nodeByKey.get(center)?.ip}` : ''}
              </div>
              {nodeByKey.get(center)?.netVia && (
                <div style={{ fontSize: 11, color: '#0F6E56', marginTop: 6, lineHeight: 1.6 }}>
                  网络位置（经宿主推导）：<br />
                  {nodeByKey.get(center)?.netVia?.host}
                  {nodeByKey.get(center)?.netVia?.switchName && ` → ${nodeByKey.get(center)?.netVia?.switchName}`}
                </div>
              )}
              {nodeByKey.get(center)?.netObserverCount != null && (
                <div style={{ fontSize: 11, color: (nodeByKey.get(center)?.netObserverCount ?? 0) > 1 ? '#b45309' : '#6b7280', marginTop: 4 }}>
                  观测交换机 {nodeByKey.get(center)?.netObserverCount} 台
                  {(nodeByKey.get(center)?.netObserverCount ?? 0) > 1 ? '（多源）' : ''}
                </div>
              )}
            </div>
          )}

          {selNode ? (
            <div className="mini-card">
              <h4 style={{ marginBottom: 6, wordBreak: 'break-all' }}>{selNode.name}</h4>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
                共 {selLinks.length} 条关系（按维度）
              </div>
              {(['host', 'network', 'storage', 'db', 'rack', 'os'] as RelAxis[]).map(ax => {
                const list = selLinks.filter(l => l.axis === ax);
                if (list.length === 0) return null;
                return (
                  <div key={ax} style={{ marginBottom: 7 }}>
                    <div style={{ fontSize: 10.5, color: AXIS_COLOR[ax], fontWeight: 500 }}>
                      {AXIS_LABEL[ax]}（{list.length}）
                    </div>
                    {list.slice(0, 6).map((l, i) => (
                      <div
                        key={i}
                        onClick={() => centerOn(l.other)}
                        style={{ fontSize: 11, padding: '1px 0 1px 6px', cursor: 'pointer', color: '#374151', wordBreak: 'break-all' }}
                        title="点击以此为中心"
                      >
                        {l.dir === 'up' ? '↑' : '↓'} {nodeByKey.get(l.other)?.name ?? l.other}
                      </div>
                    ))}
                    {list.length > 6 && (
                      <div style={{ fontSize: 10, color: '#9ca3af', paddingLeft: 6 }}>…另有 {list.length - 6} 条</div>
                    )}
                  </div>
                );
              })}
              <button
                className="btn"
                style={{ width: '100%', fontSize: 11.5, marginTop: 4 }}
                onClick={() => centerOn(selNode.key)}
              >
                以此为中心展开
              </button>
            </div>
          ) : (
            <div className="mini-card">
              <h4 style={{ marginBottom: 6 }}>怎么用</h4>
              <div style={{ fontSize: 11.5, color: '#6b7280', lineHeight: 1.9 }}>
                · <b>双击</b>任意节点 → 把它挪到中心，继续向外探索<br />
                · 上方按<b>维度</b>过滤，看单一轴的完整链路<br />
                · 深度 1–3 层控制展开范围<br />
                · 搜 CI 名/IP 可快速定位为中心<br />
                · <b>全屏</b>看大范围；Esc 退出
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
