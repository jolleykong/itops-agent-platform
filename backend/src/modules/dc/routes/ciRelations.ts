import type { Request, Response } from 'express';
import { Router } from 'express';
import { buildRelationGraph, buildRelationSummary } from '../services/ciRelationGraphService';
import { logger } from '../../../utils/logger';
import { getErrorMessage } from '../../../utils/errorHelpers';

const router = Router();

/**
 * GET /ci-relations — CMDB 全量 CI 关系图（一次构建）
 *   ?summary=1   只返回统计与孤立样例（看板首屏，响应小）
 *   ?dup=1       包含 __DUP_* 同步残渣（默认剔除）
 * 只读接口：不写 iTop、不写 cipipe。
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const includeDup = req.query.dup === '1' || req.query.dup === 'true';
    if (req.query.summary === '1' || req.query.summary === 'true') {
      const data = await buildRelationSummary(includeDup);
      res.json({ success: true, data });
      return;
    }
    const data = await buildRelationGraph(includeDup);
    res.json({ success: true, data });
  } catch (error: unknown) {
    logger.error('Failed to build CI relation graph:', error);
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

export default router;
