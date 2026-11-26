/**
 * 同步日志表格组件(从 ITopSyncSettings 拆出,避免主文件超 500 行)
 *
 * 2026-11-26 改版：详情列不再 `truncate` 成一句话。
 * 原来的 `max-w-xs truncate` 会把 iTop 报错、SQL 冲突、字段校验等真实原因整段切掉，
 * 界面上只剩「同步完成，但有 N 个错误」这种总结，根本无法排查。
 * 现在：默认单行省略（保持表格紧凑），点击行/「展开」看完整文本（保留换行、可全选），
 * 并提供一键复制；顶部可切「仅看失败」，便于直接定位。
 */
import { useMemo, useState } from 'react';
import { CheckCircle2, AlertCircle, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import clsx from 'clsx';

export interface SyncLog {
  id: string;
  timestamp: string;
  direction: string;
  ci_type: string;
  action: string;
  itop_id: string | null;
  itop_class?: string | null;
  platform_table: string | null;
  success: number;
  message: string | null;
  details?: string | null;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-text-tertiary hover:text-text-primary hover:bg-background transition-colors"
      title="复制完整内容"
    >
      {copied ? <Check className="w-3 h-3 text-status-success" /> : <Copy className="w-3 h-3" />}
      {copied ? '已复制' : '复制'}
    </button>
  );
}

/** 完整错误文本块：保留换行与缩进，等宽字体，可横向滚动 */
function FullText({ text }: { text: string }) {
  return (
    <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-text-secondary bg-background border border-border rounded p-2 max-h-64 overflow-auto">
      {text}
    </pre>
  );
}

export default function SyncLogTable({ logs }: { logs: SyncLog[] | undefined }) {
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const list = logs ?? [];
    return onlyFailed ? list.filter((l) => !l.success) : list;
  }, [logs, onlyFailed]);

  const failCount = useMemo(() => (logs ?? []).filter((l) => !l.success).length, [logs]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const expandAll = () => setExpanded(new Set(rows.map((r) => r.id)));
  const collapseAll = () => setExpanded(new Set());

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-text-primary">
          最近同步日志
          <span className="ml-2 font-normal text-text-tertiary">
            共 {logs?.length ?? 0} 条{failCount > 0 ? `，失败 ${failCount} 条` : ''}
          </span>
        </h4>
        <div className="flex items-center gap-3 text-xs">
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-text-secondary">
            <input
              type="checkbox"
              checked={onlyFailed}
              onChange={(e) => setOnlyFailed(e.target.checked)}
              className="accent-current"
            />
            仅看失败
          </label>
          <button
            type="button"
            onClick={expandAll}
            className="text-text-tertiary hover:text-text-primary"
          >
            全部展开
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="text-text-tertiary hover:text-text-primary"
          >
            收起
          </button>
        </div>
      </div>
      <div className="max-h-[520px] overflow-auto">
        {rows.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-text-tertiary">
            {onlyFailed ? '没有失败的同步记录' : '暂无日志'}
          </div>
        ) : (
          <table className="w-full text-xs table-fixed">
            <thead className="bg-background text-text-tertiary sticky top-0 z-10">
              <tr>
                <th className="text-left px-3 py-2 font-medium w-[150px]">时间</th>
                <th className="text-left px-3 py-2 font-medium w-[110px]">类型</th>
                <th className="text-left px-3 py-2 font-medium w-[70px]">操作</th>
                <th className="text-left px-3 py-2 font-medium w-[50px]">结果</th>
                <th className="text-left px-3 py-2 font-medium">详情</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((log) => {
                const text = [log.message, log.details].filter(Boolean).join('\n\n') || '';
                const isOpen = expanded.has(log.id);
                return (
                  <tr
                    key={log.id}
                    className={clsx(
                      'align-top cursor-pointer',
                      log.success ? 'hover:bg-background' : 'bg-status-failed/5 hover:bg-status-failed/10',
                    )}
                    onClick={() => toggle(log.id)}
                  >
                    <td className="px-3 py-2 text-text-secondary whitespace-nowrap font-mono">
                      {new Date(log.timestamp).toLocaleString('zh-CN')}
                    </td>
                    <td className="px-3 py-2 text-text-secondary break-all">{log.ci_type}</td>
                    <td className="px-3 py-2">
                      <span
                        className={clsx(
                          'inline-block px-1.5 py-0.5 rounded text-xs font-medium',
                          log.action === 'create'
                            ? 'bg-status-success/10 text-status-success'
                            : log.action === 'update'
                              ? 'bg-primary/10 text-primary'
                              : log.action === 'error'
                                ? 'bg-status-failed/10 text-status-failed'
                                : 'bg-background text-text-tertiary',
                        )}
                      >
                        {log.action}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {log.success ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-status-success" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 text-status-failed" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      <div className="flex items-start gap-1.5">
                        <span className="mt-0.5 text-text-tertiary shrink-0">
                          {isOpen ? (
                            <ChevronDown className="w-3 h-3" />
                          ) : (
                            <ChevronRight className="w-3 h-3" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          {isOpen ? (
                            <>
                              {text ? (
                                <FullText text={text} />
                              ) : (
                                <span className="text-text-tertiary">(空)</span>
                              )}
                              <div className="mt-1 flex items-center gap-2">
                                <CopyButton text={text || `${log.ci_type} ${log.action}`} />
                                {log.platform_table && (
                                  <span className="text-text-tertiary">表: {log.platform_table}</span>
                                )}
                                {log.itop_id && (
                                  <span className="text-text-tertiary">iTop: {log.itop_id}</span>
                                )}
                              </div>
                            </>
                          ) : (
                            <span
                              className={clsx(
                                'block truncate',
                                !log.success && 'text-status-failed',
                              )}
                              title={text}
                            >
                              {text || `${log.platform_table ?? ''}` || '(空)'}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
