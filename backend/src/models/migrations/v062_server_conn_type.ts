/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Migration } from './migrationFramework';
import { logger } from '../../utils/logger';

/**
 * Migration v062 — 服务器连接通道（conn_type）
 *
 * 让服务器设备在 SSH 之外支持 Zabbix Agent 监控通道：
 *   - conn_type: 'ssh'（默认，走 SSH 连接池采集/执行） | 'zabbix'（走 Zabbix API 采集，禁止命令执行）
 *   - zabbix_hostid: Zabbix 侧主机 ID（zabbix 通道采集/可用性检测的定位键）
 *
 * 存量数据回填：
 *   - 此前 Zabbix 导入的主机 description 固定为 `Zabbix 导入 | hostid=<id> | host=<host>`，
 *     据此回填 conn_type='zabbix' + zabbix_hostid，并清除 username='zabbix' 占位假凭据
 *     （仅当该主机确实没有配置任何真实 SSH 凭据时才清，避免误伤手工补过凭据的记录）。
 */
const v062ServerConnType: Migration = {
  id: '20250101000062',
  version: 62,
  name: 'server_conn_type',
  description: 'Add conn_type and zabbix_hostid to servers for Zabbix Agent channel support',

  up: async (db: any) => {
    logger.info('🔄 Adding conn_type / zabbix_hostid to servers...');

    const cols = db.prepare("PRAGMA table_info('servers')").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));

    if (!names.has('conn_type')) {
      // SQLite: NOT NULL 列必须带 DEFAULT
      db.exec(`ALTER TABLE servers ADD COLUMN conn_type TEXT NOT NULL DEFAULT 'ssh';`);
    }
    if (!names.has('zabbix_hostid')) {
      db.exec(`ALTER TABLE servers ADD COLUMN zabbix_hostid TEXT;`);
    }
    if (!names.has('conn_type')) return; // 防御：加列失败直接跳过回填

    // 1) 从 description 提取 hostid 并回填通道（此前 Zabbix 导入的记录）
    //    description 形如 `Zabbix 导入 | hostid=1062a5... | host=web01`
    //    hostid 是十六进制串；rtrim 的裁剪字符集 ' |host=' 不含 a-f/0-9，不会误裁 hostid 本身
    db.exec(`
      UPDATE servers
      SET conn_type = 'zabbix',
          zabbix_hostid = rtrim(
            substr(description, instr(description, 'hostid=') + 7),
            ' |host='
          )
      WHERE description LIKE '%Zabbix 导入 | hostid=%'
        AND conn_type = 'ssh'
        AND instr(description, 'hostid=') > 0;
    `);

    // 2) 清除占位假凭据：仅当 username='zabbix' 且从未配置任何真实 SSH 凭据
    db.exec(`
      UPDATE servers
      SET username = ''
      WHERE conn_type = 'zabbix'
        AND username = 'zabbix'
        AND (password IS NULL OR password = '')
        AND (private_key IS NULL OR private_key = '')
        AND (use_ssh_key = 0 OR use_ssh_key IS NULL)
        AND (ssh_key_id IS NULL OR ssh_key_id = '');
    `);

    const zbxCount = (db.prepare("SELECT COUNT(*) AS c FROM servers WHERE conn_type = 'zabbix'").get() as { c: number }).c;
    logger.info(`✅ servers conn_type ready, ${zbxCount} zabbix-channel server(s) backfilled`);
  },

  down: async (db: any) => {
    // SQLite 3.35+ 支持 DROP COLUMN；旧版本忽略失败
    try {
      db.exec(`ALTER TABLE servers DROP COLUMN zabbix_hostid;`);
      db.exec(`ALTER TABLE servers DROP COLUMN conn_type;`);
    } catch (err) {
      logger.warn('v062 down: DROP COLUMN 不受支持，跳过', err);
    }
  },
};

export default v062ServerConnType;
