import { useEffect, useMemo, useState } from 'react';
import api from '../../../../lib/api';
import type { Rack3D, SlotInfo } from './types';

/** CI 关系链节点（后端 /dc/ci-chain 返回） */
interface CiChainNode {
  class: string;
  name: string;
  relation: string;
  status?: string;
  ip?: string;
  extra?: string;
}

interface CiChainResp {
  self: { class: string; name: string; status?: string; ip?: string; extra?: string } | null;
  parents: CiChainNode[];
  children: CiChainNode[];
  source: 'itop' | 'local' | 'none';
  degraded?: string;
}

/**
 * 兼容两种响应形态：axios 拦截器已解包 { success, data } 信封时直接返回载荷，
 * 未解包（success 布尔存在）时取内层 data。
 */
function unwrapCiResp(data: unknown): CiChainResp | null {
  const d = data as { success?: boolean; data?: CiChainResp } | CiChainResp | undefined;
  if (d && typeof (d as { success?: boolean }).success === 'boolean') {
    return (d as { data?: CiChainResp }).data ?? null;
  }
  return (d as CiChainResp) ?? null;
}

/** iTop 类 → 中文展示名 */
const ciClassLabel: Record<string, string> = {
  Server: '物理服务器',
  VirtualMachine: '虚拟机',
  Hypervisor: '虚拟化宿主',
  DBServer: '数据库实例',
  NetworkDevice: '网络设备',
  StorageSystem: '存储系统',
  PDU: 'PDU',
  UPS: 'UPS',
  OsHost: '操作系统（Zabbix）',
  Rack: '机柜',
  Room: '机房',
  FunctionalCI: 'CI 对象',
};

/** iTop status 枚举 → 状态点颜色 */
function ciStatusDot(status?: string): string {
  if (!status) return 'bg-slate-600';
  if (status === 'obsolete' || status === 'offline') return 'bg-red-400';
  if (status === 'stock' || status === 'implementation') return 'bg-orange-400';
  return 'bg-green-400'; // production / active 等
}

interface Props {
  rack: Rack3D;
  slots: SlotInfo[];
  onClose: () => void;
}

/** 每个 U 位在立面图中的像素高度 */
const UH = 13;
/** 设备段最小高度（px）：保证 1U 设备也有足够可读的展示高度 */
const DEVICE_MIN_H = 30;
/** 空闲段固定压缩高度（px）：空闲不按 U 数等比拉伸，避免空闲区喧宾夺主 */
const FREE_H = 16;

/** 分段渲染高度：设备段 = max(U数×UH, 最小高度)，空闲段 = 固定压缩高度 */
function segHeight(seg: Segment): number {
  if (!seg.slot) return FREE_H;
  return Math.max((seg.top - seg.bottom + 1) * UH, DEVICE_MIN_H);
}

/** 设备类型 → 立面图配色（贴合 3D 页暗色主题） */
const typeStyles: Record<string, { bg: string; bar: string; text: string; label: string }> = {
  server: { bg: 'bg-sky-600/40', bar: 'border-l-sky-400', text: 'text-sky-100', label: '服务器' },
  vm_host: { bg: 'bg-cyan-600/40', bar: 'border-l-cyan-400', text: 'text-cyan-100', label: '虚拟化宿主' },
  network_device: { bg: 'bg-purple-600/40', bar: 'border-l-purple-400', text: 'text-purple-100', label: '网络设备' },
  pdu: { bg: 'bg-orange-600/40', bar: 'border-l-orange-400', text: 'text-orange-100', label: 'PDU' },
  ups: { bg: 'bg-orange-600/40', bar: 'border-l-orange-400', text: 'text-orange-100', label: 'UPS' },
  storage: { bg: 'bg-green-600/40', bar: 'border-l-green-400', text: 'text-green-100', label: '存储' },
  other: { bg: 'bg-slate-600/40', bar: 'border-l-slate-400', text: 'text-slate-200', label: '占位设备' },
};

const statusDot: Record<string, string> = {
  online: 'bg-green-400',
  offline: 'bg-red-400',
  warning: 'bg-orange-400',
  unknown: 'bg-slate-500',
};

/** 立面图分段：设备段（按真实 U 位绝对定位）与空闲段交替，自顶向下 */
interface Segment {
  top: number;
  bottom: number;
  slot?: SlotInfo;
}

function buildSegments(slots: SlotInfo[], totalU: number): Segment[] {
  const valid = slots.filter(s => s.startU >= 1 && s.startU <= totalU);
  const sorted = [...valid].sort((a, b) => b.startU - a.startU); // 自顶向下
  const segs: Segment[] = [];
  let pos = totalU; // 下一个分段的上边界（含）
  for (const s of sorted) {
    const top = Math.min(s.endU, pos);
    if (top < pos) segs.push({ top: pos, bottom: top + 1 });
    const bottom = Math.min(s.startU, top);
    segs.push({ top, bottom, slot: s });
    pos = bottom - 1;
  }
  if (pos >= 1) segs.push({ top: pos, bottom: 1 });
  return segs;
}

export default function RackFrontView({ rack, slots, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SlotInfo | null>(null);
  const [copied, setCopied] = useState(false);
  // CI 关系链（点击设备 → 二级清单展示上层/下层对象，节点可递归展开）
  const [ciChain, setCiChain] = useState<CiChainResp | null>(null);
  const [ciLoading, setCiLoading] = useState(false);
  const [ciErr, setCiErr] = useState('');

  const totalU = rack.totalU || 42;
  const segments = useMemo(() => buildSegments(slots, totalU), [slots, totalU]);

  const q = query.trim().toLowerCase();
  const match = (s: SlotInfo) => !q || s.deviceName.toLowerCase().includes(q);

  const usagePercent = totalU > 0 ? Math.round((rack.usedU / totalU) * 100) : 0;

  // 选中设备变化 → 加载该设备的 CI 关系（首次：deviceId/deviceType/deviceName 解析；展开层走 class+name）
  useEffect(() => {
    if (!selected) { setCiChain(null); setCiErr(''); return; }
    let cancelled = false;
    setCiLoading(true); setCiErr(''); setCiChain(null);
    api
      .get('/dc/ci-chain', {
        params: { deviceId: selected.deviceId || '', deviceType: selected.deviceType, deviceName: selected.deviceName },
      })
      .then(({ data }) => {
        if (cancelled) return;
        const resp = unwrapCiResp(data);
        if (resp) setCiChain(resp);
        else setCiErr('CI 关系查询失败');
      })
      .catch((e: unknown) => {
        if (!cancelled) setCiErr(e instanceof Error ? e.message : 'CI 关系查询失败');
      })
      .finally(() => { if (!cancelled) setCiLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  const copyName = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.deviceName);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 剪贴板不可用时静默 */ }
  };

  return (
    <div className="absolute left-4 top-1/2 -translate-y-1/2 z-30 w-[400px] max-h-[88vh] flex flex-col bg-[#0a1420]/95 backdrop-blur-xl border border-cyan-500/20 rounded-xl shadow-2xl shadow-cyan-500/5 overflow-hidden transition-all duration-300">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700/30 shrink-0">
        <div>
          <h3 className="text-sm font-bold text-white">{rack.name}</h3>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {rack.usedU}/{totalU}U · {usagePercent}% 已用 · {slots.length} 台设备
          </p>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors text-lg leading-none">✕</button>
      </div>

      {/* 占用进度条 */}
      <div className="px-4 pt-2 shrink-0">
        <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${usagePercent > 80 ? 'bg-orange-500' : usagePercent > 60 ? 'bg-yellow-500' : 'bg-cyan-500'}`}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
      </div>

      {/* 设备搜索 */}
      <div className="px-4 py-2 shrink-0">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索设备名定位 U 位…"
          className="w-full bg-white/5 border border-gray-700/40 rounded-lg px-3 py-1.5 text-[12px] text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40 transition-colors"
        />
      </div>

      {/* 立面图主体：U 标签列 + 分段 */}
      <div className="overflow-y-auto px-4 pb-2 flex-1 min-h-0">
        {slots.length === 0 ? (
          <p className="text-[11px] text-slate-600 text-center py-8">该机柜暂无设备信息</p>
        ) : (
          <div className="flex">
            {/* U 位标尺（顶=U{totalU}，底=U1；高度与分段渲染一致） */}
            <div className="w-9 shrink-0 font-mono text-[10px] text-slate-600 text-right pr-1.5 select-none">
              {segments.map((seg, i) => (
                <div key={i} style={{ height: segHeight(seg) }} className="leading-none flex items-end justify-end pb-0.5">
                  U{seg.top}
                </div>
              ))}
            </div>
            {/* 机柜体 */}
            <div className="flex-1 min-w-0 border border-slate-600/40 rounded overflow-hidden">
              {segments.map((seg, i) => {
                const h = segHeight(seg);
                if (!seg.slot) {
                  return (
                    <div
                      key={i}
                      style={{ height: h }}
                      className="flex items-center px-2 bg-white/[0.03] border-b border-slate-700/30 last:border-b-0"
                      title={`空闲 U${seg.bottom}-U${seg.top}（${seg.top - seg.bottom + 1}U，已压缩显示）`}
                    >
                      <span className="text-[9px] text-slate-600 truncate">
                        {seg.top - seg.bottom + 1 > 1 ? `空闲 U${seg.bottom}-${seg.top}` : '空闲'}
                      </span>
                    </div>
                  );
                }
                const s = seg.slot;
                const st = typeStyles[s.deviceType] || typeStyles.other;
                const dim = !match(s);
                const sel = selected?.id === s.id;
                return (
                  <div
                    key={i}
                    onClick={() => { setSelected(sel ? null : s); setCopied(false); }}
                    style={{ height: h }}
                    className={`flex items-center gap-2 px-2 border-b border-black/20 last:border-b-0 border-l-2 cursor-pointer transition-all ${st.bg} ${st.bar} ${sel ? 'ring-1 ring-cyan-400/70' : ''} ${dim ? 'opacity-25' : 'hover:brightness-125'}`}
                    title={`U${s.startU}-U${s.endU} · ${s.deviceName}`}
                  >
                    <span className={`text-[12px] font-medium truncate flex-1 min-w-0 ${st.text}`}>{s.deviceName || '(未命名设备)'}</span>
                    <span className="text-[9px] font-mono text-slate-400/70 shrink-0">U{s.startU}{s.endU > s.startU ? `-${s.endU}` : ''}</span>
                    <i className={`w-2 h-2 rounded-full shrink-0 ${statusDot[s.deviceStatus || 'unknown'] || 'bg-slate-500'}`} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 图例 */}
      <div className="px-4 py-2 border-t border-gray-700/30 shrink-0 flex flex-wrap gap-x-3 gap-y-1">
        {(['server', 'network_device', 'storage', 'other'] as const).map(t => (
          <span key={t} className="flex items-center gap-1.5 text-[10px] text-slate-500">
            <i className={`w-2.5 h-2.5 rounded-sm ${typeStyles[t].bg} border-l-2 ${typeStyles[t].bar}`} />
            {typeStyles[t].label}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <i className="w-2.5 h-2.5 rounded-sm bg-white/[0.06] border border-dashed border-slate-600" />
          空闲 U（已压缩）
        </span>
      </div>

      {/* 选中设备详情 + CI 关系层级 */}
      {selected && (
        <div className="px-4 py-3 border-t border-cyan-500/30 bg-cyan-500/5 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12px] font-semibold text-white truncate flex-1 min-w-0">{selected.deviceName}</p>
            <button
              onClick={copyName}
              className="text-[10px] px-2 py-1 rounded border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 transition-colors shrink-0"
            >
              {copied ? '已复制 ✓' : '复制名称'}
            </button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 text-[11px] text-slate-400">
            <span>U 位：<span className="text-slate-200 font-mono">U{selected.startU}-U{selected.endU}</span>（{selected.endU - selected.startU + 1}U）</span>
            <span>类型：<span className="text-slate-200">{(typeStyles[selected.deviceType] || typeStyles.other).label}</span></span>
            <span>状态：<span className="text-slate-200">{selected.deviceStatus || 'unknown'}</span></span>
            {selected.cpuUsage != null && <span>CPU：<span className="text-slate-200">{selected.cpuUsage}%</span></span>}
            {selected.memUsage != null && <span>内存：<span className="text-slate-200">{selected.memUsage}%</span></span>}
          </div>

          {/* CI 关系层级树：↑=上层对象（OS→硬件 / VM→宿主），↓=下层对象（硬件→OS/VM/DB），点击节点递归展开 */}
          <div className="mt-2 pt-2 border-t border-slate-700/30 max-h-[210px] overflow-y-auto">
            <p className="text-[10px] text-slate-500 mb-1">🔗 CI 关系 · 点击节点逐级展开</p>
            {ciLoading && <p className="text-[10px] text-slate-500 py-1">查询 CI 关系中…</p>}
            {ciErr && <p className="text-[10px] text-red-400/80 py-1">✕ {ciErr}</p>}
            {ciChain && ciChain.source === 'none' && (
              <p className="text-[10px] text-orange-400/70 py-1">⚠ {ciChain.degraded || '未找到对应 CI 对象'}</p>
            )}
            {ciChain && ciChain.self && (
              <CiTreeNode
                node={{
                  class: ciChain.self.class,
                  name: ciChain.self.name,
                  relation: '当前设备',
                  status: ciChain.self.status,
                  ip: ciChain.self.ip,
                  extra: ciChain.self.extra,
                }}
                depth={0}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 单行 CI 节点：可展开查邻接关系（递归多级别层次展开） */
function CiTreeNode({ node, depth }: { node: CiChainNode; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [chain, setChain] = useState<CiChainResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const toggle = async () => {
    if (expanded) { setExpanded(false); return; }
    if (chain || err) { setExpanded(true); return; }
    setLoading(true);
    setErr('');
    try {
      const { data } = await api.get('/dc/ci-chain', { params: { class: node.class, name: node.name } });
      const resp = unwrapCiResp(data);
      if (!resp) throw new Error('查询失败');
      setChain(resp);
      setExpanded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'CI 关系查询失败');
    } finally {
      setLoading(false);
    }
  };

  const hasRelations = true; // 每个节点都可能带父/子关系，统一给展开箭头
  const label = ciClassLabel[node.class] || node.class;

  return (
    <div style={{ marginLeft: depth > 0 ? 14 : 0 }}>
      <div
        className="flex items-center gap-1.5 py-1 cursor-pointer group rounded px-1 -mx-1 hover:bg-white/5 transition-colors"
        onClick={toggle}
      >
        <span className={`w-3 text-[9px] text-slate-500 shrink-0 text-center ${hasRelations ? 'group-hover:text-cyan-400' : ''}`}>
          {loading ? '…' : expanded ? '▾' : '▸'}
        </span>
        <i className={`w-1.5 h-1.5 rounded-full shrink-0 ${ciStatusDot(node.status)}`} />
        <span className="text-[9px] px-1 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-cyan-300/80 shrink-0">
          {label}
        </span>
        <span className="text-[11px] text-slate-200 truncate flex-1 min-w-0" title={node.name}>{node.name}</span>
        <span className="text-[9px] text-slate-500 shrink-0">{node.relation}</span>
      </div>
      {err && <p className="text-[10px] text-red-400/80 ml-4 py-0.5">{err}</p>}
      {expanded && chain && (
        <div className="ml-3 border-l border-slate-700/40 pl-1">
          {chain.degraded && (
            <p className="text-[9px] text-orange-400/70 py-0.5">⚠ {chain.degraded}</p>
          )}
          {chain.parents.length === 0 && chain.children.length === 0 && (
            <p className="text-[10px] text-slate-600 py-0.5 ml-3">无关联 CI 对象</p>
          )}
          {chain.parents.map((p, i) => (
            <CiTreeNode key={`p-${i}`} node={{ ...p, relation: `↑ ${p.relation}` }} depth={depth + 1} />
          ))}
          {chain.children.map((c, i) => (
            <CiTreeNode key={`c-${i}`} node={{ ...c, relation: `↓ ${c.relation}` }} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
