/**
 * 驱动种类判定（独立成文件，避免迁移文件 import core.ts 造成循环依赖）
 *
 * DB_DRIVER:
 *   sqlite（默认）—— 开发/测试/预览，better-sqlite3
 *   mysql          —— 生产/内网共用数据库，走 mysql/ 下的同步兼容层
 *   pg             —— 目标驱动，尚未启用（repository 层仍是同步 API）
 */
export type DbDriverKind = 'sqlite' | 'mysql' | 'pg';

export const DB_DRIVER_ENV = 'DB_DRIVER';

export function resolveDriverKind(raw: string | undefined = process.env[DB_DRIVER_ENV]): DbDriverKind {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'mysql' || v === 'mariadb') return 'mysql';
  if (v === 'pg' || v === 'postgres' || v === 'postgresql') return 'pg';
  return 'sqlite';
}

export function isMysql(): boolean {
  return resolveDriverKind() === 'mysql';
}

export function isSqlite(): boolean {
  return resolveDriverKind() === 'sqlite';
}
