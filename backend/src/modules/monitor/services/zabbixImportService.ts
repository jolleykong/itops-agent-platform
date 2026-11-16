/**
 * Zabbix 主机导入服务
 *
 * 从 Zabbix API 拉取主机清单（含接口/主机组/inventory），
 * 映射为平台 servers 表记录并写入。
 *
 * 映射规则：
 *   - hostname：主接口 IP（无 IP 用 DNS，再退回 Zabbix 技术主机名）
 *   - port：22（servers 表面向 SSH 管理，Zabbix Agent 端口不适用）
 *   - username：占位 'zabbix'（servers.username NOT NULL，用户后续补真实 SSH 凭据）
 *   - tags：['zabbix', ...主机组名]
 *   - description：标注导入来源与 Zabbix hostid
 *   - 去重：按 hostname+port 判断，已存在则跳过
 */

import { randomUUID } from 'crypto';
import { serversRepo } from '../../../repositories/serverRepository';
import { zabbixService, type ZabbixHostDetail } from './zabbixService';
import { logger } from '../../../utils/logger';

export interface ZabbixImportOptions {
  url: string;
  apiToken?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  /** 仅导入这些 hostid；不传则导入全部 */
  hostIds?: string[];
  /** true = 只做映射预览，不写库 */
  dryRun?: boolean;
}

export interface ZabbixImportDetail {
  hostid: string;
  name: string;
  hostname: string;
  ip: string;
  groups: string[];
  os: string;
  /** preview | duplicate | success | failed */
  status: string;
  error?: string;
}

export interface ZabbixImportResult {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  details: ZabbixImportDetail[];
}

/** 取主接口 IP/DNS：优先 Agent(type=1) 主接口，其次任意主接口，最后第一条 */
function pickPrimaryAddress(host: ZabbixHostDetail): { address: string; isIp: boolean } {
  const ifs = Array.isArray(host.interfaces) ? host.interfaces : [];
  const agentMain = ifs.find((i) => i.type === '1' && i.main === '1');
  const anyMain = ifs.find((i) => i.main === '1');
  const pick = agentMain ?? anyMain ?? ifs[0];
  const ip = pick?.ip?.trim() ?? '';
  const dns = pick?.dns?.trim() ?? '';
  if (ip) return { address: ip, isIp: true };
  if (dns) return { address: dns, isIp: false };
  return { address: host.host, isIp: false };
}

class ZabbixImportService {
  async importHosts(opts: ZabbixImportOptions): Promise<ZabbixImportResult> {
    if (!opts.url) {
      throw new Error('Zabbix URL 不能为空');
    }

    // 认证：优先 API Token；否则 username/password 换 session token
    let auth = opts.apiToken;
    if (!auth) {
      const login = await zabbixService.login(opts);
      if (!login.success || !login.auth) {
        throw new Error(login.error ?? 'Zabbix 认证失败');
      }
      auth = login.auth;
    }

    const fetched = await zabbixService.getHostsDetail(auth, opts.hostIds, {
      url: opts.url,
      timeoutMs: opts.timeoutMs,
    });
    if (!fetched.success || !fetched.data) {
      throw new Error(fetched.error ?? 'host.get 拉取失败');
    }

    const result: ZabbixImportResult = {
      total: fetched.data.length,
      imported: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };

    for (const host of fetched.data) {
      const groupNameList = (host.groups ?? []).map((g) => g.name).filter(Boolean);
      const { address } = pickPrimaryAddress(host);
      const displayName = host.name?.trim() || host.host;
      const os = host.inventory?.os?.trim() || host.inventory?.os_full?.trim() || '';

      const base: ZabbixImportDetail = {
        hostid: host.hostid,
        name: displayName,
        hostname: address,
        ip: address,
        groups: groupNameList,
        os,
        status: 'preview',
      };

      try {
        // 去重：servers.hostname + port 22
        const existing = serversRepo.checkDuplicateByHostnameAndPort(address, 22);
        if (existing) {
          result.skipped++;
          result.details.push({ ...base, status: 'duplicate', error: '平台已存在同地址服务器' });
          continue;
        }

        if (opts.dryRun) {
          result.details.push(base);
          continue;
        }

        const id = randomUUID();
        serversRepo.insertImport({
          id,
          name: displayName,
          hostname: address,
          port: 22,
          username: 'zabbix',
          password: null,
          private_key: null,
          use_ssh_key: 0,
          description: `Zabbix 导入 | hostid=${host.hostid} | host=${host.host}`,
          tags: ['zabbix', ...groupNameList],
          ip_address: address,
          os: os || null,
        });

        result.imported++;
        result.details.push({ ...base, status: 'success' });
      } catch (err) {
        logger.error(`Zabbix 主机导入失败 [${host.host}]`, err);
        result.failed++;
        result.details.push({
          ...base,
          status: 'failed',
          error: err instanceof Error ? err.message : '未知错误',
        });
      }
    }

    return result;
  }
}

export const zabbixImportService = new ZabbixImportService();
