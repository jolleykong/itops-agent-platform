/**
 * CMDB 看板 — 多维度 CI 关系拓扑（2026-11-28 实装）
 *
 * 数据源：/dc/ci-relations（后端从 iTop 全量建图；网络邻接读 CMDB 的
 * lnkConnectableCIToNetworkDevice，由 cipipe netadj 治理后写入）。
 *
 * 视图：
 *   · 多维度拓扑（默认）：以 CI 为中心的径向辐射，六条关系轴同时在场
 *   · 概览统计：规模、覆盖、关联质量与数据缺口
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../../lib/api';
import CiRelationExplorer from '../components/CiRelationExplorer';

type RelAxis = 'host' | 'storage' | 'network' | 'db' | 'rack' | 'os';

interface RelNode {
  key: string;
  id?: number;
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

interface RelGraph {
  generatedAt: string;
  stats: {
    totalRaw: number; total: number; osNodes: number; dupCount: number;
    isolated: number; byAxis: Record<string, number>; byClass: Record<string, number>;
    idJoin: number; nameFallback: number; multiSourceHosts: number;
  };
  nodes: RelNode[];
  edges: RelEdge[];
  isolated: string[];
  gaps: string[];
}

const CLASS_LABEL: Record<string, string> = {
  Server: '物理服务器', VirtualMachine: '虚拟机', Hypervisor: '虚拟化宿主',
  DBServer: '数据库实例', NetworkDevice: '网络设备', StorageSystem: '存储系统',
  Rack: '机柜', OsHost: '操作系统', PDU: 'PDU', UPS: 'UPS',
};

const AXIS_LABEL: Record<string, string> = {
  host: '宿主轴', network: '网络轴', storage: '存储轴',
  db: '数据库', rack: '位置', os: '运行层',
};

type Tab = 'topology' | 'overview';

export default function CmdbTopology() {
  const [graph, setGraph] = useState<RelGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('topology');

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/dc/ci-relations', { params: force ? { refresh: 1 } : {} });
      const data = (res as unknown as { data?: RelGraph }).data ?? (res as unknown as RelGraph);
      setGraph(data ?? null);
    } catch (err) {
      setError((err as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const clsList = useMemo(() => {
    const m = graph?.stats.byClass ?? {};
    return Object.keys(m).sort((a, b) => (m[b] ?? 0) - (m[a] ?? 0));
  }, [graph]);

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-text-primary mb-2">CMDB看板</h1>
        <p className="text-text-secondary text-sm">正在从 iTop 构建全量 CI 关系图…（首次约 5–8 秒）</p>
      </div>
    );
  }

  if (error || !graph) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-text-primary mb-2">CMDB看板</h1>
        <p className="text-red-500 text-sm mb-3">加载失败：{error ?? '无数据'}</p>
        <button className="px-3 py-1.5 text-sm rounded border border-border" onClick={() => void load(true)}>重试</button>
      </div>
    );
  }

  const s = graph.stats;
  const quality = s.idJoin + s.nameFallback > 0
    ? Math.round((s.idJoin / (s.idJoin + s.nameFallback)) * 100)
    : 100;

  return (
    <div className="p-5 max-w-[1800px] mx-auto">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary mb-1">CMDB看板</h1>
          <p className="text-[12.5px] text-text-secondary">
            多维度 CI 关系拓扑 · 全量 {s.total.toLocaleString()} 项 CI /{' '}
            {graph.edges.length.toLocaleString()} 条关系
            {s.osNodes > 0 && ` · OS 层另计 ${s.osNodes}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`px-3 py-1.5 text-[12.5px] rounded border ${tab === 'topology' ? 'border-cyan-500 text-cyan-600 bg-cyan-500/5' : 'border-border text-text-secondary'}`}
            onClick={() => setTab('topology')}
          >
            多维度拓扑
          </button>
          <button
            className={`px-3 py-1.5 text-[12.5px] rounded border ${tab === 'overview' ? 'border-cyan-500 text-cyan-600 bg-cyan-500/5' : 'border-border text-text-secondary'}`}
            onClick={() => setTab('overview')}
          >
            概览统计
          </button>
          <button className="px-3 py-1.5 text-[12.5px] rounded border border-border" onClick={() => void load(true)}>
            重新构建
          </button>
        </div>
      </div>

      {tab === 'topology' && (
        <>
          <div className="mb-3 rounded-lg border border-dashed border-cyan-500/30 bg-cyan-500/5 px-3 py-2 text-[11.5px] text-text-secondary leading-relaxed">
            <b>树状展开</b>：中心 CI 在左，六条关系轴（宿主 / 网络 / 存储 / 数据库 / 位置 / 运行层）
            按层向右生长，同轴相邻、连线正交不交叉。单击节点看右侧<b>平级列表</b>（含被树折叠的全部关系），
            双击把它挪到中心重新展开。网络邻接读自 CMDB（cipipe 治理后写入 iTop）。
          </div>
          <CiRelationExplorer nodes={graph.nodes} edges={graph.edges} />
        </>
      )}

      {tab === 'overview' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[
              { l: '真实 CI 总数', v: s.total.toLocaleString(), sub: `iTop 原始 ${s.totalRaw.toLocaleString()}` },
              { l: '剩余墓碑残渣', v: s.dupCount.toLocaleString(), sub: '__DUP_* 待清（治理后应归零）', warn: s.dupCount > 0 },
              { l: '孤立对象', v: s.isolated.toLocaleString(), sub: '无任何上下级关系', warn: s.isolated > 0 },
              { l: '关联质量', v: `${quality}%`, sub: `数字外键 ${s.idJoin} 条${s.nameFallback ? ` · 降级 ${s.nameFallback}` : ''}` },
            ].map(c => (
              <div key={c.l} className="rounded-lg bg-surface border border-border p-3">
                <div className="text-[11.5px] text-text-secondary">{c.l}</div>
                <div className={`text-2xl font-semibold mt-1 ${c.warn ? 'text-amber-600' : 'text-text-primary'}`}>{c.v}</div>
                <div className="text-[11px] text-text-secondary mt-1">{c.sub}</div>
              </div>
            ))}
          </div>

          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div className="rounded-lg bg-surface border border-border p-4">
              <h3 className="text-[13px] font-semibold mb-3">关系轴覆盖</h3>
              <table className="w-full text-[12.5px]">
                <tbody>
                  {Object.entries(AXIS_LABEL).map(([k, label]) => {
                    const v = s.byAxis[k] ?? 0;
                    const pct = s.total ? Math.round((v / s.total) * 100) : 0;
                    return (
                      <tr key={k}>
                        <td className="py-1 text-text-secondary w-20">{label}</td>
                        <td className="py-1">
                          <div className="h-1.5 rounded bg-border/40 overflow-hidden">
                            <div className="h-full rounded bg-cyan-500" style={{ width: `${pct}%` }} />
                          </div>
                        </td>
                        <td className="py-1 text-right w-24 text-text-secondary">{v}（{pct}%）</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="rounded-lg bg-surface border border-border p-4">
              <h3 className="text-[13px] font-semibold mb-3">对象类型分布</h3>
              <table className="w-full text-[12.5px]">
                <tbody>
                  {clsList.map(c => (
                    <tr key={c}>
                      <td className="py-1 text-text-secondary">{CLASS_LABEL[c] ?? c}</td>
                      <td className="py-1 text-right">{s.byClass[c]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {graph.gaps.length > 0 && (
            <div className="rounded-lg border border-amber-300/50 bg-amber-50 dark:bg-amber-500/5 px-3 py-2.5">
              <div className="text-[12.5px] font-semibold text-amber-700 dark:text-amber-500 mb-1.5">数据缺口与说明</div>
              {graph.gaps.map((g, i) => (
                <div key={i} className="text-[11.5px] text-amber-700/90 dark:text-amber-500/90 leading-relaxed">· {g}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
