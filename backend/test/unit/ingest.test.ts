/**
 * netops-ingest(IMPL-PLAN C2):欄位轉換、批次寫入、成功才 ACK、重啟去重、拆批、缺口偵測、設定、ClickHouse HTTP 用戶端。
 * 真 Redis / ClickHouse 的行為(DDL、JSONEachRow、去重 token、物化檢視)在 test/integration/ingest.int.test.ts。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ClickHouseError, createClickHouseWriter, isDataError, isSchemaError, isUnknownBadRequest } from '../../src/infra/clickhouse/index.js';
import { compareId, gapFrom } from '../../src/infra/redis/ingest.js';
import { loadIngestConfig } from '../../src/ingest/config.js';
import { heartbeatFields } from '../../src/ingest/main.js';
import { ip, parsePaTime, seqno, taipeiText, toRow } from '../../src/ingest/rows.js';
import { MAX_BATCH_BYTES, MAX_ENTRY_BYTES, sanitizeMessage, Writer } from '../../src/ingest/writer.js';
import { FakeClickHouse, FakeIngestRedis } from '../fixtures/fake-ingest.js';

const T0 = Date.UTC(2026, 10, 10, 5, 45, 16, 123); // 2026-11-10 13:45:16.123 台灣
const TRAFFIC = {
  type: 'TRAFFIC', time: '2026/11/10 13:45:16', subtype: 'end', src: '10.10.112.13', dst: '8.8.8.8', natSrc: '', natDst: '2001:db8::1',
  rule: 'r1', app: 'dns', sport: 51234, dport: 53, natDport: 0, proto: 'udp', action: 'allow', bytes: 120, sent: 60, recv: 60, packets: 2,
  start: '2026/11/10 13:45:00', elapsed: 16, appRisk: 4, seqno: '7688588907462574142', sessionId: 288580,
};

describe('rows:欄位轉換', () => {
  it('PA 時間轉成 ClickHouse 當地時間字串,並算出 UTC 毫秒', () => {
    assert.deepEqual(parsePaTime('2026/11/10 13:45:16'), { text: '2026-11-10 13:45:16', ms: Date.UTC(2026, 10, 10, 5, 45, 16) });
    assert.equal(parsePaTime('2026-11-10T13:45:16')?.text, '2026-11-10 13:45:16');
    for (const bad of ['2026/02/30 10:00:00', '2026/11/10 25:00:00', '2026/11/10', 'x', 123, null, ' 2026/11/10 13:45:16 extra']) assert.equal(parsePaTime(bad), null, String(bad));
    assert.equal(taipeiText(Date.UTC(2026, 10, 10, 16, 30, 0)), '2026-11-11 00:30:00');
  });

  it('IPv4 轉 ::ffff:,IPv6 原樣,不合法存 ::', () => {
    assert.equal(ip('10.1.2.3'), '::ffff:10.1.2.3');
    assert.equal(ip('2001:db8::1'), '2001:db8::1');
    for (const bad of ['', '10.1.2', '999.1.1.1', 'fe80::1%eth0', 'host', null, 5]) assert.equal(ip(bad), '::', String(bad));
  });

  it('seqno 保持字串(64 位元不失精度),不合法寫 0', () => {
    assert.equal(seqno('7688588907462574142'), '7688588907462574142');
    assert.equal(seqno('18446744073709551615'), '18446744073709551615');
    for (const bad of ['18446744073709551616', '-1', '01', '1e5', 7688588907462574142, undefined]) assert.equal(seqno(bad), '0', String(bad));
  });

  it('TRAFFIC 一筆完整轉換', () => {
    const issues = { badTime: false };
    const r = toRow('traffic', JSON.stringify(TRAFFIC), T0, issues)!;
    assert.equal(issues.badTime, false);
    assert.equal(r.event_time, '2026-11-10 13:45:16');
    assert.equal(r.received_at, '2026-11-10T05:45:16.123Z');
    assert.equal(r.src, '::ffff:10.10.112.13');
    assert.equal(r.nat_src, '::');
    assert.equal(r.nat_dst, '2001:db8::1');
    assert.equal(r.seqno, '7688588907462574142');
    assert.equal(r.session_id, 288580);
    assert.equal(r.bytes_sent, 60);
    assert.equal(r.session_start, '2026-11-10 13:45:00');
    assert.equal(r.app_risk, 4);
    assert.equal(r.source, 'syslog');
    assert.equal('type' in r, false);
  });

  it('數字超出欄位寬度寫 0;沒有開始時間寫 0;時間錯誤改用收到時間', () => {
    const issues = { badTime: false };
    const r = toRow('traffic', JSON.stringify({ time: 'bad', dport: 70000, appRisk: 300, elapsed: -1, sessionId: 2 ** 33, bytes: '12' }), T0, issues)!;
    assert.equal(issues.badTime, true);
    assert.equal(r.event_time, '2026-11-10 13:45:16');
    assert.deepEqual([r.dport, r.app_risk, r.elapsed, r.session_id, r.bytes, r.session_start, r.seqno], [0, 0, 0, 0, 12, 0, '0']);
  });

  it('事件時間和收到時間差超過 7 天時不信任', () => {
    const issues = { badTime: false };
    const r = toRow('threat', JSON.stringify({ time: '2025/01/01 00:00:00' }), T0, issues)!;
    assert.equal(issues.badTime, true);
    assert.equal(r.event_time, '2026-11-10 13:45:16');
  });

  it('威脅類寫 pa_threat_logs 的欄位,log_type 是 Stream 類型', () => {
    const r = toRow('url', JSON.stringify({ time: '2026/11/10 13:45:16', src: '10.0.0.1', url: 'example.com/a', repeat: 3, filedigest: 'abc', filetype: 'pe', sport: 1, natDport: 2, seqno: '9', sessionId: 7 }), T0, { badTime: false })!;
    assert.deepEqual(
      [r.log_type, r.url, r.repeat_count, r.file_digest, r.file_type, r.sport, r.nat_dport, r.seqno, r.session_id, r.source],
      ['url', 'example.com/a', 3, 'abc', 'pe', 1, 2, '9', 7, 'http'],
    );
  });

  it('不是 JSON 物件回 null', () => {
    for (const bad of ['{', '[]', 'null', '"x"', '']) assert.equal(toRow('traffic', bad, T0, { badTime: false }), null, bad);
  });
});

/** 測試用時鐘:讀不到新資料時前進 10 秒,讓一輪批次結束 */
function setup(opts: { batchMax?: number } = {}) {
  const redis = new FakeIngestRedis();
  const ch = new FakeClickHouse();
  let now = T0;
  const waits: number[] = [];
  const make = () =>
    new Writer(redis, ch, { batchMs: 5_000, batchMax: opts.batchMax ?? 5_000 }, async (ms) => {
      waits.push(ms);
      now += ms;
    }, () => now);
  redis.onIdle = () => {
    now += 10_000;
  };
  return { redis, ch, make, waits };
}

describe('Writer:批次寫入與 ACK', () => {
  it('讀到的 log 寫進對應的表,成功後 ACK;待處理清單清空', async () => {
    const { redis, ch, make } = setup();
    const w = make();
    await w.init();
    const ids = [redis.add('traffic', TRAFFIC), redis.add('traffic', TRAFFIC), redis.add('threat', { src: '1.1.1.1' }), redis.add('wildfire', { src: '2.2.2.2' })];
    await w.cycle(new AbortController().signal);
    assert.equal(ch.tables.traffic.length, 2);
    assert.deepEqual(ch.tables.threat.map((r) => r.log_type), ['threat', 'wildfire']);
    assert.deepEqual([...(redis.acked.traffic ?? []), ...(redis.acked.threat ?? []), ...(redis.acked.wildfire ?? [])].sort(compareId), ids.sort(compareId));
    for (const s of redis.streams.values()) assert.equal(s.group!.pending.size, 0);
    assert.equal(w.status.counts.traffic.inserted, 2);
    assert.equal(w.status.counts.traffic.batches, 1);
    assert.equal(w.status.lastAcked.traffic, ids.find((i) => redis.acked.traffic!.includes(i) && i === redis.acked.traffic!.at(-1)));
  });

  it('每種類型一批最多 batchMax 筆;token 由第一筆、最後一筆 ID 與筆數組成', async () => {
    const { redis, ch, make } = setup({ batchMax: 5 });
    const w = make();
    await w.init();
    const ids = Array.from({ length: 12 }, () => redis.add('traffic', TRAFFIC));
    const sig = new AbortController().signal;
    for (let i = 0; i < 3; i++) await w.cycle(sig);
    assert.deepEqual(ch.calls.map((c) => c.rows), [5, 5, 2]);
    assert.equal(ch.calls[0]!.token, `traffic:${ids[0]}:${ids[4]}:5`);
    assert.equal(ch.tables.traffic.length, 12);
  });

  it('ClickHouse 暫時失敗:不 ACK、退避重試,恢復後才 ACK', async () => {
    const { redis, ch, make, waits } = setup();
    const w = make();
    await w.init();
    redis.add('traffic', TRAFFIC);
    ch.failTransient = 3;
    await w.cycle(new AbortController().signal);
    assert.deepEqual(waits, [1000, 2000, 4000]);
    assert.equal(ch.tables.traffic.length, 1);
    assert.equal(redis.acked.traffic?.length, 1);
    assert.equal(w.status.insertFailures, 3);
    assert.equal(w.status.failing, 0);
    assert.match(w.status.lastError!.message, /ECONNREFUSED/);
  });

  it('寫入成功、ACK 前停止 → 重啟後待處理清單單獨成批,token 相同,ClickHouse 不重複', async () => {
    const { redis, ch, make } = setup();
    const w1 = make();
    await w1.init();
    for (let i = 0; i < 4; i++) redis.add('traffic', TRAFFIC);
    const stop = new AbortController();
    redis.failAck = 1;
    // ACK 失敗後的重試等待期間收到停止訊號
    const orig = redis.ack.bind(redis);
    redis.ack = async (t, ids) => {
      stop.abort();
      return orig(t, ids);
    };
    await w1.cycle(stop.signal);
    redis.ack = orig;
    assert.equal(ch.tables.traffic.length, 4);
    assert.equal(redis.streams.get('traffic')!.group!.pending.size, 4);
    // 重啟前又來了新的 log:待處理那批不能混新資料
    redis.add('traffic', TRAFFIC);
    const w2 = make();
    await w2.init();
    await w2.drainPending(new AbortController().signal);
    assert.equal(ch.calls.at(-1)!.token, ch.calls[0]!.token);
    assert.equal(ch.tables.traffic.length, 4, '同一個 token 重送被略過');
    assert.equal(redis.streams.get('traffic')!.group!.pending.size, 0);
    await w2.cycle(new AbortController().signal);
    assert.equal(ch.tables.traffic.length, 5);
  });

  it('寫入失敗中途停止 → 不 ACK;重啟後補寫', async () => {
    const { redis, ch, make } = setup();
    const w1 = make();
    await w1.init();
    redis.add('threat', { src: '1.1.1.1' });
    ch.failTransient = 1;
    const stop = new AbortController();
    const origInsert = ch.insert.bind(ch);
    ch.insert = async (...a) => {
      stop.abort();
      return origInsert(...a);
    };
    await w1.cycle(stop.signal);
    ch.insert = origInsert;
    assert.equal(ch.tables.threat.length, 0);
    assert.equal(redis.acked.threat, undefined);
    const w2 = make();
    await w2.init();
    // 假 Redis 全是 microtask,計時器不會觸發:讀不到新資料時直接停止
    const stop2 = new AbortController();
    const idle = redis.onIdle;
    redis.onIdle = () => {
      idle?.();
      stop2.abort();
    };
    await w2.run(stop2.signal);
    assert.equal(ch.tables.threat.length, 1);
  });

  it('資料錯誤:對半拆批,只丟壞列並計數', async () => {
    const { redis, ch, make } = setup();
    const w = make();
    await w.init();
    for (const s of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5']) redis.add('traffic', { ...TRAFFIC, src: s });
    ch.badSrc.add('::ffff:10.0.0.4');
    await w.cycle(new AbortController().signal);
    assert.deepEqual(ch.tables.traffic.map((r) => r.src), ['::ffff:10.0.0.1', '::ffff:10.0.0.2', '::ffff:10.0.0.3', '::ffff:10.0.0.5']);
    assert.equal(w.status.counts.traffic.rejected, 1);
    assert.equal(w.status.counts.traffic.inserted, 4);
    assert.equal(redis.acked.traffic?.length, 5);
    assert.ok(ch.calls.some((c) => /:[ab]\d+$/.test(c.token)), '子批 token 帶 :a / :b 與筆數');
  });

  it('壞 JSON 計 malformed、待處理已被修剪計 trimmed,都 ACK 不重讀', async () => {
    const { redis, ch, make } = setup();
    const w = make();
    await w.init();
    redis.add('traffic', '{bad');
    redis.add('traffic', TRAFFIC);
    await w.cycle(new AbortController().signal);
    assert.equal(w.status.counts.traffic.malformed, 1);
    assert.equal(ch.tables.traffic.length, 1);
    // 待處理條目被修剪:讀到 data null
    const id = redis.add('url', { src: '1.1.1.1' });
    await redis.readNew(['url'], 10);
    redis.trim('url', `${Number(id.split('-')[0]) + 1}-0`);
    await w.drainPending(new AbortController().signal);
    assert.equal(w.status.counts.url.trimmed, 1);
    assert.equal(redis.streams.get('url')!.group!.pending.size, 0);
  });

  it('時間錯誤的列仍寫入(不過濾,CQ8),計 badTime', async () => {
    const { redis, ch, make } = setup();
    const w = make();
    await w.init();
    redis.add('traffic', { ...TRAFFIC, time: 'garbage' });
    await w.cycle(new AbortController().signal);
    assert.equal(ch.tables.traffic.length, 1);
    assert.equal(w.status.counts.traffic.badTime, 1);
  });

  it('Redis 讀取失敗往上拋(main 退避後重來),已送達未寫的留在待處理清單', async () => {
    const { redis, make } = setup();
    const w = make();
    await w.init();
    redis.failRead = 1;
    await assert.rejects(w.cycle(new AbortController().signal), /ECONNREFUSED/);
  });
});

describe('Writer:熔斷與上限(審查修正)', () => {
  it('結構性錯誤(Unknown field、欄位不存在):不拆批、不 ACK、不丟列,退避重試到修好', async () => {
    const { redis, ch, make, waits } = setup();
    const w = make();
    await w.init();
    for (let i = 0; i < 4; i++) redis.add('traffic', TRAFFIC);
    ch.failWith = new ClickHouseError('ClickHouse HTTP 400:Code: 117. DB::Exception: Unknown field found while parsing JSONEachRow format: session_id', 117, 400);
    let n = 0;
    const orig = ch.insert.bind(ch);
    ch.insert = async (...a) => {
      if (++n === 4) ch.failWith = null; // 第 4 次 migration 補上了
      return orig(...a);
    };
    await w.cycle(new AbortController().signal);
    assert.ok(ch.calls.every((c) => c.rows === 4), '不拆批');
    assert.equal(waits.length, 3);
    assert.equal(ch.tables.traffic.length, 4);
    assert.equal(w.status.counts.traffic.rejected, 0);
    assert.equal(redis.acked.traffic?.length, 4);
  });

  it('資料錯誤拆到單列、前 3 列全被拒且沒有子批成功:熔斷成結構性錯誤,不 ACK', async () => {
    const { redis, ch, make } = setup();
    const w = make();
    await w.init();
    for (let i = 0; i < 8; i++) redis.add('traffic', { ...TRAFFIC, src: `10.0.0.${i}` });
    for (let i = 0; i < 8; i++) ch.badSrc.add(`::ffff:10.0.0.${i}`);
    const stop = new AbortController();
    let failures = 0;
    const orig = ch.insert.bind(ch);
    ch.insert = async (...a) => {
      try {
        return await orig(...a);
      } catch (e) {
        if (++failures > 20) stop.abort();
        throw e;
      }
    };
    await w.cycle(stop.signal);
    assert.equal(redis.acked.traffic, undefined, '沒有 ACK');
    assert.equal(w.status.counts.traffic.rejected, 0);
    assert.equal(w.status.schemaError, true);
    assert.match(w.status.lastError!.message, /視為欄位或表對不上/);
    // 每一輪最多 log2(8)+3 次請求,不會打出上萬次
    assert.ok(ch.calls.length < 30, String(ch.calls.length));
  });

  it('無法分類的 HTTP 400:先整批重試,連續 5 次後才拆批找出壞列(資安審查 M2)', async () => {
    const { redis, ch, make } = setup();
    const w = make();
    await w.init();
    for (const s of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) redis.add('traffic', { ...TRAFFIC, src: s });
    const weird = new ClickHouseError('ClickHouse HTTP 400:Code: 999. something new', 999, 400);
    const orig = ch.insert.bind(ch);
    ch.insert = async (table, rows, token) => {
      if (rows.some((r) => r.src === '::ffff:10.0.0.3')) {
        ch.calls.push({ table, rows: rows.length, token });
        throw weird;
      }
      return orig(table, rows, token);
    };
    await w.cycle(new AbortController().signal);
    assert.equal(w.status.insertFailures, 5);
    assert.equal(w.status.counts.traffic.rejected, 1);
    assert.deepEqual(ch.tables.traffic.map((r) => r.src).sort(), ['::ffff:10.0.0.1', '::ffff:10.0.0.2', '::ffff:10.0.0.4']);
    assert.equal(redis.acked.traffic?.length, 4);
  });

  it('單筆超過 64 KB 計為 malformed(不寫、ACK)', async () => {
    const { redis, ch, make } = setup();
    const w = make();
    await w.init();
    redis.add('url', { src: '1.1.1.1', url: 'x'.repeat(MAX_ENTRY_BYTES) });
    redis.add('url', { src: '1.1.1.1' });
    await w.cycle(new AbortController().signal);
    assert.equal(w.status.counts.url.malformed, 1);
    assert.equal(ch.tables.threat.length, 1);
    assert.equal(redis.acked.url?.length, 2);
  });

  it('一輪讀到的資料超過位元組上限就提早寫入', async () => {
    const { redis, ch, make } = setup();
    const w = make();
    await w.init();
    const big = { src: '1.1.1.1', url: 'y'.repeat(50_000) };
    const n = Math.ceil(MAX_BATCH_BYTES / 100_000) + 1000;
    for (let i = 0; i < n; i++) redis.add('url', big);
    await w.cycle(new AbortController().signal);
    assert.ok(ch.calls[0]!.rows < n, `第一批 ${ch.calls[0]!.rows} 筆`);
  });

  it('錯誤訊息去掉控制字元(含 C1)並截斷', () => {
    assert.equal(sanitizeMessage(new Error('a\u009b31mb\u0000c\nsecond')), 'a 31mb c');
    assert.equal(sanitizeMessage('x'.repeat(300)).length, 200);
  });

  it('錯誤分類:結構性、資料、未知 400', () => {
    const e117field = new ClickHouseError('Code: 117. Unknown field found while parsing JSONEachRow format: x', 117, 400);
    const e117data = new ClickHouseError('Code: 117. Cannot parse input: expected', 117, 400);
    assert.deepEqual([isSchemaError(e117field), isDataError(e117field)], [true, false]);
    assert.deepEqual([isSchemaError(e117data), isDataError(e117data)], [false, true]);
    assert.equal(isSchemaError(new ClickHouseError('Code: 516. Authentication failed', 516, 403)), true);
    assert.equal(isUnknownBadRequest(new ClickHouseError('Code: 999.', 999, 400)), true);
    assert.equal(isUnknownBadRequest(new ClickHouseError('Code: 241. Memory limit', 241, 400)), false);
    assert.equal(isUnknownBadRequest(new ClickHouseError('Code: 999.', 999, 500)), false);
  });
});

describe('缺口偵測', () => {
  it('還沒讀就被修剪 → 記一筆缺口(同一個缺口只記一次)', async () => {
    const { redis, make } = setup();
    const w = make();
    await w.init();
    redis.add('traffic', TRAFFIC, T0);
    await w.cycle(new AbortController().signal);
    // ingest 停止期間:新增 3 筆、修剪掉前 2 筆(還沒讀)
    redis.add('traffic', TRAFFIC, T0 + 1000);
    redis.add('traffic', TRAFFIC, T0 + 2000);
    const keep = redis.add('traffic', TRAFFIC, T0 + 3000);
    redis.trim('traffic', keep);
    const gaps = await w.checkGaps();
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.kind, 'undelivered-trimmed');
    assert.equal(gaps[0]!.missed, 2);
    assert.equal(gaps[0]!.to, keep);
    assert.equal(w.status.gaps.traffic?.from, gaps[0]!.from);
    // 停止期間又遺失 1 筆:同一段缺口(from 相同)只記新增的筆數,缺口清單不重複
    const keep2 = redis.add('traffic', TRAFFIC, T0 + 4000);
    redis.add('traffic', TRAFFIC, T0 + 5000);
    redis.trim('traffic', keep2);
    const again = await w.checkGaps();
    assert.equal(again[0]?.missed, 1);
    assert.equal(redis.gaps.length, 1);
    // 讀過之後缺口不再成立:心跳上的缺口清掉(歷史留在缺口清單)
    await w.cycle(new AbortController().signal);
    assert.equal((await w.checkGaps()).length, 0);
    assert.equal(w.status.gaps.traffic, undefined);
    assert.equal(redis.gaps.length, 1);
  });

  it('發生過缺口之後,類型閒置、已讀的舊條目被修剪:不再誤報(程式碼審查 #2)', async () => {
    const { redis, make } = setup();
    const w = make();
    await w.init();
    redis.add('threat', { src: '1.1.1.1' }, T0);
    await w.cycle(new AbortController().signal);
    const lost = redis.add('threat', { src: '1.1.1.1' }, T0 + 1000);
    const keep = redis.add('threat', { src: '1.1.1.1' }, T0 + 2000);
    redis.trim('threat', keep);
    assert.equal((await w.checkGaps()).length, 1, lost);
    await w.cycle(new AbortController().signal);
    // 之後閒置:已讀的 keep 被修剪,再來一筆新的
    const next = redis.add('threat', { src: '1.1.1.1' }, T0 + 9000);
    redis.trim('threat', next);
    assert.equal((await w.checkGaps()).length, 0);
  });

  it('待處理條目被修剪,但那一批正在寫入(ClickHouse 停太久):不算缺口(程式碼審查 #3)', async () => {
    const { redis, ch, make } = setup();
    const w = make();
    await w.init();
    const id = redis.add('url', { src: '1.1.1.1' }, T0);
    ch.failTransient = 2;
    const origInsert = ch.insert.bind(ch);
    let checked: unknown[] | null = null;
    ch.insert = async (...a) => {
      if (checked === null && ch.failTransient === 1) {
        redis.trim('url', `${T0 + 1}-0`);
        checked = await w.checkGaps();
      }
      return origInsert(...a);
    };
    await w.cycle(new AbortController().signal);
    assert.deepEqual(checked, []);
    assert.equal(ch.tables.threat.length, 1);
    assert.deepEqual(redis.acked.url, [id]);
  });

  it('類型很久沒有新 log、最後一筆(已讀)被修剪後又來新的:不是缺口', () => {
    assert.deepEqual(gapFrom('threat', { firstId: '200-0', length: 1, entriesAdded: 6 }, { lastDelivered: '100-0', entriesRead: 5 }, { count: 0, minId: null }, 0), { gap: null, newBase: null });
  });

  it('待處理條目被修剪 → pending-trimmed;還沒送達就被修剪 → undelivered-trimmed;剛建立的 group 不是缺口', () => {
    const none = { count: 0, minId: null };
    assert.deepEqual(gapFrom('url', { firstId: '200-0', length: 3, entriesAdded: 10 }, { lastDelivered: '150-0', entriesRead: 7 }, { count: 1, minId: '150-0' }, 0).gap, { type: 'url', kind: 'pending-trimmed', from: '150-0', to: '200-0', missed: null });
    assert.deepEqual(gapFrom('url', { firstId: '200-0', length: 3, entriesAdded: 10 }, { lastDelivered: '150-0', entriesRead: 5 }, none, 0), { gap: { type: 'url', kind: 'undelivered-trimmed', from: '150-0', to: '200-0', missed: 2 }, newBase: 2 });
    assert.equal(gapFrom('url', { firstId: '200-0', length: 3, entriesAdded: 10 }, { lastDelivered: '0-0', entriesRead: 0 }, none, 0).gap, null);
    assert.equal(gapFrom('url', { firstId: '200-0', length: 3, entriesAdded: null }, { lastDelivered: '100-0', entriesRead: null }, none, 0).gap?.missed, null);
    assert.equal(gapFrom('url', { firstId: null, length: 0, entriesAdded: 3 }, { lastDelivered: '100-0', entriesRead: 3 }, none, 0).gap, null);
    // Stream 整個被修剪光(空的)、待處理還在
    assert.equal(gapFrom('url', { firstId: null, length: 0, entriesAdded: 5 }, { lastDelivered: '120-0', entriesRead: 5 }, { count: 2, minId: '110-0' }, 0).gap?.kind, 'pending-trimmed');
  });

  it('已回報的基準:發生過缺口後差值一直存在,不再重複回報;Stream 重建(計數變小)時基準重設', () => {
    const none = { count: 0, minId: null };
    // 之前回報過 2 筆,閒置後已讀的最後一筆被修剪(差值仍是 2)
    assert.deepEqual(gapFrom('url', { firstId: '300-0', length: 1, entriesAdded: 8 }, { lastDelivered: '250-0', entriesRead: 5 }, none, 2), { gap: null, newBase: null });
    // 又多漏 1 筆
    assert.equal(gapFrom('url', { firstId: '300-0', length: 1, entriesAdded: 9 }, { lastDelivered: '250-0', entriesRead: 5 }, none, 2).gap?.missed, 1);
    // Stream 過期重建:計數比基準小
    assert.deepEqual(gapFrom('url', { firstId: '300-0', length: 1, entriesAdded: 2 }, { lastDelivered: '250-0', entriesRead: 1 }, none, 7), { gap: null, newBase: 0 });
  });

  it('Stream ID 比較不受 2^53 限制', () => {
    assert.equal(compareId('9007199254740993-0', '9007199254740992-5'), 1);
    assert.equal(compareId('5-10', '5-9'), 1);
    assert.equal(compareId('5-1', '5-1'), 0);
  });
});

describe('心跳欄位', () => {
  it('計數、落後時間、缺口與最後錯誤', async () => {
    const { redis, make } = setup();
    const w = make();
    await w.init();
    const id = redis.add('traffic', TRAFFIC, T0);
    await w.cycle(new AbortController().signal);
    w.status.fail('clickhouse', new Error('Code: 241. Memory limit\nsecond line'));
    w.status.gaps.url = { type: 'url', kind: 'undelivered-trimmed', from: '1-0', to: '2-0', missed: 3 };
    const f = heartbeatFields(w, { gwEnv: 'test', release: 'abc1234' }, '2026-11-10T00:00:00.000Z', T0 + 5000);
    assert.equal(f['inserted:traffic'], '1');
    assert.equal(f['lastAcked:traffic'], id);
    assert.equal(f['lagMs:traffic'], '5000');
    assert.equal(f['gapKind:url'], 'undelivered-trimmed');
    assert.equal(f['gapMissed:url'], '3');
    assert.equal(f.lastError, 'Code: 241. Memory limit');
    assert.equal(f.state, 'ok');
    for (const v of Object.values(f)) assert.equal(typeof v, 'string');
  });
});

describe('設定', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-ingest-'));
  const pw = path.join(tmp, 'ch_writer_password');
  fs.writeFileSync(pw, 's3cret\n');
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const base = { GW_ENV: 'test', REDIS_URL: 'redis://netops-redis:6379/0', CLICKHOUSE_URL: 'http://netops-clickhouse:8123', CLICKHOUSE_USER: 'netops_writer', CLICKHOUSE_PASSWORD_FILE: pw };

  it('讀 *_FILE 機密與預設批次設定', () => {
    const c = loadIngestConfig(base);
    assert.equal(c.clickhouse.password, 's3cret');
    assert.equal(c.batchMs, 5000);
    assert.equal(c.batchMax, 5000);
    assert.equal(c.release, 'dev');
  });

  it('缺少必要設定或值不合法時啟動失敗', () => {
    assert.throws(() => loadIngestConfig({ ...base, GW_ENV: 'staging' }), /GW_ENV/);
    assert.throws(() => loadIngestConfig({ ...base, REDIS_URL: '' }), /REDIS_URL/);
    assert.throws(() => loadIngestConfig({ ...base, CLICKHOUSE_URL: 'netops-clickhouse:8123' }), /CLICKHOUSE_URL/);
    assert.throws(() => loadIngestConfig({ ...base, CLICKHOUSE_USER: 'a b' }), /CLICKHOUSE_USER/);
    assert.throws(() => loadIngestConfig({ ...base, CLICKHOUSE_PASSWORD_FILE: '' }), /CLICKHOUSE_PASSWORD_FILE/);
    assert.throws(() => loadIngestConfig({ ...base, CLICKHOUSE_PASSWORD_FILE: path.join(tmp, 'nope') }), /無法讀取 CLICKHOUSE_PASSWORD_FILE/);
    assert.throws(() => loadIngestConfig({ ...base, INGEST_BATCH_SECONDS: '10' }), /INGEST_BATCH_SECONDS 必須是 3–5/);
  });

  it('正式區只接受 _FILE', () => {
    assert.throws(() => loadIngestConfig({ ...base, GW_ENV: 'prod', CLICKHOUSE_PASSWORD: 'plain' }), /正式區不可用 CLICKHOUSE_PASSWORD 明文/);
  });
});

describe('ClickHouse HTTP 用戶端', () => {
  type Call = { url: URL; init: RequestInit };
  const fake = (status: number, body: string, headers: Record<string, string> = {}) => {
    const calls: Call[] = [];
    const f = (async (url: URL, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status, headers });
    }) as unknown as typeof fetch;
    return { calls, f };
  };

  it('INSERT JSONEachRow:帳密在標頭、不在 URL;帶去重 token', async () => {
    const { calls, f } = fake(200, '');
    const ch = createClickHouseWriter({ url: 'http://netops-clickhouse:8123', user: 'netops_writer', password: 'pw' }, f);
    await ch.insert('traffic', [{ a: 1 }, { a: '7688588907462574142' }], 'traffic:1-0:2-0:2');
    const { url, init } = calls[0]!;
    assert.equal(url.searchParams.get('query'), 'INSERT INTO netops.pa_traffic_logs FORMAT JSONEachRow');
    assert.equal(url.searchParams.get('insert_deduplication_token'), 'traffic:1-0:2-0:2');
    assert.equal(url.searchParams.get('input_format_skip_unknown_fields'), '0');
    assert.doesNotMatch(url.toString(), /pw|netops_writer/);
    assert.equal(init.redirect, 'error');
    assert.deepEqual((init.headers as Record<string, string>)['X-ClickHouse-Key'], 'pw');
    assert.equal(init.body, '{"a":1}\n{"a":"7688588907462574142"}');
  });

  it('空批次不送出', async () => {
    const { calls, f } = fake(200, '');
    await createClickHouseWriter({ url: 'http://ch:8123', user: 'u', password: 'p' }, f).insert('threat', [], 't');
    assert.equal(calls.length, 0);
  });

  it('錯誤:解析出 ClickHouse 代碼,資料錯誤與暫時性錯誤分開;訊息只留第一行', async () => {
    const { f } = fake(400, 'Code: 27. DB::Exception: Cannot parse input: row 1 data\nmore', { 'X-ClickHouse-Exception-Code': '27' });
    const err = await createClickHouseWriter({ url: 'http://ch:8123', user: 'u', password: 'p' }, f).insert('traffic', [{ a: 1 }], 't').catch((e) => e);
    assert.ok(err instanceof ClickHouseError);
    assert.equal(err.code, 27);
    assert.equal(isDataError(err), true);
    assert.doesNotMatch(err.message, /more/);
    const { f: f2 } = fake(500, 'Code: 241. DB::Exception: Memory limit exceeded');
    const err2 = await createClickHouseWriter({ url: 'http://ch:8123', user: 'u', password: 'p' }, f2).insert('traffic', [{ a: 1 }], 't').catch((e) => e);
    assert.equal(err2.code, 241);
    assert.equal(isDataError(err2), false);
  });

  it('連線失敗是暫時性錯誤', async () => {
    const f = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    const err = await createClickHouseWriter({ url: 'http://ch:8123', user: 'u', password: 'p' }, f).ping().catch((e) => e);
    assert.match(err.message, /ECONNREFUSED/);
    assert.equal(isDataError(err), false);
  });

  it('URL 不可帶帳密', () => {
    assert.throws(() => createClickHouseWriter({ url: 'http://a:b@ch:8123', user: 'u', password: 'p' }), /不可帶帳密/);
  });
});
