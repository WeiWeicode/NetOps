/**
 * AD FTP 補漏(AD-3;docs/AD-AGENT-PLAN.md §5 第 2 點、ARCHITECTURE D49;需求方 2026-11-24 D1、D2、D5)。netops-ingest 從佇列取工作:
 *   1. 驗證工作(資料來自 Redis,不信任 netops-api 以外的寫入):日期、在 ad_events 保留期內、檔案在 FTP_AD_DIR/yyyyMMdd/ 下且是 .csv、數量上限
 *   2. 逐檔從 FTP 下載 CSV(記憶體內解析,不落地;AGENT.md §7.4),只取屬於這一天、工作範圍內 (DC, 記錄) 的列
 *   3. 每個 (DC, 記錄):DC 名稱對到 Agent 的寫法 → 世代判定與水位保護(ad-epoch.ts)→ 查已存在的 (computer, channel, log_epoch, record_id)
 *      → 只寫缺的列(source = 'ftp',去重 token 由工作 id、DC、記錄與批次組成,重做不重複)
 * 不刪除既有資料;ad_heat_* 由物化檢視在 INSERT 時自然累加(只寫缺的列,不重建,審查 M3);冷歸檔偵測到列數變了會重新歸檔。
 */
import type { AdBackfillCh } from '../infra/clickhouse/ad-backfill.js';
import type { ClickHouseWriter } from '../infra/clickhouse/index.js';
import type { Ftp } from '../infra/ftp/index.js';
import type { AdBackfillCounts, AdBackfillJob, AdBackfillQueue } from '../infra/redis/ad-backfill.js';
import { channelOf, enrichEvent, parseAdCsv } from '../modules/ad/core/adlog.js';
import { anchorKey, currentEpochOf, decide, segmentEpochs, splitSegments, type CsvRow, type EpochContext } from './ad-epoch.js';
import { AD_CHANNELS, csvTimeSec, csvToAdRow, type CsvAdEvent } from './ad-rows.js';

const BATCH = 5000;
const DAY_MS = 86_400_000;
/** 工作內容上限 */
const FILES_MAX = 40;
const SCOPE_MAX = 100;
/** 一天一個 (DC, 記錄) 最多幾列(超過視為異常檔,工作失敗) */
export const AD_ROWS_MAX = 500_000;

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

/** DC 名稱比對用:去掉網域後段、轉大寫(同 modules/ad/source.ts dcKey) */
export const dcKey = (computer: string): string => String(computer ?? '').trim().split('.')[0]!.toUpperCase();
const DC_RE = /^[\w-]{1,64}$/;

/** 工作驗證(資安:佇列內容可能不是 netops-api 寫的);回錯誤訊息或 null */
export function validateAdJob(job: AdBackfillJob, rules: { adDir: string; ttlDays: number; now: number }): string | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(job.day);
  if (!m) return '工作的日期不正確';
  const dayMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`);
  if (Number.isNaN(dayMs) || dayMs > rules.now || rules.now - dayMs > rules.ttlDays * DAY_MS) return '工作的日期不在 AD 事件保留期間內';
  if (!job.files.length || job.files.length > FILES_MAX) return '工作的 FTP 檔數量不正確';
  const dir = `${rules.adDir === '/' ? '' : rules.adDir}/${m[1]}${m[2]}${m[3]}/`;
  for (const f of job.files) {
    const name = typeof f === 'string' ? f.slice(dir.length) : '';
    if (typeof f !== 'string' || !f.startsWith(dir) || !name || name.includes('/') || f.includes('..') || !/\.csv$/i.test(name)) return '工作的 FTP 檔不在 AD 目錄或檔名不符';
  }
  if (!job.scope.length || job.scope.length > SCOPE_MAX) return '工作的範圍不正確';
  for (const s of job.scope) if (!s || !DC_RE.test(String(s.computer)) || !(AD_CHANNELS as readonly string[]).includes(String(s.channel))) return '工作的範圍不正確';
  return null;
}

/** FTP 原始檔(UTF-16 LE 或 UTF-8)→ 文字(同 modules/ad/importer.ts) */
const decode = (buf: Buffer) => (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '');

const errText = (e: unknown) => {
  const x = e as { code?: unknown; message?: string; name?: string };
  if (typeof x?.code === 'string' && x.code.startsWith('NETOPS_')) return String(x.message ?? x.code).slice(0, 200);
  if (typeof x?.code === 'number') return `ClickHouse 錯誤(code ${x.code})`;
  return `補漏失敗(${x?.name ?? 'Error'})`;
};
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

export interface AdBackfillDeps {
  ch: Pick<ClickHouseWriter, 'insertJson'>;
  q: AdBackfillCh;
  ftp: Ftp;
  queue: AdBackfillQueue;
  /** 接收端水位(netops:ad:recv:hwm:{computer}:欄位 channel:epoch → RecordID) */
  watermarks: (computer: string) => Promise<Record<string, string>>;
  log: Log;
  signal: AbortSignal;
  rules: { adDir: string; ttlDays: number };
  now?: () => number;
}

interface Item {
  ev: CsvAdEvent;
  /** CSV 的 Computer 欄(可能是 FQDN) */
  rawComputer: string;
  row: CsvRow;
}

/** 一個 (DC, 記錄) 的補寫:回傳各計數 */
export async function backfillGroup(
  key: { computer: string; channel: string },
  items: Item[],
  deps: Pick<AdBackfillDeps, 'ch' | 'q' | 'watermarks'> & { jobId: string; domain: string; now: number; dcName: string },
): Promise<Omit<AdBackfillCounts, 'read' | 'invalid'>> {
  const c = { skipped: 0, inserted: 0, waitingAgent: 0, ambiguous: 0 };
  const { q } = deps;
  const name = deps.dcName;
  const rids = items.map((x) => x.row.rid);
  const [keys, epochs, hwmRaw] = await Promise.all([q.keysInRange(name, key.channel, Math.min(...rids), Math.max(...rids)), q.agentEpochs(name, key.channel), deps.watermarks(name)]);
  // 有效水位:接收端水位與 ClickHouse Agent 最大 RecordID 取大
  const watermark = new Map<number, number>();
  for (const e of epochs) watermark.set(e.epoch, Math.max(watermark.get(e.epoch) ?? 0, e.maxRid));
  for (const [f, v] of Object.entries(hwmRaw)) {
    const i = f.lastIndexOf(':');
    if (f.slice(0, i) !== key.channel) continue;
    const epoch = Number(f.slice(i + 1));
    const rid = Number(v);
    if (Number.isSafeInteger(epoch) && Number.isSafeInteger(rid)) watermark.set(epoch, Math.max(watermark.get(epoch) ?? 0, rid));
  }
  const anchors = new Map<string, number>();
  const exists = new Set<string>();
  for (const k of keys) {
    exists.add(`${k.epoch}:${k.rid}`);
    if (k.source === 'agent') anchors.set(anchorKey(k.rid, k.t, k.eventId), k.epoch);
  }
  const hasAgent = watermark.size > 0;
  // 段的前後 Agent 列(每段各查一次;段數很少)
  const before = new Map<number, { epoch: number; rid: number } | null>();
  const after = new Map<number, { epoch: number; rid: number } | null>();
  const segsPre = hasAgent ? splitSegments(items.map((x) => x.row)) : [];
  for (const seg of segsPre) {
    const t0 = seg[0]!.t;
    const t1 = seg[seg.length - 1]!.t;
    if (!before.has(t0)) before.set(t0, await q.agentBefore(name, key.channel, t0));
    if (!after.has(t1)) after.set(t1, await q.agentAfter(name, key.channel, t1));
  }
  const ctx: EpochContext = { hasAgent, anchors, watermark, prevAgent: (t) => before.get(t) ?? null, nextAgent: (t) => after.get(t) ?? null };
  const segs = segmentEpochs(
    items.map((x) => x.row),
    ctx,
  );
  const current = currentEpochOf(watermark);
  const byRow = new Map<CsvRow, Item>(items.map((x) => [x.row, x]));
  let batch: string[] = [];
  let n = 0;
  const flush = async () => {
    if (!batch.length) return;
    await deps.ch.insertJson('ad', batch, `adftp:${deps.jobId}:${name}:${key.channel}:${n++}`);
    c.inserted += batch.length;
    batch = [];
  };
  for (const seg of segs) {
    for (const r of seg.rows) {
      const d = decide(r, seg.epoch, ctx, current);
      if (d.kind === 'ambiguous') {
        c.ambiguous++;
        continue;
      }
      if (d.kind === 'waiting') {
        c.waitingAgent++;
        continue;
      }
      const k = `${d.epoch}:${r.rid}`;
      if (exists.has(k)) {
        c.skipped++;
        continue;
      }
      exists.add(k);
      const row = csvToAdRow(byRow.get(r)!.ev, { computer: name, domain: deps.domain, epoch: d.epoch, receivedMs: deps.now });
      if (!row) continue;
      batch.push(JSON.stringify(row));
      if (batch.length >= BATCH) await flush();
    }
  }
  await flush();
  return c;
}

/** 執行一個工作(測試直接呼叫) */
export async function runAdBackfill(job: AdBackfillJob, deps: AdBackfillDeps): Promise<void> {
  const { ftp, queue, log, signal } = deps;
  const now = (deps.now ?? Date.now)();
  const c: AdBackfillCounts = { read: 0, skipped: 0, inserted: 0, waitingAgent: 0, ambiguous: 0, invalid: 0 };
  try {
    const invalid = validateAdJob(job, { ...deps.rules, now });
    if (invalid) throw fail('NETOPS_BACKFILL_INVALID', invalid);
    const scope = new Set(job.scope.map((s) => `${dcKey(s.computer)}|${s.channel}`));
    const groups = new Map<string, Item[]>();
    const seen = new Set<string>();
    const aborted = () => fail('NETOPS_BACKFILL_ABORTED', 'netops-ingest 停止,工作中斷;可重新送出(只補缺的列,不會重複)');
    await ftp.withSession(
      async (s) => {
        for (const file of job.files) {
          if (signal.aborted) throw aborted();
          const base = file.slice(file.lastIndexOf('/') + 1);
          // 檔名的記錄不在範圍內就不下載
          if (![...scope].some((k) => k.endsWith(`|${channelOf(base)}`))) continue;
          const events = parseAdCsv(decode(await s.download(file)), base) as CsvAdEvent[] & { computer: string }[];
          for (const raw of events as (CsvAdEvent & { computer: string })[]) {
            const ev = enrichEvent(raw) as CsvAdEvent & { computer: string };
            if (ev.time.slice(0, 10) !== job.day) continue;
            const k = `${dcKey(ev.computer)}|${ev.channel}`;
            if (!scope.has(k)) continue;
            c.read++;
            const t = csvTimeSec(ev.time);
            const rid = Number(ev.recordId);
            if (t === null || !/^[1-9]\d{0,15}$/.test(String(ev.recordId).trim()) || !Number.isSafeInteger(rid)) {
              c.invalid++;
              continue;
            }
            // 同一天新舊檔名(Security.csv 與 Security_GSMC-DC1.csv)可能重複:同 DC、記錄、RecordID、時間只算一次
            const dup = `${k}|${rid}|${t}`;
            if (seen.has(dup)) {
              c.read--;
              continue;
            }
            seen.add(dup);
            const list = groups.get(k) ?? [];
            if (list.length >= AD_ROWS_MAX) throw fail('NETOPS_BACKFILL_TOO_MANY', `一個 DC 的一個記錄一天超過 ${AD_ROWS_MAX} 列,視為異常檔`);
            list.push({ ev, rawComputer: ev.computer, row: { t, rid, eventId: Number(ev.eventId) || 0 } });
            groups.set(k, list);
          }
        }
      },
      { signal },
    );
    if (signal.aborted) throw aborted();
    // DC 名稱與網域用 Agent 的寫法;沒有 Agent 的 DC:大寫主機名,網域取 FQDN 後段
    const agents = new Map((await deps.q.agentComputers()).map((a) => [dcKey(a.computer), a]));
    for (const [k, items] of groups) {
      if (signal.aborted) throw aborted();
      const [computer, channel] = k.split('|') as [string, string];
      const a = agents.get(computer);
      const fqdn = items.find((x) => x.rawComputer.includes('.'))?.rawComputer ?? '';
      const domain = a?.domain ?? fqdn.slice(fqdn.indexOf('.') + 1).toLowerCase();
      const r = await backfillGroup({ computer, channel }, items, { ...deps, jobId: job.id, domain, now, dcName: a?.computer ?? computer });
      c.skipped += r.skipped;
      c.inserted += r.inserted;
      c.waitingAgent += r.waitingAgent;
      c.ambiguous += r.ambiguous;
      // 進度更新失敗(Redis 暫時斷線)不影響寫入
      await queue.update(job.id, c).catch(() => undefined);
    }
    await queue.update(job.id, { ...c, state: 'done', finishedAt: new Date().toISOString() });
    await queue.finish(job.id).catch(() => undefined);
    log('info', 'AD FTP 補漏完成', { id: job.id, day: job.day, ...c });
    if (c.ambiguous) log('warn', 'AD FTP 補漏有判斷不出世代的列(未寫入,需人工確認)', { id: job.id, day: job.day, ambiguous: c.ambiguous });
  } catch (e) {
    await queue.update(job.id, { ...c, state: 'failed', error: errText(e), finishedAt: new Date().toISOString() }).catch(() => undefined);
    await queue.finish(job.id).catch(() => undefined);
    log('warn', 'AD FTP 補漏失敗', { id: job.id, day: job.day, error: errText(e) });
  }
}

/** 背景迴圈:啟動時把上次中斷的工作標失敗,之後每 intervalMs 看一次佇列,一次做一個 */
export async function adBackfillLoop(deps: AdBackfillDeps & { intervalMs?: number }): Promise<void> {
  const wait = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      deps.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });
  let lastWarn = 0;
  let recovered = false;
  while (!deps.signal.aborted) {
    let job: AdBackfillJob | null = null;
    try {
      if (!recovered) {
        const ids = await deps.queue.failInterrupted('netops-ingest 重新啟動,工作中斷;可重新送出(只補缺的列,不會重複)');
        if (ids.length) deps.log('warn', 'AD 補漏工作在上次停止時中斷,已標成失敗', { ids });
        recovered = true;
      }
      job = await deps.queue.take();
    } catch (e) {
      if (Date.now() - lastWarn > 60_000) {
        lastWarn = Date.now();
        deps.log('warn', 'AD 補漏佇列讀取失敗,稍後重試', { error: (e as Error).name });
      }
    }
    if (job) await runAdBackfill(job, deps);
    else await wait(deps.intervalMs ?? 10_000);
  }
}
