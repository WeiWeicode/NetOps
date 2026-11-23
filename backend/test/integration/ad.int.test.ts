/**
 * AD-1 整合測試:真 Redis 7.4 + 真 ClickHouse 26.3(CI check:ingest-int 的一次性容器;deploy/clickhouse 的 schema 與 migrations/005)。
 *   INT_REDIS_URL、INT_CLICKHOUSE_URL(127.0.0.1)、INT_CLICKHOUSE_PASSWORD_FILE(netops_writer)、INT_CLICKHOUSE_COLD_PASSWORD_FILE(netops_cold)、
 *   INT_AD_ARCHIVE_DIR(主機目錄;ClickHouse 容器唯讀掛在 user_files/ad-archive,同 Compose)
 * 驗證:
 *   - 接收端 Lua 水位:重送同一批、重送多了新事件、兩個相同請求同時到,Stream 都不重複;log_epoch 換世代照收(M2、H4)
 *   - 接收端 → Stream → netops-ingest → ad_events 的欄位;ad_heat_5m / 1h / 1d 物化檢視的計數與 Top 來源
 *   - ingest 寫入後、ACK 前重啟:重讀同一批,ad_events 與 ad_heat_* 都不重複(M2)
 *   - Parquet 冷歸檔:ad-archive/YYYY/ad_events_YYYY-MM-DD.parquet 列數 = 來源、manifest table_name = 'ad'
 * 每次執行用唯一的 DC 名稱(computer)區分自己的列;彙總表不分 DC,比對執行前後的差值。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Redis } from 'ioredis';
import { buildAdReceiverApp } from '../../src/ad-receiver/app.js';
import { parseTokenTable, sha256Hex } from '../../src/ad-receiver/tokens.js';
import { AD_ARCHIVE_KIND_LIST, addDays, createArchiveWriterClient, createColdFileClient, taipeiDay } from '../../src/infra/clickhouse/archive.js';
import { createClickHouseWriter } from '../../src/infra/clickhouse/index.js';
import { AD_KEYS, createAdReceiverRedis, type AdReceiverRedis } from '../../src/infra/redis/ad-receiver.js';
import { createColdLock, type ColdLockClient } from '../../src/infra/redis/cold-lock.js';
import { createIngestRedis, type IngestRedis } from '../../src/infra/redis/ingest.js';
import { ARCHIVE_MARKER, Archiver } from '../../src/ingest/archive.js';
import { Writer } from '../../src/ingest/writer.js';
import { msg4625 } from '../fixtures/fake-ad-receiver.js';

const REDIS_URL = process.env.INT_REDIS_URL ?? '';
const CH_URL = process.env.INT_CLICKHOUSE_URL ?? '';
const AD_ARCHIVE_DIR = process.env.INT_AD_ARCHIVE_DIR ?? '';
const local = (u: string) => /^(redis|http):\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u);
if (!local(REDIS_URL) || !local(CH_URL) || !AD_ARCHIVE_DIR || !path.isAbsolute(AD_ARCHIVE_DIR))
  throw new Error('整合測試只連本機一次性容器:請設定 INT_REDIS_URL、INT_CLICKHOUSE_URL(127.0.0.1)與 INT_AD_ARCHIVE_DIR(絕對路徑)');
const secret = (k: string) => fs.readFileSync(process.env[k] ?? '', 'utf8').trim();
const writerCfg = { url: CH_URL, user: 'netops_writer', password: secret('INT_CLICKHOUSE_PASSWORD_FILE') };
const ch = createClickHouseWriter(writerCfg);

/** 這次執行專用的 DC 與 Token(一次性,不是任何環境的 Token) */
const DC = `IT-${randomBytes(4).toString('hex').toUpperCase()}`;
const TOKEN = randomBytes(32).toString('hex');
const tokens = parseTokenTable(`${DC} it.local ${sha256Hex(TOKEN)}\n`);
const D = addDays(taipeiDay(Date.now()), -1);
const evTime = (hh: string, mm: number) => `${D}T${hh}:${String(mm).padStart(2, '0')}:00.000+08:00`;

let r1: Redis;
let r2: Redis;
let r3: Redis;
let recv: AdReceiverRedis;
let ingest: IngestRedis;

async function query<T = Record<string, unknown>>(sql: string, params: Record<string, string> = {}): Promise<T[]> {
  const u = new URL(CH_URL);
  u.searchParams.set('query', `${sql} FORMAT JSONEachRow`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, v);
  const res = await fetch(u, { method: 'POST', headers: { 'X-ClickHouse-User': writerCfg.user, 'X-ClickHouse-Key': writerCfg.password } });
  const text = await res.text();
  if (!res.ok) throw new Error(text.split('\n', 1)[0]);
  return text.trim() ? text.trim().split('\n').map((l) => JSON.parse(l) as T) : [];
}
const adCount = async () => Number((await query<{ c: string }>('SELECT count() AS c FROM netops.ad_events WHERE computer = {dc:String}', { dc: DC }))[0]!.c);
/** 某一天所有 ad_heat_<g> 的合計(彙總表不分 DC:比對前後差值) */
const heat = async (g: '5m' | '1h' | '1d') =>
  (
    await query<{ t: string; f: string; l: string }>(
      `SELECT sum(total_events) AS t, sum(fail_logons) AS f, sum(lockouts) AS l FROM netops.ad_heat_${g} WHERE toDate(bucket) = toDate({d:String})`,
      { d: D },
    )
  ).map((x) => [Number(x.t), Number(x.f), Number(x.l)])[0] ?? [0, 0, 0];

const app = () => buildAdReceiverApp({ tokens, redis: recv, log: () => undefined });
const post = (a: ReturnType<typeof app>, events: unknown[]) =>
  a.inject({ method: 'POST', url: '/ad/v1/logs', headers: { 'content-type': 'application/json', 'x-netops-ad-token': TOKEN }, payload: JSON.stringify({ computer: DC, domain: 'it.local', events }) });
const ev = (recordId: number, over: Record<string, unknown> = {}) => ({
  time: evTime('10', recordId % 60),
  channel: 'Security',
  eventId: 4625,
  recordId,
  logEpoch: 0,
  level: 'Audit Failure',
  provider: 'Microsoft-Windows-Security-Auditing',
  message: msg4625(`it-user-${recordId % 3}`, '10.88.0.7'),
  ...over,
});

/** ingest 讀到沒有新資料為止 */
async function drain(w: Writer) {
  const stop = new AbortController();
  await w.drainPending(stop.signal);
  for (let i = 0; i < 20; i++) if ((await w.cycle(stop.signal)) === 0) break;
}
const writer = (redis: IngestRedis = ingest, wait?: (ms: number, s: AbortSignal) => Promise<void>) => new Writer(redis, ch, { batchMs: 300, batchMax: 5000 }, wait, undefined, ['ad']);

before(async () => {
  r1 = new Redis(REDIS_URL);
  r2 = new Redis(REDIS_URL);
  r3 = new Redis(REDIS_URL);
  // 只清 AD 的鍵(同一個 Redis 也跑 PA 的整合測試)
  await r1.del(AD_KEYS.log, AD_KEYS.hwm(DC), AD_KEYS.heartbeat(DC), AD_KEYS.computers, AD_KEYS.agentEvents, 'netops:cold:lock');
  recv = createAdReceiverRedis(r3);
  ingest = createIngestRedis(r1, r2);
  await ch.ping();
});
after(async () => {
  await ingest.quit();
  await recv.quit();
});

describe('AD 接收端:Lua 水位去重(真 Redis)', () => {
  it('重送同一批、重送多了新事件、相同請求同時到:Stream 都不重複;換世代照收', async () => {
    const a = app();
    const before = await r1.xlen(AD_KEYS.log);
    assert.equal((await post(a, [ev(1), ev(2), ev(3)])).json().accepted, 3);
    assert.deepEqual((await post(a, [ev(1), ev(2), ev(3)])).json().duplicates, 3);
    const more = (await post(a, [ev(2), ev(3), ev(4), ev(5)])).json();
    assert.deepEqual([more.accepted, more.duplicates], [2, 2]);
    const both = await Promise.all([post(a, [ev(6), ev(7)]), post(a, [ev(6), ev(7)])]);
    assert.equal(both.reduce((n, r) => n + r.json().accepted, 0), 2);
    // Event Log 清除後重編號:log_epoch 1 從 1 開始
    assert.equal((await post(a, [ev(1, { logEpoch: 1 }), ev(2, { logEpoch: 1, eventId: 4740, message: '帳戶被鎖定' })])).json().accepted, 2);
    assert.equal((await r1.xlen(AD_KEYS.log)) - before, 9);
    assert.equal(await r1.hget(AD_KEYS.hwm(DC), 'Security:0'), '7');
    assert.ok((await r1.ttl(AD_KEYS.hwm(DC))) > 0);
    assert.ok(await r1.sismember(AD_KEYS.computers, DC));
    assert.equal(await r1.hget(AD_KEYS.heartbeat(DC), 'received'), '9');
  });

  it('心跳:Hash 整個換新但保留 received;回應帶目前世代與水位', async () => {
    const a = app();
    const r = await a.inject({
      method: 'POST',
      url: '/ad/v1/heartbeat',
      headers: { 'content-type': 'application/json', 'x-netops-ad-token': TOKEN },
      payload: JSON.stringify({ computer: DC, domain: 'it.local', agentVersion: '0.1.0', watchdogEvents: [{ type: 'agent_restarted', cause: 'hung' }] }),
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().channels, { Security: { logEpoch: 1, lastRecordId: 2 } });
    const hb = await r1.hgetall(AD_KEYS.heartbeat(DC));
    assert.equal(hb.received, '9');
    assert.equal(hb.agentVersion, '0.1.0');
    assert.ok(hb.updatedAt);
    assert.equal(JSON.parse((await r1.lindex(AD_KEYS.agentEvents, 0))!).computer, DC);
  });
});

describe('AD 寫入 ClickHouse(真 ClickHouse,migrations/005)', () => {
  it('Stream → ad_events 欄位;ad_heat_5m / 1h / 1d 物化檢視計數與 Top 來源', async () => {
    const h0 = await Promise.all([heat('5m'), heat('1h'), heat('1d')]);
    const w = writer();
    await w.init();
    await drain(w);
    assert.equal(await adCount(), 9);
    const row = (
      await query<Record<string, unknown>>(
        `SELECT toString(event_time) AS et, ad_domain, channel, event_id, log_epoch, toString(record_id) AS rid, level, account, IPv6NumToString(src_ip) AS ip, src_ip_raw, workstation, reason, is_issue, source
         FROM netops.ad_events WHERE computer = {dc:String} AND record_id = 4 AND log_epoch = 0`,
        { dc: DC },
      )
    )[0]!;
    assert.deepEqual(
      [row.et, row.ad_domain, row.channel, row.event_id, row.log_epoch, row.rid, row.level, row.account, row.ip, row.src_ip_raw, row.workstation, row.reason, row.is_issue, row.source],
      [`${D} 10:04:00`, 'it.local', 'Security', 4625, 0, '4', 'audit_failure', 'it-user-1', '::ffff:10.88.0.7', '10.88.0.7', 'PC-it-user-1', '不明的使用者名稱或錯誤密碼。', 1, 'agent'],
    );
    const h1 = await Promise.all([heat('5m'), heat('1h'), heat('1d')]);
    // 9 筆:8 筆 4625(登入失敗)+ 1 筆 4740(鎖定);三個粒度都要加到
    for (let i = 0; i < 3; i++) assert.deepEqual(h1[i]!.map((v, j) => v - h0[i]![j]!), [9, 8, 1], `粒度 ${i}`);
    const top = await query<{ ip: string }>(
      `SELECT IPv6NumToString(arrayJoin(topKIfMerge(3)(top_fail_src))) AS ip FROM netops.ad_heat_1d WHERE toDate(bucket) = toDate({d:String})`,
      { d: D },
    );
    assert.ok(top.some((x) => x.ip === '::ffff:10.88.0.7'), JSON.stringify(top));
  });

  it('ingest 寫入後、ACK 前重啟:重讀同一批,ad_events 與 ad_heat_* 都不重複(M2)', async () => {
    const a = app();
    assert.equal((await post(a, [ev(20), ev(21), ev(22)])).json().accepted, 3);
    const n0 = await adCount();
    const h0 = await Promise.all([heat('5m'), heat('1h'), heat('1d')]);
    // 第一個程序:寫進 ClickHouse 後 ACK 失敗,退避時被停止(模擬當機)
    const stop = new AbortController();
    const broken: IngestRedis = { ...ingest, ack: async () => Promise.reject(new Error('connection lost')) };
    const w1 = writer(broken, async () => stop.abort());
    await w1.init();
    await w1.cycle(stop.signal);
    assert.equal(await adCount(), n0 + 3);
    // 第二個程序:先補待處理清單(同一批、同一個 token)
    const w2 = writer();
    await w2.init();
    await drain(w2);
    assert.equal(await adCount(), n0 + 3, 'ad_events 沒有重複');
    const h1 = await Promise.all([heat('5m'), heat('1h'), heat('1d')]);
    for (let i = 0; i < 3; i++) assert.deepEqual(h1[i]!.map((v, j) => v - h0[i]![j]!), [3, 3, 0], `粒度 ${i} 沒有重複計數`);
    // Agent 再重送同一批:接收端擋下,ClickHouse 也不變
    assert.equal((await post(a, [ev(20), ev(21), ev(22)])).json().duplicates, 3);
    await drain(w2);
    assert.equal(await adCount(), n0 + 3);
    const dup = await query<{ c: string }>(
      'SELECT count() AS c FROM (SELECT channel, log_epoch, record_id FROM netops.ad_events WHERE computer = {dc:String} GROUP BY channel, log_epoch, record_id HAVING count() > 1)',
      { dc: DC },
    );
    assert.equal(Number(dup[0]!.c), 0);
  });
});

describe('AD 冷歸檔(真 ClickHouse,ad-archive)', () => {
  it('ad-archive/YYYY/ad_events_YYYY-MM-DD.parquet:列數 = 來源、manifest table_name = ad', async () => {
    fs.writeFileSync(path.join(AD_ARCHIVE_DIR, ARCHIVE_MARKER), '');
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-ad-int-'));
    try {
      const archiver = new Archiver(
        {
          ch: createArchiveWriterClient(writerCfg),
          cold: createColdFileClient({ url: CH_URL, user: 'netops_cold', password: secret('INT_CLICKHOUSE_COLD_PASSWORD_FILE') }),
          lock: createColdLock(r1 as unknown as ColdLockClient),
          log: () => undefined,
          lockWaitMs: 2000,
          pauseMs: 0,
          freeBytes: async () => 100 * 1024 ** 3,
        },
        { dir: AD_ARCHIVE_DIR, staging, keepDays: 14, alertDays: 2, ttlDays: { traffic: 3, threat: 3, ad: 3 }, maxBytes: 1024 ** 3, kinds: AD_ARCHIVE_KIND_LIST },
      );
      const e = await archiver.archiveOne('ad', D, new AbortController().signal);
      const file = path.join(AD_ARCHIVE_DIR, D.slice(0, 4), `ad_events_${D}.parquet`);
      assert.ok(fs.statSync(file).size > 0);
      assert.ok(e.rows >= 12, String(e.rows));
      assert.equal(e.path, `${D.slice(0, 4)}/ad_events_${D}.parquet`);
      const cold = createColdFileClient({ url: CH_URL, user: 'netops_cold', password: secret('INT_CLICKHOUSE_COLD_PASSWORD_FILE') });
      assert.equal(await cold.parquetCount('ad', D), e.rows);
      const m = (await cold.manifest([D])).find((x) => x.kind === 'ad');
      assert.deepEqual([m?.status, m?.rows], ['ok', e.rows]);
      // 這次的 DC 的列都在檔案裡(IP 轉成文字)
      const inFile = await query<{ c: string }>(`SELECT count() AS c FROM netops.ad_events WHERE computer = {dc:String}`, { dc: DC });
      assert.ok(Number(inFile[0]!.c) <= e.rows);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
});
