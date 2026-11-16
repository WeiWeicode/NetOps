/**
 * B2 知識庫搬移(IMPL-PLAN B2):同一批筆記,舊版 server/lib/kb.js 與新版的解析、查詢、匯整檔、新增結果一致;API 行為
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createKbStore } from '../../src/infra/store/kb.js';
import { createKbService } from '../../src/modules/kb/service.js';
import { createTestApp, type TestApp } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LEGACY = path.resolve(here, '../../../server/lib');
const legacyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-legacy-kb-'));
const newTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-new-kb-'));

/** 舊版 kb.js 原封不動執行:設定檔換成暫存目錄,相對 import 改成絕對路徑 */
async function loadLegacyKb() {
  const src = fs
    .readFileSync(path.join(LEGACY, 'kb.js'), 'utf8')
    .replace("import { config } from '../config.js'", `const config = { kbDir: ${JSON.stringify(legacyTmp)}, kbMaxChars: 20000 }`)
    .replace("from './palog.js'", `from ${JSON.stringify(pathToFileURL(path.join(LEGACY, 'palog.js')).href)}`)
    .replace("from './utils.js'", `from ${JSON.stringify(pathToFileURL(path.join(LEGACY, 'utils.js')).href)}`);
  return import(`data:text/javascript,${encodeURIComponent(src)}`);
}

const NOTES: Record<string, string> = {
  '202611011030-a1b2c3': '---\ntitle: FTP 伺服器\nips: 10.10.130.66\ntags: FTP, 備份\nauthor: S112009 佳緯\ncreated: 2026/11/01 10:30\nupdated: 2026/11/01 10:30\nupdatedBy: S112009 佳緯\nsource: \n---\n\n# 用途\nPA 與 AD log 都放在這台。\n',
  '202611021200-d4e5f6': '---\ntitle: 機房網段\nips: 10.10.130.0/24, 10.10.131.*\ntags: 網段\nauthor: S094009\ncreated: 2026/11/02 12:00\nupdated: 2026/11/03 09:00\nupdatedBy: S112009 佳緯\nsource: AI 問答\n---\n\n## 說明\n機房伺服器 | 不可對外。\n',
  '202611030800-abcdef': '沒有欄位的舊筆記,直接是內容。\nPort 5517 是內部服務。\n',
};

let legacyKb: Awaited<ReturnType<typeof loadLegacyKb>>;
let kb: ReturnType<typeof createKbService>;
let t: TestApp;

before(async () => {
  fs.mkdirSync(path.join(newTmp, 'knowledge'), { recursive: true });
  for (const [id, text] of Object.entries(NOTES)) {
    fs.writeFileSync(path.join(legacyTmp, `${id}.md`), text);
    fs.writeFileSync(path.join(newTmp, 'knowledge', `${id}.md`), text);
  }
  legacyKb = await loadLegacyKb();
  kb = createKbService(createKbStore(newTmp));
  t = await createTestApp();
  for (const [id, text] of Object.entries(NOTES)) fs.writeFileSync(path.join(t.dataDir, 'knowledge', `${id}.md`), text);
});

after(async () => {
  await t.close();
  for (const d of [legacyTmp, newTmp]) fs.rmSync(d, { recursive: true, force: true });
});

/** 匯整檔的「更新於」是產生時間,比對時去掉 */
const stripTime = (s: string) => s.replace(/更新於 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/, '更新於 -');

describe('同一批筆記:舊版與新版一致', () => {
  it('解析與排序', () => {
    assert.deepEqual(kb.listNotes(), legacyKb.listNotes());
    for (const id of Object.keys(NOTES)) assert.deepEqual(kb.getNote(id), legacyKb.getNote(id));
  });

  it('關鍵字查詢', () => {
    for (const q of ['', 'ftp', '10.10.130', '網段 機房', 'S094009', 'port 5517', '不存在的字']) assert.deepEqual(kb.search(q), legacyKb.searchNotes(q), q);
  });

  it('匯整檔', () => {
    assert.equal(stripTime(kb.compilation().text), stripTime(legacyKb.readAll().text));
    assert.equal(kb.compilation().count, 3);
  });

  it('新增:欄位整理相同(IP 過濾、標籤上限、內容上限),寫出的 .md 格式相同', () => {
    const input = { title: ' 多行\n標題 ', ips: '10.10.1.5, not-ip, 10.10.0.0/16、::1', tags: Array.from({ length: 12 }, (_, i) => `t${i}`), content: `  # 內容\n${'x'.repeat(20)}  `, source: 'test' };
    const a = kb.saveNote(input, 'S112009 佳緯');
    const b = legacyKb.saveNote(input, 'S112009 佳緯');
    const omit = ({ id: _i, created: _c, updated: _u, ...rest }: Record<string, unknown>) => rest;
    assert.deepEqual(omit(a as unknown as Record<string, unknown>), omit(b));
    const norm = (s: string) => s.replace(/^(created|updated): .*$/gm, '$1: -');
    assert.equal(norm(fs.readFileSync(path.join(newTmp, 'knowledge', `${a.id}.md`), 'utf8')), norm(fs.readFileSync(path.join(legacyTmp, `${b.id}.md`), 'utf8')));
  });
});

describe('知識庫 API', () => {
  it('查詢:分頁、ISO 時間、匯整檔資訊', async () => {
    const res = (await t.call({ url: '/v1/kb/notes?pageSize=2' })).json();
    assert.equal(res.total, 3);
    assert.equal(res.items.length, 2);
    assert.equal(res.items[0].id, '202611021200-d4e5f6', '依更新時間新的在前');
    assert.equal(res.items[0].updated, '2026-11-03T09:00:00+08:00');
    assert.equal(res.compilation.count, 3);
    assert.ok(res.compilation.chars > 0);
    assert.equal(res.admin, undefined, '舊版的 admin 欄位拿掉');
    assert.equal((await t.call({ url: '/v1/kb/notes?q=ftp' })).json().total, 1);
  });

  it('一則筆記;不存在 404;代號格式錯誤 400', async () => {
    assert.equal((await t.call({ url: '/v1/kb/notes/202611011030-a1b2c3' })).json().title, 'FTP 伺服器');
    const nf = await t.call({ url: '/v1/kb/notes/000000-none' });
    assert.equal(nf.statusCode, 404);
    assert.equal(nf.json().code, 'NETOPS_KB_NOTE_NOT_FOUND');
    assert.equal((await t.call({ url: '/v1/kb/notes/..%2F..%2Fetc' })).statusCode, 400);
  });

  it('下載筆記 .md 與匯整檔', async () => {
    const md = await t.call({ url: '/v1/kb/notes/202611011030-a1b2c3/markdown' });
    assert.match(String(md.headers['content-type']), /^text\/markdown/);
    assert.equal(md.body, NOTES['202611011030-a1b2c3']);
    assert.match(String(md.headers['content-disposition']), new RegExp(encodeURIComponent('FTP 伺服器.md')));
    const all = await t.call({ url: '/v1/kb/compilation' });
    assert.ok(all.body.startsWith('# 網通知識庫匯整'));
    assert.match(String(all.headers['content-disposition']), new RegExp(encodeURIComponent('網通知識庫匯整.md')));
  });

  it('新增 201(記錄人為工號 姓名)→ 修改保留記錄人 → 刪除 204(冪等)', async () => {
    const c = await t.call({ method: 'POST', url: '/v1/kb/notes', payload: { title: '新筆記', ips: ['10.10.1.5'], tags: 'a, b', content: '內容' } });
    assert.equal(c.statusCode, 201, c.body);
    const note = c.json();
    assert.equal(note.author, 'S112009 測試S112009');
    assert.match(note.created, /\+08:00$/);
    const u = await t.call({ method: 'PUT', url: `/v1/kb/notes/${note.id}`, payload: { title: '改標題', content: '新內容' }, emp: 'S094009' });
    assert.equal(u.statusCode, 200, u.body);
    assert.equal(u.json().author, 'S112009 測試S112009');
    assert.equal(u.json().updatedBy, 'S094009 測試S094009');
    assert.equal(u.json().title, '改標題');
    assert.ok((await t.call({ url: '/v1/kb/compilation' })).body.includes('改標題'), '匯整檔重新產生');
    for (let i = 0; i < 2; i++) assert.equal((await t.call({ method: 'DELETE', url: `/v1/kb/notes/${note.id}` })).statusCode, 204);
    assert.equal((await t.call({ url: `/v1/kb/notes/${note.id}` })).statusCode, 404);
    assert.ok(!(await t.call({ url: '/v1/kb/compilation' })).body.includes('改標題'));
  });

  it('標籤或標題含換行回 400;service 直接傳入時也壓成一行,不能偽造記錄人與建立時間', async () => {
    for (const payload of [{ tags: ['x\nauthor: A001 主管\ncreated: 2020/01/01 00:00\n---'], content: 'c' }, { tags: 'x\r\n---', content: 'c' }, { title: 'a\nb', content: 'c' }]) {
      assert.equal((await t.call({ method: 'POST', url: '/v1/kb/notes', payload })).statusCode, 400, JSON.stringify(payload));
    }
    const n = kb.saveNote({ tags: ['x\nauthor: A001 主管\ncreated: 2020/01/01 00:00\n---'], ips: ['10.0.0.1\nauthor: x'], content: '內容' }, 'S112009 佳緯');
    const back = kb.getNote(n.id);
    assert.equal(back.author, 'S112009 佳緯');
    assert.notEqual(back.created, '2020/01/01 00:00');
    assert.equal(back.content, '內容');
    assert.deepEqual(back.ips, []);
  });

  it('手動修改或刪除 .md、刪除匯整檔後,快取與匯整檔會重新產生', async () => {
    const dir = path.join(t.dataDir, 'knowledge');
    const first = (await t.call({ url: '/v1/kb/compilation' })).body;
    // 修改時間要不同(某些檔案系統精度較粗)
    const f = path.join(dir, '202611011030-a1b2c3.md');
    fs.writeFileSync(f, NOTES['202611011030-a1b2c3']!.replace('FTP 伺服器', 'FTP 主機'));
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    assert.equal((await t.call({ url: '/v1/kb/notes/202611011030-a1b2c3' })).json().title, 'FTP 主機');
    const second = (await t.call({ url: '/v1/kb/compilation' })).body;
    assert.ok(second.includes('FTP 主機') && !first.includes('FTP 主機'));
    fs.rmSync(path.join(dir, '_knowledge-all.md'));
    assert.ok((await t.call({ url: '/v1/kb/compilation' })).body.includes('FTP 主機'));
    assert.ok(fs.existsSync(path.join(dir, '_knowledge-all.md')));
    // 手動刪除 .md(用新增的筆記,不動共用的測試資料)
    const n = (await t.call({ method: 'POST', url: '/v1/kb/notes', payload: { title: '手動刪除', content: 'x' } })).json();
    const count = (await t.call({ url: '/v1/kb/notes' })).json().compilation.count;
    fs.rmSync(path.join(dir, `${n.id}.md`));
    const list = (await t.call({ url: '/v1/kb/notes' })).json();
    assert.equal(list.compilation.count, count - 1);
    assert.ok(!(await t.call({ url: '/v1/kb/compilation' })).body.includes('手動刪除'));
  });

  it('匯整檔重產失敗時,筆記仍寫入成功,下次讀取恢復', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-kb-fail-'));
    try {
      fs.mkdirSync(path.join(tmp, 'knowledge'));
      const real = createKbStore(tmp);
      let fail = true;
      const warned: unknown[] = [];
      const svc = createKbService({ ...real, writeCompilation: (text) => (fail ? (() => { throw new Error('ENOSPC'); })() : real.writeCompilation(text)) }, { warn: (o) => warned.push(o) });
      const n = svc.saveNote({ content: '內容' }, 'S112009 佳緯');
      assert.equal(svc.getNote(n.id).content, '內容');
      assert.equal(warned.length, 1);
      fail = false;
      assert.equal(svc.compilation().count, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('下載有 nosniff', async () => {
    const md = await t.call({ url: '/v1/kb/compilation' });
    assert.equal(md.headers['x-content-type-options'], 'nosniff');
  });

  it('內容空白、超過上限、修改不存在的筆記', async () => {
    assert.equal((await t.call({ method: 'POST', url: '/v1/kb/notes', payload: { content: '   ' } })).statusCode, 400);
    assert.equal((await t.call({ method: 'POST', url: '/v1/kb/notes', payload: { content: 'x'.repeat(20001) } })).statusCode, 400);
    assert.equal((await t.call({ method: 'PUT', url: '/v1/kb/notes/000000-none', payload: { content: 'x' } })).statusCode, 404);
  });

  it('回應不含本機資料目錄路徑', async () => {
    for (const url of ['/v1/kb/notes', '/v1/kb/notes/202611011030-a1b2c3']) assert.ok(!(await t.call({ url })).body.includes(t.dataDir));
  });
});
