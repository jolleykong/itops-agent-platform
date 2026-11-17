import { useEffect, useState } from 'react';
import { Terminal, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { CommandResult, Server } from './types';
import { SshKeyPicker } from './SshKeyPicker';

interface CommandSectionProps {
  selectedServer: Server | null;
  command: string;
  onCommandChange: (v: string) => void;
  commandResult: CommandResult | null;
  onClearResult: () => void;
  isExecuting: boolean;
  onExecute: (payload?: { ssh_key_id?: string; persist_ssh_key?: boolean }) => void;
}

export function CommandSection({
  selectedServer,
  command,
  onCommandChange,
  commandResult,
  onClearResult,
  isExecuting,
  onExecute,
}: CommandSectionProps) {
  // 按需 SSH 的凭据选择状态（切换服务器时重置/预选已持久化凭据）
  const isZabbixChannel =
    !!selectedServer && (selectedServer.conn_type === 'zabbix' || selectedServer.conn_type === 'zabbix_agent');
  const [sshKeyId, setSshKeyId] = useState(selectedServer?.ssh_key_id || '');
  const [persistKey, setPersistKey] = useState(false);
  useEffect(() => {
    setSshKeyId(selectedServer?.ssh_key_id || '');
    setPersistKey(false);
  }, [selectedServer?.id, selectedServer?.ssh_key_id]);

  if (!selectedServer) return null;

  return (
    <>
      {/* Zabbix 通道按需 SSH：说明 + 凭据选择 */}
      {isZabbixChannel && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-3">
          <div className="flex items-start gap-3">
            <span className="text-amber-400 text-lg leading-none mt-0.5">⚠️</span>
            <div className="text-sm">
              <p className="text-amber-300 font-medium">
                该服务器为 {selectedServer.conn_type === 'zabbix' ? 'Zabbix API' : 'Zabbix Agent 直连'}监控通道
              </p>
              <p className="text-text-secondary mt-1 text-xs">
                常规监控为只读。如需执行命令，请在下方选择已配置的 SSH 凭据，本次执行将通过该凭据临时 SSH 到目标机。
              </p>
            </div>
          </div>
          <div className="pl-8">
            <SshKeyPicker
              value={sshKeyId}
              onChange={setSshKeyId}
              persist={persistKey}
              onPersistChange={setPersistKey}
              persistedKeyId={selectedServer.ssh_key_id}
            />
          </div>
        </div>
      )}

      {/* 命令执行结果 */}
      {commandResult && (
        <div className="bg-surface border border-border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-text-primary">命令执行结果</h3>
            <button onClick={onClearResult} className="p-1 hover:bg-background rounded transition-colors">
              <Trash2 className="w-4 h-4 text-text-secondary" />
            </button>
          </div>
          <div className="space-y-4">
            <div>
              <p className="text-xs text-text-secondary mb-1">执行的命令:</p>
              <code className="font-mono text-sm bg-background px-2 py-1 rounded text-text-primary">
                {commandResult.command}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">状态:</span>
              <span
                className={clsx(
                  'px-2 py-1 rounded text-xs font-medium',
                  commandResult.success
                    ? 'bg-status-success/10 text-status-success'
                    : 'bg-status-failed/10 text-status-failed',
                )}
              >
                {commandResult.success ? '成功' : '失败'}
              </span>
              <span className="text-xs text-text-secondary ml-4">耗时: {commandResult.duration}ms</span>
            </div>
            {commandResult.stdout && (
              <div>
                <p className="text-xs text-text-secondary mb-1">输出:</p>
                <pre className="bg-background p-3 rounded text-xs overflow-x-auto text-text-primary font-mono max-h-96 overflow-y-auto">
                  {commandResult.stdout}
                </pre>
              </div>
            )}
            {commandResult.stderr && (
              <div>
                <p className="text-xs text-status-warning mb-1">错误:</p>
                <pre className="bg-status-failed/5 p-3 rounded text-xs overflow-x-auto text-status-failed font-mono max-h-96 overflow-y-auto">
                  {commandResult.stderr}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 快速命令执行区域 */}
      <div className="bg-surface border border-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-text-primary mb-4">
          在 {selectedServer.name} 上执行命令
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">命令</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={command}
                onChange={(e) => onCommandChange(e.target.value)}
                placeholder="输入要执行的命令..."
                className="flex-1 px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:border-primary text-text-primary"
                disabled={isExecuting}
              />
              <button
                onClick={() =>
                  onExecute(
                    isZabbixChannel
                      ? { ssh_key_id: sshKeyId || undefined, persist_ssh_key: persistKey }
                      : undefined,
                  )
                }
                disabled={!command || isExecuting || (isZabbixChannel && !sshKeyId)}
                title={isZabbixChannel && !sshKeyId ? '请先选择 SSH 凭据' : undefined}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isExecuting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    执行中...
                  </>
                ) : (
                  <>
                    <Terminal className="w-4 h-4" />
                    执行
                  </>
                )}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="text-xs text-text-secondary">常用命令:</span>
            {['uname -a', 'df -h', 'free -h', 'uptime', 'whoami', 'ps aux'].map((cmd) => (
              <button
                key={cmd}
                onClick={() => onCommandChange(cmd)}
                className="px-2 py-1 bg-background border border-border rounded text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                {cmd}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
