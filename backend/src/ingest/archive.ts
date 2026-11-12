/**
 * 冷資料 Parquet 歸檔排程(C4;ARCHITECTURE D30、手冊 docs/PA-LOG-CLICKHOUSE-GUIDE.md §8.3)。只在 netops-ingest(單一容器)執行。
 *
 * 每 10 分鐘檢查一次(tick):
 *   1. 台灣時間 02:30 起處理「前一天」;更早還沒歸檔成功的日子(原始表裡還完整的範圍:今天 −(保留天數 − 1)天起)一起補,
 *      失敗的日子 1 小時後重試,直到資料被 TTL 刪除前(正式區 D+29;需求 D+25 告警)
 *   2. 一個檔:ClickHouse 匯出 Parquet(串流)→ 本機暫存(一邊算 SHA-256)→ NAS 上的 .tmp → 重讀 .tmp 比對雜湊 →
 *      ClickHouse 從唯讀掛載讀回 .tmp 的列數 = 來源列數 → 改名成正式檔、寫 .sha256 → manifest 記 ok
 *      (中途任何一步失敗:刪暫存與 .tmp、manifest 記 failed,原本的正式檔不動)
 *   3. 歸檔後來源列數變了(FTP 補漏、去重):每小時比對一次,不同就重新歸檔(覆蓋正式檔)
 *   4. 保留期限(INGEST_ARCHIVE_KEEP_DAYS;測試區 14 天、正式區 0 = 不刪,CQ12 至少 1 年):刪過期的檔,manifest 記 expired
 * NAS 標記檔 pa-archive/.giga-netops-archive 不存在(NAS 沒掛上、容器掛到本機空目錄)時不寫任何檔,心跳 archiveState = nas-missing。
 * 匯出與讀回核對都持有冷查詢鎖(netops:cold:lock,和 netops-api 的冷明細共用;全系統 1 個冷查詢,D35),每 30 秒延長。
 * 心跳:archiveState(ok / late / nas-missing / failing / disabled)、archiveLate(D+N 還沒歸檔成功的日子)、archiveLastOk:<類型>、archiveError。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  addDays,
  ARCHIVE_KIND_LIST,
  archiveFileName,
  archiveRelPath,
  isDay,
  parseArchiveName,
  taipeiDay,
  type ArchiveKind,
  type ArchiveWriterClient,
  type ColdFileClient,
  type ManifestEntry,
} from '../infra/clickhouse/archive.js';
import type { ColdLock } from '../infra/redis/cold-lock.js';

/** 標記檔:有它才寫(同 netops-kb-backup 的 .giga-netops-backup) */
export const ARCHIVE_MARKER = '.giga-netops-archive';
const DAY_MS = 86_400_000;
const TZ_MS = 8 * 3600_000;
/** 每天幾點(台灣時間,分鐘)開始處理前一天:02:30(避開 02:00 知識庫備份) */
export const ARCHIVE_START_MINUTES = 150;
export const ARCHIVE_TICK_MS = 10 * 60_000;
const RETRY_MS = 3600_000;
const RECHECK_MS = 3600_000;
const LOCK_WAIT_MS = 60_000;
const LOCK_REFRESH_MS = 30_000;
/** 心跳最多列幾個逾期的日子 */
const LATE_SHOW = 10;

export interface ArchiveOptions {
  /** 容器內的 NAS 掛載點(/archive) */
  dir: string;
  /** 本機暫存(WSL 磁碟的 volume) */
  staging: string;
  /** 保留天數;0 = 不刪 */
  keepDays: number;
  /** 前一天起算第幾天還沒歸檔成功就告警(正式區 25) */
  alertDays: number;
  /** 原始表保留天數(重試範圍) */
  ttlDays: Record<ArchiveKind, number>;
}

export interface ArchiveDeps {
  ch: ArchiveWriterClient;
  cold: ColdFileClient;
  lock: ColdLock;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
  /** 測試縮短等鎖時間 */
  lockWaitMs?: number;
}

export type ArchiveState = 'starting' | 'ok' | 'late' | 'nas-missing' | 'failing';

export interface ArchiveStatus {
  state: ArchiveState;
  /** 逾期(D+alertDays 還沒成功)的「類型:日期」 */
  late: string[];
  lastOk: Partial<Record<ArchiveKind, string>>;
  lastError: { message: string; at: string } | null;
  lastRunAt: string | null;
  /** 這次啟動後歸檔成功的檔數 */
  archived: number;
}

/** 錯誤訊息只留一行、截斷(不含路徑以外的資料內容) */
const brief = (e: unknown) => String((e as Error)?.message ?? e).replace(/\p{Cc}+/gu, ' ').slice(0, 200);
const key = (kind: ArchiveKind, day: string) => `${kind}:${day}`;
const minutesOfDay = (ms: number) => Math.floor(((ms + TZ_MS) % DAY_MS) / 60_000);
const ageDays = (day: string, today: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(
    createReadStream(p),
    new Transform({
      transform(c, _e, cb) {
        h.update(c);
        cb();
      },
    }),
  );
  return h.digest('hex');
}

/** 告警天數預設:min(25, TRAFFIC 保留天數 − 1),至少 1(測試區 TTL 3 天 → 2) */
export const defaultAlertDays = (ttlTraffic: number) => Math.max(1, Math.min(25, ttlTraffic - 1));

export class Archiver {
  readonly status: ArchiveStatus = { state: 'starting', late: [], lastOk: {}, lastError: null, lastRunAt: null, archived: 0 };
  private readonly nextTry = new Map<string, number>();
  /** 逾期告警每個項目只記一次日誌 */
  private readonly lateLogged = new Set<string>();
  private lastRecheck = 0;
  private retentionDay = '';
  private readonly now: () => number;

  constructor(
    private readonly d: ArchiveDeps,
    private readonly o: ArchiveOptions,
  ) {
    this.now = d.now ?? Date.now;
  }

  private fail(where: string, e: unknown) {
    this.status.lastError = { message: `${where}:${brief(e)}`, at: new Date(this.now()).toISOString() };
  }

  /** 啟動時清掉上次中斷留下的暫存檔(只刪本系統檔名) */
  async cleanStaging(): Promise<void> {
    await mkdir(this.o.staging, { recursive: true });
    for (const name of await readdir(this.o.staging)) if (/^pa_(traffic|threat)_[\d-]+\.parquet(\.part)?$/.test(name)) await rm(path.join(this.o.staging, name), { force: true });
  }

  /** 一輪:規劃要歸檔的日子 → 逐一歸檔 → 保留期限 → 更新狀態 */
  async tick(signal: AbortSignal): Promise<void> {
    const now = this.now();
    const today = taipeiDay(now);
    // 02:30 前前一天還不處理(最後幾分鐘的 log 可能還在寫入)
    const newest = addDays(today, minutesOfDay(now) >= ARCHIVE_START_MINUTES ? -1 : -2);
    this.status.lastRunAt = new Date(now).toISOString();
    let failed = false;

    const pending: { kind: ArchiveKind; day: string; stale: boolean }[] = [];
    const late: string[] = [];
    const recheck = now - this.lastRecheck >= RECHECK_MS;
    try {
      for (const kind of ARCHIVE_KIND_LIST) {
        // 原始表裡還完整的最早一天(同 netops-api 的熱 / 冷分界)
        const oldest = addDays(today, -(this.o.ttlDays[kind] - 1));
        if (oldest > newest) continue;
        const days: string[] = [];
        for (let d = oldest; d <= newest; d = addDays(d, 1)) days.push(d);
        const manifest = new Map((await this.d.ch.manifest(days)).filter((e) => e.kind === kind).map((e) => [e.day, e]));
        const counts = recheck ? await this.d.ch.countDays(kind, oldest, newest) : null;
        for (const day of days) {
          const e = manifest.get(day);
          if (e?.status === 'expired') continue;
          if (e?.status === 'ok') {
            this.status.lastOk[kind] = !this.status.lastOk[kind] || day > this.status.lastOk[kind]! ? day : this.status.lastOk[kind];
            // 歸檔後來源列數變了(補漏、去重):重新歸檔
            if (counts && (counts.get(day) ?? 0) !== e.rows) pending.push({ kind, day, stale: true });
            continue;
          }
          pending.push({ kind, day, stale: false });
          if (ageDays(day, today) >= this.o.alertDays) late.push(key(kind, day));
        }
      }
      if (recheck) this.lastRecheck = now;
    } catch (e) {
      this.fail('讀取歸檔紀錄', e);
      this.status.state = 'failing';
      return;
    }
    this.status.late = late;
    for (const k of late)
      if (!this.lateLogged.has(k)) {
        this.lateLogged.add(k);
        this.d.log('error', '冷歸檔逾期未成功(資料被 ClickHouse TTL 刪除前要處理)', { item: k });
      }

    if (!(await exists(path.join(this.o.dir, ARCHIVE_MARKER)))) {
      this.status.state = 'nas-missing';
      this.fail('NAS', new Error(`找不到標記檔 ${ARCHIVE_MARKER}(NAS 未掛載或目錄未建立),不寫入`));
      return;
    }

    // 舊的先做(離 TTL 刪除最近);重新歸檔排在最後
    pending.sort((a, b) => Number(a.stale) - Number(b.stale) || a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind));
    for (const p of pending) {
      if (signal.aborted) break;
      if ((this.nextTry.get(key(p.kind, p.day)) ?? 0) > now) continue;
      const owner = `archive:${key(p.kind, p.day)}:${randomUUID()}`;
      if (!(await this.acquire(owner, signal))) {
        // 冷明細查詢佔著鎖:這一輪先停,下一輪(10 分鐘後)再試
        this.d.log('info', '冷查詢鎖忙碌,歸檔延到下一輪');
        break;
      }
      try {
        const r = await this.withRefresh(owner, (s) => this.archiveOne(p.kind, p.day, AbortSignal.any([signal, s])));
        this.nextTry.delete(key(p.kind, p.day));
        this.status.archived++;
        if (!this.status.lastOk[p.kind] || p.day > this.status.lastOk[p.kind]!) this.status.lastOk[p.kind] = p.day;
        this.status.late = this.status.late.filter((k) => k !== key(p.kind, p.day));
        this.d.log('info', p.stale ? '重新歸檔完成(來源列數有變)' : '歸檔完成', { kind: p.kind, day: p.day, rows: r.rows, bytes: r.bytes });
      } catch (e) {
        failed = true;
        this.nextTry.set(key(p.kind, p.day), this.now() + RETRY_MS);
        this.fail(`歸檔 ${p.kind} ${p.day}`, e);
        this.d.log('warn', '歸檔失敗,1 小時後重試', { kind: p.kind, day: p.day, error: brief(e) });
        // 重新歸檔失敗時正式檔沒有動,保留原本的 ok 紀錄
        if (!p.stale)
          await this.d.ch
            .writeManifest([{ day: p.day, kind: p.kind, status: 'failed', rows: 0, bytes: 0, sha256: '', path: archiveRelPath(p.kind, p.day), error: brief(e), updatedAt: this.now() }])
            .catch(() => undefined);
      } finally {
        await this.d.lock.release(owner);
      }
    }

    try {
      await this.retention(today);
    } catch (e) {
      failed = true;
      this.fail('保留期限清理', e);
    }
    this.status.state = this.status.late.length ? 'late' : failed ? 'failing' : 'ok';
  }

  private async acquire(owner: string, signal: AbortSignal): Promise<boolean> {
    const until = this.now() + (this.d.lockWaitMs ?? LOCK_WAIT_MS);
    for (;;) {
      try {
        if (await this.d.lock.acquire(owner)) return true;
      } catch (e) {
        this.fail('冷查詢鎖', e);
      }
      if (this.now() >= until || signal.aborted) return false;
      await new Promise((r) => setTimeout(r, Math.min(5_000, this.d.lockWaitMs ?? 5_000)));
    }
  }

  /** 執行期間每 30 秒延長鎖;鎖被別人拿走(過期)時中止這次歸檔 */
  private async withRefresh<T>(owner: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const lost = new AbortController();
    const timer = setInterval(() => {
      this.d.lock
        .refresh(owner)
        .then((ok) => {
          if (!ok) lost.abort(new Error('冷查詢鎖已過期'));
        })
        .catch(() => undefined);
    }, LOCK_REFRESH_MS);
    try {
      return await run(lost.signal);
    } finally {
      clearInterval(timer);
    }
  }

  /** 歸檔一個檔(類型 × 一天);成功寫 manifest ok */
  async archiveOne(kind: ArchiveKind, day: string, signal: AbortSignal): Promise<ManifestEntry> {
    if (!isDay(day)) throw new Error('日期格式錯誤');
    const name = archiveFileName(kind, day);
    const local = path.join(this.o.staging, `${name}.part`);
    const yearDir = path.join(this.o.dir, day.slice(0, 4));
    const tmp = path.join(yearDir, `${name}.tmp`);
    const final = path.join(yearDir, name);
    await mkdir(this.o.staging, { recursive: true });
    try {
      // 1) 匯出到本機暫存,同時算雜湊
      const hash = createHash('sha256');
      const body = await this.d.ch.exportParquet(kind, day, signal);
      await pipeline(
        Readable.fromWeb(body as WebReadableStream<Uint8Array>),
        new Transform({
          transform(c, _e, cb) {
            hash.update(c);
            cb(null, c);
          },
        }),
        createWriteStream(local),
        { signal },
      );
      const sha = hash.digest('hex');
      const { size } = await stat(local);
      // 2) 搬到 NAS 的 .tmp,重讀比對雜湊
      await mkdir(yearDir, { recursive: true });
      await pipeline(createReadStream(local), createWriteStream(tmp), { signal });
      if ((await sha256File(tmp)) !== sha) throw new Error('NAS 檔案雜湊和匯出時不一致');
      // 3) 列數核對:串流中途失敗時 HTTP 可能已回 200、檔案被截斷;ClickHouse 從唯讀掛載讀回 .tmp(壞檔會解析失敗)
      const expected = await this.d.ch.countDay(kind, day);
      const actual = await this.d.cold.parquetCount(kind, day, true);
      if (expected !== actual) throw new Error(`列數不一致:來源 ${expected}、Parquet ${actual}`);
      // 4) 改名成正式檔(重新歸檔時覆蓋舊檔)、寫 .sha256、記 manifest
      await rename(tmp, final);
      await writeFile(`${final}.sha256`, `${sha}  ${name}\n`);
      const entry: ManifestEntry = { day, kind, status: 'ok', rows: expected, bytes: size, sha256: sha, path: archiveRelPath(kind, day), error: '', updatedAt: this.now() };
      await this.d.ch.writeManifest([entry]);
      return entry;
    } finally {
      await rm(local, { force: true });
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** 保留期限:每天一次,刪除 keepDays 天前的檔(只刪本系統檔名),manifest 記 expired */
  async retention(today: string): Promise<void> {
    if (this.o.keepDays <= 0 || this.retentionDay === today) return;
    const cutoff = addDays(today, -this.o.keepDays);
    const expired: ManifestEntry[] = [];
    for (const year of await readdir(this.o.dir)) {
      if (!/^\d{4}$/.test(year) || year > cutoff.slice(0, 4)) continue;
      const yd = path.join(this.o.dir, year);
      if (!(await stat(yd)).isDirectory()) continue;
      for (const name of await readdir(yd)) {
        const p = parseArchiveName(name);
        if (!p || p.day >= cutoff) continue;
        await rm(path.join(yd, name), { force: true });
        if (p.ext === '') expired.push({ day: p.day, kind: p.kind, status: 'expired', rows: 0, bytes: 0, sha256: '', path: archiveRelPath(p.kind, p.day), error: '', updatedAt: this.now() });
      }
    }
    if (expired.length) {
      await this.d.ch.writeManifest(expired);
      this.d.log('info', '刪除超過保留期限的歸檔', { files: expired.length, before: cutoff });
    }
    this.retentionDay = today;
  }
}

/** 心跳欄位(netops:ingest:heartbeat;和寫入管線同一個 Hash) */
export function archiveHeartbeatFields(a: Archiver | null): Record<string, string> {
  if (!a) return { archiveState: 'disabled' };
  const s = a.status;
  const f: Record<string, string> = {
    archiveState: s.state,
    archiveLate: s.late.slice(0, LATE_SHOW).join(','),
    archiveLateCount: String(s.late.length),
    archiveArchived: String(s.archived),
    archiveRunAt: s.lastRunAt ?? '',
  };
  for (const k of ARCHIVE_KIND_LIST) f[`archiveLastOk:${k}`] = s.lastOk[k] ?? '';
  if (s.lastError) {
    f.archiveError = s.lastError.message;
    f.archiveErrorAt = s.lastError.at;
  }
  return f;
}

/** 排程迴圈:啟動時清暫存、先跑一輪,之後每 10 分鐘 */
export async function archiveLoop(a: Archiver, signal: AbortSignal, log: ArchiveDeps['log'], tickMs = ARCHIVE_TICK_MS): Promise<void> {
  try {
    await a.cleanStaging();
  } catch (e) {
    log('warn', '清理歸檔暫存失敗', { error: brief(e) });
  }
  while (!signal.aborted) {
    try {
      await a.tick(signal);
    } catch (e) {
      log('warn', '歸檔排程發生非預期錯誤', { error: brief(e) });
    }
    await new Promise<void>((r) => {
      const t = setTimeout(r, tickMs);
      signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });
  }
}
