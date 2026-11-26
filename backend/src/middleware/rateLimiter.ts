import type { Request, Response, NextFunction } from 'express';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

interface RateLimitEntry {
  count: number;
  resetTime: number;
  lastAccess: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const MAX_STORE_SIZE = 10000;
const CLEANUP_INTERVAL_MS = 60 * 1000; // 每分钟清理

// 路由限流配置
interface RateLimitConfig {
  [key: string]: {
    windowMs: number;
    max: number;
  };
}

/**
 * 路由限流配置（窗口 / 上限）
 *
 * 阈值来源：环境变量优先，未配置时用下面的默认值。
 *   RATE_LIMIT_WINDOW_MS  默认 60000
 *   RATE_LIMIT_MAX        默认 600（全局限流，按 IP+方法+路径 计数）
 *   RATE_LIMIT_READ_MAX   默认 6000（机房看板 / CMDB 看板 / 监控等高频只读接口）
 *   RATE_LIMIT_WHITELIST  内网运维出口 IP，命中则完全不限流（逗号分隔，支持 CIDR 与 *）
 *
 * 历史坑：原来全局只有 100/min，机房看板的机柜下钻会连续请求
 * `/api/v1/dc/ci-chain`（每点一个节点就一次），页面自己就能把配额打满，
 * 前端随即弹「请求过于频繁」。这类只读下钻接口必须单独放宽。
 */
const READ_WINDOW_MS = env.RATE_LIMIT_WINDOW_MS;
const READ_MAX = env.RATE_LIMIT_READ_MAX;

const rateLimitConfig: RateLimitConfig = {
  // 登录是最需要收紧的（防爆破），保持 5 次/15 分钟
  '/api/v1/auth/login': { windowMs: 15 * 60 * 1000, max: 5 },
  '/api/v1/auth': { windowMs: 60 * 1000, max: 20 },
  '/api/v1/copilot': { windowMs: 60 * 1000, max: 30 },
  '/api/v1/settings/api-keys': { windowMs: 60 * 1000, max: 10 },
  '/api/v1/webhooks': { windowMs: 1000, max: 10 },
  // 高频只读：机房看板（机柜/U位/链路）、CMDB 看板、监控与拓扑
  '/api/v1/dc': { windowMs: READ_WINDOW_MS, max: READ_MAX },
  '/api/v1/cmdb-sync': { windowMs: READ_WINDOW_MS, max: READ_MAX },
  '/api/v1/monitor': { windowMs: READ_WINDOW_MS, max: READ_MAX },
  '/api/v1/topology': { windowMs: READ_WINDOW_MS, max: READ_MAX },
};

const ipWhitelist: readonly string[] = [
  ...(env.WEBHOOK_IP_WHITELIST ?? '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean),
  ...(env.RATE_LIMIT_WHITELIST ?? '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean),
];

function isIpWhitelisted(ip: string | undefined): boolean {
  if (ipWhitelist.length === 0) return false;
  if (!ip) return false;

  const clientIp = ip.replace(/^::ffff:/, '');
  return ipWhitelist.some(whitelistedIp => {
    if (whitelistedIp === '*') return true;
    if (whitelistedIp.includes('/')) {
      return isIpInCidr(clientIp, whitelistedIp);
    }
    return clientIp === whitelistedIp;
  });
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, prefixLenStr] = cidr.split('/');
  const prefixLen = parseInt(prefixLenStr, 10);
  if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;

  const ipNum = ipToNumber(ip);
  const networkNum = ipToNumber(network);
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;

  return (ipNum & mask) === (networkNum & mask);
}

function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return 0;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const DEFAULT_CONFIG = { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX };

/**
 * 完整请求路径。
 * 限流中间件是挂在 `app.use(mod.path, rateLimiter, router)` 上的，
 * 此时 `req.path` 只剩挂载点之后的部分（`/overview`），
 * 用它对配置表做 startsWith 匹配会全部落空、退化成默认阈值。
 * 必须用 `baseUrl + path`（`/api/v1/dc/overview`）。
 */
function fullPath(req: Request): string {
  return `${req.baseUrl || ''}${req.path}`;
}

function getClientKey(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return `${ip}:${req.method}:${fullPath(req)}`;
}

function findMatchingConfig(path: string): { windowMs: number; max: number } {
  // 取「最长前缀」匹配：/api/v1/auth/login 必须优先于 /api/v1/auth
  let best: { windowMs: number; max: number } | null = null;
  let bestLen = -1;
  for (const [routePath, cfg] of Object.entries(rateLimitConfig)) {
    if (path.startsWith(routePath) && routePath.length > bestLen) {
      best = cfg;
      bestLen = routePath.length;
    }
  }
  return best ?? DEFAULT_CONFIG;
}

/**
 * LRU 淘汰：移除最久未访问的条目直到低于容量阈值（容量的80%）
 */
function evictLRU(): void {
  if (rateLimitStore.size < MAX_STORE_SIZE) return;

  const entries = Array.from(rateLimitStore.entries())
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

  const targetSize = Math.floor(MAX_STORE_SIZE * 0.8);
  const toDelete = rateLimitStore.size - targetSize;

  for (let i = 0; i < toDelete && i < entries.length; i++) {
    rateLimitStore.delete(entries[i][0]);
  }

  logger.warn(`Rate limiter store full, evicted ${toDelete} oldest entries (LRU)`);
}

/**
 * 清理所有过期的条目
 */
function cleanupExpired(): number {
  const now = Date.now();
  let deleted = 0;
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
      deleted++;
    }
  }
  return deleted;
}

export function webhookIpFilter(req: Request, res: Response, next: NextFunction) {
  const clientIp = req.ip || req.socket.remoteAddress;

  if (ipWhitelist.length > 0 && req.path.startsWith('/api/v1/webhooks')) {
    if (!isIpWhitelisted(clientIp)) {
      logger.warn(`Webhook request blocked: IP ${clientIp} not in whitelist`, {
        path: req.path,
        method: req.method,
      });
      return res.status(403).json({
        success: false,
        message: 'IP not allowed',
      });
    }
  }

  next();
}

export function rateLimiter(req: Request, res: Response, next: NextFunction) {
  if (isIpWhitelisted(req.ip || req.socket.remoteAddress)) {
    return next();
  }

  const config = findMatchingConfig(fullPath(req));
  const key = getClientKey(req);
  const now = Date.now();

  let entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetTime) {
    // 如果 Map 满了，先尝试清理过期条目，必要时 LRU 淘汰
    if (rateLimitStore.size >= MAX_STORE_SIZE) {
      const cleaned = cleanupExpired();
      if (cleaned === 0) {
        evictLRU();
      }
    }

    entry = {
      count: 0,
      resetTime: now + config.windowMs,
      lastAccess: now,
    };
    rateLimitStore.set(key, entry);
  }

  entry.count++;
  entry.lastAccess = now;

  res.setHeader('X-RateLimit-Limit', config.max.toString());
  res.setHeader('X-RateLimit-Remaining', Math.max(0, config.max - entry.count).toString());
  res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000).toString());

  if (entry.count > config.max) {
    return res.status(429).json({
      success: false,
      message: '请求过于频繁，请稍后再试',
      retryAfter: Math.ceil((entry.resetTime - now) / 1000),
    });
  }

  next();
}

// 定时清理过期条目
setInterval(() => {
  const count = cleanupExpired();
  if (count > 0) {
    logger.debug(`Rate limiter cleanup: removed ${count} expired entries (remaining: ${rateLimitStore.size})`);
  }
}, CLEANUP_INTERVAL_MS);

logger.info(
  `🚦 限流生效：默认 ${DEFAULT_CONFIG.max} 次/${Math.round(
    DEFAULT_CONFIG.windowMs / 1000,
  )}s，只读接口 ${READ_MAX} 次/${Math.round(READ_WINDOW_MS / 1000)}s，白名单 ${
    ipWhitelist.length ? ipWhitelist.join(',') : '(空)'
  }`,
);
