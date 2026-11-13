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
    // FTP 摘要的每小時筆數(直接讀已分析的摘要;C3 起總覽不再讀 FTP)
    const idx = t.app.store.pa.loadIndex<{ summary?: string }>();
    const ftpHours = new Map<number, number>();
    for (const st of Object.values(idx.files)) {
      const sum = st.summary ? t.app.store.pa.readSummary<{ hours: Record<string, { n: number }> }>(st.summary) : null;
      for (const [h, v] of Object.entries(sum?.hours ?? {})) {
        if (!h.startsWith('2026/11/02')) continue;
        const ms = Date.parse(`${h.slice(0, 10).replace(/\//g, '-')}T${h.slice(11, 13)}:00:00+08:00`);
        ftpHours.set(ms, (ftpHours.get(ms) ?? 0) + v.n);
      }
    }
    chHours = new Map([...ftpHours].map(([h, n]) => [h, n - (h === Date.parse('2026-11-02T01:00:00+08:00') ? 10 : 0)]));
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

describe('自動對帳(每天 at 起,自己同步 FTP;有缺口自動補漏)', () => {
  const day = (d: string) => Date.parse(`${d}T00:00:00+08:00`);
  /** 假 TRAFFIC 匯入:files 依日期回已分析的檔(有 23:50 以後的檔才算完整) */
  function fakeTraffic() {
    const f = {
      complete: new Set<string>(),
      syncs: 0,
      syncFails: false,
      filesInRange: (from: string) => (f.complete.has(from.slice(0, 10)) ? [{ path: `/${from.slice(0, 10)}.csv`, summary: 's', timeMin: `${from.slice(0, 10)} 00:00:00`, timeMax: `${from.slice(0, 10)} 23:59:59` }] : []),
      readSummary: () => ({ hours: {} }),
      status: () => ({ busy: false }),
      sync: async () => {
        f.syncs++;
        if (f.syncFails) throw new Error('ftp down');
        return { found: 0, added: 0 };
      },
    };
    return f;
  }
  async function setup(nowMs: () => number, opts: { at?: number; queue?: BackfillQueue; enabled?: boolean; ftpN?: number; logs?: string[] } = {}) {
    const traffic = fakeTraffic();
    // FTP 摘要每天 03 時 ftpN 筆;ClickHouse 03 時 chN 筆(ftpN > chN 為缺口)
    const ftpN = opts.ftpN ?? 0;
    (traffic as { readSummary: () => unknown }).readSummary = () => ({ hours: Object.fromEntries([...traffic.complete].map((d) => [`${d} 03`, { n: ftpN }])) });
    const reader = createFakeReader();
    const ch = { n: 0 };
    reader.trafficHours = async (from) => [{ hour: from + 3 * 3600_000, action: 'allow', n: ch.n, bytes: 0 }];
    reader.earliestTrafficHour = async () => day('2026-11-01');
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'netops-recon-'));
    const { createStore } = await import('../../src/infra/store/index.js');
    const { createChSummaryBuilder } = await import('../../src/modules/pa/ch-summary.js');
    const { createReconciler } = await import('../../src/modules/pa/reconcile.js');
    const store = createStore(dir).pa;
    const builder = createChSummaryBuilder({ reader, store, log: { info() {}, warn() {} }, days: 30, minutes: 0, now: nowMs });
    const logs = opts.logs ?? [];
    const r = createReconciler({
      traffic: traffic as never,
      reader,
      builder,
      store,
      log: { info() {}, warn: (_o: object, m: string) => void logs.push(m) },
      at: opts.at ?? 60,
      backfill: { queue: opts.queue ?? null, enabled: opts.enabled ?? false, retentionDays: 10 },
      now: nowMs,
    });
    return { traffic, r, store, ch, logs };
  }
  const tick = async (r: { start(): void; stop(): void }) => {
    r.start();
    r.stop();
    await new Promise((ok) => setTimeout(ok, 20));
  };

  it('08:10 起才跑(分鐘也比);有缺口自動送補漏(createdBy system:recon),執行中等它,補完沒缺口就結束', async () => {
    let now = Date.parse('2026-11-12T08:09:00+08:00');
    const queue = createBackfillQueue(memRedis());
    const { traffic, r, store, ch } = await setup(() => now, { at: 8 * 60 + 10, queue, enabled: true, ftpN: 1000 });
    for (const d of ['2026/11/11', '2026/11/10', '2026/11/09']) traffic.complete.add(d);
    ch.n = 900;
    await tick(r);
    assert.equal(store.readRecon('20261111'), null, '08:09 不跑');

    now = Date.parse('2026-11-12T08:10:00+08:00');
    await tick(r);
    const rec = store.readRecon('20261111') as { status: string; backfills: string[] };
    assert.equal(rec.status, 'gap');
    assert.equal(rec.backfills.length, 1);
    const job = (await queue.get(rec.backfills[0]!))!;
    assert.equal(job.createdBy, 'system:recon');
    assert.deepEqual(job.hours.map((h) => h.files), [['/2026/11/11.csv']]);

    // 10 分鐘後:工作還在排隊 → 不重送
    now += 10 * 60_000;
    await tick(r);
    assert.equal((store.readRecon('20261111') as { backfills: string[] }).backfills.length, 1);

    // netops-ingest 補完,ClickHouse 筆數對上 → ok,不再送
    for (const id of [...new Set(['20261111', '20261110', '20261109'].flatMap((d) => (store.readRecon(d) as { backfills: string[] }).backfills))]) await queue.update(id, { state: 'done' });
    ch.n = 1000;
    now += 10 * 60_000;
    await tick(r);
    assert.equal((store.readRecon('20261111') as { status: string }).status, 'ok');
    assert.equal((store.readRecon('20261111') as { backfills: string[] }).backfills.length, 1);
  });

  it('補漏完成仍有缺口:同一天每天最多自動送 3 次後停止並 warn;NETOPS_RECON_AUTO_BACKFILL 關閉時不送', async () => {
    let now = Date.parse('2026-11-12T08:10:00+08:00');
    const queue = createBackfillQueue(memRedis());
    const logs: string[] = [];
    const { traffic, r, store, ch } = await setup(() => now, { at: 8 * 60 + 10, queue, enabled: true, ftpN: 1000, logs });
    traffic.complete.add('2026/11/11');
    traffic.complete.add('2026/11/12');
    ch.n = 900;
    for (let i = 0; i < 6; i++) {
      await tick(r);
      for (const id of (store.readRecon('20261111') as { backfills: string[] }).backfills) await queue.update(id, { state: 'failed' });
      now += 10 * 60_000;
    }
    assert.equal((store.readRecon('20261111') as { backfills: string[] }).backfills.length, 3);
    assert.ok(logs.some((m) => m.includes('停止自動補漏')));

    const off = await setup(() => now, { at: 8 * 60 + 10, queue, enabled: false, ftpN: 1000 });
    off.traffic.complete.add('2026/11/11');
    off.traffic.complete.add('2026/11/12');
    off.ch.n = 900;
    await tick(off.r);
    assert.equal((off.store.readRecon('20261111') as { status: string; backfills: string[] }).status, 'gap');
    assert.deepEqual((off.store.readRecon('20261111') as { backfills: string[] }).backfills, []);
  });

  it('FTP 保留期限內較舊的缺口也自動補,自動補漏同時只佔 1 個佇列位置、剛補完先等一陣子;超過保留期限仍有缺口記 warn(每天一次)', async () => {
    const now = Date.parse('2026-11-20T08:10:00+08:00');
    const queue = createBackfillQueue(memRedis());
    const logs: string[] = [];
    const { traffic, r, store, ch } = await setup(() => now, { at: 8 * 60 + 10, queue, enabled: true, ftpN: 1000, logs });
    const gapDay = (day: string) => store.saveRecon(day.replace(/\//g, ''), { day, checkedAt: '', status: 'gap', ftpFiles: 1, gaps: 1, excess: 0, hours: [], backfills: [] });
    gapDay('2026/11/13'); // 7 天前:期限內
    gapDay('2026/11/12'); // 8 天前:期限內
    gapDay('2026/11/05'); // 15 天前:超過 10 天
    for (const d of ['2026/11/12', '2026/11/13', '2026/11/14']) traffic.complete.add(d);
    ch.n = 900;
    await tick(r);
    const first = (store.readRecon('20261113') as { backfills: string[] }).backfills;
    assert.equal(first.length, 1, '期限內的缺口自動補');
    assert.equal((store.readRecon('20261112') as { backfills: string[] }).backfills.length, 0, '前一個自動補漏還沒做完,先等');
    assert.equal(logs.filter((m) => m.includes('超過 FTP 保留期限')).length, 1);

    // 11/13 的補漏剛完成(還在等彙總追上):不重送 11/13,改送 11/12
    await queue.update(first[0]!, { state: 'done', finishedAt: new Date(now).toISOString() });
    await tick(r);
    assert.equal((store.readRecon('20261113') as { backfills: string[] }).backfills.length, 1);
    assert.equal((store.readRecon('20261112') as { backfills: string[] }).backfills.length, 1);
    assert.equal(logs.filter((m) => m.includes('超過 FTP 保留期限')).length, 1, '同一天只記一次');
  });

  it('01:00 前不跑;FTP 不完整時同步一次並標 pending,30 分鐘內不重複同步;完整後不再重試;同步失敗不影響對帳', async () => {
    let now = Date.parse('2026-11-12T00:30:00+08:00');
    const { traffic, r: rec, store } = await setup(() => now);
    const tickOnce = () => tick(rec);
    await tickOnce();
    assert.equal(traffic.syncs, 0);
    assert.equal(store.readRecon('20261111'), null);

    now = Date.parse('2026-11-12T01:00:00+08:00');
    await tickOnce();
    assert.equal(traffic.syncs, 1);
    assert.equal((store.readRecon('20261111') as { status: string }).status, 'pending');

    now += 10 * 60_000;
    await tickOnce();
    assert.equal(traffic.syncs, 1, '30 分鐘內不重複同步');

    // 01:40 同步失敗:仍照常對帳(還是 pending)
    traffic.syncFails = true;
    now = Date.parse('2026-11-12T01:40:00+08:00');
    const before = (store.readRecon('20261111') as { checkedAt: string }).checkedAt;
    await tickOnce();
    assert.equal(traffic.syncs, 2);
    assert.notEqual((store.readRecon('20261111') as { checkedAt: string }).checkedAt, before);

    // 07:45 FTP 檔到了(已分析完整):不用再同步,前一天對帳完成
    traffic.complete.add('2026/11/11');
    traffic.complete.add('2026/11/10');
    traffic.complete.add('2026/11/09');
    now = Date.parse('2026-11-12T07:50:00+08:00');
    await tickOnce();
    assert.equal(traffic.syncs, 2);
    assert.notEqual((store.readRecon('20261111') as { status: string }).status, 'pending');
    const checked = (store.readRecon('20261111') as { checkedAt: string }).checkedAt;

    // 已完成的日子不再重試
    now += 10 * 60_000;
    await tickOnce();
    assert.equal((store.readRecon('20261111') as { checkedAt: string }).checkedAt, checked);
  });
});
