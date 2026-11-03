/**
 * 資料存取(infra/store,ARCHITECTURE D8):底層讀寫與就緒檢查
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createStore } from '../../src/infra/store/index.js';
import { DataFileError, listFiles, readGzipJson, readJson, safeJoin, writeAtomic, writeGzipJson, writeJson } from '../../src/infra/store/files.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-store-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('files', () => {
  it('寫入後可讀回,不留下暫存檔', () => {
    const f = path.join(tmp, 'a.json');
    writeJson(f, { n: 1 });
    writeJson(f, { n: 2 });
    assert.deepEqual(readJson(f), { n: 2 });
    const g = path.join(tmp, 'b.json.gz');
    writeGzipJson(g, { s: '中文' });
    assert.deepEqual(readGzipJson(g), { s: '中文' });
    assert.deepEqual(listFiles(tmp).filter((x) => x.endsWith('.tmp')), []);
  });

  it('不存在回 null;內容損壞丟 DataFileError,訊息不含資料目錄路徑', () => {
    assert.equal(readJson(path.join(tmp, 'none.json')), null);
    assert.deepEqual(listFiles(path.join(tmp, 'no-dir')), []);
    const bad = path.join(tmp, 'bad.json');
    writeAtomic(bad, '{not json');
    assert.throws(() => readJson(bad), (err: Error) => err instanceof DataFileError && err.message.includes('bad.json') && !err.message.includes(tmp));
  });

  it('safeJoin 只允許安全的檔名', () => {
    assert.equal(safeJoin(tmp + path.sep, 'x-1.json'), path.join(tmp, 'x-1.json'));
    for (const name of ['../x', '..', '.hidden', 'a/b', 'a\\b', '', 'c:x']) assert.throws(() => safeJoin(tmp, name), /不合法的資料檔名稱/, name);
  });
});

describe('toCsv', () => {
  it('公式字元(含全形、前面有空白)加上 \'', async () => {
    const { toCsv } = await import('../../src/shared/csv.js');
    const out = toCsv(['a'], [['=1+1'], [' +x'], ['＝SUM(A1)'], ['-'], ['ok'], [-5]]);
    assert.deepEqual(out.replace(/^\uFEFF/, '').trim().split('\r\n'), ['a', "'=1+1", "' +x", "'＝SUM(A1)", "'-", 'ok', '-5']);
  });
});

describe('createStore', () => {
  it('建立各資料子目錄;可寫入時 ready 為 true', async () => {
    const dir = path.join(tmp, 'data');
    const store = createStore(dir);
    for (const sub of ['palogs', 'adlogs', 'knowledge']) assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), sub);
    assert.equal(await store.ready(), true);
    assert.deepEqual(fs.readdirSync(dir).filter((x) => x.startsWith('.ready')), []);
  });
});
