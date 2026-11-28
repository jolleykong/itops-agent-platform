/**
 * CiRelationExplorer — 多维度 CI 关系拓扑（数据中心 · CMDB 看板）
 *
 * 布局演进（2026-11-28 用户反馈驱动）：
 *   v1 关系轴切换器 —— 一次只看一条轴，维度间割裂。
 *   v2 径向辐射   —— 六轴同时在场，但**几百个节点围成一圈、连线交叉，视觉混乱**。
 *   v3 横向树（本版）—— CI 关系本质是"一个中心 → 若干从属"，是树不是圆。
 *                      根在左、逐层向右，兄弟纵向排列，连线用正交折线不斜穿节点。
 *                      节点过多时配合**右侧平级列表**（树不爆炸，信息不丢）。
 *
 * 三个关键设计：
 *   1. tidy tree：后序遍历算子树高度 → 前序分配 y，保证兄弟不重叠、父节点居中。
 *   2. 折叠：单节点子项超过 MAX_VISIBLE 只画前几个，其余提示「+N 项见右侧」。
 *   3. 平级列表：点任意节点，右侧按其关系轴分组列出**全部**关系（含被树折叠的），
 *      列表项可点击直接以它为中心重定 —— 树看结构，列表看清单。
 *
 * 维度编码（连线颜色）：宿主紫 / 网络青 / 存储橙 / 数据库蓝 / 位置灰 / 运行层绿
 *   实心点 = CMDB 数字外键精确关联；空心点 = 观测或本地推导
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
  network: '#0F6E56',
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
  LogicalVolume: { fill: '#FAECE7', stroke: '#993C1D', text: '#4A1B0C' },
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
  LogicalVolume: '存储卷',
  Rack: '机柜',
  PDU: 'PDU',
  UPS: 'UPS',
};

const NODE_W = 172;
const NODE_H = 32;
const GAP_X = 66;
const GAP_Y = 7;
const MAX_VISIBLE = 6;
const PAD = 36;

interface LayoutNode {
  key: string;
  node: RelNode;
  depth: number;
  axis: RelAxis | null;
  parent: LayoutNode | null;
  children: LayoutNode[];
  hiddenCount: number;
  subtreeH: number;
  x: number;
  y: number;
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 900, h: 620 });

  const nodeByKey = useMemo(() => new Map(nodes.map(n => [n.key, n])), [nodes]);

  /** 邻接表（只保留启用轴） */
  const adj = useMemo(() => {
    const m = new Map<string, { other: string; axis: RelAxis; edge: RelEdge; dir: 'up' | 'down' }[]>();
    for (const e of edges) {
      if (!activeAxes.has(e.axis)) continue;
      const a = m.get(e.from) ?? [];
      a.push({ other: e.to, axis: e.axis, edge: e, dir: 'up' });
      m.set(e.from, a);
      const b = m.get(e.to) ?? [];
      b.push({ other: e.from, axis: e.axis, edge: e, dir: 'down' });
      m.set(e.to, b);
    }
    return m;
  }, [edges, activeAxes]);

  /** 无中心时选连接最多的 CI */
  const defaultCenter = useMemo(() => {
    let best: { key: string; n: number } | null = null;
    for (const n of nodes) {
      const deg = (adj.get(n.key) ?? []).length;
      if (!best || deg > best.n) best = { key: n.key, n: deg };
    }
    return best?.key;
  }, [nodes, adj]);

  const center = centerKey && nodeByKey.has(centerKey) ? centerKey : defaultCenter;

  /** 建树 + tidy 布局 */
  const layout = useMemo(() => {
    if (!center) return { root: null as LayoutNode | null, all: [] as LayoutNode[] };
    const visited = new Set<string>([center]);

    const build = (key: string, d: number, axis: RelAxis | null, parent: LayoutNode | null): LayoutNode => {
      const n = nodeByKey.get(key);
      const ln: LayoutNode = {
        key, node: n as RelNode, depth: d, axis, parent,
        children: [], hiddenCount: 0, subtreeH: NODE_H, x: 0, y: 0,
      };
      if (!n || d >= depth || collapsed.has(key)) return ln;

      // 子项按轴分组排序，同轴相邻，视觉成块
      const links = (adj.get(key) ?? [])
        .filter(l => !visited.has(l.other))
        .sort((a, b) => a.axis.localeCompare(b.axis) || a.other.localeCompare(b.other));

      const keep = links.slice(0, MAX_VISIBLE);
      ln.hiddenCount = Math.max(0, links.length - keep.length);
      for (const l of keep) {
        if (visited.has(l.other)) continue;
        visited.add(l.other);
        ln.children.push(build(l.other, d + 1, l.axis, ln));
      }
      return ln;
    };

    const root = build(center, 0, null, null);

    const measure = (t: LayoutNode): number => {
      if (t.children.length === 0) {
        t.subtreeH = NODE_H;
        return t.subtreeH;
      }
      let h = 0;
      for (const c of t.children) h += measure(c) + GAP_Y;
      t.subtreeH = Math.max(NODE_H, h - GAP_Y);
      return t.subtreeH;
    };
    const place = (t: LayoutNode, x: number, yTop: number) => {
      t.x = x;
      t.y = yTop + t.subtreeH / 2;
      let cy = yTop;
      for (const c of t.children) {
        place(c, x + NODE_W + GAP_X, cy);
        cy += c.subtreeH + GAP_Y;
      }
    };
    measure(root);
    place(root, 0, 0);

    const all: LayoutNode[] = [];
    const walk = (t: LayoutNode) => { all.push(t); t.children.forEach(walk); };
    walk(root);
    return { root, all };
  }, [center, depth, adj, nodeByKey, collapsed]);

  /** 世界尺寸（布局坐标系） */
  const world = useMemo(() => {
    if (layout.all.length === 0) return { w: 800, h: 400 };
    let maxX = 0, maxY = 0, minY = Infinity;
    for (const t of layout.all) {
      maxX = Math.max(maxX, t.x + NODE_W);
      maxY = Math.max(maxY, t.y + NODE_H / 2);
      minY = Math.min(minY, t.y - NODE_H / 2);
    }
    return { w: maxX, h: maxY - minY, minY };
  }, [layout]);

  /** 画布尺寸跟踪（折叠/全屏后要重算） */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const r = e.contentRect;
        if (r.width > 0 && r.height > 0) {
          setCanvasSize({ w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen]);

  /** 自动适配：让整棵树刚好落进画布
   *
   *  横向树的通病是「层数少、兄弟多」→ 又瘦又高，不缩放只能看到一角。
   *  这里在中心/深度/折叠变化后重算一次 zoom，并纵向居中。
   *  注意上限 1：树小时不放大，避免节点字发虚。
   */
  useEffect(() => {
    if (!layout.root) return;
    const padX = PAD * 2;
    const padY = PAD * 2;
    const zx = (canvasSize.w - padX) / Math.max(world.w, 1);
    const zy = (canvasSize.h - padY) / Math.max(world.h, 1);
    // 下限 0.5：再小字号就不可读了，宁可溢出靠拖拽看
    const z = Math.max(0.5, Math.min(1, Math.min(zx, zy)));
    setZoom(z);
    // 纵向居中：把世界中心对到画布中心
    const cy = canvasSize.h / 2 - (world.h / 2) * z - PAD;
    setPan({ x: 0, y: cy });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center, depth, collapsed, canvasSize, world.w, world.h]);

  const onWheel = useCallback((ev: React.WheelEvent) => {
    ev.preventDefault();
    setZoom(z => Math.min(2.5, Math.max(0.15, z * (ev.deltaY > 0 ? 0.9 : 1.1))));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && fullscreen) setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const centerOn = (key: string) => {
    setCenterKey(key); setSelected(key); reset(); setCollapsed(new Set());
  };
  const toggleCollapse = (key: string) => {
    setCollapsed(prev => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key); else s.add(key);
      return s;
    });
  };

  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes
      .filter(n => n.name.toLowerCase().includes(q) || (n.ip ?? '').includes(q))
      .slice(0, 8);
  }, [nodes, query]);

  /** 右侧平级列表：焦点节点的全部关系（含被树折叠的），按轴分组 */
  const focusKey = selected ?? center;
  const focusNode = focusKey ? nodeByKey.get(focusKey) : undefined;
  const focusGroups = useMemo(() => {
    const g = new Map<RelAxis, { key: string; name: string; cls: string; relation: string; exact: boolean }[]>();
    if (!focusKey) return g;
    for (const l of adj.get(focusKey) ?? []) {
      const nb = nodeByKey.get(l.other);
      if (!nb) continue;
      const arr = g.get(l.axis) ?? [];
      if (!arr.some(x => x.key === l.other)) {
        arr.push({
          key: l.other, name: nb.name, cls: nb.class,
          relation: (l.dir === 'up' ? '↑ ' : '↓ ') + l.edge.relation,
          exact: l.edge.exact,
        });
      }
      g.set(l.axis, arr);
    }
    return g;
  }, [focusKey, adj, nodeByKey]);

  const selNode = selected ? nodeByKey.get(selected) : undefined;
  const totalFocus = [...focusGroups.values()].reduce((s, a) => s + a.length, 0);

  const shellStyle: React.CSSProperties = fullscreen
    ? { position: 'fixed', inset: 0, zIndex: 9999, background: '#fff', padding: 12, display: 'flex', flexDirection: 'column' }
    : {};

  return (
    <div style={shellStyle}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <div style={{ position: 'relative' }}>
          <input
            className="search"
            placeholder="搜索 CI 名称 / IP，回车定位"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && searchHits[0]) { centerOn(searchHits[0].key); setQuery(''); } }}
            style={{ width: 220 }}
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
        {[1, 2, 3, 4].map(d => (
          <button
            key={d}
            className={`btn${depth === d ? ' primary' : ''}`}
            style={{ fontSize: 11.5, padding: '4px 9px' }}
            onClick={() => setDepth(d)}
          >
            {d} 层
          </button>
        ))}

        <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 6 }}>维度</span>
        {(Object.keys(AXIS_LABEL) as RelAxis[]).map(a => {
          const on = activeAxes.has(a);
          return (
            <button
              key={a}
              onClick={() => setActiveAxes(prev => {
                const s = new Set(prev);
                if (s.has(a)) s.delete(a); else s.add(a);
                return s;
              })}
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
          <button className="btn" style={{ fontSize: 11.5 }} onClick={() => setZoom(z => Math.min(2.5, z * 1.2))}>放大</button>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={() => setZoom(z => Math.max(0.15, z * 0.83))}>缩小</button>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={reset}>复位</button>
          <button
            className="btn"
            style={{ fontSize: 11.5 }}
            onClick={() => {
              const zx = (canvasSize.w - PAD * 2) / Math.max(world.w, 1);
              const zy = (canvasSize.h - PAD * 2) / Math.max(world.h, 1);
              const z = Math.max(0.5, Math.min(1, Math.min(zx, zy)));
              setZoom(z);
              setPan({ x: 0, y: canvasSize.h / 2 - (world.h / 2) * z - PAD });
            }}
          >
            适应画布
          </button>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={() => setCollapsed(new Set())}>全部展开</button>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={() => setFullscreen(f => !f)}>
            {fullscreen ? '退出全屏' : '全屏'}
          </button>
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 276px', gap: 10, flex: fullscreen ? 1 : undefined, minHeight: 0 }}>
        {/* 画布：横向树 */}
        <div
          ref={canvasRef}
          style={{
            position: 'relative', height: fullscreen ? '100%' : 620, minHeight: 0,
            background: '#fcfcfd',
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
          {!layout.root ? (
            <div style={{ padding: 24, fontSize: 12, color: '#6b7280' }}>暂无 CI 关系数据</div>
          ) : (
            <svg
              width="100%" height="100%"
              role="img"
              aria-label={`以 ${layout.root.node.name} 为中心的树状 CI 关系图，共 ${layout.all.length} 个节点`}
            >
              <g transform={`translate(${pan.x + PAD},${pan.y + PAD}) scale(${zoom})`}>
                {/* 连线：正交折线，不斜穿节点 */}
                {layout.all.map(t => {
                  if (!t.parent) return null;
                  const px = t.parent.x + NODE_W;
                  const py = t.parent.y;
                  const midX = px + GAP_X / 2;
                  const dim = !!selected && !(t.key === selected || t.parent.key === selected);
                  return (
                    <path
                      key={`e-${t.key}`}
                      d={`M${px},${py} H${midX} V${t.y} H${t.x}`}
                      fill="none"
                      stroke={AXIS_COLOR[t.axis ?? 'host']}
                      strokeWidth={1.2}
                      opacity={dim ? 0.15 : 0.55}
                    />
                  );
                })}

                {layout.all.map(t => {
                  const st = CLASS_STYLE[t.node.class] ?? { fill: '#F1EFE8', stroke: '#888780', text: '#2C2C2A' };
                  const isRoot = t.depth === 0;
                  const isSel = selected === t.key;
                  const isCollapsed = collapsed.has(t.key);
                  const short = t.node.name.length > 21 ? `${t.node.name.slice(0, 20)}…` : t.node.name;
                  const clsLabel = CLASS_LABEL[t.node.class] ?? t.node.class;
                  const hasKids = t.children.length > 0 || t.hiddenCount > 0;
                  return (
                    <g key={t.key} data-node="1" style={{ cursor: 'pointer' }}>
                      <title>
                        {`${clsLabel} · ${t.node.name}${t.node.ip ? ` · ${t.node.ip}` : ''}\n双击：以此为中心 ｜ 单击：看平级列表`}
                      </title>
                      <rect
                        x={t.x} y={t.y - NODE_H / 2}
                        width={NODE_W} height={NODE_H} rx={6}
                        fill={st.fill}
                        stroke={isRoot ? '#534AB7' : isSel ? st.stroke : '#e2e5e9'}
                        strokeWidth={isRoot ? 2 : isSel ? 1.8 : 0.8}
                        onClick={ev => { ev.stopPropagation(); setSelected(isSel ? null : t.key); }}
                        onDoubleClick={ev => { ev.stopPropagation(); centerOn(t.key); }}
                      />
                      <rect
                        x={t.x} y={t.y - NODE_H / 2} width={4} height={NODE_H} rx={2}
                        fill={st.stroke} style={{ pointerEvents: 'none' }}
                      />
                      <text x={t.x + 12} y={t.y - 6} fontSize={10.5} fill={st.text} style={{ pointerEvents: 'none' }}>
                        {clsLabel}
                      </text>
                      <text
                        x={t.x + 12} y={t.y + 9}
                        fontSize={11.5} fill={st.text} fontWeight={isRoot ? 500 : 400}
                        style={{ pointerEvents: 'none' }}
                      >
                        {short}
                      </text>
                      {(hasKids || isCollapsed) && t.depth > 0 && t.depth < depth && (
                        <g onClick={ev => { ev.stopPropagation(); toggleCollapse(t.key); }} style={{ cursor: 'pointer' }}>
                          <circle cx={t.x + NODE_W + 11} cy={t.y} r={8} fill="#fff" stroke="#c7cbd1" strokeWidth={0.8} />
                          <text
                            x={t.x + NODE_W + 11} y={t.y}
                            textAnchor="middle" dominantBaseline="central"
                            fontSize={11} fill="#5F5E5A" style={{ pointerEvents: 'none' }}
                          >
                            {isCollapsed ? '+' : '−'}
                          </text>
                        </g>
                      )}
                      {t.hiddenCount > 0 && !isCollapsed && (
                        <text
                          x={t.x + NODE_W + 24} y={t.y}
                          fontSize={10.5} fill="#9ca3af" dominantBaseline="central"
                          style={{ pointerEvents: 'none' }}
                        >
                          +{t.hiddenCount} 项见右侧
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}

          <div style={{
            position: 'absolute', left: 10, bottom: 10, background: 'rgba(255,255,255,.92)',
            border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 9px', fontSize: 10.5, color: '#6b7280',
          }}>
            <div style={{ marginBottom: 3 }}>
              {layout.all.length} 节点
              {collapsed.size > 0 && <span style={{ color: '#b45309' }}> · 已折叠 {collapsed.size}</span>}
            </div>
            <div>双击节点 = 以此为中心 ｜ 点 −/+ 折叠 ｜ 拖拽平移 ｜ 滚轮缩放</div>
          </div>
        </div>

        {/* 右侧：平级列表 */}
        <div style={{ overflow: 'auto', maxHeight: fullscreen ? '100%' : 620 }}>
          {focusNode ? (
            <div className="mini-card">
              <h4 style={{ marginBottom: 5, wordBreak: 'break-all', fontSize: 12.5 }}>{focusNode.name}</h4>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>
                {CLASS_LABEL[focusNode.class] ?? focusNode.class}
                {focusNode.ip ? ` · ${focusNode.ip}` : ''}
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>
                共 {totalFocus} 条平级关系{focusKey === center ? '（当前中心）' : ''}
              </div>
              {focusNode.netVia && (
                <div style={{ fontSize: 11, color: '#0F6E56', marginTop: 6, lineHeight: 1.6 }}>
                  网络位置（经宿主推导）：<br />
                  {focusNode.netVia.host}
                  {focusNode.netVia.switchName && ` → ${focusNode.netVia.switchName}`}
                </div>
              )}
            </div>
          ) : null}

          {totalFocus === 0 && focusNode && (
            <div className="mini-card">
              <div style={{ fontSize: 11.5, color: '#9ca3af', lineHeight: 1.8 }}>
                该 CI 在当前维度筛选下无平级关系。<br />
                可开启更多维度，或双击其它节点继续探索。
              </div>
            </div>
          )}

          {(Object.keys(AXIS_LABEL) as RelAxis[]).map(ax => {
            const list = focusGroups.get(ax);
            if (!list || list.length === 0) return null;
            return (
              <div key={ax} className="mini-card">
                <div style={{
                  fontSize: 11, fontWeight: 500, color: AXIS_COLOR[ax],
                  borderBottom: `1px solid ${AXIS_COLOR[ax]}33`, paddingBottom: 3, marginBottom: 5,
                }}>
                  {AXIS_LABEL[ax]}（{list.length}）
                </div>
                {list.map(item => (
                  <div
                    key={item.key}
                    onClick={() => centerOn(item.key)}
                    title={`${CLASS_LABEL[item.cls] ?? item.cls} · 点击以此为中心`}
                    style={{
                      fontSize: 11.5, padding: '3px 0 3px 3px', cursor: 'pointer',
                      color: '#374151', wordBreak: 'break-all', lineHeight: 1.45,
                    }}
                  >
                    <span style={{ color: item.exact ? '#5F5E5A' : '#c7cbd1', marginRight: 3 }}>
                      {item.exact ? '●' : '○'}
                    </span>
                    {item.name}
                    <span style={{ color: '#9ca3af', marginLeft: 4, fontSize: 10.5 }}>{item.relation}</span>
                  </div>
                ))}
              </div>
            );
          })}

          {!focusNode && (
            <div className="mini-card">
              <h4 style={{ marginBottom: 6, fontSize: 12.5 }}>怎么用</h4>
              <div style={{ fontSize: 11.5, color: '#6b7280', lineHeight: 1.9 }}>
                · 树从中心向右展开，点 −/+ 折叠分支<br />
                · <b>单击节点</b> → 右侧列出它的全部平级关系<br />
                · <b>双击节点</b> → 把它挪到中心重新展开<br />
                · 上方按维度过滤，看单一轴的完整链路<br />
                · 搜索 CI 名/IP 可快速定位
              </div>
            </div>
          )}

          {selNode && (
            <div className="mini-card">
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn" style={{ flex: 1, fontSize: 11.5 }} onClick={() => centerOn(selNode.key)}>
                  以此为中心
                </button>
                <button className="btn" style={{ fontSize: 11.5 }} onClick={() => toggleCollapse(selNode.key)}>
                  {collapsed.has(selNode.key) ? '展开' : '折叠'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
