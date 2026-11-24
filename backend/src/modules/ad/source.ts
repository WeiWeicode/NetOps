/**
 * AD 事件查詢來源(AD-3;docs/AD-AGENT-PLAN.md §5 第 3 點、ARCHITECTURE D49):NETOPS_AD_SOURCE=ftp(預設,本機 adlogs/*.json)或 clickhouse(netops.ad_events)。
 * 總覽、明細、匯出、AI 問答都經這裡,切換只看設定;兩邊回傳同樣的形狀(事件另加 dcDomain、source、logEpoch,ftp 來源為 ''、'ftp'、null)。
 * 新條件(兩種來源都支援):computer(DC,比對時忽略大小寫與網域後段)、dcDomain、ipRanges(IP 對照表名稱反查)。
 * ClickHouse 失敗 → 503 NETOPS_CLICKHOUSE_UNAVAILABLE(不改查 FTP,同 D43)。
 */
import { AppError } from '../../errors.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import type { AdChEvent, AdChFilter, AdChReader, AdOverview } from '../../infra/clickhouse/ad-reader.js';
import { taipeiDayStartMs, taipeiTimeMs } from '../../shared/time.js';
import { adContextFromSummary as adContextFromSummaryJs } from './core/ad-ai.js';
import { buildAdFilter, summarizeAd } from './core/adlog.js';
import type { AdEvent, AdFilter, AdImporter } from './importer.js';

const DAY_MS = 86_400_000;

/** core/ad-ai.js 的型別(JS 推斷的參數型別太窄) */
const adContextFromSummary = adContextFromSummaryJs as unknown as (
  s: AdOverview,
  o: { computers: string[]; secEmpty: boolean; from: string; to: string; ips: string[]; eventIds: number[]; accounts: string[]; full: boolean; match: AdChEvent[]; matchTotal: number },
) => string;

export interface AdQuery extends AdFilter {
  computer?: string;
  dcDomain?: string;
  ipRanges?: [string, string][];
}

/** 回應的事件:AdEvent + DC 網域、來源、世代 */
export type AdOutEvent = AdEvent & { dcDomain: string; source: string; logEpoch: number | null };

export interface AdDayOut {
  /** 'yyyy/MM/dd' */
  day: string;
  events: number;
  /** ftp:匯入的檔案;clickhouse:沒有 */
  files?: { name: string; channel?: string; rows: number }[];
  importedAt?: string;
  /** clickhouse:Agent / FTP 補寫各幾筆、有哪些 DC */
  agent?: number;
  ftp?: number;
  computers?: string[];
}

export interface AdAiOptions {
  ips?: string[];
  eventIds?: number[];
  accounts?: string[];
  full?: boolean;
}

export interface AdQuerySource {
  kind: 'ftp' | 'clickhouse';
  days(): Promise<AdDayOut[]>;
  /** 日期期間('yyyy/MM/dd')的統計(summarizeAd 同形狀)與有資料的天數 */
  overview(from: string, to: string): Promise<{ summary: AdOverview; days: number }>;
  /** 時間期間('yyyy/MM/dd HH:mm',含 to 那一分鐘);新的在前 */
  search(from: string, to: string, q: AdQuery, offset: number, limit: number): Promise<{ items: AdOutEvent[]; total: number; scanned: number }>;
  /** AI:期間內 AD 事件的文字(沒有資料回 '')與總筆數 */
  aiContext(from: string, to: string, opts: AdAiOptions): Promise<{ text: string; total: number }>;
  /** AI:期間內 AD 事件有沒有出現這個 IP */
  hasIp(from: string, to: string, ip: string): Promise<boolean>;
}

/** DC 名稱比對用:去掉網域後段、轉大寫(FTP CSV 的 Computer 是 MachineName,可能是 FQDN) */
export const dcKey = (computer: string): string => String(computer ?? '').trim().split('.')[0]!.toUpperCase();

const ipNum = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((x) => x > 255) ? null : ((p[0]! * 256 + p[1]!) * 256 + p[2]!) * 256 + p[3]!;
};

/** ftp 來源的 computer / dcDomain / ipRanges 條件(純函式) */
export function extraFilter(q: AdQuery): (e: AdEvent) => boolean {
  const tests: ((e: AdEvent) => boolean)[] = [];
  if (q.computer) {
    const k = dcKey(q.computer);
    tests.push((e) => dcKey(e.computer) === k);
  }
  if (q.dcDomain) {
    const d = q.dcDomain.toLowerCase();
    tests.push((e) => e.computer.toLowerCase().endsWith(`.${d}`));
  }
  if (q.ipRanges) {
    const r = q.ipRanges.map(([a, b]) => [ipNum(a), ipNum(b)] as const).filter((x): x is readonly [number, number] => x[0] !== null && x[1] !== null);
    tests.push((e) => {
      const n = ipNum(e.ip ?? '');
      return n !== null && r.some(([a, b]) => n >= a && n <= b);
    });
  }
  return (e) => tests.every((t) => t(e));
}

const outFtp = (e: AdEvent): AdOutEvent => ({ ...e, dcDomain: '', source: 'ftp', logEpoch: null });
const outCh = (e: AdChEvent): AdOutEvent => {
  const { dcDomain, source, logEpoch, ...rest } = e;
  return { ...rest, dcDomain, source, logEpoch };
};

/** 'yyyy/MM/dd HH:mm'(含那一分鐘)→ [fromMs, toMs) */
export const minuteRangeMs = (from: string, to: string): [number, number] => [taipeiTimeMs(from), taipeiTimeMs(to) + 60_000];
/** 'yyyy/MM/dd' → [fromMs, toMs) */
export const dayRangeMs = (from: string, to: string): [number, number] => [taipeiDayStartMs(from), taipeiDayStartMs(to) + DAY_MS];
/** AI 用的期間:'yyyy/MM/dd' 或 'yyyy/MM/dd HH:mm'(同 importer eventsInRange 的規則) */
export const anyRangeMs = (from: string, to: string): [number, number] => [
  from.length > 10 ? taipeiTimeMs(from) : taipeiDayStartMs(from.slice(0, 10)),
  to.length > 10 ? taipeiTimeMs(to) + 60_000 : taipeiDayStartMs((to || from).slice(0, 10)) + DAY_MS,
];

export function createFtpAdSource(ad: AdImporter): AdQuerySource {
  return {
    kind: 'ftp',
    async days() {
      return ad.days();
    },
    async overview(from, to) {
      return { summary: ad.summary(from, to) as AdOverview, days: ad.daysInRange(from, to) };
    },
    async search(from, to, q, offset, limit) {
      const all = ad.eventsInRange(from, to);
      const base = buildAdFilter(q) as (e: AdEvent) => boolean;
      const extra = extraFilter(q);
      const rows = all.filter((e) => base(e) && extra(e));
      return { items: rows.slice(offset, offset + limit).map(outFtp), total: rows.length, scanned: all.length };
    },
    async aiContext(from, to, opts) {
      const text = ad.adContext(from, to, opts);
      return { text, total: text ? ad.eventsInRange(from, to).length : 0 };
    },
    async hasIp(from, to, ip) {
      return ad.search(from, to, { ip }).rows.length > 0;
    },
  };
}

/** ClickHouse 失敗 → 503(AD 用的訊息;日誌只記代碼) */
export const adChUnavailable = (cause?: unknown) =>
  Object.assign(new AppError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', 'AD 事件資料庫(ClickHouse)暫時無法使用,請稍後再試'), cause ? { cause } : {});

async function via<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ClickHouseError) throw adChUnavailable({ code: err.code, status: err.status });
    throw err;
  }
}

export function createChAdSource(reader: AdChReader): AdQuerySource {
  const filter = (q: AdQuery, fromMs: number, toMs: number): AdChFilter => ({
    fromMs,
    toMs,
    channel: q.channel,
    level: q.level,
    eventId: q.eventId,
    q: q.q,
    account: q.account,
    ip: q.ip,
    issueOnly: q.issueOnly,
    computer: q.computer,
    dcDomain: q.dcDomain,
    ipRanges: q.ipRanges,
  });
  return {
    kind: 'clickhouse',
    days: () =>
      via(async () =>
        (await reader.days()).map((d) => ({ day: d.day, events: d.events, agent: d.agent, ftp: d.ftp, computers: d.computers })),
      ),
    overview: (from, to) =>
      via(async () => {
        const [fromMs, toMs] = dayRangeMs(from, to);
        const [summary, days] = await Promise.all([reader.overview(fromMs, toMs, 30), reader.days()]);
        return { summary, days: days.filter((d) => d.day >= from && d.day <= to).length };
      }),
    search: (from, to, q, offset, limit) =>
      via(async () => {
        const [fromMs, toMs] = minuteRangeMs(from, to);
        const r = await reader.search(filter(q, fromMs, toMs), offset, limit);
        return { items: r.rows.map(outCh), total: r.total, scanned: r.scanned };
      }),
    aiContext: (from, to, opts) =>
      via(async () => {
        const [fromMs, toMs] = anyRangeMs(from, to);
        const s = await reader.overview(fromMs, toMs, 20);
        if (!s.total) return { text: '', total: 0 };
        const ips = opts.ips ?? [];
        const eventIds = opts.eventIds ?? [];
        const accounts = opts.accounts ?? [];
        const [computers, m] = await Promise.all([reader.computers(fromMs, toMs), reader.aiMatches(fromMs, toMs, { ips, eventIds, accounts }, 25)]);
        const text = adContextFromSummary(s, {
          computers: computers.map((c) => c.computer),
          secEmpty: !s.byChannel.Security,
          from,
          to,
          ips,
          eventIds,
          accounts,
          full: opts.full ?? true,
          match: m.rows,
          matchTotal: m.total,
        });
        return { text, total: s.total };
      }),
    hasIp: (from, to, ip) =>
      via(async () => {
        const [fromMs, toMs] = anyRangeMs(from, to);
        return reader.hasIp(fromMs, toMs, ip);
      }),
  };
}

/** 測試與 ftp 來源共用:events → summarizeAd(同 ClickHouse overview 的形狀) */
export const summarizeEvents = (events: AdEvent[], topN = 30) => summarizeAd(events, topN) as AdOverview;
