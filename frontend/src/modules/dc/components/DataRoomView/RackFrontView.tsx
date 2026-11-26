import { useEffect, useMemo, useState } from 'react';
import api from '../../../../lib/api';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import type { Rack3D, SlotInfo } from './types';
import type { DcScheme } from './theme';

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

/** iTop 类 → 中文展示名
 *  VmOs 是本地虚拟类（非 iTop 类）：-VM 后缀对象背后真正承载业务的「操作系统层」CI，
 *  iTop 里它同样存成 VirtualMachine，但语义是 OS，故单独命名以免与虚拟化层的虚拟机混淆。 */
const ciClassLabel: Record<string, string> = {
  Server: '物理服务器',
  VirtualMachine: '虚拟机',
  VmOs: '操作系统',
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
  scheme: DcScheme;
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

/** 设备类型 → 立面图配色；文字色按方案深浅动态取 */
const typeStyles: Record<string, { bg: string; bar: string; textDark: string; textLight: string; label: string }> = {
  server: { bg: 'bg-sky-600/40', bar: 'border-l-sky-400', textDark: '#e0f2fe', textLight: '#075985', label: '服务器' },
  vm_host: { bg: 'bg-cyan-600/40', bar: 'border-l-cyan-400', textDark: '#cffafe', textLight: '#0e7490', label: '虚拟化宿主' },
  network_device: { bg: 'bg-purple-600/40', bar: 'border-l-purple-400', textDark: '#f3e8ff', textLight: '#6b21a8', label: '网络设备' },
  pdu: { bg: 'bg-orange-600/40', bar: 'border-l-orange-400', textDark: '#ffedd5', textLight: '#9a3412', label: 'PDU' },
  ups: { bg: 'bg-orange-600/40', bar: 'border-l-orange-400', textDark: '#ffedd5', textLight: '#9a3412', label: 'UPS' },
  storage: { bg: 'bg-green-600/40', bar: 'border-l-green-400', textDark: '#dcfce7', textLight: '#166534', label: '存储' },
  other: { bg: 'bg-slate-600/40', bar: 'border-l-slate-400', textDark: '#f1f5f9', textLight: '#334155', label: '占位设备' },
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

/** 级联列状态：levels[0] = 选中设备；点击列内子节点向右追加下一列。
 *  展示约定（2026-11-25 定稿）：每列只展示"本列自身信息卡 + 子层级"，
 *  父层级只存在于左侧列（即之前的列），列内不再重复渲染父级行。 */
interface CascadeLevel {
  key: string;
  resp: CiChainResp | null;
  loading?: boolean;
  error?: string;
  /** 本列当前展开的节点键（class:name），用于高亮与收起判断 */
  activeKey?: string;
  /** 打开本列时点击的节点（idx>0 时即本列自身；resp 未返回前信息卡用它占位） */
  node?: CiChainNode;
}

export default function RackFrontView({ rack, slots, onClose, scheme }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SlotInfo | null>(null);
  // CI 关系级联列
  const [levels, setLevels] = useState<CascadeLevel[]>([]);
  const [ciLoading, setCiLoading] = useState(false);
  const [ciErr, setCiErr] = useState('');

  const totalU = rack.totalU || 42;
  const segments = useMemo(() => buildSegments(slots, totalU), [slots, totalU]);

  const q = query.trim().toLowerCase();
  const match = (s: SlotInfo) => !q || s.deviceName.toLowerCase().includes(q);

  const usagePercent = totalU > 0 ? Math.round((rack.usedU / totalU) * 100) : 0;

  // 选中设备变化 → 加载第 0 级关系（级联首列出现在弹窗右侧）
  useEffect(() => {
    if (!selected) { setLevels([]); setCiErr(''); return; }
    let cancelled = false;
    setCiLoading(true); setCiErr(''); setLevels([]);
    api
      .get('/dc/ci-chain', {
        params: { deviceId: selected.deviceId || '', deviceType: selected.deviceType, deviceName: selected.deviceName },
      })
      .then(({ data }) => {
        if (cancelled) return;
        const resp = unwrapCiResp(data);
        if (resp) setLevels([{ key: `L0:${resp.self?.class ?? ''}:${resp.self?.name ?? ''}`, resp }]);
        else setCiErr('未找到对应 CI 对象');
      })
      .catch((e: unknown) => {
        if (!cancelled) setCiErr(e instanceof Error ? e.message : 'CI 关系查询失败');
      })
      .finally(() => { if (!cancelled) setCiLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  /** 点击级联子节点：已展开 → 收起；否则加载并替换其右侧所有列（逐级下钻） */
  const openNode = async (levelIdx: number, node: CiChainNode) => {
    const key = `${node.class}:${node.name}`;
    const cur = levels[levelIdx];
    if (!cur.loading && cur.activeKey === key) {
      // 收起该分支：清除激活态并丢弃更深的列
      setLevels(levels.slice(0, levelIdx + 1).map((lv, i) => (i === levelIdx ? { ...lv, activeKey: undefined } : lv)));
      return;
    }
    const marked = levels.slice(0, levelIdx + 1).map((lv, i) => (i === levelIdx ? { ...lv, activeKey: key } : lv));
    setLevels([...marked, { key: `pending:${key}`, resp: null, loading: true, node }]);
    try {
      const { data } = await api.get('/dc/ci-chain', { params: { class: node.class, name: node.name } });
      const resp = unwrapCiResp(data);
      setLevels(prev => {
        const base = prev.slice(0, levelIdx + 1).map((lv, i) => (i === levelIdx ? { ...lv, activeKey: key } : lv));
        return resp
          ? [...base, { key, resp, node }]
          : [...base, { key, resp: null, error: '未找到对应 CI 对象', node }];
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'CI 关系查询失败';
      setLevels(prev => [
        ...prev.slice(0, levelIdx + 1).map((lv, i) => (i === levelIdx ? { ...lv, activeKey: key } : lv)),
        { key, resp: null, error: msg, node },
      ]);
    }
  };

  /** 机柜内设备的 U 位标记，如 U10 或 U10-U11 */
  const uPos = (s: SlotInfo) => `U${s.startU}${s.endU > s.startU ? `-U${s.endU}` : ''}`;

  /** 层级链（根机柜 → 本列自身，含端点），供「复制层级」与层链展示使用。
   *  机柜内设备（第 1 级）在后缀上标注所在 U 位：rack > 设备(U10-U11) > 下层 CI */
  const chainFor = (idx: number): string[] => {
    const chain = [rack.name];
    if (selected) chain.push(`${selected.deviceName}(${uPos(selected)})`);
    for (const lv of levels.slice(1, idx + 1)) {
      const n = lv.resp?.self?.name ?? lv.node?.name;
      if (n) chain.push(n);
    }
    return chain;
  };

  /** 设备类型 → 文字色（按方案深浅） */
  const typeText = (t: string) => {
    const st = typeStyles[t] || typeStyles.other;
    return scheme.dark ? st.textDark : st.textLight;
  };

  return (
    <div className="absolute left-4 top-1/2 -translate-y-1/2 z-30">
      {/* 主弹窗（级联列渲染在其右侧，因此外层不再裁剪溢出） */}
      <div
        className="w-[400px] max-h-[88vh] flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{ background: scheme.modalBg, border: `1px solid ${scheme.modalBorder}` }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: scheme.freeSegBg }}>
          <div>
            <h3 className="text-sm font-bold" style={{ color: scheme.text }}>{rack.name}</h3>
            <p className="text-[10px] mt-0.5" style={{ color: scheme.modalTextMuted }}>
              {rack.usedU}/{totalU}U · {usagePercent}% 已用 · {slots.length} 台设备
            </p>
          </div>
          <button onClick={onClose} className="transition-colors text-lg leading-none" style={{ color: scheme.modalTextMuted }}>✕</button>
        </div>

        {/* 占用进度条 */}
        <div className="px-4 pt-2 shrink-0">
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: scheme.barTrack }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${usagePercent}%`, background: usagePercent > 80 ? scheme.danger : usagePercent > 60 ? scheme.warn : scheme.accent }}
            />
          </div>
        </div>

        {/* 设备搜索 */}
        <div className="px-4 py-2 shrink-0">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索设备名定位 U 位…"
            className="w-full rounded-lg px-3 py-1.5 text-[12px] outline-none transition-colors"
            style={{
              background: scheme.inputBg,
              border: `1px solid ${scheme.surfaceBorder}`,
              color: scheme.text,
            }}
          />
        </div>

        {/* 立面图主体：U 标签列 + 分段 */}
        <div className="overflow-y-auto px-4 pb-2 flex-1 min-h-0">
          {slots.length === 0 ? (
            <p className="text-[11px] text-center py-8" style={{ color: scheme.modalTextMuted }}>该机柜暂无设备信息</p>
          ) : (
            <div className="flex">
              {/* U 位标尺（顶=U{totalU}，底=U1；高度与分段渲染一致） */}
              <div className="w-9 shrink-0 font-mono text-[10px] text-right pr-1.5 select-none" style={{ color: scheme.modalTextMuted }}>
                {segments.map((seg, i) => (
                  <div key={i} style={{ height: segHeight(seg) }} className="leading-none flex items-end justify-end pb-0.5">
                    U{seg.top}
                  </div>
                ))}
              </div>
              {/* 机柜体 */}
              <div className="flex-1 min-w-0 rounded overflow-hidden" style={{ border: `1px solid ${scheme.surfaceBorder}` }}>
                {segments.map((seg, i) => {
                  const h = segHeight(seg);
                  if (!seg.slot) {
                    return (
                      <div
                        key={i}
                        style={{ height: h, background: scheme.freeSegBg, borderBottom: `1px solid ${scheme.freeSegBg}` }}
                        className="flex items-center px-2"
                        title={`空闲 U${seg.bottom}-U${seg.top}（${seg.top - seg.bottom + 1}U，已压缩显示）`}
                      >
                        <span className="text-[9px] truncate" style={{ color: scheme.modalTextMuted }}>
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
                      onClick={() => { setSelected(sel ? null : s); }}
                      style={{
                        height: h,
                        color: typeText(s.deviceType),
                        borderBottom: `1px solid rgba(0,0,0,0.2)`,
                        borderLeftWidth: 2,
                        boxShadow: sel ? `0 0 0 1px ${scheme.accent}` : undefined,
                        opacity: dim ? 0.25 : 1,
                      }}
                      className={`flex items-center gap-2 px-2 cursor-pointer transition-all ${st.bg} ${st.bar} ${dim ? '' : 'hover:brightness-125'}`}
                      title={`U${s.startU}-U${s.endU} · ${s.deviceName}`}
                    >
                      <span className="text-[12px] font-medium truncate flex-1 min-w-0">{s.deviceName || '(未命名设备)'}</span>
                      <span className="text-[9px] font-mono shrink-0" style={{ color: scheme.modalTextMuted }}>
                        U{s.startU}{s.endU > s.startU ? `-${s.endU}` : ''}
                      </span>
                      <i className={`w-2 h-2 rounded-full shrink-0 ${statusDot[s.deviceStatus || 'unknown'] || 'bg-slate-500'}`} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 图例 */}
        <div className="px-4 py-2 border-t shrink-0 flex flex-wrap gap-x-3 gap-y-1" style={{ borderColor: scheme.freeSegBg }}>
          {(['server', 'network_device', 'storage', 'other'] as const).map(t => (
            <span key={t} className="flex items-center gap-1.5 text-[10px]" style={{ color: scheme.modalTextMuted }}>
              <i className={`w-2.5 h-2.5 rounded-sm ${typeStyles[t].bg} border-l-2 ${typeStyles[t].bar}`} />
              {typeStyles[t].label}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-[10px]" style={{ color: scheme.modalTextMuted }}>
            <i className="w-2.5 h-2.5 rounded-sm" style={{ background: scheme.freeSegBg, border: `1px dashed ${scheme.modalTextMuted}` }} />
            空闲 U（已压缩）
          </span>
        </div>

        {/* 选中设备详情 = 右侧第 0 列信息卡 */}
      </div>

      {/* CI 关系级联列：点击设备后所有次级信息只向右侧逐级展开；父层级只存在于左侧列 */}
      {selected && (
        <div className="absolute left-[412px] top-0 flex items-start gap-2 z-40">
          {/* 第 0 列：选中设备信息卡 + 其子层级 */}
          <CiColumn
            key="col-0"
            lv={levels[0] ?? { key: 'pending:selected', resp: null, loading: ciLoading, error: ciErr }}
            idx={0}
            selectedInfo={selected}
            hierarchy={chainFor(0)}
            onOpen={openNode}
            onCloseCol={() => setSelected(null)}
            scheme={scheme}
          />
          {levels.slice(1).map((lv, i) => (
            <CiColumn
              key={lv.key}
              lv={lv}
              idx={i + 1}
              hierarchy={chainFor(i + 1)}
              onOpen={openNode}
              onCloseCol={() => setLevels(prev => prev.slice(0, i + 1))}
              scheme={scheme}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 单个级联列：本列自身信息卡（显著高亮当前层级）+ 子层级行；点击行向右展开下一列。
 *  父层级不再在列内渲染——它就是左侧的列。 */
function CiColumn({
  lv, idx, selectedInfo, hierarchy, onOpen, onCloseCol, scheme,
}: {
  lv: CascadeLevel;
  idx: number;
  /** 仅第 0 列传入：选中设备本体 */
  selectedInfo?: SlotInfo;
  /** 根层级 → 本列自身的名称链（复制层级用） */
  hierarchy: string[];
  onOpen: (levelIdx: number, node: CiChainNode) => void;
  onCloseCol: () => void;
  scheme: DcScheme;
}) {
  const [copied, setCopied] = useState(false);
  const [copiedChain, setCopiedChain] = useState(false);
  const resp = lv.resp;
  const visibleChildren = resp ? resp.children : [];

  /** 本列自身节点信息：第 0 列 = 选中设备；深层列 = resp.self（未返回时用点击节点占位） */
  const selfName = idx === 0 ? selectedInfo?.deviceName : resp?.self?.name ?? lv.node?.name;
  const selfClass = idx === 0 ? 'Server' : resp?.self?.class ?? lv.node?.class ?? '';
  const selfStatus = idx === 0 ? selectedInfo?.deviceStatus : resp?.self?.status ?? lv.node?.status;
  const selfTypeLabel = idx === 0
    ? (typeStyles[selectedInfo?.deviceType ?? ''] || typeStyles.other).label
    : ciClassLabel[selfClass] || selfClass || 'CI 对象';

  const copyName = async () => {
    if (!selfName) return;
    const ok = await copyTextToClipboard(selfName);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  /** 复制根层级 → 本层层级的链路文本（如 LGY-2-6 > svr-MGMT-… > zydb81） */
  const copyChain = async () => {
    if (hierarchy.length === 0) return;
    const ok = await copyTextToClipboard(hierarchy.join(' > '));
    if (ok) {
      setCopiedChain(true);
      setTimeout(() => setCopiedChain(false), 1500);
    }
  };

  return (
    <div
      className="w-[230px] max-h-[80vh] flex flex-col rounded-xl shadow-2xl overflow-hidden"
      style={{ background: scheme.modalBg, border: `1px solid ${scheme.modalBorder}` }}
    >
      {/* 列头 */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0" style={{ borderColor: scheme.freeSegBg }}>
        <p className="text-[10px] tracking-wide" style={{ color: scheme.modalTextMuted }}>
          {idx === 0 ? '🔗 CI 关系' : `第 ${idx + 1} 级`}
          {resp?.source === 'local' && <span> · 本地</span>}
        </p>
        <button onClick={onCloseCol} className="transition-colors text-xs leading-none" style={{ color: scheme.modalTextMuted }} title={idx === 0 ? '关闭 CI 面板' : '收起此级'}>✕</button>
      </div>

      {/* 列体 */}
      <div className="overflow-y-auto py-1 flex-1 min-h-0">
        {/* 本列自身信息卡：显著展示当前层级（每列都有，替代旧的 self 行） */}
        {selfName && (
          <div
            className="mx-1.5 mt-1 mb-1 px-2 py-1.5 rounded"
            style={{ background: `rgba(${scheme.accentRgb},0.12)`, border: `1px solid rgba(${scheme.accentRgb},0.4)` }}
          >
            <div className="flex items-center gap-1.5">
              <i className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot[selfStatus || 'unknown'] || 'bg-slate-500'}`} />
              <span
                className="text-[9px] px-1 py-0.5 rounded shrink-0"
                style={{ background: `rgba(${scheme.accentRgb},0.12)`, border: `1px solid rgba(${scheme.accentRgb},0.25)`, color: scheme.accent }}
              >
                {selfTypeLabel}
              </span>
              <button
                onClick={copyName}
                className="ml-auto text-[9px] px-1.5 py-0.5 rounded transition-colors shrink-0"
                style={{ border: `1px solid rgba(${scheme.accentRgb},0.4)`, color: scheme.accent, background: 'transparent' }}
                title="复制当前设备名称"
              >
                {copied ? '已复制 ✓' : '复制名称'}
              </button>
            </div>
            <p className="text-[11px] font-semibold mt-1 leading-tight break-all" style={{ color: scheme.text }}>{selfName}</p>
            <div className="flex flex-wrap items-center gap-x-2 mt-0.5 text-[9px]" style={{ color: scheme.modalTextMuted }}>
              {idx === 0 && selectedInfo && (
                <>
                  <span className="font-mono" style={{ color: scheme.text }}>
                    U{selectedInfo.startU}{selectedInfo.endU > selectedInfo.startU ? `-U${selectedInfo.endU}` : ''}
                  </span>
                  {selectedInfo.cpuUsage != null && <span>CPU {selectedInfo.cpuUsage}%</span>}
                  {selectedInfo.memUsage != null && <span>内存 {selectedInfo.memUsage}%</span>}
                </>
              )}
              <button
                onClick={copyChain}
                className="ml-auto text-[9px] px-1.5 py-0.5 rounded transition-colors"
                style={{ border: `1px dashed rgba(${scheme.accentRgb},0.4)`, color: scheme.accent, background: 'transparent' }}
                title="复制从根层级（机柜）到当前层级的链路文本"
              >
                {copiedChain ? '已复制 ✓' : '复制层级'}
              </button>
            </div>
            {hierarchy.length > 1 && (
              <p className="text-[8px] mt-1 leading-tight break-all opacity-70" style={{ color: scheme.modalTextMuted }} title={hierarchy.join(' > ')}>
                {hierarchy.join(' > ')}
              </p>
            )}
          </div>
        )}
        {lv.loading && <p className="text-[10px] px-3 py-2" style={{ color: scheme.modalTextMuted }}>查询中…</p>}
        {lv.error && <p className="text-[10px] px-3 py-2" style={{ color: scheme.danger }}>✕ {lv.error}</p>}
        {resp && (
          <>
            {resp.degraded && <p className="text-[9px] px-3 py-1" style={{ color: scheme.warn }}>⚠ {resp.degraded}</p>}
            {visibleChildren.map((c, i) => {
              const key = `${c.class}:${c.name}`;
              return (
                <CiRow
                  key={`c-${i}`}
                  node={c}
                  active={lv.activeKey === key}
                  onClick={() => onOpen(idx, c)}
                  scheme={scheme}
                />
              );
            })}
            {visibleChildren.length === 0 && !lv.loading && (
              <p className="text-[10px] px-3 py-2" style={{ color: scheme.modalTextMuted }}>无下层 CI 对象</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 级联列中的子层级行：点击向右展开其邻接关系 */
function CiRow({ node, active, onClick, scheme }: { node: CiChainNode; active: boolean; onClick: () => void; scheme: DcScheme }) {
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition-colors"
      style={{ background: active ? `rgba(${scheme.accentRgb},0.15)` : undefined }}
      title={`${node.relation} · ${node.name}（点击${active ? '收起' : '展开'}）`}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = scheme.freeSegBg; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <span className="w-3 text-[9px] shrink-0 text-center" style={{ color: active ? scheme.accent : scheme.modalTextMuted }}>{active ? '▾' : '▸'}</span>
      <i className={`w-1.5 h-1.5 rounded-full shrink-0 ${ciStatusDot(node.status)}`} />
      <span
        className="text-[9px] px-1 py-0.5 rounded shrink-0"
        style={{ background: `rgba(${scheme.accentRgb},0.1)`, border: `1px solid rgba(${scheme.accentRgb},0.2)`, color: scheme.accent }}
      >
        {ciClassLabel[node.class] || node.class}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] truncate leading-tight" style={{ color: scheme.text }} title={node.name}>{node.name}</p>
        <p className="text-[9px] truncate leading-tight" style={{ color: scheme.modalTextMuted }}>{node.relation}{node.ip ? ` · ${node.ip}` : ''}</p>
      </div>
    </div>
  );
}
