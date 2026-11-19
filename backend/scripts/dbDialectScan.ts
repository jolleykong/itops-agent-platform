/**
 * scripts/dbDialectScan.ts — SQLite→PG 迁移方言扫描器（P1 骨架，2026-11-19）
 *
 * 扫描 backend/src 下的 SQLite 专有语法，输出迁移 checklist 汇总。
 * 用法：npx tsx scripts/dbDialectScan.ts [扫描根目录，默认 src]
 *
 * 产出：按类别统计 + 文件级 Top 列表 + 高频 SQL 模式样例，作为异步化改造的工作量依据。
 */
import fs from 'fs';
import path from 'path';

const root = process.argv[2] || path.join(__dirname, '..', 'src');

interface Pattern {
  name: string;
  re: RegExp;
  note: string;
  count: number;
  files: Map<string, number>;
  samples: string[];
}

const patterns: Pattern[] = [
  {
    name: 'db.prepare 调用（需异步化）',
    re: /db\.prepare\(/g,
    note: 'better-sqlite3 同步 API → pg 异步；方法签名需改为 async/await',
    count: 0, files: new Map(), samples: [],
  },
  {
    name: "datetime('now'...) 时间函数",
    re: /datetime\(\s*['"]now['"]/g,
    note: "→ PG: now()/localtimestamp；'localtime' 修饰符需显式换算时区",
    count: 0, files: new Map(), samples: [],
  },
  {
    name: 'INSERT OR IGNORE / REPLACE',
    re: /INSERT\s+OR\s+(IGNORE|REPLACE)/gi,
    note: '→ PG: ON CONFLICT (cols) DO NOTHING / DO UPDATE SET ...',
    count: 0, files: new Map(), samples: [],
  },
  {
    name: 'PRAGMA 语句',
    re: /pragma\(|PRAGMA\s/gi,
    note: 'PG 无 PRAGMA；WAL/锁策略由 PG 服务端参数承担，需删除或条件编译',
    count: 0, files: new Map(), samples: [],
  },
  {
    name: 'AUTOINCREMENT',
    re: /AUTOINCREMENT/gi,
    note: '→ PG: GENERATED ALWAYS AS IDENTITY / BIGSERIAL',
    count: 0, files: new Map(), samples: [],
  },
  {
    name: 'sqlite_master 引用',
    re: /sqlite_master/gi,
    note: '→ PG: information_schema.tables / pg_catalog',
    count: 0, files: new Map(), samples: [],
  },
  {
    name: 'BOOLEAN 0/1 语义（可疑）',
    re: /enabled\s*=\s*[01]|is_preset\s*=\s*[01]/g,
    note: '→ PG BOOLEAN true/false；建议 schema 层转 BOOLEAN',
    count: 0, files: new Map(), samples: [],
  },
  {
    name: 'last_insert_rowid()',
    re: /last_insert_rowid/gi,
    note: '→ PG: INSERT ... RETURNING id',
    count: 0, files: new Map(), samples: [],
  },
];

function walk(dir: string, out: string[]): void {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
}

const files: string[] = [];
walk(root, files);

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');
  for (const pat of patterns) {
    const matches = content.match(pat.re);
    if (matches) {
      pat.count += matches.length;
      pat.files.set(path.relative(root, file), matches.length);
      if (pat.samples.length < 5) {
        for (const m of matches) {
          if (pat.samples.length >= 5) break;
          const idx = content.indexOf(m);
          const lineStart = content.lastIndexOf('\n', idx) + 1;
          const lineEnd = content.indexOf('\n', idx);
          const line = content.slice(lineStart, lineEnd > 0 ? lineEnd : undefined).trim();
          if (line && !pat.samples.includes(line)) pat.samples.push(line.substring(0, 120));
        }
      }
    }
  }
}

console.log(`\n📊 SQLite→PG 方言扫描报告（扫描 ${files.length} 个 .ts 文件，根目录 ${root}）\n`);

let total = 0;
for (const pat of patterns) {
  total += pat.count;
  console.log(`【${pat.name}】 ${pat.count} 处  →  ${pat.note}`);
  const top = [...pat.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [f, n] of top) console.log(`    ${f}: ${n}`);
  if (pat.samples.length) console.log(`    样例: ${pat.samples[0]}`);
  console.log('');
}

console.log(`合计 ${total} 处方言/API 调用点。`);
console.log('异步化改造范围 = db.prepare 所在 repo 文件数（见上【db.prepare 调用】Top 列表，共 '
  + (patterns[0].files.size) + ' 个文件）。');
console.log('完整切换方案见 docs/pg-migration-design.md');
