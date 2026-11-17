/**
 * SshKeyPicker - SSH 凭据选择器（Zabbix 通道服务器"按需 SSH"用）
 *
 * 从 /ssh-keys 拉取已配置凭据，供执行命令/AI 执行时一次性指定：
 * - 默认不勾选"保持密钥"：仅本次执行使用，不落库
 * - 勾选"保持密钥"：执行时将凭据持久化关联到服务器（servers.ssh_key_id），下次默认选中
 */
import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import api from '../../../lib/api';

interface SshKeyItem {
  id: string;
  name: string;
  auth_type: 'key' | 'password';
  username?: string | null;
}

interface SshKeyPickerProps {
  /** 当前选中凭据 ID（空 = 未选择） */
  value: string;
  onChange: (v: string) => void;
  /** "保持密钥"勾选状态 */
  persist: boolean;
  onPersistChange: (v: boolean) => void;
  /** 已持久化关联的凭据 ID（用于默认选中） */
  persistedKeyId?: string | null;
}

export function SshKeyPicker({ value, onChange, persist, onPersistChange, persistedKeyId }: SshKeyPickerProps) {
  const [keys, setKeys] = useState<SshKeyItem[]>([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get('/ssh-keys')
      .then((res: { data: { data: SshKeyItem[] } }) => {
        if (!cancelled) setKeys(res.data?.data || []);
      })
      .catch(() => {
        if (!cancelled) setLoadError('凭据列表加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <KeyRound className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
        <span className="text-xs text-text-secondary shrink-0">SSH 凭据</span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="max-w-[220px] bg-slate-800/60 border border-border rounded-md px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-blue-500/60 cursor-pointer"
        >
          <option value="">{keys.length ? '请选择凭据…' : '暂无已配置凭据'}</option>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
              {k.auth_type === 'password' ? '（密码）' : '（密钥）'}
              {k.username ? ` · ${k.username}` : ''}
            </option>
          ))}
        </select>
        {loadError && <span className="text-xs text-status-failed">{loadError}</span>}
      </div>
      <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer select-none">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => onPersistChange(e.target.checked)}
          className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
          disabled={!value}
        />
        保持密钥
        <span
          className="text-text-tertiary"
          title="勾选后，本次指定的凭据将与该服务器持久化关联，之后的执行默认使用；不勾选则仅本次生效"
        >
          （默认不关联，仅本次生效）
        </span>
      </label>
      {persistedKeyId && !persist && (
        <span className="text-xs text-text-tertiary">已关联默认凭据，可在下方重新指定</span>
      )}
    </div>
  );
}
