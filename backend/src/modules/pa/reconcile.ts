/**
 * FTP 與 ClickHouse 每日對帳(C3;ARCHITECTURE D33、手冊 §11.2、§12 CQ10)。
 *   - FTP 每小時筆數:已分析的 FTP 摘要的 hours(同一份 log 的 Receive Time;不另外掃 FTP,不增加 FTP 負載)
 *   - ClickHouse 每小時筆數:每小時彙總表 pa_traffic_hourly_app
 *   - 差異 = (FTP − ClickHouse) / FTP;> 0.5% 為缺口(gap),< −0.5% 為多出(excess,可能重複)
 *   - FTP 前一天的匯出檔還沒同步、分析完時整天標 pending(不判斷缺口);ClickHouse 開始收資料之前的小時不對帳
 * 結果存資料目錄(infra/store,palogs/ch/recon/),不新增 ClickHouse 表(C3 不動表設計)。
 * 補漏交給 netops-ingest:只補 seqno 不在 ClickHouse 的列(ingest/backfill.ts)。手動(POST /pa/backfills,netops.ftp.write),
 * 或自動對帳發現缺口時自動送出(需求方 2026-11-13 決定;createdBy = AUTO_BACKFILL_OWNER,NETOPS_RECON_AUTO_BACKFILL=0 關閉)。
 * FTP 只保留 10 天(NETOPS_FTP_RETENTION_DAYS):保留期限內有缺口的日子每天自動重試,超過期限仍有缺口記 warn。
 * 每一輪自動對帳之後接著跑 after(AC1 每日同步解密 / GlobalProtect / User-ID / AD,modules/ftp/daily-sync.ts)。
 */
import type { ClickHouseReader } from '../../infra/clickhouse/reader.js';
import type { BackfillHour, BackfillQueue } from '../../infra/redis/backfill.js';
import type { PaStore } from '../../infra/store/index.js';
import { HOUR_MS, taipeiDayStartMs, taipeiHourKey, taipeiText } from '../../shared/time.js';
import type { ChSummaryBuilder } from './ch-summary.js';
import type { TrafficImporter } from './importer.js';

/** 差異門檻(C3 完成條件:誤差 < 0.5%) */
export const RECON_THRESHOLD = 0.005;
/** 自動補漏工作的建立者(人送的是 emp:… / sub:…) */
export const AUTO_BACKFILL_OWNER = 'system:recon';
/** 同一天每天最多自動送幾次補漏(補完仍有缺口時不無限重送) */
export const AUTO_BACKFILL_MAX = 3;
/** 補漏完成後多等多久才再送(每小時彙總與摘要要時間追上,避免剛補完就重送;程式碼審查) */
export const AUTO_BACKFILL_SETTLE_MS = 20 * 60_000;

export type ReconHourStatus = 'ok' | 'gap' | 'excess' | 'ftp-missing';

export interface ReconHour {
  /** 'yyyy/MM/dd HH'(核心格式;API 轉 ISO) */
  hour: string;
  ftp: number;
  ch: number;
  /** (FTP − ClickHouse) / FTP;FTP 為 0 時 null */
  diff: number | null;
  status: ReconHourStatus;
}

export interface ReconDay {
  /** 'yyyy/MM/dd' */
  day: string;
  checkedAt: string;
  /** ok:沒有缺口;gap:有缺口;pending:FTP 還沒同步分析完;not-covered:ClickHouse 這天沒有資料 */
  status: 'ok' | 'gap' | 'pending' | 'not-covered';
  ftpFiles: number;
  gaps: number;
  excess: number;
  hours: ReconHour[];
  /** 從這一天建立的補漏工作 id */
  backfills: string[];
}

/** 對帳一天的每小時筆數(純函式):只看 coveredFrom 之後的小時(ClickHouse 開始收資料之前不比) */
export function compareHours(ftp: Map<string, number>, ch: Map<string, number>, coveredFrom: string): ReconHour[] {
  const keys = [...new Set([...ftp.keys(), ...ch.keys()])].filter((k) => k >= coveredFrom).sort();
  return keys.map((hour) => {
    const f = ftp.get(hour) ?? 0;
    const c = ch.get(hour) ?? 0;
    const diff = f ? (f - c) / f : null;
    const status: ReconHourStatus = !f ? 'ftp-missing' : diff! > RECON_THRESHOLD ? 'gap' : diff! < -RECON_THRESHOLD ? 'excess' : 'ok';
    return { hour, ftp: f, ch: c, diff: diff === null ? null : Math.round(diff * 1e6) / 1e6, status };
  });
}

/**
 * 一天的缺口 → 補漏工作的小時與涵蓋的 FTP 檔(手動與自動補漏共用)。
 * want:只補其中幾個小時('yyyy/MM/dd HH');noFiles = 找不到已分析 FTP 檔的缺口小時數(這時不能送,否則會「完成」但什麼都沒補)
 */
export function planBackfill(rec: ReconDay, filesForHour: (hourMs: number) => string[], want?: Set<string>): { hours: BackfillHour[]; noFiles: number } {
  const gaps = rec.hours.filter((h) => h.status === 'gap' && (!want || want.has(h.hour)));
  const hours = gaps.map((h) => {
    const ms = taipeiDayStartMs(h.hour.slice(0, 10)) + Number(h.hour.slice(11, 13)) * HOUR_MS;
    return { hour: ms, files: filesForHour(ms) };
  });
  return { hours, noFiles: hours.filter((h) => !h.files.length).length };
}

const dayId = (day: string) => day.replace(/\//g, '');
const nextDay = (day: string) => taipeiText(taipeiDayStartMs(day) + 86_400_000).slice(0, 10);

export interface Reconciler {
  /** 對帳一天('yyyy/MM/dd')並存檔;ClickHouse 失敗丟 ClickHouseError */
  reconcile(day: string): Promise<ReconDay>;
  /** 已存的對帳結果(期間內,新的在前) */
  list(from: string, to: string): ReconDay[];
  /** 記下從這一天建立的補漏工作 */
  addBackfill(day: string, id: string): void;
  /** 某小時涵蓋的 FTP 檔案(已分析的;補漏用) */
  filesForHour(hourMs: number): string[];
  start(): void;
  stop(): void;
}

export function createReconciler({
  traffic,
  reader,
  builder,
  store,
  log,
  at,
  backfill = { queue: null, enabled: false, retentionDays: 10 },
  after,
  now = Date.now,
}: {
  traffic: TrafficImporter;
  reader: ClickHouseReader;
  builder: ChSummaryBuilder;
  store: PaStore;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  /** 每天幾點幾分(台灣時間,當天的第幾分鐘)開始自動對帳;-1 = 不自動 */
  at: number;
  /** 自動補漏:queue 為 null 或 enabled = false 時不送;retentionDays = FTP 保留天數 */
  backfill?: { queue: BackfillQueue | null; enabled: boolean; retentionDays: number };
  /** 每一輪自動對帳(到了 at 之後)結束後接著執行(AC1:同步解密 / GlobalProtect / User-ID / AD);錯誤只寫日誌 */
  after?: () => Promise<void>;
  now?: () => number;
}): Reconciler {
  let timer: NodeJS.Timeout | null = null;
  /** 今天的自動對帳已完成(不是 pending)的日期;換日清空 */
  let doneDay = '';
  let done = new Set<string>();
  let lastSyncAt = 0;
  let running = false;
  /** 每天 pending 的次數:超過 MAX_TRIES(10 分鐘一次,約 20 小時)就不再自動重試 */
  const tries = new Map<string, number>();
  const MAX_TRIES = 120;
  /** 今天已自動送出補漏的次數(依日期);換日清空 */
  let sent = new Map<string, number>();
  /** 今天已記過「超過 FTP 保留期限」warn 的日期;換日清空 */
  let warned = new Set<string>();
  /** 還在排隊或執行中的自動補漏(全系統同時最多 1 個,不佔滿佇列、不擋人工補漏;資安審查) */
  let autoInflight: string | null = null;

  function ftpHours(day: string): { counts: Map<string, number>; files: number; complete: boolean } {
    const files = traffic.filesInRange(day, day);
    const counts = new Map<string, number>();
    let missing = 0;
    for (const f of files) {
      const s = traffic.readSummary(f.summary!) as { hours?: Record<string, { n: number }> } | null;
      if (!s) {
        missing++;
        continue;
      }
      for (const [h, v] of Object.entries(s.hours ?? {})) if (h.startsWith(day)) counts.set(h, (counts.get(h) ?? 0) + v.n);
    }
    // 這一天的 FTP 資料已完整:PA 每天的匯出檔(last_calendar_day)約隔天 07:45 才出現,最後一個檔到 23:5x;
    // 有分析完的檔涵蓋到 23:50 以後(或隔天也有檔)、沒有讀不到的摘要、沒有在分析中才算完整
    const next = nextDay(day);
    const reachesNext = files.some((f) => (f.timeMax ?? '') >= `${day} 23:50`) || traffic.filesInRange(next, next).length > 0;
    return { counts, files: files.length, complete: reachesNext && !missing && !traffic.status().busy };
  }

  async function reconcile(day: string): Promise<ReconDay> {
    const start = taipeiDayStartMs(day);
    const rows = await reader.trafficHours(start, start + 86_400_000);
    const ch = new Map<string, number>();
    for (const r of rows) ch.set(taipeiHourKey(r.hour), (ch.get(taipeiHourKey(r.hour)) ?? 0) + r.n);
    const earliest = (await reader.earliestTrafficHour()) ?? builder.earliest();
    const ftp = ftpHours(day);
    const prev = store.readRecon<ReconDay>(dayId(day));
    const base = { day, checkedAt: new Date(now()).toISOString(), ftpFiles: ftp.files, backfills: prev?.backfills ?? [] };
    if (earliest === null || earliest >= start + 86_400_000) {
      const r: ReconDay = { ...base, status: 'not-covered', gaps: 0, excess: 0, hours: [] };
      store.saveRecon(dayId(day), r);
      return r;
    }
    // ClickHouse 最早那一小時通常只收到一部分(開始收資料的時間不在整點):從下一小時開始比(程式碼審查 #3)
    const hours = compareHours(ftp.counts, ch, taipeiHourKey(Math.max(earliest + HOUR_MS, start)));
    const gaps = hours.filter((h) => h.status === 'gap').length;
    const excess = hours.filter((h) => h.status === 'excess').length;
    const r: ReconDay = { ...base, status: !ftp.complete ? 'pending' : gaps ? 'gap' : 'ok', gaps, excess, hours };
    store.saveRecon(dayId(day), r);
    return r;
  }

  /**
   * 自動對帳(需求方 2026-11-11 決定,ARCHITECTURE D43;2026-11-13 改每天 08:10 起):每天 at(預設 08:10)起對帳前 3 天,
   * 加上 FTP 保留期限內、上次對帳還有缺口的日子。
   * 對帳要的 FTP 分析由這裡自己確保:FTP 檔還沒分析完時先同步(只排 TRAFFIC 檔,30 分鐘最多一次),
   * 之後每 10 分鐘再試,直到不是 pending(PA 前一天的匯出檔約 07:45 才出現在 FTP)。
   * 有缺口時自動送補漏(autoBackfill);補漏排隊 / 執行中、FTP 檔還沒分析、佇列滿或送出失敗時,照 pending 的規則 10 分鐘後再試
   */
  async function auto() {
    // 上一輪還沒結束(FTP 同步或對帳慢)就跳過這一輪(資安審查 L)
    if (running) return;
    running = true;
    try {
      await autoOnce();
      // 對帳這一輪結束後接著每日同步(AC1);對帳失敗也照跑(兩者的 FTP 資料不同)
      if (after && minuteOf(now()) >= at) {
        try {
          await after();
        } catch (err) {
          log.warn({ code: (err as { code?: unknown }).code }, '對帳後的每日同步失敗,下一輪再試');
        }
      }
    } finally {
      running = false;
    }
  }

  /** 台灣時間當天的第幾分鐘 */
  const minuteOf = (t: number) => Number(taipeiText(t).slice(11, 13)) * 60 + Number(taipeiText(t).slice(14, 16));

  const dayAgo = (today: string, i: number) => taipeiText(taipeiDayStartMs(today) - i * 86_400_000).slice(0, 10);

  /**
   * 有缺口的一天自動送補漏;回傳要不要稍後再試(true = 這一天先不標完成)。
   * 上一個補漏還在排隊或執行中:等它(再試);同一天今天已送 AUTO_BACKFILL_MAX 次:不再送(warn)
   */
  async function autoBackfill(day: string, r: ReconDay): Promise<boolean> {
    const { queue, enabled } = backfill;
    if (!enabled || !queue) return false;
    const last = r.backfills.at(-1);
    if (last) {
      try {
        const job = await queue.get(last);
        if (job && (job.state === 'queued' || job.state === 'running')) return true;
        // 剛補完:ClickHouse 每小時彙總可能還沒追上,先等一陣子再判斷要不要重送
        if (job?.state === 'done' && job.finishedAt && now() - Date.parse(job.finishedAt) < AUTO_BACKFILL_SETTLE_MS) return true;
      } catch (err) {
        log.warn({ day, code: (err as { code?: unknown }).code }, 'FTP 對帳:讀不到補漏工作狀態(netops-redis),稍後再試');
        return true;
      }
    }
    // 別的日子的自動補漏還沒做完:先等(自動補漏同時只佔佇列 1 個位置)
    if (autoInflight && autoInflight !== last) {
      try {
        const other = await queue.get(autoInflight);
        if (other && (other.state === 'queued' || other.state === 'running')) return true;
      } catch {
        return true;
      }
      autoInflight = null;
    }
    const n = sent.get(day) ?? 0;
    if (n >= AUTO_BACKFILL_MAX) {
      log.warn({ day, gaps: r.gaps, backfills: n }, `FTP 對帳:今天已自動補漏 ${n} 次仍有缺口,停止自動補漏(可手動補漏或查 netops-ingest 日誌)`);
      return false;
    }
    const plan = planBackfill(r, filesForHour);
    if (!plan.hours.length) return false;
    // 缺口的小時還找不到已分析的 FTP 檔:同 pending,等 FTP 同步分析後再試
    if (plan.noFiles) return true;
    let job;
    try {
      job = await queue.enqueue(day, plan.hours, AUTO_BACKFILL_OWNER);
    } catch (err) {
      log.warn({ day, code: (err as { code?: unknown }).code }, 'FTP 對帳:送出自動補漏失敗(netops-redis),稍後再試');
      return true;
    }
    if (!job) {
      log.info({ day }, 'FTP 對帳:補漏佇列已滿,稍後再送自動補漏');
      return true;
    }
    sent.set(day, n + 1);
    autoInflight = job.id;
    addBackfill(day, job.id);
    log.info({ day, id: job.id, hours: plan.hours.length }, 'FTP 對帳:有缺口,已自動送出補漏');
    return true;
  }

  async function autoOnce() {
    const t = now();
    const today = taipeiText(t).slice(0, 10);
    if (minuteOf(t) < at) return;
    if (doneDay !== today) {
      doneDay = today;
      done = new Set();
      sent = new Map();
      warned = new Set();
    }
    const { retentionDays } = backfill;
    // 前 3 天,加上 FTP 保留期限內上次對帳還有缺口(或 FTP 檔不完整而 pending)的日子:自動補漏開著時,期限內每天再補。
    // 保留期限的最後一天 FTP 檔可能已被刪,所以只到 retentionDays − 1 天前
    const recent = [1, 2, 3].map((i) => dayAgo(today, i));
    const unfinished = (r: ReconDay) => r.status === 'gap' || r.status === 'pending';
    const older = backfill.enabled && backfill.queue ? list(dayAgo(today, retentionDays - 1), dayAgo(today, 4)).filter(unfinished).map((r) => r.day) : [];
    const days = [...recent, ...older].filter((d) => !done.has(d));
    // 超過 FTP 保留期限仍有缺口(或一直沒對完帳):FTP 檔已被刪或即將被刪,無法再補(記 warn,每天一次)
    for (const r of list(dayAgo(today, retentionDays + 7), dayAgo(today, retentionDays))) {
      if (!unfinished(r) || warned.has(r.day)) continue;
      warned.add(r.day);
      log.warn({ day: r.day, status: r.status, gaps: r.gaps, retentionDays }, `FTP 對帳:超過 FTP 保留期限(${retentionDays} 天)仍未補完,無法再從 FTP 補`);
    }
    if (!days.length) return;
    const st = traffic.status();
    // 只有前 3 天的 FTP 檔不完整才同步(較舊的日子 FTP 檔可能已被刪,同步也補不到)
    if (recent.some((d) => !done.has(d) && !ftpHours(d).complete) && !st.busy && t - lastSyncAt > 30 * 60_000) {
      lastSyncAt = t;
      try {
        const r = await traffic.sync();
        if (r.added) log.info({ added: r.added }, 'FTP 對帳:同步 FTP 檔並排入分析');
      } catch (err) {
        log.warn({ code: (err as { code?: unknown }).code }, 'FTP 對帳:同步 FTP 失敗,下次再試');
      }
    }
    for (const day of days) {
      try {
        const r = await reconcile(day);
        const retry = r.status === 'pending' || (r.status === 'gap' && (await autoBackfill(day, r)));
        if (retry) {
          const n = (tries.get(day) ?? 0) + 1;
          tries.set(day, n);
          if (n < MAX_TRIES) continue;
          log.warn({ day, tries: n, status: r.status }, 'FTP 對帳:一直沒有完成(FTP 檔不完整或補漏未完成),停止自動重試(可手動對帳 / 補漏)');
        }
        tries.delete(day);
        done.add(day);
        if (r.status === 'gap') log.warn({ day, gaps: r.gaps }, 'FTP 對帳:ClickHouse 有缺口(需要補漏)');
        else log.info({ day, status: r.status, excess: r.excess }, 'FTP 對帳完成');
      } catch (err) {
        log.warn({ day, code: (err as { code?: unknown }).code }, 'FTP 對帳失敗,下次再試');
        continue;
      }
    }
  }

  function list(from: string, to: string): ReconDay[] {
    const out: ReconDay[] = [];
    for (let d = to; d >= from; d = taipeiText(taipeiDayStartMs(d) - 86_400_000).slice(0, 10)) {
      const r = store.readRecon<ReconDay>(dayId(d));
      if (r) out.push(r);
    }
    return out;
  }

  function addBackfill(day: string, id: string) {
    const r = store.readRecon<ReconDay>(dayId(day));
    if (!r) return;
    r.backfills = [...(r.backfills ?? []), id].slice(-20);
    store.saveRecon(dayId(day), r);
  }

  function filesForHour(hourMs: number): string[] {
    const a = taipeiText(hourMs).slice(0, 16);
    const b = taipeiText(hourMs + HOUR_MS - 60_000).slice(0, 16);
    return traffic.filesInRange(a, b).map((f) => f.path);
  }

  return {
    reconcile,
    list,
    addBackfill,
    filesForHour,
    start() {
      if (at < 0 || timer) return;
      timer = setInterval(() => void auto(), 10 * 60_000);
      timer.unref();
      void auto();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
