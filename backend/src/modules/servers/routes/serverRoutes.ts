/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Request, Response } from 'express';
import { Router } from 'express';
import { validateBody, validateParams } from '../../../middleware/validation';
import { serverSchemas } from '../../../shared/schemas/apiValidation';
import { requireRole } from '../../../middleware/auth';
import { serverCrudService } from '../services/serverCrudService';
import { classifyServerAsset, type ServerAssetCategory } from '../services/serverAssetCategory';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const servers = serverCrudService.listServers();
    // 资产分层过滤（可选）：?category=hardware|os|storage —— 数据不移动，仅视图分流
    const category = req.query.category as ServerAssetCategory | undefined;
    if (category && ['hardware', 'os', 'storage'].includes(category)) {
      const filtered = servers.filter((s: { name: string; description?: string }) =>
        classifyServerAsset(s.name, s.description) === category,
      );
      return res.json({ success: true, data: filtered });
    }
    res.json({ success: true, data: servers });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to get servers' });
  }
});

/** 资产分层统计：三个视图的设备数（侧边栏徽标 / 页头统计用） */
router.get('/asset-summary', (_req: Request, res: Response) => {
  try {
    const servers = serverCrudService.listServers() as Array<{ name: string; description?: string }>;
    const summary = { hardware: 0, os: 0, storage: 0, total: servers.length };
    for (const s of servers) summary[classifyServerAsset(s.name, s.description)]++;
    res.json({ success: true, data: summary });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to get asset summary' });
  }
});

router.get('/:id', validateParams(serverSchemas.serverId), (req: Request, res: Response) => {
  try {
    const server = serverCrudService.getServerById(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }
    res.json({ success: true, data: server });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to get server' });
  }
});

router.post('/', validateBody(serverSchemas.createServer), requireRole('admin', 'operator'), (req: Request, res: Response) => {
  try {
    const result = serverCrudService.createServer(req.body as any);
    res.json(result);
  } catch {
    res.status(500).json({ success: false, error: 'Failed to create server' });
  }
});

router.put('/:id', validateParams(serverSchemas.serverId), validateBody(serverSchemas.updateServer), requireRole('admin', 'operator'), (req: Request, res: Response) => {
  try {
    const result = serverCrudService.updateServer(req.params.id, req.body as any);
    if (!result.success) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to update server' });
  }
});

router.delete('/:id', validateParams(serverSchemas.serverId), requireRole('admin', 'operator'), (req: Request, res: Response) => {
  try {
    serverCrudService.deleteServer(req.params.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to delete server' });
  }
});

router.get('/:id/command-history', validateParams(serverSchemas.serverId), (req: Request, res: Response) => {
  try {
    const history = serverCrudService.listCommandHistory(req.params.id);
    res.json({ success: true, data: history });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to get command history' });
  }
});

router.get('/:id/compliance-history', validateParams(serverSchemas.serverId), (req: Request, res: Response) => {
  try {
    const checks = serverCrudService.listComplianceChecks(req.params.id);
    res.json({ success: true, data: checks });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to get compliance history' });
  }
});

router.get('/:id/command-history/export', validateParams(serverSchemas.serverId), (req: Request, res: Response) => {
  try {
    const result = serverCrudService.exportCommandHistory(req.params.id);
    if (!result.success) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="command-history-${req.params.id}-${Date.now()}.json"`);
    res.json(result.data);
  } catch {
    res.status(500).json({ success: false, error: 'Failed to export command history' });
  }
});

router.get('/:id/compliance-history/export', validateParams(serverSchemas.serverId), (req: Request, res: Response) => {
  try {
    const result = serverCrudService.exportComplianceHistory(req.params.id);
    if (!result.success) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="compliance-history-${req.params.id}-${Date.now()}.json"`);
    res.json(result.data);
  } catch {
    res.status(500).json({ success: false, error: 'Failed to export compliance history' });
  }
});

export default router;
