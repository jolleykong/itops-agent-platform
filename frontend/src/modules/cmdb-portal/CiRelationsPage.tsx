/**
 * CiRelationsPage — 资源工作台 · CMDB 全量 CI 关系展开（真实数据）
 *
 * 数据源：GET /dc/ci-relations（后端一次构建全量关系图：iTop 批量 OQL + cipipe netobs/netlinks）
 * 与机房看板「CI 链路」的分工：
 *   机房看板 = 从一台设备往下钻，逐层懒加载；
 *   本页     = 全量一次性展开，用于全景浏览、按类/轴筛选、孤立对象识别、关系覆盖统计。
 *
 * 交互：左侧按类/关系轴筛选；表格分页浏览每台 CI 的上下级与三轴归属；
 *      点击行在下方展开该 CI 的全部关系边（三轴分组）与「跳转机房看板」入口。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';

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
  dims: { network?: string; host?: string; storage?: string };
}

interface RelEdge {
  from: string;
  to: string;
  axis: RelAxis;
  relation: string;
}

interface RelStats {
  totalRaw: number;
  total: number;
  osNodes: number;
  dupCount: number;
  isolated: number;
  byAxis: Record<string, number>;
  byClass: Record<string, number>;
}

interface RelGraph {
  generatedAt: string;
  stats: RelStats;
  nodes: RelNode[];
  edges: RelEdge[];
  isolated: string[];
  networkRoots: { root: string; count: number }[];
  gaps: string[];
}

const CLASS_LABEL: Record<string, string> = {
  Server: '物理服务器',
  VirtualMachine: '虚拟机',
  Hypervisor: '虚拟化宿主',
  DBServer: '数据库实例',
  NetworkDevice: '网络设备',
  StorageSystem: '存储系统',
  Rack: '机柜',
  OsHost: '操作系统（Zabbix）',
};

const AXIS_LABEL: Record<RelAxis, string> = {
  host: '宿主轴',
  storage: '存储轴',
  network: '网络轴',
  db: '数据库',
  rack: '位置',
  os: '运行层',
};

const AXIS_BADGE: Record<RelAxis, string> = {
  host: 'b',
  storage: 'o',
  network: 'g',
  db: 'b',
  rack: '',
  os: 'g',
};

const PAGE_SIZE = 50;

type Tab = 'detail' | 'roots' | 'isolated' | 'matrix';

export default function CiRelationsPage() {
  const [graph, setGraph] = useState<RelGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeDup, setIncludeDup] = useState(false);

  const [tab, setTab] = useState<Tab>('detail');
  const [clsFilter, setClsFilter] = useState<string>('');
  const [axisFilter, setAxisFilter] = useState<'' | RelAxis>('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (withDup: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/dc/ci-relations', { params: withDup ? { dup: 1 } : {} });
      const data = (res as unknown as { data?: RelGraph }).data ?? (res as unknown as RelGraph);
      setGraph(data ?? null);
      setPage(0);
    } catch (err) {
      setError((err as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(includeDup); }, [load, includeDup]);

  /** 边索引：节点键 → 出边/入边（展开单点关系用，避免再请求后端） */
  const edgeIndex = useMemo(() => {
    const out = new Map<string, RelEdge[]>();
    const inn = new Map<string, RelEdge[]>();
    for (const e of graph?.edges ?? []) {
      (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
      (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e);
    }
    return { out, inn };
  }, [graph]);

  const nodeByKey = useMemo(
    () => new Map((graph?.nodes ?? []).map(n => [n.key, n])),
    [graph],
  );

  const isolatedSet = useMemo(() => new Set(graph?.isolated ?? []), [graph]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return (graph?.nodes ?? []).filter(n => {
      if (clsFilter) {
        if (n.class !== clsFilter) return false;
      } else if (n.class === 'OsHost') {
        // 默认视图聚焦 iTop 原生 CI（与「真实 CI 总数」口径一致）；
        // OS 层在左侧类型里单独可选
        return false;
      }
      if (axisFilter && !n.axes.includes(axisFilter)) return false;
      if (kw && !(n.name.toLowerCase().includes(kw) || (n.ip ?? '').includes(kw))) return false;
      return true;
    });
  }, [graph, clsFilter, axisFilter, keyword]);

  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  const clsList = useMemo(() => {
    const keys = Object.keys(graph?.stats.byClass ?? {});
    return keys.sort((a, b) => (graph!.stats.byClass[b] ?? 0) - (graph!.stats.byClass[a] ?? 0));
  }, [graph]);

  if (loading) {
    return (
      <div className="cmdb-proto" style={{ padding: '18px 22px' }}>
        <div className="note">正在构建 CMDB 全量 CI 关系图（iTop 按类批量拉取 + cipipe 观测合并），首次加载约需数秒…</div>
      </div>
    );
  }

  if (error || !graph) {
    return (
      <div className="cmdb-proto" style={{ padding: '18px 22px' }}>
        <div className="notice">加载失败：{error ?? '无数据'}</div>
        <button className="btn" onClick={() => void load(includeDup)}>重试</button>
      </div>
    );
  }

  const { stats } = graph;
  const pct = (n: number) => (stats.total ? Math.round((n / stats.total) * 1000) / 10 : 0);

  return (
    <div className="cmdb-proto" style={{ padding: '18px 22px 60px', maxWidth: 1920, margin: '0 auto' }}>
      <div className="note">
        <b>全量 CI 关系展开</b>　数据来自 iTop 实时查询（按类批量 OQL）+ cipipe 网络观测（netobs / netlinks）+ 本地 Zabbix 主机表（运行层）。
        口径：已剔除 <code>obsolete / inactive</code> 状态对象与 <code>__DUP_*</code> 同步残渣；OS 层为 Zabbix 主机虚拟类，不占 iTop CI 名额。
        生成时间 {new Date(graph.generatedAt).toLocaleString('zh-CN', { hour12: false })}
       　<label style={{ marginLeft: 12 }}>
          <input
            type="checkbox"
            checked={includeDup}
            onChange={e => setIncludeDup(e.target.checked)}
            style={{ marginRight: 4 }}
          />
          含同步残渣（__DUP_*）
        </label>
        <button className="btn" style={{ marginLeft: 12 }} onClick={() => void load(includeDup)}>重新构建</button>
      </div>

      <div className="workspace">
        <div className="ws-head">
          <div>
            <h2>资源工作台</h2>
            <p>
              全量 CI {stats.total.toLocaleString()} 项 · 关系边 {graph.edges.length.toLocaleString()} 条 ·
              孤立 {stats.isolated.toLocaleString()} 项
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="search"
              placeholder="搜索名称 / IP"
              value={keyword}
              onChange={e => { setKeyword(e.target.value); setPage(0); }}
            />
          </div>
        </div>

        <div className="ws-body">
          <div className="sidebar">
            <div className="grp-t">对象类型</div>
            <a className={clsFilter === '' ? 'on' : ''} onClick={() => { setClsFilter(''); setPage(0); }}>
              全部对象（{stats.total}）
            </a>
            {clsList.map(c => (
              <a
                key={c}
                className={clsFilter === c ? 'on' : ''}
                onClick={() => { setClsFilter(c); setPage(0); }}
              >
                {CLASS_LABEL[c] ?? c}（{stats.byClass[c]}）
              </a>
            ))}
            {stats.osNodes > 0 && (
              <a
                className={clsFilter === 'OsHost' ? 'on' : ''}
                onClick={() => { setClsFilter('OsHost'); setPage(0); }}
              >
                {CLASS_LABEL.OsHost}（{stats.osNodes}）
              </a>
            )}
            <div className="grp-t">关系轴</div>
            <a className={axisFilter === '' ? 'on' : ''} onClick={() => { setAxisFilter(''); setPage(0); }}>
              全部轴
            </a>
            {(['network', 'host', 'storage', 'db', 'rack', 'os'] as RelAxis[]).map(a => (
              <a
                key={a}
                className={axisFilter === a ? 'on' : ''}
                onClick={() => { setAxisFilter(a); setPage(0); }}
              >
                {AXIS_LABEL[a]}（{stats.byAxis[a] ?? 0}）
              </a>
            ))}
            <div className="grp-t">视图</div>
            <a className={tab === 'detail' ? 'on' : ''} onClick={() => setTab('detail')}>关系明细</a>
            <a className={tab === 'roots' ? 'on' : ''} onClick={() => setTab('roots')}>网络根源聚合</a>
            <a className={tab === 'isolated' ? 'on' : ''} onClick={() => setTab('isolated')}>孤立对象（{stats.isolated}）</a>
            <a className={tab === 'matrix' ? 'on' : ''} onClick={() => setTab('matrix')}>覆盖矩阵</a>
          </div>

          <div className="content">
            <div className="mcards">
              <div className="mcard">
                <div className="l">真实 CI 总数</div>
                <div className="n">{stats.total.toLocaleString()}</div>
                <div className="s">
                  iTop 原始 {stats.totalRaw.toLocaleString()} 条
                  {stats.osNodes > 0 && ` · OS 层另计 ${stats.osNodes}`}
                </div>
              </div>
              <div className="mcard">
                <div className="l">同步残渣</div>
                <div className="n" style={{ color: '#b45309' }}>{stats.dupCount.toLocaleString()}</div>
                <div className="s">{Math.round((stats.dupCount / Math.max(1, stats.totalRaw)) * 100)}% 为 __DUP_* 重复对象</div>
              </div>
              <div className="mcard">
                <div className="l">孤立对象</div>
                <div className="n" style={{ color: stats.isolated ? '#b91c1c' : '#047857' }}>
                  {stats.isolated.toLocaleString()}
                </div>
                <div className="s">无任何上下级关系</div>
              </div>
              <div className="mcard">
                <div className="l">有下级可递归</div>
                <div className="n">{stats.byAxis.children.toLocaleString()}</div>
                <div className="s">占 {pct(stats.byAxis.children)}%</div>
              </div>
            </div>

            {graph.gaps.length > 0 && (
              <div className="notice">
                {graph.gaps.map((g, i) => <div key={i}>⚠ {g}</div>)}
              </div>
            )}

            {tab === 'detail' && (
              <>
                <div className="sec-t">
                  CI 关系明细
                  <span className="badge">{filtered.length} 项命中</span>
                  {clsFilter && <span className="badge b">{CLASS_LABEL[clsFilter] ?? clsFilter}</span>}
                  {axisFilter && <span className="badge g">{AXIS_LABEL[axisFilter]}</span>}
                </div>
                <table className="ltbl">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>名称</th>
                      <th>管理 IP</th>
                      <th>下级</th>
                      <th>上级</th>
                      <th>关系轴</th>
                      <th>最近上级</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(n => {
                      const isOpen = expanded === n.key;
                      return (
                        <tr key={n.key} style={{ background: isOpen ? '#f0f7ff' : undefined }}>
                          <td><span className="badge b">{CLASS_LABEL[n.class] ?? n.class}</span></td>
                          <td title={n.name} style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {n.name}
                            {n.dup && <span className="badge r" style={{ marginLeft: 6 }}>残渣</span>}
                          </td>
                          <td style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{n.ip ?? '—'}</td>
                          <td>{n.children || '—'}</td>
                          <td>{n.parents || '—'}</td>
                          <td>
                            {n.axes.length === 0
                              ? <span className="badge">无关系</span>
                              : n.axes.map(a => (
                                <span key={a} className={`badge ${AXIS_BADGE[a]}`} style={{ marginRight: 3 }}>
                                  {AXIS_LABEL[a]}
                                </span>
                              ))}
                          </td>
                          <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[n.dims.network, n.dims.host].filter(Boolean).join(' / ')}>
                            {n.dims.host ?? n.dims.network ?? '—'}
                          </td>
                          <td>
                            <button
                              className="btn"
                              style={{ padding: '3px 8px', fontSize: 11 }}
                              onClick={() => setExpanded(isOpen ? null : n.key)}
                            >
                              {isOpen ? '收起' : '展开关系'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {pageRows.length === 0 && (
                      <tr><td colSpan={8} style={{ color: '#6b7280' }}>没有匹配的 CI</td></tr>
                    )}
                  </tbody>
                </table>

                {expanded && (
                  <NodeRelations
                    nodeKey={expanded}
                    node={nodeByKey.get(expanded)}
                    outs={edgeIndex.out.get(expanded) ?? []}
                    ins={edgeIndex.inn.get(expanded) ?? []}
                    nodeByKey={nodeByKey}
                    isolated={isolatedSet.has(expanded)}
                  />
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 12 }}>
                  <button className="btn" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>上一页</button>
                  <span style={{ color: '#6b7280' }}>第 {page + 1} / {pageCount} 页</span>
                  <button className="btn" disabled={page >= pageCount - 1} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}>下一页</button>
                </div>
              </>
            )}

            {tab === 'roots' && (
              <>
                <div className="sec-t">网络轴根源聚合 <span className="badge">收敛到核心/出口的对象数</span></div>
                <table className="ltbl">
                  <thead><tr><th>根源设备</th><th>收敛对象数</th><th>占比</th></tr></thead>
                  <tbody>
                    {graph.networkRoots.map(r => (
                      <tr key={r.root}>
                        <td style={{ fontFamily: 'monospace' }}>{r.root}</td>
                        <td>{r.count}</td>
                        <td>{pct(r.count)}%</td>
                      </tr>
                    ))}
                    {graph.networkRoots.length === 0 && (
                      <tr><td colSpan={3} style={{ color: '#6b7280' }}>无网络轴数据</td></tr>
                    )}
                  </tbody>
                </table>
              </>
            )}

            {tab === 'isolated' && (
              <>
                <div className="sec-t">孤立对象 <span className="badge r">{stats.isolated} 项</span></div>
                <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                  这些 CI 在 CMDB 中既没有下级也没有上级，无法参与任何链路递归——多数是同步残渣、
                  未纳管设备或关联字段为空的机器。
                </p>
                <table className="ltbl">
                  <thead><tr><th>类型</th><th>名称</th><th>管理 IP</th><th>状态</th></tr></thead>
                  <tbody>
                    {graph.isolated.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map(k => {
                      const n = nodeByKey.get(k);
                      return (
                        <tr key={k}>
                          <td><span className="badge">{CLASS_LABEL[n?.class ?? ''] ?? n?.class ?? '—'}</span></td>
                          <td title={n?.name}>{n?.name ?? k}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{n?.ip ?? '—'}</td>
                          <td>{n?.status ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 12 }}>
                  <button className="btn" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>上一页</button>
                  <span style={{ color: '#6b7280' }}>
                    第 {page + 1} / {Math.max(1, Math.ceil(stats.isolated / PAGE_SIZE))} 页
                  </span>
                  <button
                    className="btn"
                    disabled={page >= Math.ceil(stats.isolated / PAGE_SIZE) - 1}
                    onClick={() => setPage(p => p + 1)}
                  >
                    下一页
                  </button>
                </div>
              </>
            )}

            {tab === 'matrix' && (
              <>
                <div className="sec-t">关系覆盖矩阵 <span className="badge">按对象类型统计</span></div>
                <table className="ltbl">
                  <thead>
                    <tr>
                      <th>对象类型</th>
                      <th>数量</th>
                      <th>有下级</th>
                      <th>网络轴</th>
                      <th>宿主轴</th>
                      <th>数据库</th>
                      <th>位置</th>
                      <th>孤立</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clsList.map(c => {
                      const sub = graph.nodes.filter(n => n.class === c);
                      const cnt = (f: (n: RelNode) => boolean) => sub.filter(f).length;
                      return (
                        <tr key={c}>
                          <td><span className="badge b">{CLASS_LABEL[c] ?? c}</span></td>
                          <td>{sub.length}</td>
                          <td>{cnt(n => n.children > 0)}</td>
                          <td>{cnt(n => n.axes.includes('network'))}</td>
                          <td>{cnt(n => n.axes.includes('host'))}</td>
                          <td>{cnt(n => n.axes.includes('db'))}</td>
                          <td>{cnt(n => n.axes.includes('rack'))}</td>
                          <td>{cnt(n => isolatedSet.has(n.key))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 单个 CI 的全量关系展开：上级（按三轴分组）+ 下级（按关系类型分组） */
function NodeRelations({
  nodeKey, node, outs, ins, nodeByKey, isolated,
}: {
  nodeKey: string;
  node?: RelNode;
  outs: RelEdge[];
  ins: RelEdge[];
  nodeByKey: Map<string, RelNode>;
  isolated: boolean;
}) {
  const group = (edges: RelEdge[]) => {
    const m = new Map<RelAxis, RelEdge[]>();
    for (const e of edges) {
      const arr = m.get(e.axis);
      if (arr) arr.push(e); else m.set(e.axis, [e]);
    }
    return m;
  };
  const parentGroups = group(outs);
  const childGroups = group(ins);
  const label = (k: string) => nodeByKey.get(k)?.name ?? k;

  return (
    <div style={{ marginTop: 14, padding: '14px 16px', background: '#fafbfc', borderRadius: 9, border: '1px solid #e5e7eb' }}>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>
        {node?.name ?? nodeKey}
        <span className="badge b" style={{ marginLeft: 8 }}>{CLASS_LABEL[node?.class ?? ''] ?? node?.class}</span>
        {node?.ip && <span className="badge" style={{ marginLeft: 6, fontFamily: 'monospace' }}>{node.ip}</span>}
        {isolated && <span className="badge r" style={{ marginLeft: 6 }}>孤立：无任何关系</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>上级（{outs.length}）</div>
          {outs.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af' }}>无上级关系</div>}
          {[...parentGroups.entries()].map(([axis, edges]) => (
            <div key={axis} style={{ marginBottom: 8 }}>
              <span className={`badge ${AXIS_BADGE[axis]}`}>{AXIS_LABEL[axis]}</span>
              {edges.map((e, i) => (
                <div key={i} style={{ fontSize: 12, padding: '3px 0 3px 8px', color: '#374151' }}>
                  → {label(e.to)} <span style={{ color: '#9ca3af' }}>（{e.relation}）</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>下级（{ins.length}）</div>
          {ins.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af' }}>无下级关系</div>}
          {[...childGroups.entries()].map(([axis, edges]) => (
            <div key={axis} style={{ marginBottom: 8 }}>
              <span className={`badge ${AXIS_BADGE[axis]}`}>{AXIS_LABEL[axis]}</span>
              {edges.map((e, i) => (
                <div key={i} style={{ fontSize: 12, padding: '3px 0 3px 8px', color: '#374151' }}>
                  ← {label(e.from)} <span style={{ color: '#9ca3af' }}>（{e.relation}）</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
