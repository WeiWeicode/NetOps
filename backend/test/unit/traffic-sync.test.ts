/**
 * TRAFFIC 同步範圍與佇列上限(#4,需求方 2026-11-18 決定;調查手冊 2026-11-18-prod-issues.md §4.2):
 *   只排 FTP 保留期限內的檔(依檔名資料日期)、新的先排;佇列放不下時加到上限為止、回報略過的檔數,不整批拒絕;
 *   lastSyncError 只在 FTP 失敗或一個都加不進去時設定。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import type { Ftp } from '../../src/infra/ftp/index.js';
import { createStore } from '../../src/infra/store/index.js';
import { createTrafficImporter, fileDataDay, MAX_QUEUE, syncWindow } from '../../src/modules/pa/importer.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** 2026-11-18 12:00 台灣時間 */
const NOW = Date.parse('2026-11-18T12:00:00+08:00');
/** PA 匯出檔名(檔名日期 = 匯出日,資料日期是前一天) */
const fileName = (exportDay: string, seq: number) => `PA-560_traffic_${exportDay.replace(/-/g, '_')}_last_calendar_day_${seq}.csv`;
const dayAgo = (n: number) => new Date(NOW + 8 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);

/** FTP 上 files 個 TRAFFIC 檔,平均分散在匯出日 0 ~ days − 1 天前;分析永遠不會結束(佇列數量固定),stop() 時中止 */
function setup(files: number, days: number, retentionDays: number) {
  const fake = createFakeFtp();
  for (let i = 0; i < files; i++) fake.put(`/${fileName(dayAgo(i % days), Math.floor(i / days))}`, 'x');
  const ftp: Ftp = {
    ...fake,
    openStream: (_file, { signal } = {}) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-traffic-sync-'));
  dirs.push(dataDir);
  const cfg = loadConfig({ GW_ENV: 'dev', SERVICE_CODE: 'netops-api', GW_JWKS_URL: 'http://127.0.0.1:1/jwks', NETOPS_DATA_DIR: dataDir, FTP_HOST: 'fake-ftp' });
  assert.ok(cfg.ftp!.pattern.test(fileName('2026-11-18', 0)), '測試檔名要符合 FTP_PATTERN');
  const traffic = createTrafficImporter({ ftp, store: createStore(dataDir).pa, ftpConfig: cfg.ftp, log: silent, retentionDays, now: () => NOW });
  return { traffic, parallel: cfg.ftp!.maxConnections };
}

describe('TRAFFIC 同步範圍(syncWindow)', () => {
  it('只留保留期限內(今天往前 retentionDays − 1 天),新的先排;檔名沒有日期的排最後', () => {
    // 資料日期 = 檔名日期 − 1:檔名 11-10 → 11-09(10 天保留的最早一天)、檔名 11-09 → 11-08(超出)
    const names = [fileName('2026-11-09', 0), fileName('2026-11-10', 1), fileName('2026-11-18', 2), 'no-date.csv', fileName('2026-11-15', 10), fileName('2026-11-15', 2)];
    assert.equal(fileDataDay(fileName('2026-11-10', 1)), '2026/11/09');
    const r = syncWindow(names.map((name) => ({ name })), 10, NOW);
    assert.equal(r.outOfWindow, 1);
    assert.deepEqual(
      r.items.map((x) => x.name),
      [fileName('2026-11-18', 2), fileName('2026-11-15', 2), fileName('2026-11-15', 10), fileName('2026-11-10', 1), 'no-date.csv'],
    );
    // 保留天數設得很小時仍涵蓋對帳需要的前 3 天(資料日期 11-15 = 檔名 11-16)
    assert.deepEqual(
      syncWindow([fileName('2026-11-16', 0), fileName('2026-11-15', 0)].map((name) => ({ name })), 1, NOW).items.map((x) => x.name),
      [fileName('2026-11-16', 0)],
    );
  });
});

describe('TRAFFIC 同步與佇列上限', () => {
  it('5,529 個檔都在保留期限內、上限 5000:加到上限為止,回報略過 529 個,不設 lastSyncError', async () => {
    const { traffic, parallel } = setup(5529, 9, 10);
    const r = await traffic.sync();
    assert.deepEqual({ found: r.found, added: r.added, skipped: r.skipped, outOfWindow: r.outOfWindow }, { found: 5529, added: MAX_QUEUE, skipped: 529, outOfWindow: 0 });
    const st = traffic.status();
    assert.equal(st.queued + st.running.length, MAX_QUEUE);
    assert.equal(st.running.length, parallel);
    assert.equal(st.lastSyncError, '');
    assert.match(st.lastSyncNote, /加入 5000 個,略過 529 個/);
    assert.deepEqual(st.lastSync, { added: MAX_QUEUE, skipped: 529, outOfWindow: 0 });
    // 新的先排:分析中的是最新一天(匯出日今天)
    for (const run of st.running) assert.ok(run.name.startsWith(`PA-560_traffic_${dayAgo(0).replace(/-/g, '_')}_`), run.name);
    // 上限只算排隊中的檔(分析中的不算):再同步一次補滿空出的位置,再下一次一個都加不進去 → lastSyncError
    const again = await traffic.sync();
    assert.deepEqual([again.added, again.skipped], [parallel, 529 - parallel]);
    await assert.rejects(traffic.sync(), (e: { code?: string }) => e.code === 'NETOPS_IMPORT_QUEUE_FULL');
    assert.match(traffic.status().lastSyncError, /分析佇列已滿/);
    assert.equal(traffic.status().lastSync, null);
    assert.equal(traffic.status().lastSyncNote, '');
    await traffic.stop();
  });

  it('FTP 上 33 天共 5,529 個檔、保留 10 天:只排期限內的檔,不會碰到上限', async () => {
    const { traffic } = setup(5529, 33, 10);
    const r = await traffic.sync();
    // 保留 10 天 = 資料日期 11-09 ~ 11-18;檔名(匯出日)11-10 ~ 11-18 共 9 天,每天 168 個(5,529 = 33 × 167 + 18)
    assert.equal(r.added, 9 * 168);
    assert.equal(r.skipped, 0);
    assert.equal(r.added + r.outOfWindow, 5529);
    assert.equal(traffic.status().lastSyncError, '');
    assert.equal(traffic.status().lastSyncNote, '');
    assert.equal(traffic.status().retentionDays, 10);
    await traffic.stop();
  });

  it('手動加入(enqueueSome):放得下的加入、其餘算 skipped;一個都放不下丟 409', async () => {
    const { traffic, parallel } = setup(MAX_QUEUE + 10, 3, 10);
    const r = await traffic.sync();
    assert.equal(r.skipped, 10);
    const more = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ path: `/${tag}-${i}.csv`, name: `${tag}-${i}.csv`, size: 1, modified: null }));
    // 分析中的檔空出的位置
    assert.deepEqual(traffic.enqueueSome(more(parallel + 3, 'fill')), { added: parallel, skipped: 3 });
    const items = more(3, 'extra');
    assert.throws(() => traffic.enqueueSome(items), (e: { code?: string }) => e.code === 'NETOPS_IMPORT_QUEUE_FULL');
    assert.deepEqual(traffic.enqueueSome([]), { added: 0, skipped: 0 });
    await traffic.stop();
    // 停止後佇列清空:同一批可以加入;再加一次已在佇列的不算新加入也不算略過
    assert.deepEqual(traffic.enqueueSome(items), { added: 3, skipped: 0 });
    assert.deepEqual(traffic.enqueueSome(items), { added: 0, skipped: 0 });
    await traffic.stop();
  });
});
