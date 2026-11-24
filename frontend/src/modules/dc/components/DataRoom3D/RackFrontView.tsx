import { useMemo, useState } from 'react';
import type { Rack3D, SlotInfo } from './types';

interface Props {
  rack: Rack3D;
  slots: SlotInfo[];
  onClose: () => void;
}

/** 每个 U 位在立面图中的像素高度 */
const UH = 13;

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

  const totalU = rack.totalU || 42;
  const segments = useMemo(() => buildSegments(slots, totalU), [slots, totalU]);

  const q = query.trim().toLowerCase();
  const match = (s: SlotInfo) => !q || s.deviceName.toLowerCase().includes(q);

  const usagePercent = totalU > 0 ? Math.round((rack.usedU / totalU) * 100) : 0;

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
            {/* U 位标尺（顶=U{totalU}，底=U1） */}
            <div className="w-9 shrink-0 font-mono text-[10px] text-slate-600 text-right pr-1.5 select-none">
              {segments.map((seg, i) => (
                <div key={i} style={{ height: (seg.top - seg.bottom + 1) * UH }} className="leading-none flex items-end justify-end pb-0.5">
                  U{seg.top}
                </div>
              ))}
            </div>
            {/* 机柜体 */}
            <div className="flex-1 min-w-0 border border-slate-600/40 rounded overflow-hidden">
              {segments.map((seg, i) => {
                const h = (seg.top - seg.bottom + 1) * UH;
                if (!seg.slot) {
                  return (
                    <div
                      key={i}
                      style={{ height: h }}
                      className="flex items-center px-2 bg-white/[0.03] border-b border-slate-700/30 last:border-b-0"
                    >
                      <span className="text-[10px] text-slate-600">空闲</span>
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
                    <span className={`text-[11px] truncate flex-1 min-w-0 ${st.text}`}>{s.deviceName || '(未命名设备)'}</span>
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
          空闲 U
        </span>
      </div>

      {/* 选中设备详情 */}
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
        </div>
      )}
    </div>
  );
}
