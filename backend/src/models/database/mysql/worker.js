'use strict';
/**
 * MySQL/MariaDB 查询执行 worker（主线程通过 Atomics 同步等待）
 *
 * 为什么需要 worker：better-sqlite3 是同步 API，平台 1000+ 处调用都按同步取结果。
 * 主线程阻塞等待时无法驱动自己的事件循环，因此把 mysql2 放进工作线程，
 * 主线程用 `receiveMessageOnPort` + `Atomics.wait` 同步取回结果。
 * 语义与 better-sqlite3 一致：调用方阻塞，查询串行。
 */
const { workerData } = require('worker_threads');
const mysql = require('mysql2');

const { cfg, port, signal } = workerData;
const ctl = new Int32Array(signal);

function notify() {
  Atomics.store(ctl, 0, 1);
  Atomics.notify(ctl, 0);
}

function createConn() {
  const conn = mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    charset: 'utf8mb4',
    // db.exec() 会一次下发多语句脚本（迁移里的 CREATE TABLE + CREATE INDEX）
    multipleStatements: true,
    // 与 SQLite 的 TEXT 语义对齐：日期原样返回字符串，避免驱动转成 Date 丢格式
    dateStrings: true,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    // SQLite 的 run().changes 是「匹配到的行数」，MySQL 默认只报「值真的变了的行数」。
    // 仓库里有 70 处依赖 changes（更新不存在 = 0），开启 FOUND_ROWS 才能语义一致。
    flags: ['FOUND_ROWS'],
    connectTimeout: 15000,
  });
  conn.on('error', (err) => {
    port.postMessage({ type: 'conn-error', error: String(err && err.message) });
    notify();
  });
  return conn;
}

let conn = createConn();
let ready = false;
let lastError = null;

/**
 * 会话级设置：
 * - PIPES_AS_CONCAT：SQLite 的 `||` 是字符串拼接，MySQL 默认是逻辑或
 * - NO_ENGINE_SUBSTITUTION + 非严格模式：SQLite 不做类型校验（'' 写进 INTEGER 也不报错），
 *   严格模式会让历史数据写入直接失败
 * - time_zone +08:00：aiops-mariadb 容器是 UTC，而应用侧一律按东八区本地时间落库，
 *   NOW() 必须与 datetime('now','localtime') 语义一致
 */
function initSession(cb) {
  const stmts = [
    "SET SESSION sql_mode='PIPES_AS_CONCAT,NO_ENGINE_SUBSTITUTION'",
    "SET SESSION time_zone='+08:00'",
    "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci",
  ].join('; ');
  conn.query(stmts, (err) => cb(err));
}

conn.connect((err) => {
  if (err) {
    lastError = err;
    port.postMessage({ type: 'ready', error: String(err.message || err), code: err.code });
    notify();
    return;
  }
  initSession((e2) => {
    ready = true;
    if (e2) lastError = e2;
    port.postMessage({ type: 'ready', error: e2 ? String(e2.message || e2) : null });
    notify();
  });
});

const RECONNECT_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'PROTOCOL_SEQUENCE_TIMEOUT',
]);

function reply(id, ok, err, result) {
  const payload = ok
    ? { id, ok: true, result }
    : {
        id,
        ok: false,
        error: {
          code: err && err.code,
          errno: err && err.errno,
          message: (err && (err.sqlMessage || err.message)) || 'unknown error',
          sql: err && err.sql,
        },
      };
  try {
    port.postMessage(payload);
  } catch (e) {
    port.postMessage({ id, ok: false, error: { message: '结果序列化失败: ' + String(e && e.message) } });
  }
  notify();
}

function run(msg) {
  if (!ready) {
    reply(msg.id, false, { message: 'MySQL 连接不可用: ' + (lastError ? lastError.message : '未就绪') });
    return;
  }
  conn.query(msg.sql, msg.params || [], (err, result) => {
    if (err && RECONNECT_CODES.has(err.code)) {
      try {
        conn.destroy();
      } catch (e) {
        /* ignore */
      }
      conn = createConn();
      conn.connect((ce) => {
        if (ce) return reply(msg.id, false, ce);
        initSession(() => {
          conn.query(msg.sql, msg.params || [], (err2, result2) => reply(msg.id, !err2, err2, result2));
        });
      });
      return;
    }
    reply(msg.id, !err, err, result);
  });
}

port.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'query') {
    try {
      run(msg);
    } catch (e) {
      reply(msg.id, false, e);
    }
    return;
  }
  if (msg.type === 'quit') {
    try {
      conn.end();
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  }
});
