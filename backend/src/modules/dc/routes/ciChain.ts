import type { Request, Response } from 'express';
import { Router } from 'express';
import { getCiChain } from '../services/ciChainService';
import { logger } from '../../../utils/logger';
import { getErrorMessage } from '../../../utils/errorHelpers';

const router = Router();

// GET /ci-chain — 机柜设备 CI 关系层级展开（逐层懒加载）
//   ?class=&name=                     已知 iTop 类名（节点展开）
//   ?deviceId=&deviceType=&deviceName= 槽位设备首查（服务端解析 class+name）
router.get('/', async (req: Request, res: Response) => {
  try {
    const chain = await getCiChain({
      class: req.query.class as string | undefined,
      name: req.query.name as string | undefined,
      deviceId: req.query.deviceId as string | undefined,
      deviceType: req.query.deviceType as string | undefined,
      deviceName: req.query.deviceName as string | undefined,
    });
    res.json({ success: true, data: chain });
  } catch (error: unknown) {
    logger.error('Failed to resolve CI chain:', error);
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

export default router;
