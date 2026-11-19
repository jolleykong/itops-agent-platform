/**
 * Elasticsearch 连接配置持久化（对齐 zabbixConnectionStore 模式）
 *
 * 存储位置（复用现有机制，不新建表）：
 *   - ES_URL / ES_TIMEOUT_MS → settingsRepository（明文，非敏感）
 *   - username / password    → credentialService('es_username' / 'es_password')（加密）
 *
 * 安全约定（用户 2026-11-19 定稿）：保存后凭据不再回传前端——
 * getMasked() 仅返回 url 与"是否已配置"布尔位，不回传用户名/密码。
 */

import { settingsRepository } from '../../../repositories/settingsRepository';
import { credentialService } from '../../auth/services/credentialService';
import { safeLog } from '../../../utils/sensitiveMask';
import type { EsClientOptions } from './elasticsearchService';

export interface StoredEsConfig {
  url: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

const CRED_USERNAME = 'es_username';
const CRED_PASSWORD = 'es_password';

class ElasticsearchConnectionStore {
  /** 读取持久化配置；未配置时返回 null（url 为空视为未配置） */
  get(): StoredEsConfig | null {
    const url = (settingsRepository.getValue('ES_URL') ?? '').trim();
    if (!url) return null;

    const timeoutRaw = settingsRepository.getValue('ES_TIMEOUT_MS');
    const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;

    const config: StoredEsConfig = { url };
    const username = credentialService.getCredential(CRED_USERNAME);
    if (username) config.username = username;
    const password = credentialService.getCredential(CRED_PASSWORD);
    if (password) config.password = password;
    if (timeoutMs && timeoutMs > 0) config.timeoutMs = timeoutMs;

    return config;
  }

  /**
   * 保存配置。字段语义（与 Zabbix/AI provider 配置一致）：
   *   - undefined = 不修改该项
   *   - ''        = 删除该项
   *   - 有值      = 覆盖写入
   */
  save(input: {
    url?: string;
    username?: string;
    password?: string;
    timeoutMs?: number | string;
  }): { success: true } | { success: false; error: string } {
    if (input.url !== undefined) {
      const url = input.url.trim();
      if (url === '') {
        settingsRepository.delete('ES_URL');
      } else if (!/^https?:\/\//i.test(url)) {
        return { success: false, error: 'Elasticsearch URL 必须以 http:// 或 https:// 开头' };
      } else {
        settingsRepository.upsert('ES_URL', url);
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
        settingsRepository.delete('ES_TIMEOUT_MS');
      } else {
        settingsRepository.upsert('ES_TIMEOUT_MS', String(n));
      }
    }

    safeLog('🔧 Elasticsearch connection config saved');
    return { success: true };
  }

  /** 转为 EsClientOptions（供查询接口在后端无请求凭据时使用） */
  toClientOptions(config: StoredEsConfig): EsClientOptions {
    return {
      url: config.url,
      basicAuth: config.username
        ? { username: config.username, password: config.password ?? '' }
        : undefined,
      timeoutMs: config.timeoutMs,
    };
  }

  /**
   * 掩码视图（API 返回用）：只回传 url 与是否已配置布尔位，
   * 用户名/密码一律不回传（用户定稿：没必要呈现）。
   */
  getMasked(): {
    url: string;
    hasUsername: boolean;
    hasPassword: boolean;
    timeoutMs?: number;
  } {
    const config = this.get();
    if (!config) {
      return { url: '', hasUsername: false, hasPassword: false };
    }
    return {
      url: config.url,
      hasUsername: !!config.username,
      hasPassword: !!config.password,
      timeoutMs: config.timeoutMs,
    };
  }
}

export const elasticsearchConnectionStore = new ElasticsearchConnectionStore();
