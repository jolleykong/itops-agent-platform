/**
 * CiTopologyCanvas — CMDB 关系拓扑画布（2026-11-28）
 *
 * 数据：来自 /dc/ci-relations 的 nodes + edges（与列表视图同一份，不再额外请求）。
 * 布局：按关系轴分层（层号由轴向决定，同层横向排列）。不做力导向——CI 关系本身
 *       是层级化的，力导向在 1000+ 节点上既慢又难读。
 *
 * 规模控制（关键）：
 *   每层只渲染前 MAX_PER_LAYER 个节点，其余折叠为一个「聚合节点」（显示数量，
 *   点击可展开该层）。这样 host 轴 646 个 VM 不会把画布压垮。
 *
 * 交互：
 *   · 轴切换（网络/宿主/运行层/数据库/位置/存储）
 *   · 滚轮缩放、拖拽平移、双击复位
 *   · 点击节点：高亮其直接邻居，右侧显示该节点的关系明细
 *   · 悬停节点：显示完整名称与所属层
 *
 * 渲染：纯 SVG（不引入 d3），节点/边为简单图形，切换轴时重算布局。
 */
import { useCallback, useMemo, useRef, useState } from 'react';

type RelAxis = 'host' | 'storage' | 'network' | 'db' | 'rack' | 'os';

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
  netObserverCount?: number;
}

interface RelEdge {
  from: string;
  to: string;
  axis: RelAxis;
  relation: string;
  origin: 'itop' | 'observed' | 'topology' | 'local';
  exact: boolean;
}

const CLASS_COLOR: Record<string, { fill: string; stroke: string; text: string }> = {
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

const AXIS_LABEL: Record<RelAxis, string> = {
  network: '网络轴（→ 出口）',
  host: '宿主轴（→ 物理机）',
  storage: '存储轴（→ 存储系统）',
  db: '数据库',
  rack: '位置（→ 机柜）',
  os: '运行层（→ 操作系统）',
};

const ORIGIN_LABEL: Record<string, string> = {
  itop: 'CMDB 权威',
  observed: '网络观测',
  topology: 'CDP 拓扑',
  local: '本地库',
};

const ORIGIN_COLOR: Record<string, string> = {
  itop: '#185FA5',
  observed: '#0F6E56',
  topology: '#534AB7',
  local: '#854F0B',
};

/** 每层最多独立渲染的节点数，超出折叠 */
const MAX_PER_LAYER = 26;
const NODE_W = 132;
const NODE_H = 34;
const GAP_X = 12;
const LAYER_H = 112;

interface Placed {
  key: string;
  node?: RelNode;
  /** 聚合节点：该层被折叠的数量 */
  collapsed?: number;
  layer: number;
  x: number;
  y: number;
  label: string;
  cls: string;
}

/**
 * 按轴求层号。
 * 轴向语义：边的 from 是「下级/本端」，to 是「上级/根源」，所以 to 的层号更小。
 */
function layerOfAxis(axis: RelAxis): (n: RelNode) => number {
  switch (axis) {
    case 'host':
      // Server(0) ← Hypervisor(1) ← VirtualMachine(2)
      return n => (n.class === 'Server' ? 0 : n.class === 'Hypervisor' ? 1 : 2);
    case 'os':
      // Server(0) ← OsHost(1)
      return n => (n.class === 'OsHost' ? 1 : 0);
    case 'db':
      // 承载对象(0) ← DBServer(1)
      return n => (n.class === 'DBServer' ? 1 : 0);
    case 'rack':
      // Rack(0) ← 设备(1)
      return n => (n.class === 'Rack' ? 0 : 1);
    case 'storage':
      return n => (n.class === 'StorageSystem' ? 0 : 1);
    case 'network':
    default:
      // 交换机按 CDP 层级，机器放最下层（由布局阶段按边关系修正）
      return n => (n.class === 'NetworkDevice' ? 2 : 3);
  }
}

export default function CiTopologyCanvas({
  nodes, edges,
}: {
  nodes: RelNode[];
  edges: RelEdge[];
}) {
  const [axis, setAxis] = useState<RelAxis>('host');
  const [expandLayer, setExpandLayer] = useState<Record<number, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const nodeByKey = useMemo(() => new Map(nodes.map(n => [n.key, n])), [nodes]);

  /** 当前轴的边 */
  const axisEdges = useMemo(
    () => edges.filter(e => e.axis === axis),
    [edges, axis],
  );

  /** 当前轴涉及的节点 */
  const axisKeys = useMemo(() => {
    const s = new Set<string>();
    for (const e of axisEdges) { s.add(e.from); s.add(e.to); }
    return s;
  }, [axisEdges]);

  /** 网络轴：用 CDP 层号做真实分层（核心=0 向下递增），机器放最大层 */
  const netLayer = useMemo(() => {
    if (axis !== 'network') return new Map<string, number>();
    // 从「无 network 上级」的交换机出发 BFS
    const ups = new Map<string, string[]>();
    for (const e of axisEdges) {
      if (e.origin !== 'topology') continue;
      const arr = ups.get(e.from);
      if (arr) arr.push(e.to); else ups.set(e.from, [e.to]);
    }
    const layer = new Map<string, number>();
    const roots = [...new Set(axisEdges.filter(e => e.origin === 'topology').map(e => e.to))]
      .filter(k => !ups.has(k));
    for (const r of roots) layer.set(r, 0);
    const queue = [...roots];
    while (queue.length) {
      const cur = queue.shift()!;
      const l = layer.get(cur) ?? 0;
      for (const e of axisEdges) {
        if (e.to === cur && e.origin === 'topology' && !layer.has(e.from)) {
          layer.set(e.from, l + 1);
          queue.push(e.from);
        }
      }
    }
    const maxSwitch = Math.max(-1, ...[...layer.values()]);
    // 机器（观测态边 from 侧）排在交换机最深层之下
    for (const e of axisEdges) {
      if (e.origin === 'observed' && !layer.has(e.from)) layer.set(e.from, maxSwitch + 1);
    }
    // 未归层的交换机兜底
    for (const k of axisKeys) {
      if (!layer.has(k)) layer.set(k, maxSwitch + 2);
    }
    return layer;
  }, [axis, axisEdges, axisKeys]);

  /** 布局：分层 + 同层折叠 */
  const layout = useMemo(() => {
    if (axisEdges.length === 0) return { placed: [], width: 800, height: 300, hidden: 0 };

    const baseLayer = layerOfAxis(axis);
    const byLayer = new Map<number, RelNode[]>();
    let hidden = 0;

    for (const k of axisKeys) {
      const n = nodeByKey.get(k);
      if (!n) { hidden += 1; continue; }
      const l = axis === 'network' ? (netLayer.get(k) ?? 9) : baseLayer(n);
      const arr = byLayer.get(l);
      if (arr) arr.push(n); else byLayer.set(l, [n]);
    }

    const placed: Placed[] = [];
    let maxRowW = 0;
    const layers = [...byLayer.keys()].sort((a, b) => a - b);

    for (const l of layers) {
      const group = byLayer.get(l)!;
      group.sort((a, b) => (a.class === b.class
        ? a.name.localeCompare(b.name)
        : a.class.localeCompare(b.class)));
      const expanded = expandLayer[l];
      const shown = expanded ? group : group.slice(0, MAX_PER_LAYER);
      const rest = group.length - shown.length;

      const items = shown.length + (rest > 0 ? 1 : 0);
      const rowW = items * NODE_W + (items - 1) * GAP_X;
      maxRowW = Math.max(maxRowW, rowW);
      const startX = -rowW / 2;
      const y = l * LAYER_H + 40;

      shown.forEach((n, i) => {
        placed.push({
          key: n.key, node: n, layer: l,
          x: startX + i * (NODE_W + GAP_X), y,
          label: n.name, cls: n.class,
        });
      });
      if (rest > 0) {
        placed.push({
          key: `__more_${l}`, collapsed: rest, layer: l,
          x: startX + shown.length * (NODE_W + GAP_X), y,
          label: `+${rest} 个`, cls: 'Other',
        });
      }
    }

    return {
      placed,
      width: Math.max(720, maxRowW + 120),
      height: layers.length * LAYER_H + 100,
      hidden,
    };
  }, [axis, axisEdges, axisKeys, nodeByKey, netLayer, expandLayer]);

  /** 可见节点键集合（边只画两端可见的） */
  const visibleKeys = useMemo(
    () => new Set(layout.placed.filter(p => p.node).map(p => p.key)),
    [layout],
  );
  const posOf = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const p of layout.placed) if (p.node) m.set(p.key, { x: p.x, y: p.y });
    return m;
  }, [layout]);

  /** 选中节点的邻接集合（高亮用） */
  const neighbors = useMemo(() => {
    if (!selected) return new Set<string>();
    const s = new Set<string>([selected]);
    for (const e of axisEdges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    return s;
  }, [selected, axisEdges]);

  const onWheel = useCallback((ev: React.WheelEvent) => {
    ev.preventDefault();
    setZoom(z => Math.min(2.5, Math.max(0.25, z * (ev.deltaY > 0 ? 0.92 : 1.08))));
  }, []);

  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); setSelected(null); };

  const selNode = selected ? nodeByKey.get(selected) : undefined;
  const selOut = selected ? axisEdges.filter(e => e.from === selected) : [];
  const selIn = selected ? axisEdges.filter(e => e.to === selected) : [];

  /** 轴统计（哪个轴有多少边） */
  const axisCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of edges) m[e.axis] = (m[e.axis] ?? 0) + 1;
    return m;
  }, [edges]);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {(['host', 'network', 'os', 'db', 'rack', 'storage'] as RelAxis[]).map(a => (
          <button
            key={a}
            className={`btn${axis === a ? ' primary' : ''}`}
            style={{ fontSize: 11.5, padding: '5px 10px' }}
            onClick={() => { setAxis(a); setExpandLayer({}); setSelected(null); }}
          >
            {AXIS_LABEL[a]}（{axisCounts[a] ?? 0}）
          </button>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={() => setZoom(z => Math.min(2.5, z * 1.2))}>放大</button>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={() => setZoom(z => Math.max(0.25, z * 0.83))}>缩小</button>
          <button className="btn" style={{ fontSize: 11.5 }} onClick={reset}>复位</button>
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 268px', gap: 12 }}>
        <div
          className="topo-wrap"
          style={{
            height: 560, background: '#fafbfc', cursor: dragRef.current ? 'grabbing' : 'grab',
            // 拖拽平移时禁止选中文本（否则会整屏变蓝）
            userSelect: 'none', WebkitUserSelect: 'none',
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
          {axisEdges.length === 0 ? (
            <div style={{ padding: 24, fontSize: 12, color: '#6b7280' }}>
              该关系轴暂无关联数据{axis === 'storage' ? '（存储挂载关系未采集）' : ''}。
            </div>
          ) : (
            <svg
              width="100%"
              height="100%"
              role="img"
              aria-label={`${AXIS_LABEL[axis]} 关系拓扑图，共 ${layout.placed.length} 个节点、${axisEdges.length} 条关系`}
            >
              <g transform={`translate(${pan.x + 400},${pan.y + 20}) scale(${zoom})`}>
                {/* 边：先画，压在节点下 */}
                {axisEdges.map((e, i) => {
                  const a = posOf.get(e.from);
                  const b = posOf.get(e.to);
                  if (!a || !b) return null;
                  const dim = selected ? !(neighbors.has(e.from) && neighbors.has(e.to)) : false;
                  return (
                    <line
                      key={`e-${i}`}
                      x1={a.x + NODE_W / 2}
                      y1={a.y}
                      x2={b.x + NODE_W / 2}
                      y2={b.y + NODE_H}
                      stroke={ORIGIN_COLOR[e.origin] ?? '#888780'}
                      strokeWidth={e.exact ? 1.2 : 0.6}
                      strokeDasharray={e.exact ? undefined : '3 3'}
                      opacity={dim ? 0.08 : selected ? 0.9 : 0.34}
                    />
                  );
                })}

                {/* 节点 */}
                {layout.placed.map(p => {
                  if (p.collapsed != null) {
                    return (
                      <g
                        key={p.key}
                        data-node="1"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpandLayer(s => ({ ...s, [p.layer]: true }))}
                      >
                        <rect
                          x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={8}
                          fill="#F1EFE8" stroke="#888780" strokeWidth={0.8}
                          strokeDasharray="4 3"
                        />
                        <text
                          x={p.x + NODE_W / 2} y={p.y + NODE_H / 2}
                          textAnchor="middle" dominantBaseline="central"
                          fontSize={12} fill="#5F5E5A"
                        >
                          {p.label}（点击展开）
                        </text>
                      </g>
                    );
                  }
                  const c = CLASS_COLOR[p.cls] ?? { fill: '#F1EFE8', stroke: '#888780', text: '#2C2C2A' };
                  const dim = selected ? !neighbors.has(p.key) : false;
                  const isSel = selected === p.key;
                  const short = p.label.length > 17 ? `${p.label.slice(0, 16)}…` : p.label;
                  return (
                    <g
                      key={p.key}
                      data-node="1"
                      style={{ cursor: 'pointer' }}
                      opacity={dim ? 0.25 : 1}
                      onClick={ev => { ev.stopPropagation(); setSelected(s => (s === p.key ? null : p.key)); }}
                    >
                      <title>{`${CLASS_LABEL[p.cls] ?? p.cls} · ${p.label}${p.node?.ip ? ` · ${p.node.ip}` : ''}`}</title>
                      <rect
                        x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={7}
                        fill={c.fill} stroke={c.stroke}
                        strokeWidth={isSel ? 2 : 0.8}
                      />
                      <text
                        x={p.x + NODE_W / 2} y={p.y + NODE_H / 2}
                        textAnchor="middle" dominantBaseline="central"
                        fontSize={11.5} fill={c.text}
                      >
                        {short}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
        </div>

        {/* 右侧：图例 + 选中详情 */}
        <div>
          <div className="mini-card">
            <h4>图例</h4>
            <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.9 }}>
              {Object.entries(ORIGIN_LABEL).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 16, height: 0, borderTop: `2px ${k === 'itop' ? 'solid' : 'dashed'} ${ORIGIN_COLOR[k]}` }} />
                  {v}
                </div>
              ))}
              <div style={{ marginTop: 6, color: '#9ca3af' }}>实线=数字外键精确关联<br />虚线=观测/降级匹配</div>
            </div>
          </div>

          {selNode ? (
            <div className="mini-card">
              <h4 style={{ wordBreak: 'break-all' }}>{selNode.name}</h4>
              <div className="kv"><span className="k">类型</span><span className="v">{CLASS_LABEL[selNode.class] ?? selNode.class}</span></div>
              {selNode.ip && <div className="kv"><span className="k">管理 IP</span><span className="v" style={{ fontFamily: 'monospace' }}>{selNode.ip}</span></div>}
              {selNode.netObserverCount != null && (
                <div className="kv">
                  <span className="k">观测交换机</span>
                  <span className="v" style={{ color: selNode.netObserverCount > 1 ? '#b45309' : undefined }}>
                    {selNode.netObserverCount} 台{selNode.netObserverCount > 1 ? '（多源）' : ''}
                  </span>
                </div>
              )}
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 8 }}>
                上级 {selOut.length} · 下级 {selIn.length}
              </div>
              {selOut.slice(0, 6).map((e, i) => (
                <div key={`o${i}`} style={{ fontSize: 11, padding: '2px 0', wordBreak: 'break-all' }}>
                  ↑ {nodeByKey.get(e.to)?.name ?? e.to}
                  <span style={{ color: ORIGIN_COLOR[e.origin], marginLeft: 4 }}>[{ORIGIN_LABEL[e.origin]}]</span>
                </div>
              ))}
              {selIn.slice(0, 6).map((e, i) => (
                <div key={`i${i}`} style={{ fontSize: 11, padding: '2px 0', wordBreak: 'break-all' }}>
                  ↓ {nodeByKey.get(e.from)?.name ?? e.from}
                </div>
              ))}
              {(selOut.length + selIn.length) > 12 && (
                <div style={{ fontSize: 10.5, color: '#9ca3af', marginTop: 4 }}>
                  仅显示前 6 条，完整关系见「关系明细」
                </div>
              )}
            </div>
          ) : (
            <div className="mini-card">
              <h4>操作提示</h4>
              <div style={{ fontSize: 11.5, color: '#6b7280', lineHeight: 1.8 }}>
                · 点击节点查看该 CI 的关系<br />
                · 滚轮缩放，拖拽平移<br />
                · 每层超 {MAX_PER_LAYER} 个节点会折叠，点「+N 个」展开<br />
                · 切换上方关系轴查看不同层级
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
