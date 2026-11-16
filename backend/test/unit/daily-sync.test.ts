/**
 * AC1 對帳後每日同步(解密 / GlobalProtect / User-ID / AD;ARCHITECTURE D43、D44):
 *   - fileDataDay:匯出檔名推算資料日期(last_calendar_day 往前一天)
 *   - 其他類型 log 的同步可只排指定類型與日期;dayState 依檔名日期判斷每一天的匯入狀態
 *   - 每日同步:前一天沒匯入完成時照對帳的規則重試(FTP 30 分鐘最多列一次),完成後當天不再跑;試太多次停止並 warn;
 *     超過 FTP 保留期限仍沒匯入記 warn(每個類型每天一次,從沒匯入過的類型不記);FTP 失敗不丟出
 *   - 對帳每一輪(到了 at 之後)結束後才接著每日同步;對帳失敗也照跑
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createStore } from '../../src/infra/store/index.js';
import { createDailySync, DAILY_MAX_TRIES, type DailyDayState } from '../../src/modules/ftp/daily-sync.js';
import { createEventImporter } from '../../src/modules/pa-events/importer.js';
import { fileDataDay } from '../../src/modules/pa/importer.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { createFakeReader } from '../fixtures/fake-ch.js';
import { waitFor } from '../helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'netops-daily-'));

describe('fileDataDay', () => {
  it('匯出檔名是匯出日,last_calendar_day 往前一天;沒有日期回 null', () => {
    assert.equal(fileDataDay('PA-560_decryption_2026_11_13_last_calendar_day_0.csv'), '2026/11/12');
    assert.equal(fileDataDay('PA-560_userid_2026_03_01_last_calendar_day_1.csv.gz'), '2026/02/28');
    assert.equal(fileDataDay('gp-2026-11-12.csv'), '2026/11/12');
    assert.equal(fileDataDay('globalprotect.csv'), null);
  });
});

describe('其他類型 log:只同步指定類型與日期、每天的匯入狀態', () => {
  const GP = 'Receive Time,Event ID,Stage,Status,Source User,Public IP\n2026/11/12 10:00:00,gateway-connected,connect,success,alice,1.2.3.4\n';
  it('types / days 只排符合的檔;dayState 依檔名日期回 done / none / error', async () => {
    const ftp = createFakeFtp();
    ftp.put('/globalprotect/PA-560_globalprotect_2026_11_13_last_calendar_day_0.csv', GP); // 11/12
    ftp.put('/globalprotect/PA-560_globalprotect_2026_10_01_last_calendar_day_0.csv', GP); // 9/30:保留期限外
    ftp.put('/globalprotect/PA-560_globalprotect_2026_11_12_last_calendar_day_0.csv', 'not,a,pa,log\n1,2,3,4\n'); // 11/11:格式錯
    ftp.put('/threat/PA-560_threat_2026_11_13_last_calendar_day_0.csv', GP);
    const store = createStore(tmp()).pa;
    const eventDirs = { threat: '/threat', url: '', data: '', wildfire: '', decryption: '', globalprotect: '/globalprotect', userid: '' };
    const ev = createEventImporter({
      ftp,
      store,
      ftpConfig: { eventDirs, syncMinutes: 0, maxConnections: 1 } as never,
      log: { info() {}, warn() {}, error() {} } as never,
    });
    const r = await ev.sync({ types: ['globalprotect', 'decryption'], days: new Set(['2026/11/12', '2026/11/11']) });
    assert.equal(r.added, 2, '只排 globalprotect 的 11/12、11/11;不排 9/30 與威脅類');
    await waitFor(() => !ev.status().busy);
    assert.equal(ev.dayState('globalprotect', '2026/11/12'), 'done');
    assert.equal(ev.dayState('globalprotect', '2026/11/11'), 'error');
    assert.equal(ev.dayState('globalprotect', '2026/09/30'), 'none');
    assert.equal(ev.dayState('threat', '2026/11/12'), 'none');
    assert.equal(ev.hasAnyFile('globalprotect'), true);
    assert.equal(ev.hasAnyFile('threat'), false);
    await ev.stop();
  });
});

/** 假的其他類型 log 與 AD 匯入:states[類型][日期] */
function fakes(opts: { types?: string[] } = {}) {
  const states: Record<string, Record<string, DailyDayState>> = { decryption: {}, globalprotect: {}, userid: {}, ad: {} };
  const calls = { events: [] as { types?: string[]; days?: Set<string> }[], ad: [] as { days?: string[] | null }[] };
  const f = {
    states,
    calls,
    eventsFail: false,
    adFail: false,
    used: new Set(['decryption', 'globalprotect', 'userid', 'ad']),
    events: {
      eventTypes: () =>
        (opts.types ?? ['threat', 'decryption', 'globalprotect', 'userid']).map((type) => ({ type, label: type === 'threat' ? '威脅' : type, dir: `/${type}` })),
      sync: async (o: { types?: string[]; days?: Set<string> } = {}) => {
        calls.events.push(o);
        if (f.eventsFail) throw new Error('ftp down');
        return { found: 0, added: 0, errors: [] as string[] };
      },
      dayState: (t: string, d: string) => states[t]?.[d] ?? 'none',
      hasAnyFile: (t: string) => f.used.has(t),
    },
    ad: {
      configured: () => true,
      sync: async (o: { days?: string[] | null; force?: boolean } = {}) => {
        calls.ad.push(o);
        if (f.adFail) throw Object.assign(new Error('ftp down'), { code: 'NETOPS_FTP_UNAVAILABLE' });
        return { days: 0, imported: [] };
      },
      dayState: (d: string) => states.ad![d] ?? 'none',
      hasAnyDay: () => f.used.has('ad'),
    },
  };
  return f;
}
const allDone = (f: ReturnType<typeof fakes>, day: string) => {
  for (const k of ['decryption', 'globalprotect', 'userid', 'ad']) f.states[k]![day] = 'done';
};

describe('每日同步(解密 / GlobalProtect / User-ID / AD)', () => {
  it('前一天還沒全部匯入:每輪再看,FTP 30 分鐘最多列一次;全部完成後當天不再跑;只排保留期限內的日子', async () => {
    let now = Date.parse('2026-11-13T08:10:00+08:00');
    const f = fakes();
    const logs: string[] = [];
    const d = createDailySync({ events: f.events as never, ad: f.ad as never, log: { info: (_o, m) => void logs.push(m), warn: (_o, m) => void logs.push(m) }, enabled: true, at: 8 * 60 + 10, retentionDays: 10, now: () => now });
    assert.equal(d.status().state, 'waiting');

    await d.run();
    assert.equal(f.calls.events.length, 1);
    assert.deepEqual(f.calls.events[0]!.types, ['decryption', 'globalprotect', 'userid'], '不同步 TRAFFIC 與威脅類');
    assert.deepEqual([...f.calls.events[0]!.days!].sort(), ['2026/11/04', '2026/11/05', '2026/11/06', '2026/11/07', '2026/11/08', '2026/11/09', '2026/11/10', '2026/11/11', '2026/11/12']);
    assert.deepEqual(f.calls.ad[0]!.days?.[0], '2026/11/12');
    let st = d.status();
    assert.equal(st.state, 'retrying');
    assert.equal(st.at, '08:10');
    assert.deepEqual(st.categories.map((c) => c.key), ['decryption', 'globalprotect', 'userid', 'ad']);
    assert.equal(st.categories[0]!.days[0]!.day, '2026-11-12');
    assert.equal(st.categories[0]!.days.length, 9);

    // 10 分鐘後:檔還在分析,不重新列 FTP
    now += 10 * 60_000;
    f.states.decryption!['2026/11/12'] = 'pending';
    await d.run();
    assert.equal(f.calls.events.length, 1);
    assert.equal(d.status().categories[0]!.days[0]!.state, 'pending');

    // 30 分鐘後再列一次;全部完成
    now += 20 * 60_000;
    allDone(f, '2026/11/12');
    await d.run();
    assert.equal(f.calls.events.length, 2);
    st = d.status();
    assert.equal(st.state, 'done');
    assert.ok(st.finishedAt);
    assert.ok(logs.some((m) => m.includes('每日同步完成')));

    // 當天不再跑
    now += 60 * 60_000;
    await d.run();
    assert.equal(f.calls.events.length, 2);

    // 隔天重新開始
    now = Date.parse('2026-11-14T08:10:00+08:00');
    await d.run();
    assert.equal(f.calls.events.length, 3);
    assert.equal(d.status().state, 'retrying');
  });

  it('FTP 失敗不丟出、下一輪再試;試太多次停止並 warn', async () => {
    let now = Date.parse('2026-11-13T08:10:00+08:00');
    const f = fakes();
    f.eventsFail = true;
    f.adFail = true;
    const warns: string[] = [];
    const d = createDailySync({ events: f.events as never, ad: f.ad as never, log: { info() {}, warn: (_o, m) => void warns.push(m) }, enabled: true, at: 490, retentionDays: 10, now: () => now });
    await d.run();
    assert.ok(warns.some((m) => m.includes('PA 類型目錄同步失敗')));
    assert.ok(warns.some((m) => m.includes('AD 同步失敗')));
    for (let i = 1; i < DAILY_MAX_TRIES; i++) {
      now += 10 * 60_000;
      await d.run();
    }
    assert.equal(d.status().state, 'gave-up');
    assert.ok(warns.some((m) => m.includes('停止自動重試')));
    const n = f.calls.events.length;
    now += 30 * 60_000;
    await d.run();
    assert.equal(f.calls.events.length, n, '停止後當天不再列 FTP');
  });

  it('超過 FTP 保留期限仍沒匯入記 warn(每個類型每天一次);從沒匯入過的類型不記;關閉時不做事', async () => {
    const now = Date.parse('2026-11-20T08:10:00+08:00');
    const f = fakes({ types: ['decryption', 'globalprotect', 'userid'] });
    f.used.delete('userid');
    // 10 天前(11/10)起都還沒匯入;解密 11/10 有
    f.states.decryption!['2026/11/10'] = 'done';
    const warns: { o: object; m: string }[] = [];
    const d = createDailySync({ events: f.events as never, ad: f.ad as never, log: { info() {}, warn: (o, m) => void warns.push({ o, m }) }, enabled: true, at: 490, retentionDays: 10, now: () => now });
    await d.run();
    const expired = warns.filter((w) => w.m.includes('超過 FTP 保留期限'));
    // 11/10 ~ 11/03 共 8 天:globalprotect 8、AD 8、decryption 7(11/10 已匯入);userid 從沒匯入過不記
    assert.equal(expired.length, 23);
    assert.ok(!expired.some((w) => (w.o as { type: string }).type === 'userid'));
    await d.run();
    assert.equal(warns.filter((w) => w.m.includes('超過 FTP 保留期限')).length, 23, '同一天不重複記');

    const off = fakes();
    const d2 = createDailySync({ events: off.events as never, ad: off.ad as never, log: { info() {}, warn() {} }, enabled: false, at: 490, retentionDays: 10, now: () => now });
    await d2.run();
    assert.equal(off.calls.events.length + off.calls.ad.length, 0);
    assert.equal(d2.status().state, 'disabled');
    assert.equal(d2.status().at, null);
    assert.deepEqual(d2.status().categories, []);
  });

  it('沒有設定的類型(目錄為 -)與沒有 FTP 時不列入', async () => {
    const f = fakes({ types: ['threat', 'globalprotect'] });
    (f.ad as { configured: () => boolean }).configured = () => false;
    const d = createDailySync({ events: f.events as never, ad: f.ad as never, log: { info() {}, warn() {} }, enabled: true, at: 490, retentionDays: 10, now: () => Date.parse('2026-11-13T08:10:00+08:00') });
    await d.run();
    assert.deepEqual(f.calls.events[0]!.types, ['globalprotect']);
    assert.equal(f.calls.ad.length, 0);
    assert.deepEqual(d.status().categories.map((c) => c.key), ['globalprotect']);
  });
});

describe('對帳每一輪之後接著每日同步', () => {
  it('到了 at 才跑;對帳失敗也照跑;每日同步丟錯只記 warn', async () => {
    let now = Date.parse('2026-11-13T08:00:00+08:00');
    const reader = createFakeReader();
    reader.trafficHours = async () => {
      throw Object.assign(new Error('ch down'), { code: 'NETOPS_CLICKHOUSE_UNAVAILABLE' });
    };
    const store = createStore(tmp()).pa;
    const { createChSummaryBuilder } = await import('../../src/modules/pa/ch-summary.js');
    const { createReconciler } = await import('../../src/modules/pa/reconcile.js');
    const builder = createChSummaryBuilder({ reader, store, log: { info() {}, warn() {} }, days: 30, minutes: 0, now: () => now });
    const traffic = { filesInRange: () => [], readSummary: () => null, status: () => ({ busy: false }), sync: async () => ({ found: 0, added: 0 }) };
    let calls = 0;
    let fail = false;
    const warns: string[] = [];
    const r = createReconciler({
      traffic: traffic as never,
      reader,
      builder,
      store,
      log: { info() {}, warn: (_o: object, m: string) => void warns.push(m) },
      at: 8 * 60 + 10,
      after: async () => {
        calls++;
        if (fail) throw new Error('boom');
      },
      now: () => now,
    });
    const tick = async () => {
      r.start();
      r.stop();
      await new Promise((ok) => setTimeout(ok, 20));
    };
    await tick();
    assert.equal(calls, 0, '08:00 不跑');
    now = Date.parse('2026-11-13T08:10:00+08:00');
    await tick();
    assert.equal(calls, 1, 'ClickHouse 失敗(對帳失敗)也接著同步');
    assert.ok(warns.some((m) => m.includes('FTP 對帳失敗')));
    fail = true;
    now += 10 * 60_000;
    await tick();
    assert.equal(calls, 2);
    assert.ok(warns.some((m) => m.includes('對帳後的每日同步失敗')));
  });
});
