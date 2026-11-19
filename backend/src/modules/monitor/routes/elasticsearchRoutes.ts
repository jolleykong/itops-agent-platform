import { Router, type Request } from 'express';
import { logger } from '../../../utils/logger';
import { validateBody } from '../../../middleware/validation';
import { requireRole } from '../../../middleware/auth';
import { elasticsearchSchemas } from '../../../shared/schemas/apiValidation';
import {
  test,
  listIndexFamilies,
  search,
  rawSearch,
  type EsClientOptions,
} from '../services/elasticsearchService';
import { elasticsearchConnectionStore } from '../services/elasticsearchConnectionStore';

const router = Router();

const NOT_CONFIGURED = 'Elasticsearch 连接未配置：请先在「连接设置」中保存地址与凭据';

/**
 * 客户端选项解析：请求体未携带 url/凭据时回退到后端持久化配置。
 * （用户定稿：凭据加密存储在后端，前端保存后不再持有。）
 */
function pickClientOptions(body: Record<string, unknown>): EsClientOptions | null {
  const b = body as {
    url?: string;
    username?: string;
    password?: string;
    timeoutMs?: number;
  };

  // 请求体自带完整 url → 直接用（兼容未持久化时的临时查询）
  if (b.url && b.url.trim()) {
    return {
      url: b.url,
      basicAuth: b.username ? { username: b.username, password: b.password ?? '' } : undefined,
      timeoutMs: b.timeoutMs,
    };
  }

  // 否则回退持久化配置
  const stored = elasticsearchConnectionStore.get();
  if (!stored) return null;
  return {
    ...elasticsearchConnectionStore.toClientOptions(stored),
    timeoutMs: b.timeoutMs ?? stored.timeoutMs,
  };
}

// GET /api/v1/monitor/elasticsearch/config —— 掩码视图（url + 是否已配置，不回传凭据）
router.get('/config', async (_req: Request, res) => {
  res.json({ success: true, data: elasticsearchConnectionStore.getMasked() });
});

// POST /api/v1/monitor/elasticsearch/config —— 保存（admin；凭据 undefined=不改 / ''=删除）
router.post(
  '/config',
  validateBody(elasticsearchSchemas.saveConfig),
  requireRole('admin'),
  async (req: Request, res) => {
    const body = req.body as {
      url?: string;
      username?: string;
      password?: string;
      timeoutMs?: number | string;
    };
    const result = elasticsearchConnectionStore.save(body);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: elasticsearchConnectionStore.getMasked() });
  },
);

// POST /api/v1/monitor/elasticsearch/test —— 连接测试（size=0 聚合，兼容 viewer 只读角色）
router.post('/test', validateBody(elasticsearchSchemas.test), async (req: Request, res) => {
  try {
    const opts = pickClientOptions(req.body);
    if (!opts) {
      return res.status(400).json({ success: false, error: NOT_CONFIGURED });
    }
    const result = await test(opts);
    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (err) {
    logger.error('Elasticsearch test failed:', err);
    return res.status(500).json({ success: false, error: 'Elasticsearch 连接测试失败' });
  }
});

// POST /api/v1/monitor/elasticsearch/indices —— 索引族枚举
router.post('/indices', validateBody(elasticsearchSchemas.test), async (req: Request, res) => {
  try {
    const opts = pickClientOptions(req.body);
    if (!opts) {
      return res.status(400).json({ success: false, error: NOT_CONFIGURED });
    }
    const result = await listIndexFamilies(opts);
    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (err) {
    logger.error('Elasticsearch indices failed:', err);
    return res.status(500).json({ success: false, error: '索引族枚举失败' });
  }
});

// POST /api/v1/monitor/elasticsearch/search —— 结构化日志查询（时间窗/级别/主机/SID + 聚合）
router.post('/search', validateBody(elasticsearchSchemas.search), async (req: Request, res) => {
  try {
    const body = req.body as {
      index: string;
      queryString?: string;
      logLevel?: string[];
      hostName?: string;
      sid?: string;
      timeField?: string;
      rangeHours?: number;
      size?: number;
      groupBy?: 'host' | 'level' | 'sid' | 'none';
    };
    const opts = pickClientOptions(req.body);
    if (!opts) {
      return res.status(400).json({ success: false, error: NOT_CONFIGURED });
    }
    const result = await search(opts, {
      index: body.index,
      queryString: body.queryString,
      logLevel: body.logLevel,
      hostName: body.hostName,
      sid: body.sid,
      timeField: body.timeField,
      rangeHours: body.rangeHours,
      size: body.size,
      groupBy: body.groupBy && body.groupBy !== 'none' ? body.groupBy : undefined,
    });
    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (err) {
    logger.error('Elasticsearch search failed:', err);
    return res.status(500).json({ success: false, error: 'Elasticsearch 查询失败' });
  }
});

// POST /api/v1/monitor/elasticsearch/raw-search —— 原生 DSL 透传（仅 _search，size/超时强制上限）
router.post(
  '/raw-search',
  validateBody(elasticsearchSchemas.rawSearch),
  async (req: Request, res) => {
    try {
      const body = req.body as { index: string; dsl: Record<string, unknown> };
      const opts = pickClientOptions(req.body);
      if (!opts) {
        return res.status(400).json({ success: false, error: NOT_CONFIGURED });
      }
      const result = await rawSearch(opts, body.index, body.dsl);
      if (!result.success) {
        return res.status(502).json({ success: false, error: result.error });
      }
      return res.json({ success: true, data: result.data });
    } catch (err) {
      logger.error('Elasticsearch raw search failed:', err);
      return res.status(500).json({ success: false, error: 'Elasticsearch DSL 查询失败' });
    }
  },
);

export default router;
