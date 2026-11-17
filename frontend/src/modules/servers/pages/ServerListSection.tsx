import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Server, Terminal, CheckCircle2, AlertCircle, ShieldCheck, Wifi, History, Clock, FolderTree,
  Upload, RefreshCw, Plus, Edit, Trash2, Cpu, HardDrive, MemoryStick, Monitor,
  MonitorPlay, Sparkles, FolderPlus, Search, X,
} from 'lucide-react';
import clsx from 'clsx';
import api from '../../../lib/api';
import type { Server as ServerType, ServerGroup } from './types';
import { GroupTree } from './ServerGroupSection';

interface ServerListSectionProps {
  // Data
  servers: ServerType[];
  isLoading: boolean;
  groupsData: ServerGroup[] | undefined;
  allTags: string[];
  filteredServers: ServerType[];
  // Selection
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
  selectedGroupId: string | null;
  onSelectGroupId: (id: string | null) => void;
  // Toolbar state
  showGroups: boolean;
  onToggleGroups: () => void;
  isCollecting: boolean;
  isCollectingMetrics: boolean;
  // Handlers
  onCollectAll: () => void;
  onCollectAllMetrics: () => void;
  onOpenImport: () => void;
  onOpenGroupModal: () => void;
  onTestConnection: (server: ServerType) => void;
  onCollectInfo: (server: ServerType) => void;
  onCollectMetrics: (server: ServerType) => void;
  onEdit: (server: ServerType) => void;
  onDelete: (id: string, name: string) => void;
  onOpenAiCommand: (server: ServerType) => void;
  onSelectForCommand: (server: ServerType) => void;
  onRunCompliance: (server: ServerType) => void;
  onViewCommandHistory: (server: ServerType) => void;
  onViewComplianceHistory: (server: ServerType) => void;
}

export function ServerListSection({
  servers: _servers,
  isLoading,
  groupsData,
  allTags,
  filteredServers,
  selectedTag,
  onSelectTag,
  selectedGroupId,
  onSelectGroupId,
  showGroups,
  onToggleGroups,
  isCollecting,
  isCollectingMetrics,
  onCollectAll,
  onCollectAllMetrics,
  onOpenImport,
  onOpenGroupModal,
  onTestConnection,
  onCollectInfo,
  onCollectMetrics,
  onEdit,
  onDelete,
  onOpenAiCommand,
  onSelectForCommand,
  onRunCompliance,
  onViewCommandHistory,
  onViewComplianceHistory,
}: ServerListSectionProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ── 搜索 ──
  const [searchQuery, setSearchQuery] = useState('');
  const visibleServers = searchQuery.trim()
    ? filteredServers.filter((s) => {
        const q = searchQuery.trim().toLowerCase();
        return (
          s.name.toLowerCase().includes(q) ||
          s.hostname.toLowerCase().includes(q) ||
          (s.ip_address || '').toLowerCase().includes(q) ||
          (s.os || '').toLowerCase().includes(q)
        );
      })
    : filteredServers;

  // ── 批量选择/删除 ──
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`确定删除选中的 ${selectedIds.size} 台服务器？此操作不可恢复！`)) return;
    setIsBatchDeleting(true);
    let ok = 0, fail = 0;
    const errs: string[] = [];
    for (const id of selectedIds) {
      try {
        await api.delete(`/servers/${id}`);
        ok++;
      } catch (e: any) {
        fail++;
        errs.push(e?.response?.data?.message || e?.message || '未知错误');
      }
    }
    setIsBatchDeleting(false);
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ['servers'] });
    window.alert(`批量删除完成：成功 ${ok} 台，失败 ${fail} 台${errs.length ? '\n' + errs.slice(0, 5).join('\n') : ''}`);
  };

  // ── 批量添加 ──
  const [batchAddOpen, setBatchAddOpen] = useState(false);
  const [batchAddText, setBatchAddText] = useState('');
  const [batchAddType, setBatchAddType] = useState<'zabbix' | 'zabbix_agent' | 'ssh'>('zabbix');
  const [batchAddRunning, setBatchAddRunning] = useState(false);
  const [batchAddResult, setBatchAddResult] = useState<string | null>(null);
  const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
  const handleBatchAdd = async () => {
    const lines = batchAddText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    setBatchAddRunning(true);
    setBatchAddResult(null);
    let ok = 0, fail = 0;
    const errs: string[] = [];
    const port = batchAddType === 'ssh' ? 22 : 10050;
    for (const line of lines) {
      // 每行格式：IP 或 IP,名称（逗号/空格分隔均可）
      const parts = line.split(/[,|\s]+/).filter(Boolean);
      const ip = parts[0];
      const name = parts[1] || ip;
      if (!IPV4_RE.test(ip)) {
        fail++;
        errs.push(`${line}: "${ip}" 不是合法 IPv4 地址`);
        continue;
      }
      try {
        await api.post('/servers', {
          name,
          hostname: ip,
          port,
          username: '',
          os_type: 'linux',
          conn_type: batchAddType,
          description: '批量添加',
        });
        ok++;
      } catch (e: any) {
        fail++;
        errs.push(`${line}: ${e?.response?.data?.message || e?.message || '未知错误'}`);
      }
    }
    setBatchAddRunning(false);
    setBatchAddResult(`成功 ${ok} 台，失败 ${fail} 台${errs.length ? '\n' + errs.slice(0, 10).join('\n') : ''}`);
    queryClient.invalidateQueries({ queryKey: ['servers'] });
  };

  return (
    <>
      {/* 工具栏 */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={onToggleGroups}
          className={clsx(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors border',
            showGroups
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'border-border bg-surface text-text-secondary hover:text-text-primary',
          )}
        >
          <FolderTree className="w-4 h-4" />
          分组
        </button>
        <button
          onClick={onCollectAll}
          disabled={isCollecting}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-surface border border-border text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
        >
          <RefreshCw className={clsx('w-4 h-4', isCollecting && 'animate-spin')} />
          采集所有主机信息
        </button>
        <button
          onClick={onCollectAllMetrics}
          disabled={isCollectingMetrics}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-surface border border-border text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
        >
          <RefreshCw className={clsx('w-4 h-4', isCollectingMetrics && 'animate-spin')} />
          采集所有性能指标
        </button>
        <button
          onClick={onOpenImport}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-surface border border-border text-text-secondary hover:text-text-primary transition-colors"
        >
          <Upload className="w-4 h-4" />
          批量导入
        </button>
        <button
          onClick={() => { setBatchAddOpen(true); setBatchAddResult(null); }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-surface border border-border text-text-secondary hover:text-text-primary transition-colors"
        >
          <Plus className="w-4 h-4" />
          批量添加
        </button>
        <button
          onClick={onOpenGroupModal}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-surface border border-border text-text-secondary hover:text-text-primary transition-colors"
        >
          <FolderPlus className="w-4 h-4" />
          新建分组
        </button>
        {selectedIds.size > 0 && (
          <button
            onClick={handleBatchDelete}
            disabled={isBatchDeleting}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            删除选中 ({selectedIds.size})
          </button>
        )}
        {/* 搜索框 */}
        <div className="relative ml-auto w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索名称 / IP / OS..."
            className="w-full pl-8 pr-8 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-primary"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-background rounded"
            >
              <X className="w-3.5 h-3.5 text-text-secondary" />
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-4">
        {/* 分组侧边栏 */}
        {showGroups && (
          <div className="w-56 flex-shrink-0 bg-surface border border-border rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-text-primary">服务器分组</h3>
              <button
                onClick={() => onSelectGroupId(null)}
                className="text-xs text-text-secondary hover:text-text-primary"
              >
                清除筛选
              </button>
            </div>
            {groupsData && groupsData.length > 0 ? (
              <GroupTree groups={groupsData} selectedGroupId={selectedGroupId} onSelectGroup={onSelectGroupId} />
            ) : (
              <p className="text-xs text-text-secondary py-4 text-center">暂无分组</p>
            )}
          </div>
        )}

        {/* 服务器列表 */}
        <div className="flex-1">
          {/* 标签筛选器 */}
          {allTags.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  onSelectTag(null);
                  onSelectGroupId(null);
                }}
                className={clsx(
                  'px-3 py-1 rounded-full text-sm transition-colors',
                  !selectedTag && !selectedGroupId
                    ? 'bg-primary text-white'
                    : 'bg-background border border-border text-text-secondary hover:bg-surface',
                )}
              >
                全部
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => {
                    onSelectTag(selectedTag === tag ? null : tag);
                    onSelectGroupId(null);
                  }}
                  className={clsx(
                    'px-3 py-1 rounded-full text-sm transition-colors',
                    selectedTag === tag
                      ? 'bg-primary text-white'
                      : 'bg-background border border-border text-text-secondary hover:bg-surface',
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-surface border border-border rounded-lg p-4 animate-pulse">
                  <div className="h-4 bg-border rounded w-1/2 mb-2" />
                  <div className="h-3 bg-border rounded w-3/4" />
                </div>
              ))
            ) : visibleServers.length === 0 ? (
              <div className="col-span-full flex flex-col items-center justify-center py-12 text-text-secondary">
                <Server className="w-12 h-12 mb-4 opacity-50" />
                <p>
                  {searchQuery
                    ? `没有匹配 "${searchQuery}" 的服务器`
                    : selectedTag
                    ? `没有带标签 "${selectedTag}" 的服务器`
                    : selectedGroupId
                      ? '该分组下暂无服务器'
                      : '暂无服务器，请添加第一个服务器'}
                </p>
              </div>
            ) : (
              visibleServers.map((server) => (
                <div
                  key={server.id}
                  className={clsx(
                    'relative bg-surface border rounded-lg p-4 min-w-0 overflow-hidden',
                    server.os_type === 'linux'
                      ? 'border-yellow-500/30'
                      : server.os_type === 'windows'
                        ? 'border-blue-500/30'
                        : 'border-border',
                  )}
                >
                  {/* 操作系统左侧标识条 */}
                  <div
                    className={clsx(
                      'absolute left-0 top-0 bottom-0 w-1',
                      server.os_type === 'linux'
                        ? 'bg-gradient-to-b from-yellow-500 to-orange-500'
                        : server.os_type === 'windows'
                          ? 'bg-gradient-to-b from-blue-500 to-cyan-500'
                          : 'bg-gradient-to-b from-text-tertiary/50 to-text-tertiary/30',
                    )}
                  />

                  <div className="flex items-start justify-between mb-3 min-w-0 pl-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* 批量选择复选框 */}
                      <input
                        type="checkbox"
                        checked={selectedIds.has(server.id)}
                        onChange={() => toggleSelect(server.id)}
                        className="rounded border-border flex-shrink-0 cursor-pointer"
                        title="加入批量选择"
                      />
                      <div
                        className={clsx(
                          'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
                          server.os_type === 'linux'
                            ? 'bg-yellow-500/10'
                            : server.os_type === 'windows'
                              ? 'bg-blue-500/10'
                              : 'bg-primary/10',
                        )}
                      >
                        <Server
                          className={clsx(
                            'w-4 h-4',
                            server.os_type === 'linux'
                              ? 'text-yellow-500'
                              : server.os_type === 'windows'
                                ? 'text-blue-500'
                                : 'text-primary',
                          )}
                        />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-medium text-text-primary truncate">
                          {server.name}
                          {server.conn_type === 'zabbix' && (
                            <span
                              className="ml-1.5 inline-flex items-center px-1.5 py-0.5 bg-purple-500/10 text-purple-500 text-[10px] rounded align-middle"
                              title="Zabbix API 通道：只读监控，不支持 SSH 命令执行"
                            >
                              ZBX
                            </span>
                          )}
                          {server.conn_type === 'zabbix_agent' && (
                            <span
                              className="ml-1.5 inline-flex items-center px-1.5 py-0.5 bg-teal-500/10 text-teal-500 text-[10px] rounded align-middle"
                              title="Zabbix Agent 直连通道：平台直接访问目标机 10050 端口（需目标机 Server= 白名单放行）"
                            >
                              ZBXA
                            </span>
                          )}
                        </h3>
                        <p className="text-xs text-text-secondary truncate">
                          {server.hostname}:{server.port}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      {server.os_type === 'windows' && (
                        <button
                          onClick={() => navigate(`/remote-desktop/${server.id}`)}
                          className="p-1 hover:bg-background rounded transition-colors"
                          title="远程桌面"
                        >
                          <MonitorPlay className="w-4 h-4 text-text-secondary" />
                        </button>
                      )}
                      <button
                        onClick={() => onTestConnection(server)}
                        className="p-1 hover:bg-background rounded transition-colors"
                        title="测试连接"
                      >
                        <Wifi className="w-4 h-4 text-text-secondary" />
                      </button>
                      <button
                        onClick={() => onCollectInfo(server)}
                        disabled={isCollecting}
                        className="p-1 hover:bg-background rounded transition-colors disabled:opacity-50"
                        title="采集主机信息"
                      >
                        <RefreshCw className={clsx('w-4 h-4 text-text-secondary', isCollecting && 'animate-spin')} />
                      </button>
                      <button
                        onClick={() => onCollectMetrics(server)}
                        disabled={isCollectingMetrics}
                        className="p-1 hover:bg-background rounded transition-colors disabled:opacity-50"
                        title="采集性能指标"
                      >
                        <Monitor className={clsx('w-4 h-4 text-text-secondary', isCollectingMetrics && 'animate-spin')} />
                      </button>
                      <button
                        onClick={() => onDelete(server.id, server.name)}
                        className="p-1 hover:bg-background rounded transition-colors"
                        title="删除"
                      >
                        <Trash2 className="w-4 h-4 text-status-failed" />
                      </button>
                      <button
                        onClick={() => onEdit(server)}
                        className="p-1 hover:bg-background rounded transition-colors"
                        title="编辑"
                      >
                        <Edit className="w-4 h-4 text-text-secondary" />
                      </button>
                    </div>
                  </div>
                  {server.description && (
                    <p className="text-xs text-text-secondary mb-3">{server.description}</p>
                  )}

                  {/* 主机扩展信息 */}
                  {(server.os || server.cpu_cores || server.memory_gb || server.disk_gb) && (
                    <div className="mb-3 p-2 bg-background rounded-lg">
                      {server.os && (
                        <div className="flex items-center gap-1.5 text-xs text-text-secondary mb-2">
                          <Monitor className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{server.os}</span>
                        </div>
                      )}
                      {(server.cpu_cores !== undefined ||
                        server.memory_gb !== undefined ||
                        server.disk_gb !== undefined) && (
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          {server.cpu_cores !== undefined && (
                            <div className="flex items-center gap-1.5 text-text-secondary">
                              <Cpu className="w-3 h-3 flex-shrink-0" />
                              <span>{server.cpu_cores} 核</span>
                            </div>
                          )}
                          {server.memory_gb !== undefined && (
                            <div className="flex items-center gap-1.5 text-text-secondary">
                              <MemoryStick className="w-3 h-3 flex-shrink-0" />
                              <span>{server.memory_gb} GB</span>
                            </div>
                          )}
                          {server.disk_gb !== undefined && (
                            <div className="flex items-center gap-1.5 text-text-secondary">
                              <HardDrive className="w-3 h-3 flex-shrink-0" />
                              <span>{server.disk_gb} GB</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 分组展示 */}
                  {server.groups && server.groups.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {server.groups.map((g) => (
                        <span
                          key={g.id}
                          className="px-2 py-0.5 bg-purple-500/10 text-purple-500 text-xs rounded-full flex items-center gap-1"
                        >
                          <FolderTree className="w-2.5 h-2.5" />
                          {g.name}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* 标签展示 */}
                  {server.tags && server.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {server.tags.map((tag: string) => (
                        <span key={tag} className="px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-full">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2 mb-3">
                    {server.last_connected ? (
                      <span className="flex items-center gap-1 text-xs text-text-secondary">
                        <CheckCircle2 className="w-3 h-3 text-status-success" />
                        最后连接: {new Date(server.last_connected).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-text-secondary">
                        <AlertCircle className="w-3 h-3 text-status-warning" />
                        未连接过
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-3">
                    <button
                      onClick={() => onOpenAiCommand(server)}
                      className="flex flex-col items-center justify-center gap-1 px-2 py-2.5 bg-gradient-to-r from-purple-600/20 to-blue-600/20 border border-purple-500/30 rounded-lg text-xs font-medium text-purple-300 whitespace-nowrap hover:from-purple-600/30 hover:to-blue-600/30 transition-colors"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>AI 执行</span>
                    </button>
                    <button
                      onClick={() => onSelectForCommand(server)}
                      className="flex flex-col items-center justify-center gap-1 px-2 py-2.5 bg-surface border border-border rounded-lg text-xs text-text-primary whitespace-nowrap hover:bg-background transition-colors"
                    >
                      <Terminal className="w-4 h-4" />
                      <span>执行命令</span>
                    </button>
                    <button
                      onClick={() => onRunCompliance(server)}
                      className="flex flex-col items-center justify-center gap-1 px-2 py-2.5 bg-surface border border-border rounded-lg text-xs text-text-primary whitespace-nowrap hover:bg-background transition-colors"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      <span>合规检查</span>
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <button
                      onClick={() => onViewCommandHistory(server)}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-surface border border-border rounded-lg text-xs text-text-secondary hover:text-text-primary transition-colors whitespace-nowrap"
                    >
                      <History className="w-3.5 h-3.5" />
                      <span>命令历史</span>
                    </button>
                    <button
                      onClick={() => onViewComplianceHistory(server)}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-surface border border-border rounded-lg text-xs text-text-secondary hover:text-text-primary transition-colors whitespace-nowrap"
                    >
                      <Clock className="w-3.5 h-3.5" />
                      <span>检查历史</span>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 批量添加弹窗 */}
      {batchAddOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setBatchAddOpen(false)}>
          <div
            className="bg-surface border border-border rounded-xl p-6 w-[520px] max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-text-primary">批量添加服务器</h3>
              <button onClick={() => setBatchAddOpen(false)} className="p-1 hover:bg-background rounded">
                <X className="w-4 h-4 text-text-secondary" />
              </button>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-text-secondary mb-2">连接通道</label>
              <select
                value={batchAddType}
                onChange={(e) => setBatchAddType(e.target.value as 'zabbix' | 'zabbix_agent' | 'ssh')}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:border-primary"
              >
                <option value="zabbix">Zabbix API（只读监控，默认）</option>
                <option value="zabbix_agent">Zabbix Agent 直连（需目标机白名单放行）</option>
                <option value="ssh">SSH（可执行命令）</option>
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-text-secondary mb-2">
                主机列表（每行一台：IP 或 IP,名称）
              </label>
              <textarea
                value={batchAddText}
                onChange={(e) => setBatchAddText(e.target.value)}
                placeholder={'192.168.1.10\n192.168.1.11,web-server\n192.168.1.12 db-server'}
                rows={8}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary font-mono focus:outline-none focus:border-primary"
              />
            </div>
            {batchAddResult && (
              <pre className="mb-4 p-3 bg-background border border-border rounded-lg text-xs text-text-secondary whitespace-pre-wrap max-h-40 overflow-auto">
                {batchAddResult}
              </pre>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBatchAddOpen(false)}
                className="px-4 py-2 rounded-lg text-sm bg-background border border-border text-text-secondary hover:text-text-primary"
              >
                关闭
              </button>
              <button
                onClick={handleBatchAdd}
                disabled={batchAddRunning || !batchAddText.trim()}
                className="px-4 py-2 rounded-lg text-sm bg-primary text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {batchAddRunning ? '添加中...' : '开始添加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
