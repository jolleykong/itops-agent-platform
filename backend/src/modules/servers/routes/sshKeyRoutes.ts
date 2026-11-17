/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Request, Response } from 'express';
import { Router } from 'express';
import { validateBody, validateParams } from '../../../middleware/validation';
import { requireRole } from '../../../middleware/auth';
import { z } from 'zod';
import { sshKeyCrudService } from '../services/sshKeyCrudService';
import { createAuditLog } from '../../audit/services/auditService';

const router = Router();

const sshKeyIdSchema = z.object({ id: z.string().uuid('无效的SSH密钥ID') });

router.get('/', (_req: Request, res: Response) => {
  try {
    const keys = sshKeyCrudService.listKeys();
    res.json({ success: true, data: keys });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to get SSH keys' });
  }
});

// 安全：详情默认脱敏（不下发 password/private_key 密文），且仅 admin 可读
router.get('/:id', requireRole('admin'), validateParams(sshKeyIdSchema), (req: Request & { user?: { id: string; username?: string } }, res: Response) => {
  try {
    const key = sshKeyCrudService.getKeyById(req.params.id);
    if (!key) {
      return res.status(404).json({ success: false, error: 'SSH key not found' });
    }
    const { password: _pw, private_key: _pk, ...safe } = key as Record<string, unknown>;
    res.json({ success: true, data: safe });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to get SSH key' });
  }
});

router.get('/:id/usage', validateParams(sshKeyIdSchema), (req: Request, res: Response) => {
  try {
    const usage = sshKeyCrudService.getKeyUsage(req.params.id);
    res.json({ success: true, data: usage });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to get SSH key usage' });
  }
});

router.post('/', requireRole('admin'), validateBody(z.object({
  name: z.string().min(1, '密钥名称不能为空'),
  auth_type: z.enum(['key', 'password'], { message: '认证类型必须是 key 或 password' }),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  private_key: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
}).refine((data) => {
  if (data.auth_type === 'key') return !!data.private_key;
  if (data.auth_type === 'password') return !!data.username && !!data.password;
  return false;
}, {
  message: 'SSH密钥类型必须提供私钥，用户名密码类型必须提供用户名和密码',
})), (req: Request & { user?: { id: string } }, res: Response) => {
  try {
    const result = sshKeyCrudService.createKey(req.body);
    if (!result.success) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    createAuditLog({
      user_id: req.user?.id || 'unknown',
      action: 'sshkey-create',
      resource_type: 'ssh_key',
      resource_id: result.data.id,
      details: { name: req.body.name, auth_type: req.body.auth_type } as any,
    });
    res.json({ success: true, data: result.data });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to create SSH key' });
  }
});

router.put('/:id', requireRole('admin'), validateParams(sshKeyIdSchema), validateBody(z.object({
  name: z.string().min(1).optional(),
  auth_type: z.enum(['key', 'password']).optional(),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  private_key: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
})), (req: Request & { user?: { id: string } }, res: Response) => {
  try {
    const result = sshKeyCrudService.updateKey(req.params.id, req.body as any);
    if (!result.success) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    createAuditLog({
      user_id: req.user?.id || 'unknown',
      action: 'sshkey-update',
      resource_type: 'ssh_key',
      resource_id: req.params.id,
      details: { fields: Object.keys(req.body) } as any,
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to update SSH key' });
  }
});

router.delete('/:id', requireRole('admin'), validateParams(sshKeyIdSchema), (req: Request & { user?: { id: string } }, res: Response) => {
  try {
    const result = sshKeyCrudService.deleteKey(req.params.id);
    if (!result.success) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    createAuditLog({
      user_id: req.user?.id || 'unknown',
      action: 'sshkey-delete',
      resource_type: 'ssh_key',
      resource_id: req.params.id,
      details: {} as any,
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to delete SSH key' });
  }
});

export default router;
