// 比對 netops-api 的 x-gherkin 場景與 docs/Gherkin/*.feature(README「場景對照」)
//   cd backend && npm run -s openapi > ../openapi.tmp.json && node ../docs/Gherkin/check-scenarios.mjs ../openapi.tmp.json
// 檢查:
//   1. 每個 operation 的 x-gherkin 場景,在對應的 .feature 都有名稱完全相同的「場景:」或「場景大綱:」
//   2. 每個場景前都有「# 來源: 檔案:行號」,檔案存在且行號在範圍內(frontend/ 的來源標了分支,只檢查格式)
//   3. x-gherkin 場景的來源行號指到該場景名稱所在的行(不一致時列出正確行號)
// 結果印出統計;有問題時結束碼為 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const doc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

/** 後端路徑 → feature 檔(由長到短比對) */
const FILES = [
  ['/v1/pa/log-searches', 'pa-log-searches/search.feature'],
  ['/v1/pa-events/', 'pa-events/overview.feature'],
  ['/v1/pa/', 'pa/overview.feature'],
  ['/v1/ftp/pa/', 'ftp/pa-files.feature'],
  ['/v1/ftp/ad/', 'ftp/ad-files.feature'],
  ['/v1/ad/', 'ad/events.feature'],
  ['/v1/kb/', 'kb/notes.feature'],
  ['/v1/pa-live/stream-test', 'pa-live/stream-test.feature'],
  ['/v1/pa-live/', 'pa-live/realtime.feature'],
  ['/v1/ping', 'api/skeleton.feature'],
];
const fileOf = (p) => FILES.find(([prefix]) => p.startsWith(prefix))?.[1];

const problems = [];
const features = new Map();
for (const f of fs.readdirSync(here, { recursive: true }).filter((x) => String(x).endsWith('.feature'))) {
  const rel = String(f).replace(/\\/g, '/');
  const lines = fs.readFileSync(path.join(here, rel), 'utf8').split(/\r?\n/);
  const scenarios = [];
  lines.forEach((l, i) => {
    const m = /^\s*(場景|場景大綱):\s*(.+?)\s*$/.exec(l);
    if (!m) return;
    // 往上找 # 來源(跳過標籤與其他註解)
    let src = null;
    for (let j = i - 1; j >= 0 && /^\s*(@|#)/.test(lines[j]); j--) {
      const s = /#\s*來源:\s*(\S+?):(\d+|§[\d.]+)/.exec(lines[j]);
      if (s) {
        src = { file: s[1], line: s[2], at: j };
        break;
      }
    }
    scenarios.push({ name: m[2], line: i + 1, src });
  });
  features.set(rel, { lines, scenarios });
}

// 1、3:x-gherkin
let xCount = 0;
const rows = [];
for (const [p, methods] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    const names = [...String(op['x-gherkin'] ?? '').matchAll(/^場景[::]\s*(.+?)\s*$/gm)].map((m) => m[1]);
    const file = fileOf(p);
    for (const name of names) {
      xCount++;
      const f = file && features.get(file);
      const sc = f?.scenarios.find((s) => s.name === name);
      rows.push({ api: `${method.toUpperCase()} ${p.replace(/^\/v1/, '/api/netops')}`, name, file, ok: !!sc });
      if (!sc) {
        problems.push(`缺少場景:${file ?? '(沒有對應檔案)'} 「${name}」(${method.toUpperCase()} ${p})`);
        continue;
      }
      if (sc.src && /^\d+$/.test(sc.src.line) && sc.src.file.startsWith('backend/src/')) {
        const code = fs.readFileSync(path.join(repo, sc.src.file), 'utf8').split(/\r?\n/);
        const at = code.findIndex((l) => l.includes(`場景: ${name}`) || l.includes(`場景: ${name.replace(/\d{5}/, '${AD_EXPORT_MAX}')}`));
        if (at >= 0 && at + 1 !== Number(sc.src.line)) problems.push(`來源行號:${file}:${sc.line}「${name}」應為 ${sc.src.file}:${at + 1}`);
      }
    }
  }
}

// 2:來源
let total = 0;
for (const [rel, f] of features) {
  for (const s of f.scenarios) {
    total++;
    if (!s.src) {
      problems.push(`沒有來源註解:${rel}:${s.line}「${s.name}」`);
      continue;
    }
    if (s.src.file.startsWith('docs/') || s.src.file.startsWith('frontend/')) continue;
    const abs = path.join(repo, s.src.file);
    if (!fs.existsSync(abs)) problems.push(`來源檔不存在:${rel}:${s.line} ${s.src.file}`);
    else if (Number(s.src.line) > fs.readFileSync(abs, 'utf8').split(/\r?\n/).length) problems.push(`來源行號超出範圍:${rel}:${s.line} ${s.src.file}:${s.src.line}`);
  }
}

const tagCount = (tag) => [...features.values()].reduce((n, f) => n + f.lines.filter((l) => new RegExp(`(^|\\s)${tag}(\\s|$)`).test(l.trim())).length, 0);
console.log(`feature 檔 ${features.size} 個、場景 ${total} 個(含場景大綱)`);
console.log(`x-gherkin 場景 ${xCount} 個,對應到同名場景 ${rows.filter((r) => r.ok).length} 個`);
console.log(`標籤:@changed ${tagCount('@changed')}、@pending-ui ${tagCount('@pending-ui')}、@untested ${tagCount('@untested')}`);
if (process.argv.includes('--table')) for (const r of rows) console.log(`| \`${r.api}\` | ${r.name} | \`${r.file}\` |`);
if (problems.length) {
  console.log(`\n問題 ${problems.length} 個:`);
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
