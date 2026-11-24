/**
 * AD FTP 與 ClickHouse 每日對帳(AD-3;docs/AD-AGENT-PLAN.md §5、ARCHITECTURE D49;對齊 PA 的 modules/pa/reconcile.ts、D33、D43)。
 *   - FTP 端:AD 匯入器已同步的那一天 CSV(本機 adlogs,每日同步 AC1 匯入;不另外掃 FTP)每個 (DC, 記錄) 的筆數
 *   - ClickHouse 端:netops.ad_events 同一天同一 (DC, 記錄) 的 count();Security 只算 FTP 匯出的 23 種事件(審查 M1)
 *   - DC 名稱比對忽略大小寫與網域後段(CSV 的 Computer 是 MachineName,可能是 FQDN;Agent 是 Token 對應表的寫法)
 *   - 只對帳 ad_events 保留期內、FTP 保留期內、昨天以前的日子
 * 結果不存檔:畫面要時即時算(一天幾萬筆,在記憶體計數 + 一次 ClickHouse 查詢)。
 * 有缺口時送補漏工作給 netops-ingest(Redis 佇列,ingest/ad-backfill.ts):自動對帳每個日子每天最多送 1 次(waiting-agent 的列隔天再對,D1、D5),
 * 手動(POST /v1/ad/backfills)不受此限。NETOPS_RECON_AUTO_BACKFILL=0 關閉自動送。
 */
import { FTP_SECURITY_EVENT_IDS, type AdChReader, type AdReconCount } from '../../infra/clickhouse/ad-reader.js';
import type { AdBackfillJob, AdBackfillQueue, AdBackfillScope } from '../../infra/redis/ad-backfill.js';
import { taipeiDayStartMs, taipeiText } from '../../shared/time.js';
import type { AdEvent, AdImporter } from './importer.js';
import { dcKey } from './source.js';

const DAY_MS = 86_400_000;
const FTP_SECURITY = new Set<number>(FTP_SECURITY_EVENT_IDS);
/** 自動補漏的建立者 */
export const AD_AUTO_BACKFILL_OWNER = 'system:ad-recon';
/** 自動對帳最短間隔(對帳每 10 分鐘一輪,AD 不必每輪都查) */
export const AD_RECON_GAP_MS = 30 * 60_000;

export type AdReconItemStatus = 'ok' | 'gap' | 'excess';
export interface AdReconItem {
  /** DC(大寫、不含網域) */
  computer: string;
  channel: string;
  ftp: number;
  ch: number;
  /** ClickHouse 裡 Agent 寫入 / FTP 補寫各幾筆 */
  chAgent: number;
  chFtp: number;
  /** ftp − ch */
  diff: number;
  status: AdReconItemStatus;
}

/** ok;gap 有缺口;excess 只有多出(可能重複或 CSV 不完整);pending FTP 這天還沒匯入完;ftp-error 匯入時有檔案讀取失敗 */
export type AdReconStatus = 'ok' | 'gap' | 'excess' | 'pending' | 'ftp-error';
export interface AdReconDay {
  /** 'yyyy/MM/dd' */
  day: string;
  checkedAt: string;
  status: AdReconStatus;
  ftpFiles: number;
  gaps: number;
  excess: number;
  items: AdReconItem[];
  /** 從這一天建立的補漏工作 id(程序內記憶,重新啟動後清空;工作本身在 Redis 保留 7 天) */
  backfills: string[];
}

/** FTP 事件 → 每個 (DC, 記錄) 的筆數(Security 只算 23 種;純函式) */
export function ftpCounts(events: readonly Pick<AdEvent, 'computer' | 'channel' | 'eventId'>[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) {
    if (e.channel === 'Security' && !FTP_SECURITY.has(e.eventId)) continue;
    const k = `${dcKey(e.computer)}|${e.channel}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** 對帳比對(純函式):兩邊的鍵取聯集,依 DC、記錄排序 */
export function compareAd(ftp: Map<string, number>, ch: readonly AdReconCount[]): AdReconItem[] {
  const chMap = new Map<string, { n: number; agent: number; ftp: number }>();
  for (const r of ch) {
    const k = `${dcKey(r.computer)}|${r.channel}`;
    const cur = chMap.get(k) ?? { n: 0, agent: 0, ftp: 0 };
    chMap.set(k, { n: cur.n + r.n, agent: cur.agent + r.agent, ftp: cur.ftp + r.ftp });
  }
  const keys = [...new Set([...ftp.keys(), ...chMap.keys()])].sort();
  return keys.map((k) => {
    const [computer, channel] = k.split('|') as [string, string];
    const f = ftp.get(k) ?? 0;
    const c = chMap.get(k) ?? { n: 0, agent: 0, ftp: 0 };
    const diff = f - c.n;
    return { computer, channel, ftp: f, ch: c.n, chAgent: c.agent, chFtp: c.ftp, diff, status: diff > 0 ? 'gap' : diff < 0 ? 'excess' : 'ok' };
  });
}

/** 一天的 FTP 檔案路徑(補漏工作用;只取缺口記錄的檔) */
export function filesFor(adDir: string, day: string, names: readonly { name: string; channel?: string }[], channels: Set<string>): string[] {
  const dir = `${adDir === '/' ? '' : adDir}/${day.replace(/\//g, '')}`;
  return names.filter((f) => /\.csv$/i.test(f.name) && !f.name.includes('/') && channels.has(f.channel ?? '')).map((f) => `${dir}/${f.name}`);
}

export interface AdReconciler {
  /** 對帳一天('yyyy/MM/dd');ClickHouse 失敗丟 ClickHouseError */
  reconcile(day: string): Promise<AdReconDay>;
  /** 可對帳的日子(新的在前) */
  window(): string[];
  /** 送補漏:只補有缺口的 (DC, 記錄);沒有缺口回 'nothing',FTP 還沒匯入回 'pending',佇列滿回 'busy' */
  backfill(day: string, createdBy: string, want?: AdBackfillScope[]): Promise<AdBackfillJob | 'nothing' | 'pending' | 'busy' | 'no-queue'>;
  /** 自動對帳一輪(每日對帳 after 鏈呼叫;錯誤只寫日誌) */
  run(): Promise<void>;
}

export function createAdReconciler({
  ad,
  reader,
  queue,
  log,
  adDir,
  ftpRetentionDays,
  ttlDays,
  autoBackfill,
  now = Date.now,
}: {
  ad: Pick<AdImporter, 'eventsInRange' | 'days' | 'dayState'>;
  reader: Pick<AdChReader, 'reconCounts'>;
  queue: AdBackfillQueue | null;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  adDir: string;
  ftpRetentionDays: number;
  ttlDays: number;
  autoBackfill: boolean;
  now?: () => number;
}): AdReconciler {
  const jobs = new Map<string, string[]>();
  /** 自動補漏:'yyyy/MM/dd(對帳日)|yyyy/MM/dd(今天)' 已送過 */
  const autoSent = new Set<string>();
  let lastRun = 0;
  /** 每個對帳日最近一次自動補漏(工作 id 與送出時的缺口筆數) */
  const lastAuto = new Map<string, { id: string; gapSum: number }>();

  const today = () => taipeiText(now()).slice(0, 10);
  function window(): string[] {
    const n = Math.max(0, Math.min(ftpRetentionDays, ttlDays) - 1);
    const t = taipeiDayStartMs(today());
    return Array.from({ length: n }, (_, i) => taipeiText(t - (i + 1) * DAY_MS).slice(0, 10));
  }

  async function reconcile(day: string): Promise<AdReconDay> {
    const [fromMs, toMs] = [taipeiDayStartMs(day), taipeiDayStartMs(day) + DAY_MS];
    const st = ad.dayState(day);
    const files = ad.days().find((d) => d.day === day)?.files ?? [];
    const ftp = st === 'done' || st === 'error' ? ftpCounts(ad.eventsInRange(day, day)) : new Map<string, number>();
    const items = compareAd(ftp, await reader.reconCounts(fromMs, toMs));
    const gaps = items.filter((x) => x.status === 'gap').length;
    const excess = items.filter((x) => x.status === 'excess').length;
    const status: AdReconStatus = st === 'pending' || st === 'none' ? 'pending' : st === 'error' ? 'ftp-error' : gaps ? 'gap' : excess ? 'excess' : 'ok';
    return { day, checkedAt: new Date(now()).toISOString(), status, ftpFiles: files.length, gaps, excess, items, backfills: jobs.get(day) ?? [] };
  }

  async function backfill(day: string, createdBy: string, want?: AdBackfillScope[]) {
    if (!queue) return 'no-queue' as const;
    const rec = await reconcile(day);
    if (rec.status === 'pending') return 'pending' as const;
    const wantKeys = want?.length ? new Set(want.map((w) => `${dcKey(w.computer)}|${w.channel}`)) : null;
    const scope = rec.items.filter((x) => x.status === 'gap' && (!wantKeys || wantKeys.has(`${x.computer}|${x.channel}`))).map((x) => ({ computer: x.computer, channel: x.channel }));
    if (!scope.length) return 'nothing' as const;
    const files = filesFor(adDir, day, ad.days().find((d) => d.day === day)?.files ?? [], new Set(scope.map((s) => s.channel)));
    if (!files.length) return 'pending' as const;
    const job = await queue.enqueue(day, files, scope, createdBy);
    if (!job) return 'busy' as const;
    jobs.set(day, [job.id, ...(jobs.get(day) ?? [])].slice(0, 20));
    return job;
  }

  async function run() {
    if (now() - lastRun < AD_RECON_GAP_MS) return;
    lastRun = now();
    const t = today();
    for (const day of window()) {
      try {
        const rec = await reconcile(day);
        if (rec.status !== 'gap') continue;
        log.info({ day, gaps: rec.gaps }, '[AD 對帳] 有缺口');
        const key = `${day}|${t}`;
        if (!autoBackfill || autoSent.has(key)) continue;
        // 上一次自動補漏還在跑,或做完什麼都沒補、缺口也沒變(剩下的是 waiting-agent / ambiguous):不重送(程式碼審查 M5)
        const gapSum = rec.items.reduce((a, x) => a + Math.max(0, x.diff), 0);
        const prev = lastAuto.get(day);
        if (prev && queue) {
          const pj = await queue.get(prev.id).catch(() => null);
          if (pj && (pj.state === 'queued' || pj.state === 'running')) continue;
          if (pj?.state === 'done' && pj.inserted === 0 && prev.gapSum === gapSum) continue;
        }
        const r = await backfill(day, AD_AUTO_BACKFILL_OWNER);
        if (typeof r === 'object') {
          autoSent.add(key);
          lastAuto.set(day, { id: r.id, gapSum });
          log.info({ day, id: r.id, scope: r.scope.length }, '[AD 對帳] 自動送出補漏');
        } else if (r === 'busy') log.warn({ day }, '[AD 對帳] 補漏佇列已滿,下一輪再送');
      } catch (err) {
        log.warn({ day, err: (err as { code?: unknown }).code ?? (err as Error).name }, '[AD 對帳] 失敗');
      }
    }
    // 換日後清掉舊的記錄
    for (const k of autoSent) if (!k.endsWith(`|${t}`)) autoSent.delete(k);
    const keep = new Set(window());
    for (const d of lastAuto.keys()) if (!keep.has(d)) lastAuto.delete(d);
  }

  return { reconcile, window, backfill, run };
}
