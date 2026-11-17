/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Request, Response } from 'express';
import { Router } from 'express';
import { executeCommand, testConnection, runComplianceCheck, complianceChecks } from '../services/sshService';
import { serversRepo } from '../../../repositories/serverRepository';
import { logger } from '../../../utils/logger';
import { requireRole } from '../../../middleware/auth';
import { validateBody, validateParams } from '../../../middleware/validation';
import { commonSchemas, serverCommandSchemas } from '../../../shared/schemas/apiValidation';
import { createAuditLog } from '../../audit/services/auditService';

const router = Router();

router.post('/:id/test', requireRole('admin', 'operator'), validateParams(commonSchemas.idParam), async (req: Request, res: Response) => {
  try {
    const result = await testConnection(req.params.id);
    res.json({ success: result.success, data: result });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to test connection' });
  }
});

router.post('/:id/exec', requireRole('admin', 'operator'), validateParams(commonSchemas.idParam), validateBody(serverCommandSchemas.execCommand), async (req: Request & { user?: { id: string } }, res: Response) => {
  try {
    const { command, timeout, ssh_key_id, persist_ssh_key } = req.body;
    const userId = req.user?.id || 'unknown';

    // 通过 auditService 记录命令审计（避免 routes 直访 auditLogRepository）
    createAuditLog({
      user_id: userId,
      action: 'command-execute',
      resource_type: 'server',
      resource_id: req.params.id,
      details: { command, isSafe: true, warnings: [], ssh_key_id: ssh_key_id || undefined, persist_ssh_key: !!persist_ssh_key } as any,
    });

    // "保持密钥"：把本次指定的凭据持久化关联到服务器（下次默认选中）
    if (persist_ssh_key && ssh_key_id) {
      serversRepo.update(req.params.id, { ssh_key_id } as any);
      logger.info(`🔑 SSH credential ${ssh_key_id} persisted to server ${req.params.id}`);
    }

    const result = await executeCommand(req.params.id, command, {
      timeout,
      executedBy: userId,
      sshKeyId: ssh_key_id || undefined,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to execute command' });
  }
});

router.get('/compliance/checks', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: complianceChecks.map((check) => ({
      name: check.name,
      command: check.command,
    })),
  });
});

router.post('/:id/compliance', requireRole('admin', 'operator'), async (req: Request, res: Response) => {
  try {
    const saveResults = req.body.saveResults !== false;
    const useAI = req.body.useAI !== false;
    const concurrency = req.body.concurrency || 5;

    const results = await runComplianceCheck(req.params.id, {
      saveResults,
      useAI,
      concurrency,
    });

    res.json({ success: true, data: results });
  } catch (error) {
    logger.error('Compliance check error:', error);
    res.status(500).json({ success: false, error: 'Failed to run compliance check' });
  }
});

export default router;
