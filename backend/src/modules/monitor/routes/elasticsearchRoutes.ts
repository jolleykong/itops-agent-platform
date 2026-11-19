import { Router, type Request } from 'express';
import { logger } from '../../../utils/logger';
import { validateBody } from '../../../middleware/validation';
import { elasticsearchSchemas } from '../../../shared/schemas/apiValidation';
import {
  test,
  listIndexFamilies,
  search,
  rawSearch,
  type EsClientOptions,
} from '../services/elasticsearchService';

const router = Router();

function pickClientOptions(body: Record<string, unknown>): EsClientOptions {
  const b = body as {
    url: string;
    username?: string;
    password?: string;
    timeoutMs?: number;
  };
  return {
    url: b.url,
    basicAuth: b.username ? { username: b.username, password: b.password ?? '' } : undefined,
    timeoutMs: b.timeoutMs,
  };
}

// POST /api/v1/monitor/elasticsearch/test —— 连接测试（size=0 聚合，兼容 viewer 只读角色）
router.post('/test', validateBody(elasticsearchSchemas.test), async (req: Request, res) => {
  try {
    const result = await test(pickClientOptions(req.body));
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
    const result = await listIndexFamilies(pickClientOptions(req.body));
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
    const result = await search(pickClientOptions(req.body), {
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
      const result = await rawSearch(pickClientOptions(req.body), body.index, body.dsl);
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
