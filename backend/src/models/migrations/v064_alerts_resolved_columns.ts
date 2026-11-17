/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Migration } from './migrationFramework';
import { logger } from '../../utils/logger';

/**
 * Migration v064 — alerts 表补齐恢复（resolved）列
 *
 * 背景：alertRepository/coreAlerts.ts 的 resolveAutoByExternalId / resolveAutoByHost
 * 引用了 resolved_at / resolved_by / resolution_notes 三列，但 v001 建表时
 * 并未包含它们（只有 status/updated_at）→ Zabbix webhook 推送恢复事件
 * （EVENT.VALUE=0）时自动关闭告警报 `no such column: resolved_at`，恢复链路断裂。
 *
 * 本迁移为 alerts 表追加三列（SQLite ALTER TABLE ADD COLUMN，不影响存量数据）。
 */
const v064AlertsResolvedColumns: Migration = {
  id: '20250101000064',
  version: 64,
  name: 'alerts_resolved_columns',
  description: 'Add resolved_at / resolved_by / resolution_notes columns to alerts',

  up: async (db: any) => {
    const cols = (db.prepare(`PRAGMA table_info(alerts)`).all() as Array<{ name: string }>).map((c) => c.name);
    const stmts: Array<[string, string]> = [
      ['resolved_at', `ALTER TABLE alerts ADD COLUMN resolved_at TEXT`],
      ['resolved_by', `ALTER TABLE alerts ADD COLUMN resolved_by TEXT`],
      ['resolution_notes', `ALTER TABLE alerts ADD COLUMN resolution_notes TEXT`],
    ];
    for (const [col, sql] of stmts) {
      if (!cols.includes(col)) {
        db.exec(sql);
        logger.info(`✅ alerts.${col} added`);
      } else {
        logger.info(`ℹ️ alerts.${col} already exists, skip`);
      }
    }
  },
};

export default v064AlertsResolvedColumns;
