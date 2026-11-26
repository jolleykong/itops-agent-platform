/**
 * SQLite → MySQL/MariaDB 方言转换
 *
 * 背景：平台的数据访问层是 better-sqlite3 的**同步** API（1016 处 `db.prepare`），
 * 全部改写成异步 mysql2 等于重写整个 repository 层。这里走另一条路：
 * 保留同步调用形态（见 syncDriver.ts 的 worker 桥），只在这一层把 SQL 文本
 * 从 SQLite 方言翻成 MySQL 方言，业务代码零改动。
 *
 * 覆盖范围 = 本仓库实际用到的语法子集，逐项对照过 grep 统计：
 *   datetime('now'…) 474 / INSERT OR IGNORE 42 / INSERT OR REPLACE 17 /
 *   ON CONFLICT 14 / AUTOINCREMENT 6 / julianday 12 / strftime 2 / sqlite_master 16
 *
 * 未覆盖也不打算覆盖的：WITHOUT ROWID、GLOB、窗口函数特殊语法、
 * RETURNING（仓库内 0 处）、CREATE TRIGGER 的 RAISE(ABORT) 形态（见 isSqliteOnly 注释）。
 */

/** 语句首关键字判定（去掉前导空白与注释后） */
function firstKeyword(stmt: string): string {
  const s = stmt.trimStart();
  return (s.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
}

/** 按顶层逗号切分（忽略括号内、引号内、注释内的逗号） */
export function splitTopLevel(body: string, sep = ','): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      buf += c;
      if (c === quote) {
        // 处理 '' 转义
        if (body[i + 1] === quote) {
          buf += body[i + 1];
          i++;
        } else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/**
 * 把一段脚本切成单条语句。
 * 处理：行注释 `--`/`#`、块注释、字符串字面量、CREATE TRIGGER 的 BEGIN…END 体。
 */
export function splitStatements(script: string): string[] {
  const stmts: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  // BEGIN…END 体内的分号不能当语句分隔
  let inTriggerBody = false;

  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    const next = script[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        buf += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      buf += c;
      if (c === quote) {
        if (next === quote) {
          buf += next;
          i++;
        } else quote = null;
      }
      continue;
    }

    if (c === '-' && next === '-') {
      // MySQL 要求 `-- ` 带空白才算注释；SQLite 不要求。统一按注释处理。
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '#') {
      inLineComment = true;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === ';') {
      const head = firstKeyword(buf);
      if (/TRIGGER$/.test(buf.trim().slice(0, 40).toUpperCase()) && head === 'CREATE') {
        inTriggerBody = true;
      }
      if (inTriggerBody && !/^END$/i.test(buf.trim().split('\n').pop()?.trim() ?? '')) {
        buf += c;
        continue;
      }
      inTriggerBody = false;
      stmts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) stmts.push(buf.trim());
  return stmts.filter((s) => s.length > 0);
}

/**
 * SQLite 允许把 MySQL 保留字当表名/列名，仓库里实际命中的只有三个（实测建表验证过）：
 *   settings.key    → KEY 是保留字
 *   databases       → 表名，DATABASES 是保留字
 *   dc_racks.row_number 等 → ROW_NUMBER 是保留字
 * 其余如 name/status/type/value/id 在 MariaDB 里是非保留关键字，可裸用。
 *
 * 这里只在这三个词处于「标识符位置」时补反引号，避免误伤
 * PRIMARY KEY / FOREIGN KEY / UNIQUE KEY / ON DUPLICATE KEY UPDATE / ROW_NUMBER() 等语法。
 */
const RESERVED_NAMES = new Set(['key', 'databases', 'row_number']);

/**
 * 派生表补别名。
 * SQLite 允许 `FROM (SELECT …)` 不带别名，MySQL 必须写成 `FROM (SELECT …) AS t`，
 * 否则报 `syntax error near ') as used_u'`（dc_racks 的 used_u 聚合就是这么挂的）。
 * 只处理紧跟在 FROM / JOIN 之后的 `(`——SELECT 列表里的标量子查询不能被加别名。
 */
function addDerivedTableAliases(sql: string): string {
  const re = /\b(?:FROM|JOIN)\s*\(/gi;
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) hits.push(m.index + m[0].length - 1); // 指向 '('

  let out = sql;
  let n = 0;
  // 从右往左处理，位置索引不受影响
  for (let k = hits.length - 1; k >= 0; k--) {
    const open = hits[k];
    let depth = 0;
    let quote: string | null = null;
    let close = -1;
    for (let i = open; i < out.length; i++) {
      const c = out[i];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    const trimmed = out.slice(close + 1).replace(/^\s+/, '');
    const isKeywordAfter = /^(WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|ON|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|USING|WINDOW|SET|VALUES)\b/i.test(
      trimmed,
    );
    const endsHere = trimmed === '' || /^[,);]/.test(trimmed);
    // 已带别名（`AS x` 或裸标识符）就跳过
    if (!endsHere && !isKeywordAfter && /^(?:AS\s+)?[`\w]+/i.test(trimmed)) continue;
    if (endsHere || isKeywordAfter) {
      out = `${out.slice(0, close + 1)} AS __dt${n++}${out.slice(close + 1)}`;
    }
  }
  return out;
}

/**
 * 列级 `REFERENCES t(c)`（SQLite 允许写在列定义里）。
 * MySQL 在 CREATE TABLE 里是「解析但忽略」，在 ALTER TABLE … ADD COLUMN 里却会真的去建 FK，
 * 而 TEXT 列建不了外键 → 直接报 errno 1005。统一剥掉，保留表级 FOREIGN KEY 约束不动。
 */
function stripInlineReferences(sql: string): string {
  const re =
    /\s+REFERENCES\s+`?[\w$]+`?\s*\([^)]*\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT))*)/gi;
  return sql.replace(re, (whole: string, _tail: string, offset: number, src: string) => {
    const before = src.slice(Math.max(0, offset - 120), offset);
    if (/FOREIGN\s+KEY\s*\([^)]*\)\s*$/i.test(before)) return whole; // 表级约束，保留
    return '';
  });
}

/** 单个标识符按需加反引号（建表/建索引时表名是自己拼出去的，走不到全局替换） */
export function quoteIdent(name: string): string {
  const bare = name.replace(/`/g, '');
  return RESERVED_NAMES.has(bare.toLowerCase()) ? `\`${bare}\`` : bare;
}

function quoteReservedIdents(sql: string): string {
  let s = sql;

  // key
  s = s.replace(/\bkey\b/gi, (m, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 24), offset);
    if (before.endsWith('`')) return m; // 已转义
    if (/\b(PRIMARY|FOREIGN|UNIQUE|DUPLICATE)\s+$/i.test(before)) return m; // PRIMARY KEY / ON DUPLICATE KEY
    const after = whole.slice(offset + m.length);
    if (/^\s*\(/.test(after)) return m; // KEY (a, b) 索引定义
    return '`key`';
  });

  // databases（排除 SHOW DATABASES）
  s = s.replace(/\bdatabases\b/gi, (m, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 24), offset);
    if (before.endsWith('`')) return m;
    if (/\bSHOW\s+$/i.test(before)) return m;
    return '`databases`';
  });

  // row_number（排除 ROW_NUMBER() 窗口函数）
  s = s.replace(/\brow_number\b/gi, (m, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 8), offset);
    if (before.endsWith('`')) return m;
    const after = whole.slice(offset + m.length);
    if (/^\s*\(/.test(after)) return m;
    return '`row_number`';
  });

  return s;
}

const UNIT = 'day|days|hour|hours|minute|minutes|month|months|year|years|second|seconds|week|weeks';

/** `-30 days` / `+2 hours` 这种修饰符 → MySQL 区间表达式 */
function modifierToInterval(mod: string, base: string): string {
  const t = mod.trim().toLowerCase();
  // 非数字修饰符（SQLite 的语义化写法），仓库里实际用到 start of day
  if (t === 'now' || t === 'localtime') return base;
  if (t === 'start of day') return 'CURDATE()';
  if (t === 'start of month') return "DATE_FORMAT(NOW(), '%Y-%m-01')";
  if (t === 'start of year') return "DATE_FORMAT(NOW(), '%Y-01-01')";
  if (t === 'end of day') return "DATE_ADD(CURDATE(), INTERVAL 1 DAY) - INTERVAL 1 SECOND";

  const m = mod.match(new RegExp(`^([+-]?\\d+)\\s*(${UNIT})$`, 'i'));
  if (!m) return base;
  const n = parseInt(m[1], 10);
  let unit = m[2].toLowerCase().replace(/s$/, '');
  if (unit === 'week') unit = 'week';
  return n < 0
    ? `DATE_SUB(${base}, INTERVAL ${Math.abs(n)} ${unit.toUpperCase()})`
    : `DATE_ADD(${base}, INTERVAL ${n} ${unit.toUpperCase()})`;
}

/** 宽松日期表达式：SQLite 能直接吃 ISO8601（含 T/Z），MySQL 需要先规整 */
function dtCast(expr: string): string {
  const e = expr.trim();
  if (/^'?now'?$/i.test(e) || /^CURRENT_TIMESTAMP$/i.test(e) || /^NOW\(\)$/i.test(e)) return 'NOW()';
  return `CAST(REPLACE(REPLACE(${e},'T',' '),'Z','') AS DATETIME)`;
}

/**
 * 通用 DML 改写（对 DDL 也安全，只命中明确的 SQLite 函数/关键字）
 */
function rewriteCommon(sql: string): string {
  let s = sql;

  // ── datetime('now'[,'localtime'][, '+N unit']) ──────────────
  s = s.replace(
    new RegExp(`datetime\\(\\s*'now'\\s*(?:,\\s*'localtime'\\s*)?(?:,\\s*'([^']+)'\\s*)?\\)`, 'gi'),
    (_m, mod?: string) => (mod ? modifierToInterval(mod, 'NOW()') : 'NOW()'),
  );
  // datetime('now', <expr> || '<unit>') —— 修饰符由参数拼出来（dashboardStats 的 `? || ' hours'`）
  // 必须在下面「通用 datetime(expr)」之前处理，否则会被当成普通表达式 CAST 成 NULL 而静默查空。
  s = s.replace(
    new RegExp(`datetime\\(\\s*'now'\\s*,\\s*([^,()]+?)\\s*\\|\\|\\s*'\\s*(${UNIT})\\s*'\\s*\\)`, 'gi'),
    (_m, expr: string, unit: string) => {
      const u = unit.toLowerCase().replace(/s$/, '').toUpperCase();
      return `DATE_ADD(NOW(), INTERVAL (${expr.trim()}) ${u})`;
    },
  );

  // datetime(<expr>[, '+N unit'])
  s = s.replace(
    new RegExp(`datetime\\(\\s*([^(),]+?)\\s*(?:,\\s*'([^']+)'\\s*)?\\)`, 'gi'),
    (_m, expr: string, mod?: string) => {
      const base = dtCast(expr);
      return mod ? modifierToInterval(mod, base) : base;
    },
  );

  // ── date('now'[,'-N unit']) / date(<expr>) ──────────────────
  s = s.replace(
    new RegExp(`date\\(\\s*'now'\\s*(?:,\\s*'([^']+)'\\s*)?\\)`, 'gi'),
    (_m, mod?: string) => (mod ? modifierToInterval(mod, 'CURDATE()') : 'CURDATE()'),
  );
  s = s.replace(/date\(\s*([^(),]+?)\s*\)/gi, (_m, expr: string) => `DATE(${dtCast(expr)})`);

  // ── time('now') ────────────────────────────────────────────
  s = s.replace(/time\(\s*'now'\s*\)/gi, 'CURTIME()');

  // ── julianday(a) - julianday(b) → 秒差 / 86400 ─────────────
  s = s.replace(
    /julianday\(\s*([^()]+?)\s*\)\s*-\s*julianday\(\s*([^()]+?)\s*\)/gi,
    (_m, a: string, b: string) => `(TIMESTAMPDIFF(SECOND, ${dtCast(b)}, ${dtCast(a)}) / 86400.0)`,
  );
  s = s.replace(/julianday\(\s*([^()]+?)\s*\)/gi, (_m, a: string) => `(TO_DAYS(${dtCast(a)}) + 0.5)`);

  // ── strftime(fmt, expr) ────────────────────────────────────
  s = s.replace(/strftime\(\s*'([^']+)'\s*,\s*([^()]+?)\s*\)/gi, (_m, fmt: string, expr: string) => {
    if (fmt === '%s') return `UNIX_TIMESTAMP(${dtCast(expr)})`;
    return `DATE_FORMAT(${dtCast(expr)}, '${fmt}')`;
  });

  // ── typeof(x) ──────────────────────────────────────────────
  // SQLite 的 typeof 返回 integer/text/real/null/blob；MySQL 无对应函数。
  // 仓库里只在 v008 用于「判断 id 是不是整数」，用 REGEXP 等价表达。
  s = s.replace(/typeof\(\s*([^()]+?)\s*\)\s*=\s*'integer'/gi, (_m, x: string) => `(${x} REGEXP '^[0-9]+$')`);
  s = s.replace(/typeof\(\s*([^()]+?)\s*\)\s*=\s*'text'/gi, (_m, x: string) => `(NOT (${x} REGEXP '^[0-9]+$'))`);
  s = s.replace(/typeof\(\s*([^()]+?)\s*\)\s*=\s*'null'/gi, (_m, x: string) => `(${x} IS NULL)`);
  s = s.replace(
    /typeof\(\s*([^()]+?)\s*\)/gi,
    (_m, x: string) => `IF(${x} IS NULL, 'null', IF(${x} REGEXP '^[0-9]+$', 'integer', 'text'))`,
  );

  // ── CAST 目标类型 ──────────────────────────────────────────
  s = s.replace(/CAST\(([\s\S]*?)\s+AS\s+TEXT\s*\)/gi, 'CAST($1 AS CHAR)');
  s = s.replace(/CAST\(([\s\S]*?)\s+AS\s+REAL\s*\)/gi, 'CAST($1 AS DOUBLE)');

  // ── 排序规则 ───────────────────────────────────────────────
  s = s.replace(/COLLATE\s+NOCASE/gi, 'COLLATE utf8mb4_general_ci');
  s = s.replace(/COLLATE\s+BINARY/gi, 'COLLATE utf8mb4_bin');

  // ── INSERT OR IGNORE / INSERT OR REPLACE ───────────────────
  s = s.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO');
  s = s.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'REPLACE INTO');
  s = s.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'REPLACE');
  s = s.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE');

  // ── ON CONFLICT ────────────────────────────────────────────
  // DO NOTHING → 去掉子句并把 INSERT 升级成 INSERT IGNORE
  if (/ON\s+CONFLICT\s*(\([^)]*\))?\s+DO\s+NOTHING/i.test(s)) {
    s = s.replace(/\s*ON\s+CONFLICT\s*(\([^)]*\))?\s+DO\s+NOTHING/gi, '');
    if (!/\bINSERT\s+IGNORE\b/i.test(s)) s = s.replace(/\bINSERT\b/i, 'INSERT IGNORE');
  }
  // DO UPDATE SET … excluded.col → ON DUPLICATE KEY UPDATE … VALUES(col)
  s = s.replace(
    /\s*ON\s+CONFLICT\s*(?:\([^)]*\))?\s+DO\s+UPDATE\s+SET\s+([\s\S]+)$/i,
    (_m, body: string) => ` ON DUPLICATE KEY UPDATE ${body.replace(/\bexcluded\.(\w+)/gi, 'VALUES($1)')}`,
  );

  // ── sqlite_master 元表 ─────────────────────────────────────
  if (/sqlite_master/i.test(s)) {
    s = s.replace(
      /\bsqlite_master\b/gi,
      `(SELECT table_name AS name, 'table' AS type, '' AS \`sql\`, table_name AS tbl_name
          FROM information_schema.tables WHERE table_schema = DATABASE()
        UNION ALL
        SELECT index_name AS name, 'index' AS type, '' AS \`sql\`, table_name AS tbl_name
          FROM information_schema.statistics WHERE table_schema = DATABASE()
         GROUP BY index_name, table_name) AS sqlite_master`,
    );
    // 形如 FROM (…子查询…) AS sqlite_master 后面又跟 WHERE 的场景保持可用
  }

  // ── 表值函数 pragma_table_info('t') ────────────────────────
  // SQLite 支持 `SELECT … FROM pragma_table_info('t')` 这种写法（v033 用它判断列是否存在）
  s = s.replace(/pragma_table_info\s*\(\s*['"`]?([\w$]+)['"`]?\s*\)/gi, (_m, t: string) =>
    `(SELECT COLUMN_NAME AS name, DATA_TYPE AS type,
             CASE WHEN IS_NULLABLE = 'NO' THEN 1 ELSE 0 END AS notnull,
             COLUMN_DEFAULT AS dflt_value,
             CASE WHEN COLUMN_KEY = 'PRI' THEN 1 ELSE 0 END AS pk
        FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = '${t}') AS pragma_table_info`,
  );

  // ── 其它 ───────────────────────────────────────────────────
  s = s.replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT');
  s = s.replace(/\bIFNULL\(/gi, 'IFNULL(');
  s = s.replace(/\bGLOB\b/gi, 'LIKE');

  // ── 事务起始语句 ───────────────────────────────────────────
  // SQLite: BEGIN [DEFERRED|IMMEDIATE|EXCLUSIVE] TRANSACTION；MySQL: START TRANSACTION
  s = s.replace(/\bBEGIN\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE)\s+TRANSACTION\b/gi, 'START TRANSACTION');
  s = s.replace(/\bBEGIN\s+TRANSACTION\b/gi, 'START TRANSACTION');
  s = s.replace(/\bBEGIN\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE)\b/gi, 'START TRANSACTION');
  s = s.replace(/\bEND\s+TRANSACTION\b/gi, 'COMMIT');

  return quoteReservedIdents(addDerivedTableAliases(stripInlineReferences(s)));
}

/**
 * PRAGMA 在 MySQL 下没有等价物，单独兜住：
 * - `PRAGMA table_info(t)` → information_schema（v012 等迁移用它读列名）
 * - 其余（journal_mode / foreign_keys / busy_timeout …）→ 退化成无害的 SELECT
 */
function translatePragma(stmt: string): string {
  // 外键开关：SQLite 的 PRAGMA foreign_keys 对应 MySQL 的 FOREIGN_KEY_CHECKS，
  // 迁移里的「重建表」模式（rename → create → copy → drop）必须有它才能 DROP 父表。
  const fk = stmt.match(/^\s*PRAGMA\s+foreign_keys\s*=\s*(ON|OFF|1|0|TRUE|FALSE)\s*$/i);
  if (fk) {
    const on = /^(ON|1|TRUE)$/i.test(fk[1]);
    return `SET FOREIGN_KEY_CHECKS=${on ? 1 : 0}`;
  }
  const m = stmt.match(/^\s*PRAGMA\s+table_info\s*\(\s*['"`]?([\w$]+)['"`]?\s*\)/i);
  if (m) {
    return `SELECT COLUMN_NAME AS name, DATA_TYPE AS type,
                   CASE WHEN IS_NULLABLE = 'NO' THEN 1 ELSE 0 END AS notnull,
                   COLUMN_DEFAULT AS dflt_value,
                   CASE WHEN COLUMN_KEY = 'PRI' THEN 1 ELSE 0 END AS pk
              FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = '${m[1]}'`;
  }
  return 'SELECT 1 AS sqlite_pragma_noop';
}

const TYPE_MAP: Array<[RegExp, string]> = [
  [/^BOOLEAN$/i, 'TINYINT(1)'],
  [/^BOOL$/i, 'TINYINT(1)'],
  [/^INTEGER$/i, 'BIGINT'],
  [/^INT$/i, 'BIGINT'],
  [/^REAL$/i, 'DOUBLE'],
  [/^DOUBLE$/i, 'DOUBLE'],
  [/^FLOAT$/i, 'DOUBLE'],
  [/^NUMERIC$/i, 'DECIMAL(20,6)'],
  [/^DECIMAL$/i, 'DECIMAL(20,6)'],
  [/^BLOB$/i, 'LONGBLOB'],
  [/^JSON$/i, 'JSON'],
];

/** 把 SQLite 列类型映射为 MySQL 类型；TEXT 需要按是否参与主键分叉 */
function mapType(rawType: string, isPk: boolean): string {
  const t = rawType.trim();
  const upper = t.toUpperCase();
  if (upper === 'TEXT') return isPk ? 'VARCHAR(191)' : 'LONGTEXT';
  for (const [re, to] of TYPE_MAP) {
    if (re.test(upper)) return to;
  }
  return t;
}

/** 单列定义翻译 */
function translateColumn(item: string, pkCols: Set<string>): string {
  const m = item.match(/^(\s*`?[\w$]+`?)(\s+)([\s\S]*)$/);
  if (!m) return item;
  const [, name, sp, restRaw] = m;
  const bare = name.replace(/`/g, '').trim();

  const tm = restRaw.match(/^([A-Za-z]+)(\s*\([^)]*\))?/);
  if (!tm) return item;
  const typeToken = (tm[1] + (tm[2] ?? '')).trim();
  let rest = restRaw.slice(tm[0].length);

  const isPk = /PRIMARY\s+KEY/i.test(rest) || pkCols.has(bare.toLowerCase());
  let type = mapType(typeToken, isPk);

  // INTEGER PRIMARY KEY AUTOINCREMENT → BIGINT PRIMARY KEY AUTO_INCREMENT
  const autoInc = /AUTOINCREMENT/i.test(rest);
  rest = rest.replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT');
  if (autoInc) type = 'BIGINT';

  // DEFAULT (datetime('now','localtime')) → DEFAULT (NOW())
  rest = rest.replace(
    /DEFAULT\s*\(\s*datetime\([^)]*\)\s*\)/gi,
    'DEFAULT (NOW())',
  );
  rest = rest.replace(/DEFAULT\s+datetime\([^)]*\)/gi, 'DEFAULT (NOW())');
  // TEXT 列不允许 CURRENT_TIMESTAMP 默认值
  if (/^LONGTEXT$/i.test(type) && /DEFAULT\s+CURRENT_TIMESTAMP/i.test(rest)) {
    rest = rest.replace(/DEFAULT\s+CURRENT_TIMESTAMP/gi, 'DEFAULT (NOW())');
  }

  rest = rest.replace(/COLLATE\s+NOCASE/gi, 'COLLATE utf8mb4_general_ci');
  // 内联 REFERENCES 在 MySQL 里会被忽略，保留不报错；CHECK 内联 MariaDB 支持
  return `${name}${sp}${type}${rest}`;
}

/** CREATE TABLE 翻译 */
function translateCreateTable(stmt: string): string {
  const head = stmt.match(/^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(`?[\w$]+`?)\s*\(/i);
  if (!head) return rewriteCommon(stmt);
  const prefix = head[1];
  const table = head[2];

  // 找到与之配对的右括号
  let depth = 1;
  let i = head[0].length;
  let body = '';
  let quote: string | null = null;
  for (; i < stmt.length; i++) {
    const c = stmt[i];
    if (quote) {
      body += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      body += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
    body += c;
  }
  const tail = stmt.slice(i + 1);

  const items = splitTopLevel(body);

  // 先扫一遍主键/外键列，供 TEXT→VARCHAR 判定。
  // 外键列必须是可索引的定长类型，LONGTEXT 既不能建 FK 也无法与被引用列类型匹配。
  const pkCols = new Set<string>();
  const fkCols = new Set<string>();
  for (const it of items) {
    const trimmed = it.trim();
    const tablePk = trimmed.match(/^PRIMARY\s+KEY\s*\(([^)]*)\)/i);
    if (tablePk) {
      tablePk[1].split(',').forEach((c) => pkCols.add(c.replace(/`/g, '').trim().toLowerCase()));
      continue;
    }
    const tableFk = trimmed.match(/^FOREIGN\s+KEY\s*\(([^)]*)\)/i);
    if (tableFk) {
      tableFk[1].split(',').forEach((c) => fkCols.add(c.replace(/`/g, '').trim().toLowerCase()));
      continue;
    }
    const colPk = trimmed.match(/^`?([\w$]+)`?\s+[\s\S]*?\bPRIMARY\s+KEY\b/i);
    if (colPk) pkCols.add(colPk[1].toLowerCase());
    const colFk = trimmed.match(/^`?([\w$]+)`?\s+[\s\S]*?\bREFERENCES\s+/i);
    if (colFk) fkCols.add(colFk[1].toLowerCase());
  }
  const keyCols = new Set<string>([...pkCols, ...fkCols]);

  const outItems = items.map((it) => {
    const trimmed = it.trim();
    if (/^(PRIMARY\s+KEY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i.test(trimmed)) {
      return rewriteCommon(trimmed);
    }
    return rewriteCommon(translateColumn(trimmed, keyCols));
  });

  // 主键/外键列若仍是 LONGTEXT（表级约束声明），就地改成 VARCHAR(191)
  const fixedItems = outItems.map((it) => {
    const m2 = it.match(/^(`?[\w$]+`?)\s+LONGTEXT\b/i);
    if (m2 && keyCols.has(m2[1].replace(/`/g, '').toLowerCase())) {
      return it.replace(/^(.*?)\s+LONGTEXT\b/i, '$1 VARCHAR(191)');
    }
    return it;
  });

  // 列类型索引：给多列 UNIQUE 里的 LONGTEXT 补前缀长度，
  // 否则 InnoDB 会报 "Specified key was too long; max key length is 3072 bytes"
  const colType = new Map<string, string>();
  for (const it of fixedItems) {
    const m3 = it.match(/^`?([\w$]+)`?\s+([A-Za-z]+)(\s*\([^)]*\))?/);
    if (m3 && !/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK)$/i.test(m3[1])) {
      colType.set(m3[1].toLowerCase(), (m3[2] + (m3[3] ?? '')).toUpperCase());
    }
  }
  const withPrefix = fixedItems.map((it) => {
    const m4 = it.match(/^(UNIQUE)\s*\(([^)]*)\)(.*)$/i);
    if (!m4) return it;
    const cols = m4[2].split(',').map((c) => c.trim());
    const longTexts = cols.filter((c) => {
      const bare = c.replace(/`/g, '').replace(/\(.*\)$/, '').toLowerCase();
      return /^(LONGTEXT|TEXT|MEDIUMTEXT)$/.test(colType.get(bare) ?? '') && !/\(\d+\)$/.test(c);
    }).length;
    if (longTexts === 0) return it;
    const prefix = cols.length >= 4 ? 64 : 191;
    const rebuilt = cols
      .map((c) => {
        const bare = c.replace(/`/g, '').replace(/\(.*\)$/, '').toLowerCase();
        const isLong = /^(LONGTEXT|TEXT|MEDIUMTEXT)$/.test(colType.get(bare) ?? '');
        return isLong && !/\(\d+\)$/.test(c) ? `${c}(${prefix})` : c;
      })
      .join(', ');
    return `UNIQUE (${rebuilt})${m4[3]}`;
  });

  const opts = /ENGINE\s*=/i.test(tail) ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
  return stripInlineReferences(`${prefix}${quoteIdent(table)} (\n  ${withPrefix.join(',\n  ')}\n)${opts}`);
}

/** 解析 `CREATE [UNIQUE] INDEX name ON table (cols)`，供驱动按真实列类型补前缀 */
export function parseCreateIndex(
  stmt: string,
): { unique: boolean; ifNotExists: boolean; name: string; table: string; cols: string[]; tail: string } | null {
  const m = stmt.match(
    /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?(`?[\w$]+`?)\s+ON\s+(`?[\w$]+`?)\s*\(([^)]*)\)([\s\S]*)$/i,
  );
  if (!m) return null;
  return {
    unique: !!m[1],
    ifNotExists: !!m[2],
    name: m[3],
    table: m[4].replace(/`/g, ''),
    cols: splitTopLevel(m[5]).map((c) => c.trim()),
    tail: m[6] ?? '',
  };
}

/** ALTER TABLE 里新增/修改列的类型翻译 */
function translateAlter(stmt: string): string {
  let s = rewriteCommon(stmt);
  s = s.replace(
    /(\bALTER\s+TABLE\s+`?[\w$]+`?\s+(?:ADD|MODIFY|CHANGE)\s+(?:COLUMN\s+)?`?[\w$]+`?\s+)([A-Za-z]+)(\s*\([^)]*\))?/gi,
    (m, pre: string, type: string, args: string | undefined) => {
      const mapped = mapType(type + (args ?? ''), false);
      return pre + mapped;
    },
  );
  return s;
}

export interface TranslateOptions {
  /** 为 true 时输出翻译前后对照（排查用） */
  debug?: (from: string, to: string) => void;
}

/** 单条语句翻译（供 prepare / exec 共用） */
export function translateStatement(stmt: string, opts?: TranslateOptions): string {
  const kw = firstKeyword(stmt);
  let out: string;
  if (kw === 'PRAGMA') {
    out = translatePragma(stmt);
  } else if (kw === 'CREATE' && /^\s*CREATE\s+TABLE\b/i.test(stmt)) {
    out = translateCreateTable(stmt);
  } else if (kw === 'ALTER') {
    out = translateAlter(stmt);
  } else if (kw === 'CREATE' && /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(stmt)) {
    // MariaDB 10.5+ 支持 CREATE INDEX IF NOT EXISTS；TEXT 列会自动加前缀长度
    out = rewriteCommon(stmt);
  } else {
    out = rewriteCommon(stmt);
  }
  opts?.debug?.(stmt, out);
  return out;
}

/** 供 d.ts 断言用的能力标记 */
export const SQLITE_ONLY_REASON =
  'SQLite 专有内省/重建表/触发器语法（sqlite_master 读 DDL、ALTER CHECK 重建、RAISE(ABORT)）在 MySQL 下无等价物';
