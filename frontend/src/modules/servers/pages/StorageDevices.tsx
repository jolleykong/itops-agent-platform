import { useQuery } from '@tanstack/react-query';
import { HardDrive, RefreshCw } from 'lucide-react';
import api from '../../../lib/api';
import type { Server } from './types';

/**
 * 存储设备页（2026-11-24）
 * 数据源：/servers?category=storage —— servers 表中按资产分层规则识别的存储设备
 * （Unity 系列存储、台账登记的 NBU/备份存储等）。
 * iTop StorageSystem 同步的无 IP 存储在机房 3D 以占位形式展示，不在本页范围。
 */
export default function StorageDevices() {
  const { data: servers, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['servers', 'storage'],
    queryFn: async () => {
      const { data } = await api.get('/servers', { params: { category: 'storage' } });
      return data as Server[];
    },
  });

  const list = Array.isArray(servers) ? servers : [];

  return (
    <div className="h-full overflow-auto p-6">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-primary mb-2">存储设备</h1>
            <p className="text-text-secondary">
              存储资产管理（Unity 系列、备份存储等，数据来源 CMDB 同步与台账）
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
            disabled={isFetching}
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>

        {/* 列表 */}
        <div className="bg-surface border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center text-text-secondary">加载中...</div>
          ) : list.length === 0 ? (
            <div className="p-12 text-center">
              <HardDrive className="w-12 h-12 mx-auto text-text-tertiary mb-4" />
              <p className="text-text-secondary">暂无存储设备</p>
              <p className="text-sm text-text-tertiary mt-2">
                在 iTop CMDB 或台账中登记存储设备后，同步将自动归入此页
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-slate-800/60 text-left text-text-secondary">
                <tr>
                  <th className="px-4 py-3 font-medium">设备名称</th>
                  <th className="px-4 py-3 font-medium">IP 地址</th>
                  <th className="px-4 py-3 font-medium">OS</th>
                  <th className="px-4 py-3 font-medium">描述</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr
                    key={s.id}
                    className="border-t border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/40"
                  >
                    <td className="px-4 py-3 font-medium text-text-primary">{s.name}</td>
                    <td className="px-4 py-3 text-text-secondary font-mono">{s.ip_address || '-'}</td>
                    <td className="px-4 py-3 text-text-secondary">{s.os || '-'}</td>
                    <td className="px-4 py-3 text-text-secondary max-w-md truncate">
                      {s.description || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="text-xs text-text-tertiary">
          共 {list.length} 台存储设备 · 分类规则：存储产品命名（Unity/OceanStor 等）或非硬件 BMC 命名且描述含「存储」
        </p>
      </div>
    </div>
  );
}
