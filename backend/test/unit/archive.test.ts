/**
 * C4 冷歸檔單元測試:歸檔排程(Archiver,真暫存目錄 + 假 ClickHouse)、檔名與路徑、設定、冷明細的歸檔檢查與錯誤對應。
 * 真 ClickHouse 的匯出 / file() 讀回在 test/integration/archive.int.test.ts。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { AppError } from '../../src/errors.js';
import {
  addDays,
  archiveRelPath,
  coldSource,
  daysCovering,
  isDay,
  parseArchiveName,
  taipeiDay,
  type ArchiveKind,
  type ArchiveWriterClient,
  type ColdFileClient,
  type ManifestEntry,
} from '../../src/infra/clickhouse/archive.js';
import { ClickHouseError } from '../../src/infra/clickhouse/index.js';
import { createColdLock, type ColdLock } from '../../src/infra/redis/cold-lock.js';
import { ARCHIVE_MARKER, archiveHeartbeatFields, Archiver, defaultAlertDays } from '../../src/ingest/archive.js';
import { IngestConfigError, loadIngestConfig } from '../../src/ingest/config.js';
import { createColdSlice, missingDays } from '../../src/modules/pa-heat/cold.js';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'netops-archive-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
let seq = 0;
function dirs(marker = true) {
  const base = path.join(tmpRoot, String(seq++));
  const dir = path.join(base, 'nas');
  const staging = path.join(base, 'staging');
  mkdirSync(dir, { recursive: true });
  if (marker) writeFileSync(path.join(dir, ARCHIVE_MARKER), '');
  return { dir, staging };
}

/** 假 ClickHouse:每天的來源列數、匯出內容(位元組)、manifest */
function fakeCh(rows: Record<string, number> = {}) {
  const manifest = new Map<string, ManifestEntry>();
  const exports: string[] = [];
  let failExport = false;
  /** Parquet 讀回的列數(預設同來源) */
  const parquetRows: Record<string, number> = {};
  const k = (kind: ArchiveKind, day: string) => `${kind}:${day}`;
  const ch: ArchiveWriterClient = {
    async exportParquet(kind, day) {
      if (failExport) throw new ClickHouseError('ClickHouse 連線失敗:ECONNREFUSED', undefined, undefined);
      exports.push(k(kind, day));
      const body = Buffer.from(`PAR1-${kind}-${day}-${rows[k(kind, day)] ?? 0}`);
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(body));
          c.close();
        },
      });
    },
    countDay: async (kind, day) => rows[k(kind, day)] ?? 0,
    async countDays(kind, from, to) {
      const m = new Map<string, number>();
      for (let d = from; d <= to; d = addDays(d, 1)) m.set(d, rows[k(kind, d)] ?? 0);
      return m;
    },
    manifest: async (days) => [...manifest.values()].filter((e) => days.includes(e.day)),
    async writeManifest(entries) {
      for (const e of entries) manifest.set(k(e.kind, e.day), e);
    },
  };
  const cold: ColdFileClient = {
    parquetCount: async (kind, day) => parquetRows[k(kind, day)] ?? rows[k(kind, day)] ?? 0,
    manifest: ch.manifest,
    rows: async () => [],
  };
  return { ch, cold, manifest, exports, rows, parquetRows, setFailExport: (v: boolean) => (failExport = v) };
}

function memLock(): ColdLock & { held: () => string | null; hold: (v: string | null) => void } {
  let held: string | null = null;
  const lock = createColdLock({
    set: async (_k, v) => (held ? null : ((held = v), 'OK')),
    eval: async (script, _n, _k, v) => (held === v ? (script.includes('pexpire') ? 1 : ((held = null), 1)) : 0),
    quit: async () => 'OK',
  });
  return Object.assign(lock, { held: () => held, hold: (v: string | null) => (held = v) });
}

const logs: { level: string; msg: string }[] = [];
const log = (level: 'info' | 'warn' | 'error', msg: string) => void logs.push({ level, msg });
/** 2026-11-12 03:00 台灣時間 */
const T0 = Date.parse('2026-11-12T03:00:00+08:00');
const opts = (d: { dir: string; staging: string }, extra: Partial<{ keepDays: number; alertDays: number }> = {}) => ({
  ...d,
  keepDays: extra.keepDays ?? 14,
  alertDays: extra.alertDays ?? 2,
  ttlDays: { traffic: 3, threat: 3 } as Record<ArchiveKind, number>,
});
const signal = new AbortController().signal;

describe('歸檔檔名與日期', () => {
  it('日期驗證、台灣日、涵蓋的日子', () => {
    assert.ok(isDay('2026-11-12'));
    for (const bad of ['2026-11-31', '2026-1-1', '../2026-11-12', '2026-11-12/..', '']) assert.equal(isDay(bad), false, bad);
    assert.equal(taipeiDay(Date.parse('2026-11-11T16:00:00Z')), '2026-11-12');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.deepEqual(daysCovering(Date.parse('2026-11-10T22:00:00+08:00'), Date.parse('2026-11-11T02:00:00+08:00')), ['2026-11-10', '2026-11-11']);
    assert.deepEqual(daysCovering(Date.parse('2026-11-10T00:00:00+08:00'), Date.parse('2026-11-11T00:00:00+08:00')), ['2026-11-10']);
  });

  it('路徑只由常數與日期組成;不是本系統的檔名不處理', () => {
    assert.equal(archiveRelPath('traffic', '2026-11-12'), '2026/pa_traffic_2026-11-12.parquet');
    assert.throws(() => archiveRelPath('threat', "2026-11-12' OR 1"));
    assert.deepEqual(parseArchiveName('pa_threat_2026-11-01.parquet.sha256'), { kind: 'threat', day: '2026-11-01', ext: '.sha256' });
    assert.equal(parseArchiveName('netops-kb-test-20261104.tar.gz'), null);
    assert.equal(parseArchiveName('pa_traffic_2026-13-01.parquet'), null);
  });

  it('冷資料來源:IP 轉回 IPv6、時間轉回台灣時區、跨日 UNION ALL;日期不合法丟錯', () => {
    const s = coldSource('traffic', ['2026-11-01', '2026-11-02']);
    assert.match(s, /file\('archive\/2026\/pa_traffic_2026-11-01\.parquet', 'Parquet'\) UNION ALL/);
    assert.match(s, /toIPv6\(nat_dst\) AS nat_dst/);
    assert.match(s, /toDateTime\(session_start, 'Asia\/Taipei'\) AS session_start/);
    assert.doesNotMatch(coldSource('threat', ['2026-11-01']), /session_start/);
    assert.throws(() => coldSource('traffic', ["2026-11-01') --"]));
  });
});

describe('Archiver.archiveOne', () => {
  it('匯出 → 暫存 → NAS:正式檔、.sha256、manifest ok;暫存與 .tmp 清掉', async () => {
    const d = dirs();
    const f = fakeCh({ 'traffic:2026-11-11': 42 });
    const a = new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log, now: () => T0 }, opts(d));
    const e = await a.archiveOne('traffic', '2026-11-11', signal);
    const final = path.join(d.dir, '2026', 'pa_traffic_2026-11-11.parquet');
    const body = readFileSync(final);
    const sha = createHash('sha256').update(body).digest('hex');
    assert.equal(e.status, 'ok');
    assert.equal(e.rows, 42);
    assert.equal(e.bytes, body.length);
    assert.equal(e.sha256, sha);
    assert.equal(e.path, '2026/pa_traffic_2026-11-11.parquet');
    assert.equal(readFileSync(`${final}.sha256`, 'utf8'), `${sha}  pa_traffic_2026-11-11.parquet\n`);
    assert.equal(f.manifest.get('traffic:2026-11-11')?.status, 'ok');
    assert.deepEqual(readdirSync(path.join(d.dir, '2026')).sort(), ['pa_traffic_2026-11-11.parquet', 'pa_traffic_2026-11-11.parquet.sha256']);
    assert.deepEqual(readdirSync(d.staging), []);
  });

  it('Parquet 讀回列數和來源不同:失敗,不留 .tmp,原本的正式檔不動', async () => {
    const d = dirs();
    const f = fakeCh({ 'threat:2026-11-11': 10 });
    mkdirSync(path.join(d.dir, '2026'));
    writeFileSync(path.join(d.dir, '2026', 'pa_threat_2026-11-11.parquet'), 'old');
    f.parquetRows['threat:2026-11-11'] = 9;
    const a = new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log, now: () => T0 }, opts(d));
    await assert.rejects(a.archiveOne('threat', '2026-11-11', signal), /列數不一致:來源 10、Parquet 9/);
    assert.deepEqual(readdirSync(path.join(d.dir, '2026')), ['pa_threat_2026-11-11.parquet']);
    assert.equal(readFileSync(path.join(d.dir, '2026', 'pa_threat_2026-11-11.parquet'), 'utf8'), 'old');
    assert.deepEqual(readdirSync(d.staging), []);
  });
});

describe('Archiver.tick', () => {
  it('沒有標記檔:不寫任何檔,狀態 nas-missing', async () => {
    const d = dirs(false);
    const f = fakeCh({ 'traffic:2026-11-11': 5 });
    const a = new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log, now: () => T0 }, opts(d));
    await a.tick(signal);
    assert.equal(a.status.state, 'nas-missing');
    assert.deepEqual(f.exports, []);
    assert.deepEqual(readdirSync(d.dir), []);
    assert.match(archiveHeartbeatFields(a).archiveError ?? '', /標記檔/);
  });

  it('02:30 後處理前一天,並補原始表還完整的更早日子(TTL 3 天 → 前天、昨天);第二輪沒有要做的', async () => {
    const d = dirs();
    const f = fakeCh({ 'traffic:2026-11-10': 1, 'traffic:2026-11-11': 2, 'threat:2026-11-11': 3 });
    const a = new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log, now: () => T0 }, opts(d));
    await a.tick(signal);
    assert.deepEqual(f.exports, ['threat:2026-11-10', 'traffic:2026-11-10', 'threat:2026-11-11', 'traffic:2026-11-11']);
    assert.equal(a.status.state, 'ok');
    assert.equal(a.status.archived, 4);
    assert.deepEqual(a.status.lastOk, { threat: '2026-11-11', traffic: '2026-11-11' });
    await a.tick(signal);
    assert.equal(f.exports.length, 4);
    const hb = archiveHeartbeatFields(a);
    assert.equal(hb.archiveState, 'ok');
    assert.equal(hb['archiveLastOk:traffic'], '2026-11-11');
  });

  it('02:30 前不處理前一天', async () => {
    const d = dirs();
    const f = fakeCh();
    const a = new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log, now: () => Date.parse('2026-11-12T02:29:00+08:00') }, opts(d));
    await a.tick(signal);
    assert.deepEqual(f.exports, ['threat:2026-11-10', 'traffic:2026-11-10']);
  });

  it('失敗記 failed、1 小時後才重試;D+alertDays 還沒成功 → late(心跳告警)', async () => {
    const d = dirs();
    const f = fakeCh();
    let now = T0;
    const a = new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log, now: () => now }, opts(d, { alertDays: 2 }));
    f.setFailExport(true);
    await a.tick(signal);
    assert.equal(f.manifest.get('traffic:2026-11-11')?.status, 'failed');
    assert.match(f.manifest.get('traffic:2026-11-11')?.error ?? '', /ECONNREFUSED/);
    // 2026-11-10 是 D+2 → late
    assert.equal(a.status.state, 'late');
    assert.deepEqual(a.status.late, ['traffic:2026-11-10', 'threat:2026-11-10']);
    assert.ok(logs.some((l) => l.level === 'error' && /逾期/.test(l.msg)));
    f.setFailExport(false);
    now = T0 + 30 * 60_000;
    await a.tick(signal);
    assert.deepEqual(f.exports, []);
    now = T0 + 61 * 60_000;
    await a.tick(signal);
    assert.equal(f.exports.length, 4);
    assert.equal(a.status.state, 'ok');
    assert.deepEqual(a.status.late, []);
  });

  it('冷查詢鎖被佔用:這一輪不歸檔;歸檔中持有鎖,結束後釋放', async () => {
    const d = dirs();
    const f = fakeCh({ 'traffic:2026-11-11': 1 });
    const lock = memLock();
    lock.hold('someone');
    const a = new Archiver({ ch: f.ch, cold: f.cold, lock, log, now: () => T0, lockWaitMs: 1 }, opts(d));
    await a.tick(signal);
    assert.deepEqual(f.exports, []);
    lock.hold(null);
    await a.tick(signal);
    assert.equal(f.exports.length, 4);
    assert.equal(lock.held(), null);
  });

  it('歸檔後來源列數變了(補漏、去重):重新歸檔', async () => {
    const d = dirs();
    const f = fakeCh({ 'traffic:2026-11-11': 5 });
    let now = T0;
    const a = new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log, now: () => now }, opts(d));
    await a.tick(signal);
    f.rows['traffic:2026-11-11'] = 7;
    now = T0 + 61 * 60_000;
    await a.tick(signal);
    assert.equal(f.exports.at(-1), 'traffic:2026-11-11');
    assert.equal(f.manifest.get('traffic:2026-11-11')?.rows, 7);
  });

  it('保留期限:刪除超過天數的本系統檔案、manifest 記 expired;其他檔不動;0 = 不刪', async () => {
    const d = dirs();
    mkdirSync(path.join(d.dir, '2026'));
    for (const n of ['pa_traffic_2026-10-28.parquet', 'pa_traffic_2026-10-28.parquet.sha256', 'pa_threat_2026-10-29.parquet', 'other.txt']) writeFileSync(path.join(d.dir, '2026', n), 'x');
    const f = fakeCh();
    const keep0 = new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log, now: () => T0 }, opts(d, { keepDays: 0 }));
    await keep0.retention('2026-11-12');
    assert.equal(readdirSync(path.join(d.dir, '2026')).length, 4);
    const a = new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log, now: () => T0 }, opts(d, { keepDays: 14 }));
    await a.retention('2026-11-12');
    // 2026-11-12 − 14 天 = 10-29:10-28 刪除、10-29 保留
    assert.deepEqual(readdirSync(path.join(d.dir, '2026')).sort(), ['other.txt', 'pa_threat_2026-10-29.parquet']);
    assert.equal(f.manifest.get('traffic:2026-10-28')?.status, 'expired');
    assert.equal(f.manifest.has('threat:2026-10-29'), false);
  });

  it('啟動時清掉中斷留下的暫存檔', async () => {
    const d = dirs();
    mkdirSync(d.staging, { recursive: true });
    writeFileSync(path.join(d.staging, 'pa_traffic_2026-11-11.parquet.part'), 'x');
    writeFileSync(path.join(d.staging, 'keep.txt'), 'x');
    const f = fakeCh();
    await new Archiver({ ch: f.ch, cold: f.cold, lock: memLock(), log }, opts(d)).cleanStaging();
    assert.deepEqual(readdirSync(d.staging), ['keep.txt']);
  });

  it('告警天數預設:正式區 25、測試區(TTL 3)2', () => {
    assert.equal(defaultAlertDays(30), 25);
    assert.equal(defaultAlertDays(3), 2);
    assert.equal(defaultAlertDays(1), 1);
    assert.deepEqual(archiveHeartbeatFields(null), { archiveState: 'disabled' });
  });
});

describe('冷歸檔設定(netops-ingest)', () => {
  const pw = path.join(tmpRoot, 'pw');
  writeFileSync(pw, 'secret-value');
  const base = { GW_ENV: 'test', REDIS_URL: 'redis://r:6379/0', CLICKHOUSE_URL: 'http://ch:8123', CLICKHOUSE_USER: 'netops_writer', CLICKHOUSE_PASSWORD_FILE: pw };

  it('預設關閉;開啟時需要冷查詢密碼;測試區保留 14 天、告警 2 天', () => {
    assert.equal(loadIngestConfig(base).archive, null);
    assert.throws(() => loadIngestConfig({ ...base, NETOPS_ARCHIVE_ENABLED: '1' }), /CLICKHOUSE_COLD_PASSWORD_FILE/);
    assert.throws(() => loadIngestConfig({ ...base, NETOPS_ARCHIVE_ENABLED: 'yes' }), IngestConfigError);
    const a = loadIngestConfig({ ...base, NETOPS_ARCHIVE_ENABLED: '1', CLICKHOUSE_COLD_PASSWORD_FILE: pw }).archive!;
    assert.deepEqual({ dir: a.dir, staging: a.staging, keepDays: a.keepDays, alertDays: a.alertDays, user: a.cold.user }, { dir: '/archive', staging: '/var/lib/netops-ingest/staging', keepDays: 14, alertDays: 2, user: 'netops_cold' });
    assert.throws(() => loadIngestConfig({ ...base, NETOPS_ARCHIVE_ENABLED: '1', CLICKHOUSE_COLD_PASSWORD_FILE: pw, INGEST_ARCHIVE_DIR: '/archive/../etc' }), /絕對路徑/);
  });

  it('正式區:預設不刪;保留天數設定時至少 366(CQ12)', () => {
    const prod = { ...base, GW_ENV: 'prod', NETOPS_ARCHIVE_ENABLED: '1', CLICKHOUSE_COLD_PASSWORD_FILE: pw };
    const a = loadIngestConfig(prod).archive!;
    assert.equal(a.keepDays, 0);
    assert.equal(a.alertDays, 25);
    assert.throws(() => loadIngestConfig({ ...prod, INGEST_ARCHIVE_KEEP_DAYS: '30' }), /至少 366/);
    assert.equal(loadIngestConfig({ ...prod, INGEST_ARCHIVE_KEEP_DAYS: '400' }).archive!.keepDays, 400);
  });
});

describe('冷明細(netops-api,C4 / V-a 冷路由)', () => {
  const entry = (kind: ArchiveKind, day: string, status: ManifestEntry['status']): ManifestEntry => ({ day, kind, status, rows: 1, bytes: 1, sha256: '', path: '', error: '', updatedAt: 0 });
  const quiet = { warn: () => undefined };
  const filter = { fromMs: Date.parse('2026-11-01T22:00:00+08:00'), toMs: Date.parse('2026-11-02T02:00:00+08:00') };

  it('缺的日子與狀態:TRAFFIC 明細另外要威脅歸檔', () => {
    const m = missingDays([entry('traffic', '2026-11-01', 'ok'), entry('threat', '2026-11-01', 'expired'), entry('traffic', '2026-11-02', 'failed')], ['traffic', 'threat'], ['2026-11-01', '2026-11-02']);
    assert.deepEqual(m, [
      { type: 'traffic', day: '2026-11-02', status: 'failed' },
      { type: 'threat', day: '2026-11-01', status: 'expired' },
      { type: 'threat', day: '2026-11-02', status: 'missing' },
    ]);
  });

  it('期間內有一天沒歸檔:404 NETOPS_COLD_ARCHIVE_NOT_FOUND,不送查詢', async () => {
    let queried = 0;
    const client: ColdFileClient = { parquetCount: async () => 0, manifest: async () => [entry('traffic', '2026-11-01', 'ok'), entry('threat', '2026-11-01', 'ok')], rows: async () => (queried++, []) };
    const err = await createColdSlice(client, quiet)
      .query('traffic', filter, 10, 'time', signal)
      .catch((e: unknown) => e);
    assert.ok(err instanceof AppError);
    assert.equal(err.status, 404);
    assert.equal(err.code, 'NETOPS_COLD_ARCHIVE_NOT_FOUND');
    assert.deepEqual((err.details as { missing: unknown[] }).missing.length, 2);
    assert.equal(queried, 0);
  });

  it('都歸檔了:查 Parquet 子查詢;檔案讀不到(107)→ 404 unreadable;其他錯誤 → 503,不帶原文', async () => {
    const ok = ['2026-11-01', '2026-11-02'].flatMap((d) => [entry('traffic', d, 'ok'), entry('threat', d, 'ok')]);
    const sqls: string[] = [];
    const client: ColdFileClient = { parquetCount: async () => 0, manifest: async () => ok, rows: async <T>(sql: string) => (sqls.push(sql), [] as T[]) };
    const r = await createColdSlice(client, quiet).query('traffic', filter, 10, 'time', signal);
    assert.equal(r.summary.sessions, 0);
    assert.ok(sqls.every((s) => /FROM \(SELECT \* REPLACE/.test(s)));
    assert.ok(sqls.some((s) => /pa_threat_2026-11-02\.parquet/.test(s)));

    const fail = (code: number): ColdFileClient => ({ ...client, rows: async () => Promise.reject(new ClickHouseError('ClickHouse HTTP 500:secret path /var/lib', code, 500)) });
    const e1 = await createColdSlice(fail(107), quiet).query('threat', filter, 10, 'time', signal).catch((e: unknown) => e);
    assert.ok(e1 instanceof AppError && e1.status === 404);
    assert.equal((e1.details as { missing: { status: string }[] }).missing[0]!.status, 'unreadable');
    const e2 = await createColdSlice(fail(241), quiet).query('threat', filter, 10, 'time', signal).catch((e: unknown) => e);
    assert.ok(e2 instanceof AppError && e2.status === 503);
    assert.doesNotMatch(e2.message, /secret path/);
  });

  it('冷查詢鎖:refresh 只延長自己的鎖', async () => {
    const lock = memLock();
    assert.equal(await lock.acquire('a'), true);
    assert.equal(await lock.refresh('a'), true);
    assert.equal(await lock.refresh('b'), false);
    await lock.release('a');
    assert.equal(lock.held(), null);
    assert.equal(existsSync(tmpRoot), true);
  });
});
