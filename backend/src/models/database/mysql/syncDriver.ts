/**
 * better-sqlite3 → MySQL/MariaDB 同步驱动兼容层
 *
 * 目标：让 1016 处 `db.prepare(sql).run/get/all`、241 处 `db.exec`、15 处
 * `db.transaction` 在切换数据库后**一行都不用改**。
 *
 * 实现要点
 *  1. mysql2 跑在 worker 线程里，主线程用 receiveMessageOnPort + Atomics.wait
 *     同步取结果。主线程阻塞会挡住自己的事件循环，但 mysql 的 IO 在 worker 的
 *     事件循环里照常推进，因此不会死锁（这是 Node 官方提供的同步 IPC 用法）。
 *  2. SQL 文本在 prepare/exec 时经 dialect.ts 翻译成 MySQL 方言。
 *  3. 事务：`transaction(fn)` 返回包装函数，内部 BEGIN/COMMIT/ROLLBACK；
 *     嵌套时降级为 SAVEPOINT，和 better-sqlite3 的语义一致。
 */
import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'worker_threads';
import path from 'path';
import { logger } from '../../../utils/logger';
import { translateStatement, splitStatements, parseCreateIndex } from './dialect';

export interface MysqlDriverConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** 单条语句超时（毫秒）。全量同步时的批量写入可能较慢，默认 60s */
  timeoutMs?: number;
}

interface WorkerReply {
  id?: number;
  type?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; errno?: number; message?: string; sql?: string };
  [k: string]: unknown;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

const IDENT = /[\w$]/;

/** 把 better-sqlite3 的 `@name` / `:name` / `$name` 命名参数换成 MySQL 的 `?` */
function bindNamed(sql: string, obj: Record<string, unknown>): { sql: string; params: unknown[] } {
  let out = '';
  const params: unknown[] = [];
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '@' || c === ':' || c === '$') {
      // @@ 是 MySQL 系统变量，原样保留
      if (c === '@' && sql[i + 1] === '@') {
        out += '@@';
        i++;
        continue;
      }
      let j = i + 1;
      let name = '';
      while (j < sql.length && IDENT.test(sql[j])) {
        name += sql[j];
        j++;
      }
      if (name) {
        if (!(name in obj)) throw new Error(`命名参数缺失: ${name}`);
        out += '?';
        params.push(obj[name] === undefined ? null : obj[name]);
        i = j - 1;
        continue;
      }
    }
    out += c;
  }
  return { sql: out, params };
}

function normalizeArgs(args: unknown[]): { positional: unknown[] | null; named: Record<string, unknown> | null } {
  if (args.length === 1) {
    const a = args[0];
    if (Array.isArray(a)) return { positional: a, named: null };
    if (a && typeof a === 'object' && !(a instanceof Date) && !Buffer.isBuffer(a)) {
      return { positional: null, named: a as Record<string, unknown> };
    }
  }
  return { positional: args.map((v) => (v === undefined ? null : v)), named: null };
}

class MysqlStatement {
  private readonly rawSql: string;
  private cachedTranslated: string | null = null;

  constructor(private readonly drv: MysqlSyncDriver, sql: string) {
    this.rawSql = sql;
  }

  /** 兼容 better-sqlite3 的链式修饰（仓库内未使用，保证不会因存在性检查报错） */
  raw(): this {
    return this;
  }
  pluck(): this {
    return this;
  }
  expand(): this {
    return this;
  }
  safeIntegers(): this {
    return this;
  }
  columns(): unknown[] {
    return [];
  }
  iterate(): IterableIterator<unknown> {
    return this.all()[Symbol.iterator]();
  }
  bind(): this {
    return this;
  }

  private translated(): string {
    if (this.cachedTranslated === null) {
      this.cachedTranslated = translateStatement(this.rawSql);
    }
    return this.cachedTranslated;
  }

  private execute(args: unknown[]): unknown {
    const { positional, named } = normalizeArgs(args);
    let sql = this.translated();
    let params: unknown[] = positional ?? [];
    if (named) {
      const bound = bindNamed(sql, named);
      sql = bound.sql;
      params = bound.params;
    }
    return this.drv.query(sql, params);
  }

  run(...args: unknown[]): RunResult {
    const r = this.execute(args) as { affectedRows?: number; insertId?: number } | unknown[];
    if (Array.isArray(r)) return { changes: r.length, lastInsertRowid: 0 };
    return {
      changes: r?.affectedRows ?? 0,
      lastInsertRowid: r?.insertId ?? 0,
    };
  }

  get(...args: unknown[]): unknown {
    const rows = this.execute(args);
    return Array.isArray(rows) ? (rows[0] as unknown) : undefined;
  }

  all(...args: unknown[]): unknown[] {
    const rows = this.execute(args);
    return Array.isArray(rows) ? (rows as unknown[]) : [];
  }
}

/**
 * 与 better-sqlite3 的 `Database` 同形的同步门面。
 * 类型上用 `as unknown as Database.Database` 交回调用方，避免改动 1000+ 处签名。
 */
export class MysqlSyncDriver {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly ctl: Int32Array;
  private readonly timeoutMs: number;
  private seq = 0;
  private txDepth = 0;
  private closed = false;
  private readyError: string | null = null;

  constructor(cfg: MysqlDriverConfig) {
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    const signal = new SharedArrayBuffer(4);
    this.ctl = new Int32Array(signal);

    const workerPath = path.join(__dirname, 'worker.js');
    this.worker = new Worker(workerPath, {
      workerData: {
        cfg: {
          host: cfg.host,
          port: cfg.port,
          user: cfg.user,
          password: cfg.password,
          database: cfg.database,
        },
        port: port2,
        signal,
      },
      transferList: [port2],
    });
    this.worker.unref();
    this.worker.on('error', (err) => {
      logger.error(`❌ MySQL worker 异常: ${err.message}`);
    });

    this.awaitReady();
    if (this.readyError) {
      throw new Error(`MySQL 连接失败：${this.readyError}`);
    }
    logger.info(
      `🗄️ MySQL 已连接 ${cfg.host}:${cfg.port}/${cfg.database} (user=${cfg.user}, 同步兼容层)`,
    );
  }

  /** 阻塞等到 worker 报 ready（或超时） */
  private awaitReady(): void {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const got = receiveMessageOnPort(this.port);
      if (got) {
        const m = got.message as WorkerReply;
        if (m.type === 'ready') {
          this.readyError = (m.error as string | null) ?? null;
          return;
        }
        continue;
      }
      if (Date.now() > deadline) {
        this.readyError = '连接超时（20s）';
        return;
      }
      Atomics.wait(this.ctl, 0, 0, 20);
      Atomics.store(this.ctl, 0, 0);
    }
  }

  /** 同步执行一条已翻译好的 SQL */
  query(sql: string, params: unknown[] = []): unknown {
    if (this.closed) throw new Error('MySQL 连接已关闭');
    const id = ++this.seq;
    this.port.postMessage({ type: 'query', id, sql, params });
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const got = receiveMessageOnPort(this.port);
      if (got) {
        const m = got.message as WorkerReply;
        // 非本条请求的消息（连接级通知）丢弃
        if (m.id !== id) continue;
        if (!m.ok) {
          const err = new Error(m.error?.message ?? 'MySQL 执行失败') as Error & {
            code?: string;
            errno?: number;
            sql?: string;
          };
          err.code = m.error?.code;
          err.errno = m.error?.errno;
          err.sql = m.error?.sql;
          throw err;
        }
        return m.result;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`MySQL 查询超时(${this.timeoutMs}ms): ${sql.slice(0, 160)}`);
      }
      Atomics.wait(this.ctl, 0, 0, Math.min(left, 25));
      Atomics.store(this.ctl, 0, 0);
    }
  }

  // ── better-sqlite3 形态的公开 API ─────────────────────────────

  prepare(sql: string): MysqlStatement {
    return new MysqlStatement(this, sql);
  }

  exec(script: string): this {
    const statements = splitStatements(script);
    for (const raw of statements) {
      let stmt = translateStatement(raw);
      if (!stmt.trim()) continue;
      if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(stmt)) stmt = this.addIndexPrefixes(stmt);
      if (/^CREATE\s+TABLE\b/i.test(stmt) && /FOREIGN\s+KEY/i.test(stmt)) {
        stmt = this.pruneUnsupportedForeignKeys(stmt);
        // 去掉 FK 后可能留下 ", )"
        stmt = stmt.replace(/,\s*\)/g, ')');
      }
      try {
        this.query(stmt);
      } catch (err) {
        const code = (err as { code?: string }).code;
        // 幂等兜底：IF NOT EXISTS 之外的重复索引/表
        if (code === 'ER_DUP_KEYNAME' || code === 'ER_TABLE_EXISTS_ERROR') {
          logger.debug(`exec 幂等跳过: ${stmt.slice(0, 120)}`);
          continue;
        }
        // DROP INDEX IF EXISTS `x`（SQLite 允许省略 ON table）
        if (/^DROP\s+INDEX\s+IF\s+EXISTS/i.test(stmt)) {
          logger.debug(`DROP INDEX 忽略: ${stmt.slice(0, 120)}`);
          continue;
        }
        // 把出错的那条 SQL 带进错误信息：迁移脚本里动辄几十条 DDL，
        // 只报 "Specified key was too long" 无法定位是哪张表
        const e = err as Error;
        e.message = `${e.message}\n  SQL: ${stmt.replace(/\s+/g, ' ').slice(0, 600)}`;
        throw e;
      }
    }
    return this;
  }

  /** 表 → 列类型缓存（CREATE INDEX 补前缀长度用） */
  private readonly colTypes = new Map<string, Map<string, string>>();

  private tableColTypes(table: string): Map<string, string> {
    const cached = this.colTypes.get(table);
    if (cached) return cached;
    const map = new Map<string, string>();
    try {
      const rows = this.query(
        `SELECT COLUMN_NAME AS n, DATA_TYPE AS t FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ?`,
        [table],
      ) as Array<{ n: string; t: string }>;
      for (const r of rows) map.set(String(r.n).toLowerCase(), String(r.t).toLowerCase());
    } catch {
      /* 表不存在时保持空表，调用方按原名执行 */
    }
    // 空结果不缓存：表可能在后续语句里才被创建
    if (map.size > 0) this.colTypes.set(table, map);
    return map;
  }

  /**
   * InnoDB 单索引最大 3072 字节，utf8mb4 下 TEXT/LONGTEXT 列直接进索引会超限。
   * 按真实列类型给 TEXT 列补前缀长度（MariaDB 不会自动加）。
   */
  private addIndexPrefixes(stmt: string): string {
    const p = parseCreateIndex(stmt);
    if (!p) return stmt;
    const types = this.tableColTypes(p.table);
    const prefix = p.cols.length >= 4 ? 64 : 191;
    const cols = p.cols.map((raw) => {
      if (raw.includes('(')) return raw; // 已带前缀长度或函数表达式
      // 支持 `col DESC` / `col ASC` 的排序后缀
      const m = raw.match(/^(`?[\w$]+`?)(\s+(?:ASC|DESC))?$/i);
      if (!m) return raw;
      const [, name, order = ''] = m;
      const bare = name.replace(/`/g, '').trim().toLowerCase();
      const t = types.get(bare);
      const pfx = t && /text|blob/.test(t) ? `(${prefix})` : '';
      return `${name}${pfx}${order}`;
    });
    // 部分索引（`… WHERE x IS NOT NULL`）MySQL 不支持。
    // 仓库里只有 `WHERE ip_address IS NOT NULL` 这种形态，而 MySQL 的 UNIQUE
    // 本来就不把多行 NULL 当重复，去掉条件语义等价。
    let tail = p.tail ?? '';
    if (/\bWHERE\b/i.test(tail)) {
      logger.warn(`去掉 MySQL 不支持的部分索引条件: ${p.name}${tail.replace(/\s+/g, ' ').slice(0, 120)}`);
      tail = tail.replace(/\s+WHERE\b[\s\S]*$/i, '');
    }
    return `CREATE ${p.unique ? 'UNIQUE ' : ''}INDEX ${p.ifNotExists ? 'IF NOT EXISTS ' : ''}${p.name} ON \`${p.table}\` (${cols.join(', ')})${tail}`;
  }

  /**
   * 外键兜底：MySQL 要求 FK 两侧列类型完全一致且父列必须有索引。
   * SQLite 侧存在两类 MySQL 无法满足的写法：
   *   1. 引用非主键的 TEXT 列（如 users.username UNIQUE + TEXT），父列被映射成 LONGTEXT；
   *   2. 引用的表在本语句之后才创建（前向引用）。
   * 这两种情况直接去掉该条 FK（保留列与数据），并记一条 warn —— 否则整张表建不出来。
   */
  private pruneUnsupportedForeignKeys(stmt: string): string {
    const fkRe =
      /(?:,\s*)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+`?([\w$]+)`?\s*\(([^)]*)\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))*(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))*)/gi;

    return stmt.replace(fkRe, (whole: string, _cols: string, table: string, refCol: string) => {
      const types = this.tableColTypes(table);
      if (types.size === 0) {
        logger.warn(`跳过前向引用外键: ${table}（表尚未创建）`);
        return '';
      }
      const t = types.get(String(refCol).replace(/`/g, '').trim().toLowerCase()) ?? '';
      if (/^(longtext|text|mediumtext|tinytext|longblob|blob)$/.test(t)) {
        logger.warn(`跳过外键: 父列 ${table}.${refCol} 在 MySQL 下是 ${t}，无法作为外键目标`);
        return '';
      }
      return whole;
    });
  }

  pragma(expr: string): unknown[] {
    const e = expr.trim();
    if (e.includes('=')) return []; // 各类 WAL/缓存开关，MySQL 下无对应物
    const key = e.toLowerCase();
    if (key.startsWith('wal_checkpoint')) return [];
    if (key.startsWith('foreign_key_check')) return [];
    if (key === 'integrity_check' || key === 'quick_check') return [{ integrity_check: 'ok' }];
    if (key === 'page_size') return [{ page_size: 16384 }];
    if (key === 'page_count') return [{ page_count: 0 }];
    if (key === 'freelist_count') return [{ freelist_count: 0 }];
    if (key === 'cache_size') return [{ cache_size: 0 }];
    if (key.startsWith('table_info')) {
      const table = e.replace(/^table_info\s*\(\s*|\s*\)$/g, '');
      const rows = this.query(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS notnull, COLUMN_DEFAULT AS dflt_value,
                CASE WHEN COLUMN_KEY='PRI' THEN 1 ELSE 0 END AS pk
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ?`,
        [table],
      ) as Array<{ notnull: string }>;
      return rows.map((r) => ({ ...r, notnull: r.notnull === 'NO' ? 1 : 0 }));
    }
    return [];
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    const self = this;
    const wrapped = function (...args: never[]): unknown {
      const depth = self.txDepth++;
      const sp = `itops_sp_${depth}`;
      if (depth === 0) self.query('START TRANSACTION');
      else self.query(`SAVEPOINT ${sp}`);
      try {
        const out = fn(...args);
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          throw new Error(
            'db.transaction() 的回调必须是同步函数：MySQL 兼容层用 BEGIN/COMMIT 包裹同步调用',
          );
        }
        if (depth === 0) self.query('COMMIT');
        else self.query(`RELEASE SAVEPOINT ${sp}`);
        return out;
      } catch (err) {
        try {
          if (depth === 0) self.query('ROLLBACK');
          else self.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        } catch {
          /* 回滚失败不掩盖原始错误 */
        }
        throw err;
      } finally {
        self.txDepth--;
      }
    };
    return wrapped as unknown as T;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port.postMessage({ type: 'quit' });
    } catch {
      /* ignore */
    }
    void this.worker.terminate();
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  get readOnly(): boolean {
    return false;
  }

  get name(): string {
    return 'mysql';
  }
}
