/**
 * Zabbix 主机导入服务
 *
 * 从 Zabbix API 拉取主机清单（含接口/主机组/inventory），
 * 映射为平台 servers 表记录并写入。
 *
 * 映射规则（v062 起默认走 Zabbix Agent 通道，不持有 SSH 凭据）：
 *   - conn_type：'zabbix'（监控数据经 Zabbix API 采集，禁止 SSH 命令执行）
 *   - zabbix_hostid：Zabbix 侧主机 ID（采集定位键）
 *   - hostname：主接口 IP（无 IP 用 DNS，再退回 Zabbix 技术主机名）
 *   - port：10050（Zabbix Agent 端口，仅作展示；通道不走 SSH）
 *   - username：''（不再写 'zabbix' 占位假凭据）
 *   - tags：['zabbix', ...主机组名]
 *   - description：标注导入来源与 Zabbix hostid
 *   - 去重/回填：
 *     1) 按 zabbix_hostid 精确匹配 → 已是 zabbix 通道则跳过；否则回填通道字段（存量修复）
 *     2) 按 hostname+port 匹配（手工 SSH 服务器）→ 跳过
 */

import { randomUUID } from 'crypto';
import { serversRepo } from '../../../repositories/serverRepository';
import { zabbixService, type ZabbixHostDetail } from './zabbixService';
import { zabbixConnectionStore } from './zabbixConnectionStore';
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
  /** preview | duplicate | backfill | success | failed */
  status: string;
  error?: string;
}

export interface ZabbixImportResult {
  total: number;
  imported: number;
  /** 存量服务器回填为 zabbix 通道的数量 */
  backfilled: number;
  skipped: number;
  failed: number;
  details: ZabbixImportDetail[];
}

/** Zabbix Agent 端口（仅展示用，conn_type='zabbix' 不走 SSH） */
const ZABBIX_AGENT_PORT = 10050;

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
    // 认证回退：请求未带认证信息时，使用后端持久化的连接配置
    // （前端 localStorage 的 cfg 可能丢失 Token，用户只需在 UI 点一次「保存到后端」）
    const saved = zabbixConnectionStore.get();
    const url = opts.url?.trim() || saved?.url || '';
    if (!url) {
      throw new Error('Zabbix URL 不能为空（请求与后端保存的连接配置均未提供）');
    }

    const apiToken = opts.apiToken?.trim() || saved?.apiToken;
    let username = opts.username?.trim() || saved?.username;
    const password = opts.password || saved?.password;

    // 认证：优先 API Token；否则 username/password 换 session token
    let auth = apiToken;
    if (!auth) {
      const login = await zabbixService.login({ url, username, password, timeoutMs: opts.timeoutMs ?? saved?.timeoutMs });
      if (!login.success || !login.auth) {
        throw new Error(login.error ?? 'Zabbix 认证失败（API Token 与用户名密码均未提供或无效）');
      }
      auth = login.auth;
    }

    const fetched = await zabbixService.getHostsDetail(auth, opts.hostIds, {
      url,
      timeoutMs: opts.timeoutMs ?? saved?.timeoutMs,
    });
    if (!fetched.success || !fetched.data) {
      throw new Error(fetched.error ?? 'host.get 拉取失败');
    }

    const result: ZabbixImportResult = {
      total: fetched.data.length,
      imported: 0,
      backfilled: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };

    for (const host of fetched.data) {
      const groupNameList = (host.hostgroups ?? host.groups ?? [])
        .map((g) => g.name)
        .filter(Boolean);
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
        // 1) hostid 精确匹配（此前 Zabbix 导入过的记录，含 v062 前的存量）
        const byHostid = serversRepo.getByZabbixHostid(host.hostid);
        if (byHostid) {
          if (byHostid.conn_type === 'zabbix') {
            result.skipped++;
            result.details.push({ ...base, status: 'duplicate', error: '该 hostid 已导入且为 zabbix 通道' });
          } else {
            // 存量 SSH/占位记录 → 回填通道字段并清占位假凭据
            if (!opts.dryRun) {
              serversRepo.backfillZabbixChannel(byHostid.id, host.hostid);
            }
            result.backfilled++;
            result.details.push({ ...base, status: 'backfill', error: '已存在同主机记录，将回填为 zabbix 通道' });
          }
          continue;
        }

        // 2) 手工添加的 SSH 服务器（同 hostname+port 10050 不会撞，但同 hostname+22 会撞 → 保留原样）
        const existing = serversRepo.checkDuplicateByHostnameAndPort(address, 22);
        if (existing) {
          result.skipped++;
          result.details.push({ ...base, status: 'duplicate', error: '平台已存在同地址 SSH 服务器（如需统一为 zabbix 通道请单独处理）' });
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
          port: ZABBIX_AGENT_PORT,
          username: '',
          password: null,
          private_key: null,
          use_ssh_key: 0,
          description: `Zabbix 导入 | hostid=${host.hostid} | host=${host.host}`,
          // tags 列为 JSON 字符串；传数组会被 better-sqlite3 当作绑定列表展开，导致占位符数量不匹配
          tags: JSON.stringify(['zabbix', ...groupNameList]),
          ip_address: address,
          os: os || null,
          conn_type: 'zabbix',
          zabbix_hostid: host.hostid,
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
