/**
 * FTP 與 ClickHouse 每日對帳(C3;ARCHITECTURE D33、手冊 §11.2、§12 CQ10)。
 *   - FTP 每小時筆數:已分析的 FTP 摘要的 hours(同一份 log 的 Receive Time;不另外掃 FTP,不增加 FTP 負載)
 *   - ClickHouse 每小時筆數:每小時彙總表 pa_traffic_hourly_app
 *   - 差異 = (FTP − ClickHouse) / FTP;> 0.5% 為缺口(gap),< −0.5% 為多出(excess,可能重複)
 *   - FTP 前一天的匯出檔還沒同步、分析完時整天標 pending(不判斷缺口);ClickHouse 開始收資料之前的小時不對帳
 * 結果存資料目錄(infra/store,palogs/ch/recon/),不新增 ClickHouse 表(C3 不動表設計)。
 * 補漏(手動,netops.ftp.write)交給 netops-ingest:只補 seqno 不在 ClickHouse 的列(ingest/backfill.ts)。
 */
import type { ClickHouseReader } from '../../infra/clickhouse/reader.js';
import type { PaStore } from '../../infra/store/index.js';
import { HOUR_MS, taipeiDayStartMs, taipeiHourKey, taipeiText } from '../../shared/time.js';
import type { ChSummaryBuilder } from './ch-summary.js';
import type { TrafficImporter } from './importer.js';

/** 差異門檻(C3 完成條件:誤差 < 0.5%) */
export const RECON_THRESHOLD = 0.005;

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
  hour,
  now = Date.now,
}: {
  traffic: TrafficImporter;
  reader: ClickHouseReader;
  builder: ChSummaryBuilder;
  store: PaStore;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  hour: number;
  now?: () => number;
}): Reconciler {
  let timer: NodeJS.Timeout | null = null;
  let lastAuto = '';

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
    // 這一天的 FTP 資料已完整:隔天也有分析完的檔案(PA 匯出檔依時間接續)、沒有讀不到的摘要、沒有在分析中(程式碼審查 #5)
    const next = nextDay(day);
    const reachesNext = traffic.filesInRange(next, next).length > 0;
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

  async function auto() {
    const t = now();
    const today = taipeiText(t).slice(0, 10);
    if (Number(taipeiText(t).slice(11, 13)) < hour || lastAuto === today) return;
    lastAuto = today;
    // 前 3 天:前一天第一次對帳;再前兩天補 FTP 晚到或補漏後的結果
    for (let i = 1; i <= 3; i++) {
      const day = taipeiText(taipeiDayStartMs(today) - i * 86_400_000).slice(0, 10);
      try {
        const r = await reconcile(day);
        if (r.status === 'gap') log.warn({ day, gaps: r.gaps }, 'FTP 對帳:ClickHouse 有缺口(需要補漏)');
        else log.info({ day, status: r.status, excess: r.excess }, 'FTP 對帳完成');
      } catch (err) {
        lastAuto = '';
        log.warn({ day, code: (err as { code?: unknown }).code }, 'FTP 對帳失敗,下次再試');
        return;
      }
    }
  }

  return {
    reconcile,
    list(from, to) {
      const out: ReconDay[] = [];
      for (let d = to; d >= from; d = taipeiText(taipeiDayStartMs(d) - 86_400_000).slice(0, 10)) {
        const r = store.readRecon<ReconDay>(dayId(d));
        if (r) out.push(r);
      }
      return out;
    },
    addBackfill(day, id) {
      const r = store.readRecon<ReconDay>(dayId(day));
      if (!r) return;
      r.backfills = [...(r.backfills ?? []), id].slice(-20);
      store.saveRecon(dayId(day), r);
    },
    filesForHour(hourMs) {
      const a = taipeiText(hourMs).slice(0, 16);
      const b = taipeiText(hourMs + HOUR_MS - 60_000).slice(0, 16);
      return traffic.filesInRange(a, b).map((f) => f.path);
    },
    start() {
      if (hour < 0 || timer) return;
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
