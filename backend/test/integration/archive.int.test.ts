/**
 * C4 冷歸檔整合測試:真 ClickHouse 26.3 + 真 Redis(CI check:ingest-int 的一次性容器)。
 *   INT_CLICKHOUSE_URL、INT_CLICKHOUSE_PASSWORD_FILE(netops_writer)、INT_CLICKHOUSE_READER_PASSWORD_FILE(netops_reader)、
 *   INT_CLICKHOUSE_COLD_PASSWORD_FILE(netops_cold)、INT_REDIS_URL、
 *   INT_ARCHIVE_DIR(主機目錄;ClickHouse 容器唯讀掛在 user_files/archive,同 Compose)
 * 驗證:匯出 Parquet → 暫存 → 「NAS」→ file() 讀回列數 → manifest;冷明細和熱明細結果相同(IP、時區還原);
 *       netops_reader 不能用 file();排程一輪補完原始表還完整的日子;沒有歸檔的日子回 404。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Redis } from 'ioredis';
import { AppError } from '../../src/errors.js';
import { addDays, createArchiveWriterClient, createColdFileClient, taipeiDay } from '../../src/infra/clickhouse/archive.js';
import { createHeatReader } from '../../src/infra/clickhouse/heat.js';
import { createClickHouseWriter } from '../../src/infra/clickhouse/index.js';
import { createColdLock, type ColdLockClient } from '../../src/infra/redis/cold-lock.js';
import { ARCHIVE_MARKER, Archiver } from '../../src/ingest/archive.js';
import { toThreatRow, toTrafficRow } from '../../src/ingest/rows.js';
import { createColdSlice } from '../../src/modules/pa-heat/cold.js';
import { taipeiText } from '../../src/shared/time.js';

const CH_URL = process.env.INT_CLICKHOUSE_URL ?? '';
const REDIS_URL = process.env.INT_REDIS_URL ?? '';
const ARCHIVE_DIR = process.env.INT_ARCHIVE_DIR ?? '';
const secret = (k: string) => fs.readFileSync(process.env[k] ?? '', 'utf8').trim();
const local = (u: string) => /^(redis|http):\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u);
if (!local(CH_URL) || !local(REDIS_URL) || !ARCHIVE_DIR || !path.isAbsolute(ARCHIVE_DIR))
  throw new Error('整合測試只連本機一次性容器:請設定 INT_CLICKHOUSE_URL、INT_REDIS_URL(127.0.0.1)與 INT_ARCHIVE_DIR(絕對路徑)');

const writerCfg = { url: CH_URL, user: 'netops_writer', password: secret('INT_CLICKHOUSE_PASSWORD_FILE') };
const coldCfg = { url: CH_URL, user: 'netops_cold', password: secret('INT_CLICKHOUSE_COLD_PASSWORD_FILE') };
const readerCfg = { url: CH_URL, user: 'netops_reader', password: secret('INT_CLICKHOUSE_READER_PASSWORD_FILE') };
const ch = createArchiveWriterClient(writerCfg);
const cold = createColdFileClient(coldCfg);
const heat = createHeatReader(readerCfg);
const HOUR = 3600_000;
const TODAY = taipeiDay(Date.now());
/** 測試資料:昨天 10:00–11:00(測試區 TTL 3 天,原始表完整) */
const D = addDays(TODAY, -1);
const H = Date.parse(`${D}T10:00:00+08:00`);
const IP = '10.77.0.9';
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-archive-int-'));
const signal = new AbortController().signal;
let redis: Redis;
const logs: string[] = [];
const log = (_l: string, msg: string) => void logs.push(msg);

before(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  await redis.del('netops:cold:lock');
  fs.writeFileSync(path.join(ARCHIVE_DIR, ARCHIVE_MARKER), '');
  const writer = createClickHouseWriter(writerCfg);
  const issues = { badTime: false };
  const tag = `c4-int-${randomUUID()}`;
  const traffic = Array.from({ length: 12 }, (_, i) =>
    toTrafficRow(
      { time: taipeiText(H + i * 120_000), src: i % 2 ? IP : '10.77.0.1', dst: '2001:db8::7', natDst: '8.8.4.4', app: 'c4-int-app', action: i % 3 ? 'allow' : 'deny', proto: 'tcp', dport: 443, bytes: 100 + i, sent: 40, recv: 60 + i, start: taipeiText(H + i * 120_000 - 5000), srcHost: tag, seqno: String(9_000_000 + i) },
      H + i * 120_000,
      issues,
    ),
  );
  await writer.insert('traffic', traffic, tag);
  const threats = Array.from({ length: 4 }, (_, i) =>
    toThreatRow('threat', { time: taipeiText(H + i * 60_000), src: IP, dst: '10.77.0.1', name: 'C4 Test(1)', severity: i ? 'high' : 'critical', action: 'alert', dport: 22, proto: 'tcp' }, H + i * 60_000, issues),
  );
  await writer.insert('threat', threats, `${tag}-t`);
});

after(async () => {
  await redis?.quit();
  fs.rmSync(staging, { recursive: true, force: true });
});

const lockClient = () => redis as unknown as ColdLockClient;
const archiver = (now = Date.now()) =>
  new Archiver({ ch, cold, lock: createColdLock(lockClient()), log, now: () => now, lockWaitMs: 2000 }, { dir: ARCHIVE_DIR, staging, keepDays: 14, alertDays: 2, ttlDays: { traffic: 3, threat: 3 } });

describe('C4 歸檔(真 ClickHouse)', () => {
  it('匯出一天:Parquet 列數 = 來源列數、雜湊和 .sha256 一致、manifest ok', async () => {
    for (const kind of ['traffic', 'threat'] as const) {
      const e = await archiver().archiveOne(kind, D, signal);
      const file = path.join(ARCHIVE_DIR, D.slice(0, 4), `pa_${kind}_${D}.parquet`);
      const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      assert.equal(e.sha256, sha);
      assert.equal(fs.readFileSync(`${file}.sha256`, 'utf8').split(' ')[0], sha);
      assert.equal(e.rows, await ch.countDay(kind, D));
      assert.equal(await cold.parquetCount(kind, D), e.rows);
      assert.ok(e.rows >= (kind === 'traffic' ? 12 : 4));
      const m = (await cold.manifest([D])).find((x) => x.kind === kind);
      assert.deepEqual([m?.status, m?.rows, m?.sha256, m?.path], ['ok', e.rows, sha, `${D.slice(0, 4)}/pa_${kind}_${D}.parquet`]);
    }
    assert.deepEqual(fs.readdirSync(staging), []);
  });

  it('冷明細和熱明細結果相同(IP 文字還原、時間是台灣時間)', async () => {
    const f = { fromMs: H, toMs: H + HOUR, ip: IP };
    const hot = await heat.slice('traffic', f, 50, 'time', 30);
    const coldR = await createColdSlice(cold, { warn: () => undefined }).query('traffic', f, 50, 'time', signal);
    assert.equal(hot.summary.sessions, 6);
    assert.deepEqual(coldR.summary, hot.summary);
    assert.deepEqual(coldR.top, hot.top);
    assert.deepEqual(coldR.rows, hot.rows);
    assert.equal(coldR.rows[0]!.src, IP);
    assert.equal(coldR.rows[0]!.dst, '2001:db8::7');
    assert.equal(coldR.rows[0]!.natDst, '8.8.4.4');
    assert.equal(String(coldR.rows.at(-1)!.time), taipeiText(H + 120_000));
    const thrHot = await heat.slice('threat', { fromMs: H, toMs: H + HOUR, ip: IP, severity: 'high' }, 10, 'time', 30);
    const thrCold = await createColdSlice(cold, { warn: () => undefined }).query('threat', { fromMs: H, toMs: H + HOUR, ip: IP, severity: 'high' }, 10, 'time', signal);
    assert.equal(thrHot.rows.length, 3);
    assert.deepEqual(thrCold, thrHot);
  });

  it('netops_reader 不能用 file() 讀歸檔', async () => {
    const reader = createColdFileClient(readerCfg);
    await assert.rejects(reader.parquetCount('traffic', D));
  });

  it('沒有歸檔的日子:404 NETOPS_COLD_ARCHIVE_NOT_FOUND', async () => {
    const old = Date.parse(`${addDays(TODAY, -40)}T10:00:00+08:00`);
    const err = await createColdSlice(cold, { warn: () => undefined })
      .query('traffic', { fromMs: old, toMs: old + HOUR }, 10, 'time', signal)
      .catch((e: unknown) => e);
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'NETOPS_COLD_ARCHIVE_NOT_FOUND');
  });

  it('排程一輪(今天 03:00):補完原始表還完整的日子,狀態 ok;鎖已釋放', async () => {
    const a = archiver(Date.parse(`${TODAY}T03:00:00+08:00`));
    await a.tick(signal);
    assert.equal(a.status.state, 'ok', JSON.stringify(a.status));
    const m = await cold.manifest([addDays(TODAY, -2), D]);
    assert.equal(m.filter((x) => x.status === 'ok').length, 4);
    assert.equal(await redis.get('netops:cold:lock'), null);
  });

  it('歸檔後來源列數變了:重新歸檔', async () => {
    const before = (await cold.manifest([D])).find((x) => x.kind === 'threat')!.rows;
    const issues = { badTime: false };
    await createClickHouseWriter(writerCfg).insert('threat', [toThreatRow('threat', { time: taipeiText(H + 30 * 60_000), src: '10.77.0.2', dst: '10.77.0.1', severity: 'low', action: 'alert' }, H, issues)], `c4-int-${randomUUID()}`);
    const a = archiver(Date.parse(`${TODAY}T03:00:00+08:00`));
    await a.tick(signal);
    const m = (await cold.manifest([D])).find((x) => x.kind === 'threat')!;
    assert.equal(m.status, 'ok');
    assert.equal(m.rows, before + 1);
    assert.equal(await cold.parquetCount('threat', D), before + 1);
  });
});
