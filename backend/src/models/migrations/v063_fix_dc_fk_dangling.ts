/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Migration } from './migrationFramework';
import { logger } from '../../utils/logger';

/**
 * Migration v063 — 修复 v058 表重建遗留的外键死链
 *
 * 根因（SQLite 表重建陷阱）：
 *   v058 第 2 步执行 `ALTER TABLE dc_racks RENAME TO _dc_racks_backup` 时，
 *   SQLite ≥3.25 会自动改写所有引用 dc_racks 的外键文本 →
 *   dc_rack_slots / dc_power_feeds 的 FK 被改写为 REFERENCES "_dc_racks_backup"(id)。
 *   随后新建 dc_racks、删除备份表后，这两个表的 FK 指向不存在的表。
 *
 * 影响（foreign_keys=ON 时）：
 *   - 任何对 dc_rack_slots 的写入/删除都报 `no such table: main._dc_racks_backup`
 *   - 连带触发器 trg_servers_delete_clear_slots → **删除任意服务器必 500**
 *
 * 修复：重建 dc_rack_slots / dc_power_feeds，FK 指回 dc_racks，保留数据与索引。
 */
const v063FixDcFkDangling: Migration = {
  id: '20250101000063',
  version: 63,
  name: 'fix_dc_fk_dangling_backup_ref',
  description: 'Rebuild dc_rack_slots / dc_power_feeds whose FK points to dropped _dc_racks_backup',

  up: async (db: any) => {
    logger.info('🔄 Fixing dangling FK references to _dc_racks_backup...');

    const getDdl = (table: string): string =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { sql: string } | undefined)?.sql || '';

    db.exec(`PRAGMA foreign_keys=OFF;`);

    // DROP TABLE 时 SQLite 会重新校验所有引用该表的触发器，
    // 必须先摘掉引用 dc_rack_slots / dc_power_feeds 的全部触发器，重建后逐一恢复
    const affectedTriggers = (db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type='trigger' AND (sql LIKE '%dc_rack_slots%' OR sql LIKE '%dc_power_feeds%')
    `).all() as Array<{ name: string; sql: string }>);
    for (const t of affectedTriggers) {
      logger.info(`  → temporarily dropping trigger ${t.name}`);
      db.exec(`DROP TRIGGER IF EXISTS "${t.name}";`);
    }

    try {
      // ── dc_rack_slots ──
      const slotsDdl = getDdl('dc_rack_slots');
      if (slotsDdl && slotsDdl.includes('_dc_racks_backup')) {
        logger.info('  → Rebuilding dc_rack_slots (FK → dc_racks)');
        db.exec(`
          CREATE TABLE dc_rack_slots_fixed (
            id TEXT PRIMARY KEY,
            rack_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            device_type TEXT NOT NULL CHECK(device_type IN ('server','network_device','vm_host','pdu','ups','other')),
            device_type_id TEXT,
            start_u INTEGER NOT NULL,
            end_u INTEGER NOT NULL,
            position_face TEXT DEFAULT 'front',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (rack_id) REFERENCES dc_racks(id) ON DELETE CASCADE,
            FOREIGN KEY (device_type_id) REFERENCES device_types(id) ON DELETE SET NULL
          );
          INSERT OR IGNORE INTO dc_rack_slots_fixed SELECT * FROM dc_rack_slots;
          DROP TABLE dc_rack_slots;
          ALTER TABLE dc_rack_slots_fixed RENAME TO dc_rack_slots;
          CREATE INDEX IF NOT EXISTS idx_dc_rack_slots_rack ON dc_rack_slots(rack_id);
          CREATE INDEX IF NOT EXISTS idx_dc_rack_slots_device ON dc_rack_slots(device_id);
        `);
        logger.info('  ✓ dc_rack_slots rebuilt');
      } else if (slotsDdl) {
        logger.info('  ✓ dc_rack_slots FK already correct');
      }

      // ── dc_power_feeds ──
      const feedsDdl = getDdl('dc_power_feeds');
      if (feedsDdl && feedsDdl.includes('_dc_racks_backup')) {
        logger.info('  → Rebuilding dc_power_feeds (FK → dc_racks)');
        db.exec(`
          CREATE TABLE dc_power_feeds_fixed (
            id TEXT PRIMARY KEY,
            power_panel_id TEXT NOT NULL,
            rack_id TEXT DEFAULT NULL,
            name TEXT NOT NULL,
            status TEXT DEFAULT 'active' CHECK(status IN ('active','planned','failed','decommissioned')),
            feed_type TEXT DEFAULT 'primary' CHECK(feed_type IN ('primary','redundant')),
            supply TEXT DEFAULT 'ac' CHECK(supply IN ('ac','dc')),
            voltage REAL DEFAULT 220,
            amperage REAL DEFAULT 16,
            max_utilization_pct REAL DEFAULT 80,
            current_load_w REAL DEFAULT 0,
            description TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (power_panel_id) REFERENCES dc_power_panels(id) ON DELETE RESTRICT,
            FOREIGN KEY (rack_id) REFERENCES dc_racks(id) ON DELETE SET NULL
          );
          INSERT OR IGNORE INTO dc_power_feeds_fixed SELECT * FROM dc_power_feeds;
          DROP TABLE dc_power_feeds;
          ALTER TABLE dc_power_feeds_fixed RENAME TO dc_power_feeds;
          CREATE INDEX IF NOT EXISTS idx_dc_power_feeds_panel ON dc_power_feeds(power_panel_id);
          CREATE INDEX IF NOT EXISTS idx_dc_power_feeds_rack ON dc_power_feeds(rack_id);
        `);
        logger.info('  ✓ dc_power_feeds rebuilt');
      } else if (feedsDdl) {
        logger.info('  ✓ dc_power_feeds FK already correct');
      }
    } finally {
      // 逐个恢复摘除的触发器
      for (const t of affectedTriggers) {
        if (t.sql) {
          db.exec(t.sql);
          logger.info(`  ✓ trigger ${t.name} restored`);
        }
      }
      db.exec(`PRAGMA foreign_keys=ON;`);
    }

    logger.info('✅ Dangling DC FK references fixed');
  },

  down: async (_db: any) => {
    logger.warn('v063 down: 不还原死链 FK（保留修复后的正确约束）');
  },
};

export default v063FixDcFkDangling;
