/**
 * C3 FTP 對帳與補漏(ARCHITECTURE D33、手冊 §11、§12 CQ10):
 *   - compareHours:差異 > 0.5% 為 gap、< −0.5% 為 excess、FTP 沒有為 ftp-missing;ClickHouse 開始收資料之前不比
 *   - 對帳 API:FTP 摘要的每小時筆數 vs ClickHouse 每小時彙總;FTP 還沒分析完為 pending
 *   - 補漏:只補 seqno 不在 ClickHouse 的列(source = 'ftp'),沒有 seqno 的略過;佇列滿回 409
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createBackfillQueue, type BackfillClient, type BackfillQueue } from '../../src/infra/redis/backfill.js';
import { runBackfill, validateJob } from '../../src/ingest/backfill.js';
import { compareHours } from '../../src/modules/pa/reconcile.js';
import { createFakeFtp, type FakeFtp } from '../fixtures/fake-ftp.js';
import { createFakeReader, type FakeReader } from '../fixtures/fake-ch.js';
import { FakeClickHouse } from '../fixtures/fake-ingest.js';
import { trafficCsv } from '../fixtures/fake-logs.js';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

/** 記憶體版 Redis(只有佇列用到的指令) */
function memRedis(): BackfillClient {
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  return {
    lpush: async (k: string, v: string) => (lists.set(k, [v, ...(lists.get(k) ?? [])]), lists.get(k)!.length),
    rpop: async (k: string) => lists.get(k)?.pop() ?? null,
    llen: async (k: string) => lists.get(k)?.length ?? 0,
    hset: async (k: string, f: Record<string, string>) => (hashes.set(k, { ...(hashes.get(k) ?? {}), ...f }), 1),
    hgetall: async (k: string) => ({ ...(hashes.get(k) ?? {}) }),
    expire: async () => 1,
    sadd: async (k: string, v: string) => (sets.set(k, new Set([...(sets.get(k) ?? []), v])), 1),
    srem: async (k: string, v: string) => (sets.get(k)?.delete(v), 1),
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    quit: async () => 'OK',
  } as unknown as BackfillClient;
}

describe('compareHours', () => {
  it('依差異分類;ClickHouse 開始之前的小時不比', () => {
    const ftp = new Map([['2026/11/12 00', 1000], ['2026/11/12 01', 1000], ['2026/11/12 02', 1000], ['2026/11/12 03', 1000], ['2026/11/12 04', 0]]);
    const ch = new Map([['2026/11/12 00', 10], ['2026/11/12 01', 996], ['2026/11/12 02', 990], ['2026/11/12 03', 1010], ['2026/11/12 05', 7]]);
    const r = compareHours(ftp, ch, '2026/11/12 01');
    assert.deepEqual(r.map((h) => [h.hour.slice(11), h.status]), [['01', 'ok'], ['02', 'gap'], ['03', 'excess'], ['04', 'ok'], ['05', 'ftp-missing']].map(([h, s]) => [h, s === 'ok' && h === '04' ? 'ftp-missing' : s]));
    assert.equal(r[1]!.diff, 0.01);
    assert.equal(r[0]!.diff, 0.004);
  });
});

describe('補漏佇列(Redis)', () => {
  it('建立、取出、更新、查詢;佇列滿回 null', async () => {
    const q = createBackfillQueue(memRedis());
    const job = await q.enqueue('2026/11/12', [{ hour: 1, files: ['/a.csv'] }], 'S112009');
    assert.equal(job!.state, 'queued');
    const taken = await q.take();
    assert.equal(taken!.id, job!.id);
    assert.equal(taken!.state, 'running');
    await q.update(job!.id, { state: 'done', inserted: 3 });
    assert.equal((await q.get(job!.id))!.inserted, 3);
    assert.equal(await q.get('../x'), null);
    for (let i = 0; i < 10; i++) assert.ok(await q.enqueue('2026/11/12', [], 'x'));
    assert.equal(await q.enqueue('2026/11/12', [], 'x'), null);
  });
});

describe('補漏執行(netops-ingest)', () => {
  const HOUR = Date.parse('2026-11-12T09:00:00+08:00');
  const header = 'Receive Time,Sequence Number,Session ID,Source address,Destination address,Action,Application,IP Protocol,Destination Port,Bytes,Bytes Sent,Bytes Received,Packets';
  const line = (t: string, seq: string) => `${t},${seq},77,10.10.1.5,8.8.8.8,allow,ssl,tcp,443,100,40,60,2`;

  it('只補 seqno 不在 ClickHouse 的列,沒有 seqno 略過;source 為 ftp', async () => {
    const ch = new FakeClickHouse();
    // ClickHouse 已有 seqno 1–5
    ch.tables.traffic.push(...[1, 2, 3, 4, 5].map((i) => ({ event_time: `2026-11-12 09:0${i}:00`, seqno: String(i) })));
    const ftp = createFakeFtp();
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => line(`2026/11/12 09:0${i}:00`, String(i)));
    rows.push(line('2026/11/12 09:30:00', ''), line('2026/11/12 10:00:01', '9'), line('2026/11/12 08:59:59', '10'));
    ftp.put('/day.csv', [header, ...rows].join('\r\n') + '\r\n');
    const q = createBackfillQueue(memRedis());
    const job = (await q.enqueue('2026/11/12', [{ hour: HOUR, files: ['/day.csv'] }], 'S112009'))!;
    await runBackfill((await q.take())!, { ch, ftp, queue: q, log: () => {}, signal: new AbortController().signal });
    const done = (await q.get(job.id))!;
    assert.equal(done.state, 'done', String(done.error));
    assert.deepEqual([done.read, done.skipped, done.inserted, done.noSeqno], [9, 5, 3, 1]);
    const added = ch.tables.traffic.filter((r) => r.source === 'ftp');
    assert.deepEqual(added.map((r) => r.seqno), ['6', '7', '8']);
    assert.equal(added[0]!.src, '::ffff:10.10.1.5');
    assert.equal(added[0]!.session_id, 77);
    // 再跑一次:全部略過(冪等)
    const again = (await q.enqueue('2026/11/12', [{ hour: HOUR, files: ['/day.csv'] }], 'S112009'))!;
    await runBackfill((await q.take())!, { ch, ftp, queue: q, log: () => {}, signal: new AbortController().signal });
    assert.equal((await q.get(again.id))!.inserted, 0);
  });

  it('工作內容驗證:檔案要在 log 目錄、小時對齊且屬於該日期(Redis 內容不完全可信)', () => {
    const rules = { logDir: '/my-data', pattern: /\.(csv|gz)$/i, now: Date.parse('2026-11-13T00:00:00+08:00') };
    const job = (hours: { hour: number; files: string[] }[], day = '2026/11/12') => ({ id: 'x', day, hours } as never);
    assert.equal(validateJob(job([{ hour: HOUR, files: ['/my-data/a.csv'] }]), rules), null);
    assert.match(validateJob(job([{ hour: HOUR, files: ['/etc/passwd'] }]), rules)!, /log 目錄/);
    assert.match(validateJob(job([{ hour: HOUR, files: ['/my-data/../x.csv'] }]), rules)!, /log 目錄/);
    assert.match(validateJob(job([{ hour: HOUR + 1, files: [] }]), rules)!, /小時/);
    assert.match(validateJob(job([{ hour: HOUR, files: [] }], '2026/11/11'), rules)!, /日期/);
    assert.match(validateJob(job([{ hour: HOUR - 40 * 86_400_000, files: [] }], '2026/10/03'), rules)!, /小時/);
  });

  it('FTP 檔沒有 Sequence Number 欄位:工作 failed(不能標成完成)', async () => {
    const ftp = createFakeFtp();
    ftp.put('/x.csv', 'Receive Time,Source address\r\n2026/11/12 09:01:00,10.1.1.1\r\n');
    const q = createBackfillQueue(memRedis());
    const job = (await q.enqueue('2026/11/12', [{ hour: HOUR, files: ['/x.csv'] }], 'S112009'))!;
    await runBackfill((await q.take())!, { ch: new FakeClickHouse(), ftp, queue: q, log: () => {}, signal: new AbortController().signal });
    const r = (await q.get(job.id))!;
    assert.equal(r.state, 'failed');
    assert.match(r.error!, /Sequence Number/);
  });

  it('netops-ingest 重啟時,上次執行中的工作標失敗', async () => {
    const q = createBackfillQueue(memRedis());
    const job = (await q.enqueue('2026/11/12', [{ hour: HOUR, files: ['/x.csv'] }], 'S112009'))!;
    await q.take();
    assert.deepEqual(await q.failInterrupted('重新啟動'), [job.id]);
    assert.equal((await q.get(job.id))!.state, 'failed');
    assert.deepEqual(await q.failInterrupted('重新啟動'), []);
  });

  it('FTP 讀取失敗:工作 failed,錯誤只留分類', async () => {
    const q = createBackfillQueue(memRedis());
    const job = (await q.enqueue('2026/11/12', [{ hour: HOUR, files: ['/nope.csv'] }], 'S112009'))!;
    await runBackfill((await q.take())!, { ch: new FakeClickHouse(), ftp: createFakeFtp(), queue: q, log: () => {}, signal: new AbortController().signal });
    const r = (await q.get(job.id))!;
    assert.equal(r.state, 'failed');
    assert.ok(r.error);
  });
});

describe('對帳與補漏 API', () => {
  let t: TestApp;
  let ftp: FakeFtp;
  let reader: FakeReader;
  let queue: BackfillQueue;
  /** ClickHouse 每小時筆數 = FTP 的筆數,但 2026/11/02 01 時少 10 筆 */
  let chHours: Map<number, number>;

  before(async () => {
    ftp = createFakeFtp();
    ftp.put('/PA-560_traffic_2026_11_03_last_calendar_day_0.csv', trafficCsv('2026/11/02', 3000, 2));
    ftp.put('/PA-560_traffic_2026_11_04_last_calendar_day_0.csv', trafficCsv('2026/11/03', 50, 3));
    reader = createFakeReader();
    queue = createBackfillQueue(memRedis());
    t = await createTestApp({ ftp, chReader: reader, backfillQueue: queue, chNow: () => Date.parse('2026-11-04T07:00:00+08:00'), env: { NETOPS_CH_SUMMARY_MINUTES: '0', NETOPS_RECON_HOUR: '-1' } });
    const items = [...ftp.files.entries()].map(([path, f]) => ({ path, size: f.data.length, modified: '2026-11-04T00:05:00.000Z' }));
    assert.equal((await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items } })).statusCode, 200);
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/pa/status' })).json().traffic.busy);
    // FTP 摘要的每小時筆數 → 假 ClickHouse 每小時彙總
    const ov = (await t.call({ url: '/v1/pa/overview?from=2026-11-02&source=ftp' })).json();
    chHours = new Map(ov.hours.map((h: { hour: string; n: number }) => [Date.parse(h.hour), h.n - (h.hour.startsWith('2026-11-02T01') ? 10 : 0)]));
    reader.trafficHours = async (from, to) => [...chHours].filter(([h]) => h >= from && h < to).map(([hour, n]) => ({ hour, action: 'allow', n, bytes: 0 }));
    reader.earliestTrafficHour = async () => Date.parse('2026-11-02T00:00:00+08:00');
    await t.app.chSummary!.runOnce();
  });
  after(async () => t.close());

  it('立即對帳:有缺口的小時標 gap;結果存檔可查詢', async () => {
    const res = await t.call({ method: 'POST', url: '/v1/pa/reconciliations', payload: { day: '2026-11-02' } });
    assert.equal(res.statusCode, 200, res.body);
    const r = res.json();
    assert.equal(r.day, '2026-11-02');
    assert.equal(r.status, 'gap');
    assert.equal(r.gaps, 1);
    const gap = r.hours.find((h: { status: string }) => h.status === 'gap');
    assert.equal(gap.hour, '2026-11-02T01:00:00+08:00');
    assert.equal(gap.ftp - gap.ch, 10);
    const list = (await t.call({ url: '/v1/pa/reconciliations?from=2026-11-01&to=2026-11-03' })).json();
    assert.equal(list.days[0].day, '2026-11-02');
    assert.equal(list.threshold, 0.005);
  });

  it('補漏:只送缺口的小時,附涵蓋的 FTP 檔案;指定不是缺口的小時回 409', async () => {
    const res = await t.call({ method: 'POST', url: '/v1/pa/backfills', payload: { day: '2026-11-02' } });
    assert.equal(res.statusCode, 202, res.body);
    const job = res.json();
    assert.equal(job.state, 'queued');
    assert.deepEqual(job.hours, [{ hour: '2026-11-02T01:00:00+08:00', files: 1 }]);
    const taken = (await queue.take())!;
    assert.deepEqual(taken.hours[0]!.files, ['/PA-560_traffic_2026_11_03_last_calendar_day_0.csv']);
    assert.equal((await t.call({ url: `/v1/pa/backfills/${job.id}` })).json().state, 'running');
    assert.equal((await t.call({ url: '/v1/pa/backfills/00000000-0000-4000-8000-000000000000' })).statusCode, 404);
    const none = await t.call({ method: 'POST', url: '/v1/pa/backfills', payload: { day: '2026-11-02', hours: ['2026-11-02T05:00:00+08:00'] } });
    assert.equal(none.statusCode, 409);
    assert.equal(none.json().code, 'NETOPS_BACKFILL_NOTHING');
    // 對帳結果記下補漏工作
    assert.deepEqual((await t.call({ url: '/v1/pa/reconciliations?from=2026-11-02' })).json().days[0].backfills, [job.id]);
  });

  it('FTP 還沒涵蓋到隔天:pending,補漏回 409 NETOPS_RECON_PENDING', async () => {
    const r = (await t.call({ method: 'POST', url: '/v1/pa/reconciliations', payload: { day: '2026-11-03' } })).json();
    assert.equal(r.status, 'pending');
    const res = await t.call({ method: 'POST', url: '/v1/pa/backfills', payload: { day: '2026-11-03' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'NETOPS_RECON_PENDING');
  });

  it('ClickHouse 連不上回 503;沒有設定 ClickHouse 也回 503', async () => {
    reader.failing = true;
    const orig = reader.trafficHours;
    reader.trafficHours = async () => {
      throw new (await import('../../src/infra/clickhouse/index.js')).ClickHouseError('x', undefined, undefined);
    };
    try {
      const res = await t.call({ method: 'POST', url: '/v1/pa/reconciliations', payload: { day: '2026-11-02' } });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'NETOPS_CLICKHOUSE_UNAVAILABLE');
    } finally {
      reader.failing = false;
      reader.trafficHours = orig;
    }
    const t2 = await createTestApp({ ftp: createFakeFtp(), chReader: null });
    try {
      assert.equal((await t2.call({ url: '/v1/pa/reconciliations?from=2026-11-02' })).statusCode, 503);
    } finally {
      await t2.close();
    }
  });
});
