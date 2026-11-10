/**
 * netops-ingest 整合測試(IMPL-PLAN C2):真 Redis 7.4 + 真 ClickHouse 26.3(deploy/clickhouse 的設定、schema、migrations、netops_writer 帳號)。
 * CI check:ingest-int 用一次性容器執行(.gitlab-ci.yml);本機要自己起容器時見該 job 的指令。
 *   INT_REDIS_URL                 redis://127.0.0.1:<port>/0(只接受本機,測試會 FLUSHDB)
 *   INT_CLICKHOUSE_URL            http://127.0.0.1:<port>
 *   INT_CLICKHOUSE_PASSWORD_FILE  netops_writer 的一次性密碼檔
 * 驗證:JSONEachRow 欄位與型別(seqno 64 位元、IPv4→IPv6、時區)、去重 token 與物化檢視、重啟不重複、缺口偵測、資料錯誤代碼分類。
 * 每個測試用唯一標記(src_host / url)區分自己的列,不需要清表。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { Redis } from 'ioredis';
import { ClickHouseError, createClickHouseWriter, isDataError } from '../../src/infra/clickhouse/index.js';
import { createIngestRedis, type IngestRedis } from '../../src/infra/redis/ingest.js';
import { Writer } from '../../src/ingest/writer.js';

const REDIS_URL = process.env.INT_REDIS_URL ?? '';
const CH_URL = process.env.INT_CLICKHOUSE_URL ?? '';
const PW_FILE = process.env.INT_CLICKHOUSE_PASSWORD_FILE ?? '';
const local = (u: string) => /^(redis|http):\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u);
if (!local(REDIS_URL) || !local(CH_URL) || !PW_FILE) throw new Error('整合測試只連本機一次性容器:請設定 INT_REDIS_URL、INT_CLICKHOUSE_URL(127.0.0.1)與 INT_CLICKHOUSE_PASSWORD_FILE');

const password = readFileSync(PW_FILE, 'utf8').trim();
const ch = createClickHouseWriter({ url: CH_URL, user: 'netops_writer', password });
let r1: Redis;
let r2: Redis;
let ingest: IngestRedis;

/** netops_writer 有 SELECT 權限:查詢結果 JSON 列 */
async function query<T = Record<string, unknown>>(sql: string, params: Record<string, string> = {}): Promise<T[]> {
  const u = new URL(CH_URL);
  u.searchParams.set('query', `${sql} FORMAT JSONEachRow`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, v);
  const res = await fetch(u, { method: 'POST', headers: { 'X-ClickHouse-User': 'netops_writer', 'X-ClickHouse-Key': password } });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text.trim() ? text.trim().split('\n').map((l) => JSON.parse(l) as T) : [];
}
const countBy = async (table: string, col: string, mark: string) =>
  Number((await query<{ c: string }>(`SELECT count() AS c FROM ${table} WHERE ${col} = {m:String}`, { m: mark }))[0]!.c);

const traffic = (mark: string, i: number) => ({
  type: 'TRAFFIC', time: '2026/11/10 13:45:16', src: '10.10.112.13', dst: '8.8.8.8', natDst: '2001:db8::1', app: 'dns', action: 'allow',
  proto: 'udp', dport: 53, sport: 40000 + i, bytes: 100, packets: 1, start: '2026/11/10 13:45:00', seqno: '7688588907462574142', sessionId: 288580 + i, srcHost: mark,
});
const xadd = (t: string, d: object) => r1.xadd(`netops:pa:log:${t}`, '*', 'd', JSON.stringify(d));

/** 只跑到讀不到新資料為止(真 Redis 的 BLOCK 有 I/O,計時器可正常觸發) */
async function runUntilIdle(w: Writer) {
  const stop = new AbortController();
  await w.drainPending(stop.signal);
  for (let i = 0; i < 20; i++) if ((await w.cycle(stop.signal)) === 0) break;
}
const newWriter = (redis: IngestRedis = ingest) => new Writer(redis, ch, { batchMs: 300, batchMax: 5000 });

before(async () => {
  r1 = new Redis(REDIS_URL);
  r2 = new Redis(REDIS_URL);
  await r1.flushdb();
  ingest = createIngestRedis(r1, r2);
  await ch.ping();
});
after(async () => {
  await ingest.quit();
});

describe('寫入 ClickHouse', () => {
  it('TRAFFIC:欄位型別、seqno 64 位元、IPv4→IPv6、台灣時間;寫入後 ACK', async () => {
    const mark = `it-${randomUUID()}`;
    for (let i = 0; i < 3; i++) await xadd('traffic', traffic(mark, i));
    const w = newWriter();
    await w.init();
    await runUntilIdle(w);
    const rows = await query<Record<string, string | number>>(
      `SELECT toString(seqno) AS seqno, session_id, toString(src) AS src, toString(dst) AS dst, toString(nat_dst) AS nat_dst, toString(nat_src) AS nat_src,
              toString(event_time) AS et, toUnixTimestamp(event_time) AS ets, toString(session_start) AS ss, source, dport
         FROM netops.pa_traffic_logs WHERE src_host = {m:String} ORDER BY session_id`,
      { m: mark },
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.seqno, '7688588907462574142');
    assert.equal(Number(rows[0]!.session_id), 288580);
    assert.equal(rows[0]!.src, '::ffff:10.10.112.13');
    assert.equal(rows[0]!.dst, '::ffff:8.8.8.8');
    assert.equal(rows[0]!.nat_dst, '2001:db8::1');
    assert.equal(rows[0]!.nat_src, '::');
    assert.equal(rows[0]!.et, '2026-11-10 13:45:16');
    assert.equal(Number(rows[0]!.ets), Date.UTC(2026, 10, 10, 5, 45, 16) / 1000, '台灣時間 13:45:16 = UTC 05:45:16');
    assert.equal(rows[0]!.ss, '2026-11-10 13:45:00');
    assert.equal(rows[0]!.source, 'syslog');
    const pending = (await r1.xpending('netops:pa:log:traffic', 'ch-writer')) as [number];
    assert.equal(pending[0], 0);
    // 每小時彙總(物化檢視)
    const hourly = await query<{ s: string }>(`SELECT sum(sessions) AS s FROM netops.pa_traffic_hourly_src WHERE hour = toDateTime('2026-11-10 13:00:00', 'Asia/Taipei') AND src = toIPv6('10.10.112.13')`);
    assert.ok(Number(hourly[0]!.s) >= 3);
  });

  it('威脅類:migration 001 的 session_id、sport、nat_dport 存在,log_type 依 Stream', async () => {
    const mark = `it-${randomUUID()}`;
    await xadd('url', { time: '2026/11/10 13:45:16', src: '10.0.0.1', url: mark, sport: 1234, natDport: 4321, sessionId: 77, seqno: '18446744073709551615', repeat: 2 });
    await xadd('wildfire', { time: '2026/11/10 13:45:16', src: '10.0.0.2', url: mark, category: 'benign' });
    const w = newWriter();
    await w.init();
    await runUntilIdle(w);
    const rows = await query<Record<string, string | number>>(
      `SELECT log_type, session_id, sport, nat_dport, toString(seqno) AS seqno, repeat_count, source FROM netops.pa_threat_logs WHERE url = {m:String} ORDER BY log_type`,
      { m: mark },
    );
    assert.deepEqual(rows.map((r) => r.log_type), ['url', 'wildfire']);
    assert.deepEqual([Number(rows[0]!.session_id), Number(rows[0]!.sport), Number(rows[0]!.nat_dport), rows[0]!.seqno, Number(rows[0]!.repeat_count), rows[0]!.source], [77, 1234, 4321, '18446744073709551615', 2, 'http']);
  });
});

describe('去重與重啟', () => {
  it('同一個 token 重送:原始表與每小時彙總都不重複', async () => {
    const mark = `it-${randomUUID()}`;
    const row = { event_time: '2026-11-09 08:00:00', received_at: '2026-11-09T00:00:00.000Z', src: '::ffff:10.99.0.1', action: 'allow', app: mark, src_host: mark, source: 'syslog' };
    const token = `traffic:${mark}`;
    await ch.insert('traffic', [row, { ...row, src: '::ffff:10.99.0.2' }], token);
    await ch.insert('traffic', [row, { ...row, src: '::ffff:10.99.0.2' }], token);
    assert.equal(await countBy('netops.pa_traffic_logs', 'src_host', mark), 2);
    const h = await query<{ s: string }>(`SELECT sum(sessions) AS s FROM netops.pa_traffic_hourly_app WHERE app = {m:String}`, { m: mark });
    assert.equal(Number(h[0]!.s), 2, '被略過的批次不進物化檢視');
  });

  it('寫入成功、ACK 前停止 → 重啟補待處理清單,ClickHouse 不重複;之後的新資料照常寫入', async () => {
    const mark = `it-${randomUUID()}`;
    for (let i = 0; i < 5; i++) await xadd('traffic', traffic(mark, i));
    const w = newWriter();
    await w.init();
    await runUntilIdle(w); // 先清掉前面測試留下的
    for (let i = 0; i < 4; i++) await xadd('traffic', traffic(`${mark}-b`, i));
    // 第一個 writer:ACK 時「當機」
    const stop = new AbortController();
    const crashing: IngestRedis = { ...ingest, ack: async () => { stop.abort(); throw new Error('crash'); } };
    const w1 = newWriter(crashing);
    await w1.cycle(stop.signal);
    assert.equal(await countBy('netops.pa_traffic_logs', 'src_host', `${mark}-b`), 4);
    assert.equal(((await r1.xpending('netops:pa:log:traffic', 'ch-writer')) as [number])[0], 4);
    // 重啟前又來一筆新的
    await xadd('traffic', traffic(`${mark}-b`, 9));
    const w2 = newWriter();
    await w2.init();
    await runUntilIdle(w2);
    assert.equal(await countBy('netops.pa_traffic_logs', 'src_host', `${mark}-b`), 5, '4 筆不重複 + 新的 1 筆');
    assert.equal(((await r1.xpending('netops:pa:log:traffic', 'ch-writer')) as [number])[0], 0);
  });
});

describe('缺口偵測(真 Redis XINFO)', () => {
  it('還沒讀就被 XTRIM 修剪 → 缺口與遺失筆數;剛建立的 group 不是缺口', async () => {
    const key = 'netops:pa:log:data';
    await r1.del(key);
    const w = newWriter();
    await w.init(); // MKSTREAM 建立空 Stream 與 group
    assert.equal(await ingest.detectGap('data'), null);
    await r1.xadd(key, '1000-0', 'd', '{}');
    await runUntilIdle(w);
    await r1.xadd(key, '2000-0', 'd', '{}');
    await r1.xadd(key, '3000-0', 'd', '{}');
    await r1.xadd(key, '4000-0', 'd', '{}');
    await r1.xtrim(key, 'MINID', '4000-0');
    const g = await ingest.detectGap('data');
    assert.deepEqual(g, { type: 'data', from: '1000-0', to: '4000-0', missed: 2 });
    await w.checkGaps();
    const list = await r1.lrange('netops:ingest:gaps', 0, -1);
    assert.equal(JSON.parse(list[0]!).missed, 2);
  });

  it('類型閒置後最後一筆被修剪、再來新的:不是缺口', async () => {
    const key = 'netops:pa:log:threat';
    await r1.del(key);
    const w = newWriter();
    await w.init();
    await r1.xadd(key, '1000-0', 'd', '{}');
    await runUntilIdle(w);
    await r1.xadd(key, '5000-0', 'd', '{}');
    await r1.xtrim(key, 'MINID', '5000-0');
    assert.equal(await ingest.detectGap('threat'), null);
  });

  it('Stream 過期消失後重建:自動重建 group 繼續讀', async () => {
    const key = 'netops:pa:log:wildfire';
    const w = newWriter();
    await w.init();
    await r1.del(key);
    const mark = `it-${randomUUID()}`;
    await xadd('wildfire', { time: '2026/11/10 13:45:16', url: mark });
    await runUntilIdle(w);
    assert.equal(await countBy('netops.pa_threat_logs', 'url', mark), 1);
  });
});

describe('ClickHouse 錯誤分類', () => {
  it('型別錯誤是資料錯誤(拆批丟列);欄位名稱錯誤也直接失敗', async () => {
    const e1 = await ch.insert('traffic', [{ event_time: 'x', src: 'not-ip' }], `bad-${randomUUID()}`).catch((e) => e);
    assert.ok(e1 instanceof ClickHouseError, String(e1));
    assert.equal(isDataError(e1), true, `code ${e1.code}`);
    const e2 = await ch.insert('traffic', [{ no_such_column: 1 }], `bad-${randomUUID()}`).catch((e) => e);
    assert.ok(e2 instanceof ClickHouseError);
  });

  it('帳密錯誤是暫時性錯誤(重試,不丟資料)', async () => {
    const bad = createClickHouseWriter({ url: CH_URL, user: 'netops_writer', password: 'wrong' });
    const e = await bad.ping().catch((x) => x);
    assert.ok(e instanceof ClickHouseError);
    assert.equal(isDataError(e), false);
  });
});
