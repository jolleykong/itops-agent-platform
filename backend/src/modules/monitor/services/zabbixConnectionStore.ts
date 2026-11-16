/**
 * Zabbix 连接配置持久化
 *
 * 后端定时采集 / Zabbix Agent 通道指标采集需要"无请求上下文"地拿到
 * Zabbix URL + 认证信息，因此必须持久化在后端（此前仅前端每次传参）。
 *
 * 存储位置（复用现有机制，不新建表）：
 *   - ZABBIX_URL / ZABBIX_TIMEOUT_MS → settingsRepository（明文，非敏感）
 *   - apiToken                        → credentialService('zabbix_api_token')（加密）
 *   - username / password             → credentialService('zabbix_username' / 'zabbix_password')（加密）
 *
 * 认证优先级：apiToken > username/password（login 换 session token）。
 */

import { settingsRepository } from '../../../repositories/settingsRepository';
import { credentialService } from '../../auth/services/credentialService';
import { safeLog } from '../../../utils/sensitiveMask';
import type { ZabbixClientOptions } from './zabbixService';

export interface StoredZabbixConfig {
  url: string;
  apiToken?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

const CRED_TOKEN = 'zabbix_api_token';
const CRED_USERNAME = 'zabbix_username';
const CRED_PASSWORD = 'zabbix_password';

class ZabbixConnectionStore {
  /** 读取持久化配置；未配置时返回 null（url 为空视为未配置） */
  get(): StoredZabbixConfig | null {
    const url = (settingsRepository.getValue('ZABBIX_URL') ?? '').trim();
    if (!url) return null;

    const timeoutRaw = settingsRepository.getValue('ZABBIX_TIMEOUT_MS');
    const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;

    const config: StoredZabbixConfig = { url };
    const token = credentialService.getCredential(CRED_TOKEN);
    if (token) config.apiToken = token;
    const username = credentialService.getCredential(CRED_USERNAME);
    if (username) config.username = username;
    const password = credentialService.getCredential(CRED_PASSWORD);
    if (password) config.password = password;
    if (timeoutMs && timeoutMs > 0) config.timeoutMs = timeoutMs;

    return config;
  }

  /**
   * 保存配置。字段语义（与 AI provider 配置一致）：
   *   - undefined = 不修改该项
   *   - ''        = 删除该项
   *   - 有值      = 覆盖写入
   */
  save(input: {
    url?: string;
    apiToken?: string;
    username?: string;
    password?: string;
    timeoutMs?: number | string;
  }): { success: true } | { success: false; error: string } {
    if (input.url !== undefined) {
      const url = input.url.trim();
      if (url === '') {
        settingsRepository.delete('ZABBIX_URL');
      } else if (!/^https?:\/\//i.test(url)) {
        return { success: false, error: 'Zabbix URL 必须以 http:// 或 https:// 开头' };
      } else {
        settingsRepository.upsert('ZABBIX_URL', url);
      }
    }

    if (input.apiToken !== undefined) {
      if (input.apiToken === '') {
        credentialService.deleteCredential(CRED_TOKEN);
      } else {
        credentialService.setCredential(CRED_TOKEN, input.apiToken);
      }
    }
    if (input.username !== undefined) {
      if (input.username === '') {
        credentialService.deleteCredential(CRED_USERNAME);
      } else {
        credentialService.setCredential(CRED_USERNAME, input.username);
      }
    }
    if (input.password !== undefined) {
      if (input.password === '') {
        credentialService.deleteCredential(CRED_PASSWORD);
      } else {
        credentialService.setCredential(CRED_PASSWORD, input.password);
      }
    }

    if (input.timeoutMs !== undefined) {
      const n = parseInt(String(input.timeoutMs), 10);
      if (!n || n <= 0) {
        settingsRepository.delete('ZABBIX_TIMEOUT_MS');
      } else {
        settingsRepository.upsert('ZABBIX_TIMEOUT_MS', String(n));
      }
    }

    safeLog('🔧 Zabbix connection config saved');
    return { success: true };
  }

  /** 转为 ZabbixClientOptions（供 zabbixService/zabbixMetricCollector 使用） */
  toClientOptions(config: StoredZabbixConfig): ZabbixClientOptions {
    return {
      url: config.url,
      apiToken: config.apiToken,
      username: config.username,
      password: config.password,
      timeoutMs: config.timeoutMs,
    };
  }

  /**
   * 取认证（token 或 login session）：
   * 有 token 直接返回；无 token 且有用户名密码时自动 login。
   */
  async resolveAuth(config: StoredZabbixConfig): Promise<string | null> {
    if (config.apiToken) return config.apiToken;
    if (config.username && config.password) {
      // 延迟导入避免循环依赖（zabbixService 不依赖本文件，但保持懒加载更稳）
      const { zabbixService } = await import('./zabbixService');
      const login = await zabbixService.login({
        url: config.url,
        username: config.username,
        password: config.password,
        timeoutMs: config.timeoutMs,
      });
      if (login.success && login.auth) return login.auth;
      return null;
    }
    return null;
  }

  /** 掩码视图（API 返回用）：token 只回传是否已配置 + 尾 4 位 */
  getMasked(): {
    url: string;
    hasApiToken: boolean;
    apiTokenHint: string;
    username: string;
    hasPassword: boolean;
    timeoutMs?: number;
  } {
    const config = this.get();
    if (!config) {
      return { url: '', hasApiToken: false, apiTokenHint: '', username: '', hasPassword: false };
    }
    const token = config.apiToken ?? '';
    const username = config.username ?? '';
    return {
      url: config.url,
      hasApiToken: !!token,
      apiTokenHint: token ? `${token.slice(0, 2)}****${token.slice(-4)}` : '',
      username,
      hasPassword: !!config.password,
      timeoutMs: config.timeoutMs,
    };
  }
}

export const zabbixConnectionStore = new ZabbixConnectionStore();
