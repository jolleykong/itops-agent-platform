/**
 * itopClient — iTop REST/JSON API 客户端
 *
 * 仿照 modules/monitor/services/zabbixService.ts 的模式：
 *   - 统一 { success, data?, error? } 信封
 *   - axios POST，validateStatus 不抛异常
 *   - 超时 / ECONNABORTED 处理
 *
 * iTop REST API 文档: https://www.itophub.io/wiki/page?id=latest:advancedtopics:rest_json
 *
 * 认证方式：auth_user + auth_pwd（支持 token 或账号密码）
 */

import axios, { type AxiosError } from 'axios';
import https from 'https';
import { logger } from '../../../utils/logger';
import { settingsRepository } from '../../../repositories';
import { credentialService } from '../../auth/services/credentialService';

// ============================================================
// 类型定义
// ============================================================

export interface ITopResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** iTop API 返回的信封 */
interface ITopEnvelope {
  code: number;
  message: string;
  objects?: Record<string, ITopObjectEntry> | null;
}

interface ITopObjectEntry {
  code: number;
  message: string;
  class: string;
  key: string | number;
  fields: Record<string, unknown>;
}

/** 配置选项 */
export interface ITopClientConfig {
  apiUrl: string; // 完整的 rest.php URL
  authUser: string;
  authPwd: string; // 密码或 token
  timeoutMs?: number;
  sslVerify?: boolean; // 是否校验 SSL 证书(企业内部 CA 通常需关闭)
}

// ============================================================
// 客户端
// ============================================================

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 传输层瞬时故障的重试策略。
 *
 * 背景：本服务的 DB 兼容层（models/database/mysql/syncDriver.ts）用 Atomics.wait
 * 在主线程同步等待 worker 结果，长事务期间 event loop 会被短时冻结；期间到达的
 * FIN 无法及时读取，表现为 `socket hang up`。这类失败与 iTop 无关，重试即可成功。
 *
 * 只重试「连接层故障 / 5xx」，绝不重试业务错误（code!=0）与 4xx：
 * 后两者重试无意义，且反复失败认证可能触发 iTop 账号锁定。
 */
const RETRY_MAX_ATTEMPTS = 3; // 首次 + 2 次重试
const RETRY_BASE_DELAY_MS = 300; // 退避基数：300ms、600ms

/** 单次尝试的结果，比 ITopResult 多一个 retryable 标记供外层决策 */
interface AttemptResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  retryable?: boolean;
}

/** 判断错误是否属于「可重试的传输层故障」 */
function isRetryableError(error: unknown): boolean {
  const e = error as AxiosError & { code?: string };
  const code = e?.code ?? '';
  if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED'].includes(code)) {
    return true;
  }
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('socket hang up');
}

class ITopClient {
  private config: ITopClientConfig | null = null;

  /**
   * 从 settings + credentials 加载配置
   * 在每次 API 调用前动态加载，支持热更新
   */
  private loadConfig(): ITopClientConfig | null {
    const apiUrl = settingsRepository.getValue('ITOP_API_BASE');
    if (!apiUrl) {
      return null;
    }

    const authUser = settingsRepository.getValue('ITOP_AUTH_USER') || 'admin';
    const authToken = credentialService.getCredential('itop');
    const timeoutStr = settingsRepository.getValue('ITOP_TIMEOUT_MS');
    const timeoutMs = timeoutStr ? parseInt(timeoutStr, 10) : DEFAULT_TIMEOUT_MS;
    // 企业内网常用自签名/内部 CA 证书，默认关闭校验（可通过 ITOP_SSL_VERIFY=true 开启）
    const sslVerify = settingsRepository.getValue('ITOP_SSL_VERIFY') === 'true';

    if (!authToken) {
      return null;
    }

    return { apiUrl, authUser, authPwd: authToken, timeoutMs, sslVerify };
  }

  /**
   * 测试配置是否有效（不依赖已存储的配置，用于"测试连接"功能）
   */
  isConfigured(): boolean {
    return this.loadConfig() !== null;
  }

  /**
   * 用外部传入的配置进行测试（不修改已存储配置）
   */
  async testWithConfig(
    config: ITopClientConfig,
  ): Promise<ITopResult<{ version: string; objects_found: number }>> {
    const result = await this.request<{ objects: unknown; code: number; message: string }>(
      {
        operation: 'core/get',
        class: 'Organization',
        key: 'SELECT Organization',
        output_fields: 'name',
      },
      config,
    );

    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      data: {
        version: 'ok',
        objects_found: result.data.code,
      },
    };
  }

  /**
   * 核心请求方法 — 带传输层重试的入口
   *
   * 重试仅针对连接层瞬时故障与 5xx；业务错误/4xx 立即返回（见 isRetryableError）。
   */
  private async request<T = ITopEnvelope>(
    payload: Record<string, unknown>,
    overrideConfig?: ITopClientConfig,
  ): Promise<ITopResult<T>> {
    const config = overrideConfig ?? this.loadConfig();
    if (!config) {
      return { success: false, error: 'iTop 未配置：请先设置 API 地址和认证信息' };
    }

    let last: AttemptResult<T> | null = null;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      last = await this.attemptRequest<T>(payload, config);

      if (last.success) {
        return { success: true, data: last.data };
      }
      // 业务错误 / 4xx 重试无意义，立即返回
      if (!last.retryable) {
        return { success: false, error: last.error };
      }
      if (attempt < RETRY_MAX_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * attempt;
        logger.warn(
          `iTop API 瞬时故障（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次），${delay}ms 后重试: ${(last.error ?? '').slice(0, 200)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    logger.error(
      `iTop API 重试 ${RETRY_MAX_ATTEMPTS} 次仍失败: ${(last?.error ?? '').slice(0, 300)}`,
    );
    return {
      success: false,
      error: `${last?.error ?? '未知错误'}（已重试 ${RETRY_MAX_ATTEMPTS - 1} 次）`,
    };
  }

  /**
   * 单次请求尝试（不含重试逻辑）
   */
  private async attemptRequest<T = ITopEnvelope>(
    payload: Record<string, unknown>,
    config: ITopClientConfig,
  ): Promise<AttemptResult<T>> {
    try {
      // iTop REST API 通过 form-data 传递 json_data + auth 参数
      const formData = new URLSearchParams();
      formData.append('version', '1.3');
      formData.append('auth_user', config.authUser);
      formData.append('auth_pwd', config.authPwd);
      formData.append('json_data', JSON.stringify(payload));

      const response = await axios.post<string | T>(config.apiUrl, formData, {
        timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true, // 不在非 2xx 时抛异常
        // 企业内网 iTop 常用自签名/内部 CA 证书，sslVerify=false 时跳过证书校验
        httpsAgent: config.sslVerify === false
          ? new https.Agent({ rejectUnauthorized: false })
          : undefined,
      });

      // iTop 返回的 body 可能是 JSON 或 HTML 错误页
      // 统一规整为字符串用于 HTML 检测，再决定是 JSON.parse 还是直接用对象
      const rawIsString = typeof response.data === 'string';
      const rawBody = rawIsString ? (response.data as string) : JSON.stringify(response.data);

      // 非 2xx：把状态码和响应体一起带出来 —— 排查时必须看到 iTop/PHP 的真实报错，
      // 只给一句 "请求失败" 无法定位（同步日志里展示的就是这段文本）。
      if (response.status >= 400) {
        const plain = rawBody
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          success: false,
          // 仅 5xx（服务端临时故障）值得重试；4xx 是请求本身的问题
          retryable: response.status >= 500,
          error: `HTTP ${response.status} ${response.statusText || ''}`.trim() +
            (plain ? `: ${plain.slice(0, 1500)}` : ''),
        };
      }

      // 检查是否是 HTML（登录失败/服务器错误）
      if (rawBody.trimStart().startsWith('<')) {
        // 提取 HTML 中的错误信息
        const errorMatch = rawBody.match(/<h1[^>]*>(.*?)<\/h1>/i);
        const errorMsg = errorMatch ? errorMatch[1].trim() : 'iTop 返回了 HTML 错误页面（可能是认证失败）';
        const plain = rawBody
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          success: false,
          error: `${errorMsg}${plain ? ` | 原始响应: ${plain.slice(0, 1200)}` : ''}`,
        };
      }

      // 先按 envelope 形状解析（用于检测 iTop 业务错误码 code/message），再交给调用方按 T 使用
      const body: T = rawIsString ? (JSON.parse(rawBody) as T) : (response.data as T);
      const envelope = body as unknown as { code?: number; message?: string };

      // iTop REST API code=0 表示成功，非 0 表示业务错误
      if (envelope.code !== undefined && envelope.code !== 0) {
        return { success: false, error: `iTop 错误 [code=${envelope.code}]: ${envelope.message}` };
      }

      return { success: true, data: body };
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.code === 'ECONNABORTED') {
        // 超时通常是服务端慢或本端 event loop 冻结，重试可能有效
        return {
          success: false,
          retryable: true,
          error: `iTop API 请求超时 (${config.timeoutMs}ms)`,
        };
      }
      if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ENOTFOUND') {
        // 连接被拒 / DNS 失败：可能是瞬时网络抖动，允许重试
        return {
          success: false,
          retryable: true,
          error: `无法连接 iTop: ${axiosError.code}`,
        };
      }
      const msg = error instanceof Error ? error.message : String(error);
      const respData = (axiosError as AxiosError).response?.data;
      const detail = respData
        ? ` | 响应: ${
            typeof respData === 'string' ? respData.slice(0, 1200) : JSON.stringify(respData).slice(0, 1200)
          }`
        : '';
      return { success: false, retryable: isRetryableError(error), error: `${msg}${detail}` };
    }
  }

  // ============================================================
  // core/get — 查询对象
  // ============================================================

  async getObjects<T = Record<string, unknown>>(
    className: string,
    oql?: string,
    outputFields?: string,
  ): Promise<ITopResult<{ objects: Record<string, { key: string | number; class: string; fields: T }>; count: number }>> {
    const payload: Record<string, unknown> = {
      operation: 'core/get',
      class: className,
      key: oql ?? `SELECT ${className}`,
      output_fields: outputFields ?? '*',
    };

    const result = await this.request<ITopEnvelope>(payload);
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }

    const envelope = result.data;
    const objects: Record<string, { key: string | number; class: string; fields: T }> = {};

    if (envelope.objects) {
      for (const [objKey, entry] of Object.entries(envelope.objects)) {
        objects[objKey] = {
          key: entry.key,
          class: entry.class,
          fields: entry.fields as T,
        };
      }
    }

    return {
      success: true,
      data: { objects, count: Object.keys(objects).length },
    };
  }

  // ============================================================
  // core/create — 创建对象
  // ============================================================

  async createObject(
    className: string,
    fields: Record<string, unknown>,
    comment?: string,
  ): Promise<ITopResult<{ key: string | number; fields: Record<string, unknown> }>> {
    const payload: Record<string, unknown> = {
      operation: 'core/create',
      class: className,
      output_fields: '*',
      fields,
    };
    if (comment) {
      payload.comment = comment;
    }

    const result = await this.request<ITopEnvelope>(payload);
    if (!result.success || !result.data?.objects) {
      return { success: false, error: result.error ?? '创建失败' };
    }

    const firstEntry = Object.values(result.data.objects)[0];
    if (!firstEntry) {
      return { success: false, error: 'iTop 返回空对象' };
    }
    if (firstEntry.code !== 0) {
      return { success: false, error: `iTop 创建失败: ${firstEntry.message}` };
    }

    return { success: true, data: { key: firstEntry.key, fields: firstEntry.fields } };
  }

  // ============================================================
  // core/update — 更新对象
  // ============================================================

  async updateObject(
    className: string,
    key: string | number,
    fields: Record<string, unknown>,
    comment?: string,
  ): Promise<ITopResult<{ key: string | number; fields: Record<string, unknown> }>> {
    const payload: Record<string, unknown> = {
      operation: 'core/update',
      class: className,
      key,
      output_fields: '*',
      fields,
    };
    if (comment) {
      payload.comment = comment;
    }

    const result = await this.request<ITopEnvelope>(payload);
    if (!result.success || !result.data?.objects) {
      return { success: false, error: result.error ?? '更新失败' };
    }

    const firstEntry = Object.values(result.data.objects)[0];
    if (!firstEntry) {
      return { success: false, error: 'iTop 返回空对象' };
    }
    if (firstEntry.code !== 0) {
      return { success: false, error: `iTop 更新失败: ${firstEntry.message}` };
    }

    return { success: true, data: { key: firstEntry.key, fields: firstEntry.fields } };
  }

  // ============================================================
  // core/get_related — 查询关联对象
  // ============================================================

  async getRelated<T = Record<string, unknown>>(
    className: string,
    key: string | number,
    relation: string,
    outputFields?: string,
  ): Promise<ITopResult<{ objects: Record<string, { key: string | number; class: string; fields: T }>; count: number }>> {
    const payload: Record<string, unknown> = {
      operation: 'core/get_related',
      class: className,
      key,
      relation,
      output_fields: outputFields ?? '*',
    };

    const result = await this.request<ITopEnvelope>(payload);
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }

    const objects: Record<string, { key: string | number; class: string; fields: T }> = {};
    if (result.data.objects) {
      for (const [objKey, entry] of Object.entries(result.data.objects)) {
        objects[objKey] = { key: entry.key, class: entry.class, fields: entry.fields as T };
      }
    }

    return { success: true, data: { objects, count: Object.keys(objects).length } };
  }
}

// 单例导出
export const itopClient = new ITopClient();
export default itopClient;
