/**
 * AI 分析、問答、外部 IP 學習的 ClickHouse 資料來源(IMPL-PLAN AC2、ARCHITECTURE D44;取代 FTP 摘要與 FTP 原始 log 掃描)。
 * 送給模型的文字格式沿用 FTP 版(buildContext、evidence.js 的 collector、paevents.js 的 aggText),只換資料來源:
 *
 *   期間分析(最長 92 天)
 *     - 最近 rawDays 天(= min(每小時摘要天數, 原始 TRAFFIC 保留天數);正式區 30、測試區 3):
 *       ClickHouse 原始 log 建的每小時摘要(pa/ch-summary.ts),排行與 FTP 摘要相同
 *     - 更早的部分:每天彙總(pa_heat_1d:連線數、阻擋、位元組、威脅嚴重度)+ 每小時彙總(App、區域、動作 13 個月;來源 IP 90 天),
 *       併成一份「粗的摘要」一起合併,另外附每天一列;meta 的 grain 標示粒度,畫面註明「超過 30 天的資料較粗」
 *     - 威脅、URL、資料過濾、WildFire:最近 rawDays 天用每小時摘要;更早(威脅保留 90 天內)用原始威脅表依組合累計前幾名
 *     - 解密、GlobalProtect、User-ID 不進 ClickHouse,仍讀本機 FTP 摘要(AC1 每天同步)
 *   問答
 *     - 有 IP / Port:原始 TRAFFIC(保留期限內)依連線組合與小時累計 + 最多 15 筆範例紀錄;威脅類(保留期限內)依組合累計
 *     - 超過保留期限的部分不查,文字與 evidence 的 skipped 明確標示(查無紀錄不等於沒有發生,AGENT.md §5)
 *   外部 IP 學習:最近 N 天(上限 30)的每小時摘要(原始 TRAFFIC 建的),排行同 FTP 摘要,不新增彙總表
 *
 * ClickHouse 未設定或連不上:回 503 NETOPS_CLICKHOUSE_UNAVAILABLE(串流開始前由路由回;開始後以 error 事件),不改用 FTP(同 D43)。
 * 只送統計與彙整;IP 與使用者帳號不遮罩(AQ2,模型在公司內部 AI 主機);錯誤只記代碼,不把 log 內容寫進日誌。
 */
import { AppError } from '../../errors.js';
import type { AiCond, AiDayRow, AiFlowRow, AiThreatRow, ClickHouseReader, LogRecord, TopRow } from '../../infra/clickhouse/reader.js';
import { CH_EVENT_TYPES } from '../../infra/clickhouse/reader.js';
import { taipeiDayStartMs, taipeiText, taipeiTimeMs } from '../../shared/time.js';
import { checkCoverage, dataDays, unavailable, viaClickHouse, type ChOverviewDeps } from '../pa/ch-overview.js';
import type { ChSummaryBuilder } from '../pa/ch-summary.js';
import { mergeSummaries } from '../pa/core/palog.js';
import { aggText, EVENT_TYPES, mergeEventSummaries } from '../pa-events/core/paevents.js';
import type { EventImporter } from '../pa-events/importer.js';
import { buildContext } from './core/context.js';
import { buildCondition, createCollector } from './core/evidence.js';

/** AI 的資料來源(NETOPS_AI_SOURCE):正式區在 C6 之前沿用 ftp(需求方 2026-11-13 AQ4「Keep old path」) */
export type AiSource = 'clickhouse' | 'ftp';

const DAY = 86_400_000;
/** 不進 ClickHouse、仍讀本機 FTP 摘要的類型 */
export const FTP_EVENT_TYPES = ['decryption', 'globalprotect', 'userid'] as const;
/** 問答:連線組合(每小時一列)最多讀幾列;超過時標示資料不完整 */
export const FLOW_LIMIT = 20_000;
/** 問答:範例紀錄最多幾筆(D25 ③、需求方 2026-11-13「保留 15 筆」) */
export const SAMPLE_LIMIT = 15;
/** 問答:威脅類組合最多讀幾列 */
const THREAT_LIMIT = 5_000;
/** 分析:超過 rawDays 的威脅類只列前幾種組合 */
const OLD_THREAT_TOP = 30;
/** 排行一律用上限算(同 ch-overview TOP_MAX),buildContext 再截 */
const TOP_MAX = 100;

type Summary = Record<string, unknown>;
type Merged = ReturnType<typeof mergeSummaries> & { files: number; rows: number; timeMin: string; timeMax: string; hours: { hour: string }[] };
type EventDef = { label: string; dims: [string, string, (r: LogRecord) => unknown][] };
const DEFS = EVENT_TYPES as unknown as Record<string, EventDef>;
const collector = createCollector as unknown as () => { addFlow(f: unknown): void; text(): string; stats(): { n: number; allow: number; block: number; flows: number } };
const condition = buildCondition as unknown as (cond: AiCond, from: string, to: string) => { label: string };
const context = buildContext as unknown as (
  summarize: (from: string, to: string, topN: number) => Merged,
  from: string,
  to: string,
  opts: { source(s: Merged): string },
) => { text: string; files: number; rows: number } | null;
const mergeEvents = mergeEventSummaries as unknown as (type: string, list: unknown[], topN: number) => {
  rows: number;
  timeMin: string;
  timeMax: string;
  kpis: { title: string; items: { key: string; n: number }[] }[];
  tops: { title: string; items: { key: string; n: number }[] }[];
};
const agg = aggText as unknown as (type: string, rows: unknown[][], limit?: number) => { total: number; kinds: number; text: string };

const num = (n: number) => (Number(n) || 0).toLocaleString('en-US');
const ymd = (ms: number) => taipeiText(ms).slice(0, 10);
/** API 輸出的日期 YYYY-MM-DD */
const isoDay = (ms: number) => ymd(ms).replace(/\//g, '-');
/** [fromMs, toMs) → 'yyyy/MM/dd ~ yyyy/MM/dd'(toMs 不含) */
const dayText = (a: number, b: number) => `${ymd(a)} ~ ${ymd(b - 1)}`;
const minuteText = (ms: number) => taipeiText(ms).slice(0, 16);
function bytes(n: number) {
  let v = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(1) : v}${u[i]}`;
}

/** 粒度(日期 YYYY-MM-DD):detail = 每小時摘要(原始 log 建的);coarse = 每天 / 每小時彙總(較粗) */
export interface Grain {
  detail: { from: string; to: string } | null;
  coarse: { from: string; to: string } | null;
  /** 每小時摘要涵蓋最近幾天(正式區 30) */
  rawDays: number;
}

export type ChAiSource = ReturnType<typeof createChAiSource>;

export function createChAiSource(deps: {
  reader: ClickHouseReader | null;
  builder: ChSummaryBuilder | null;
  events: EventImporter;
  /** 原始表保留天數(TRAFFIC、威脅類) */
  ttlDays: { traffic: number; threat: number };
  /** 每小時摘要建幾天(NETOPS_CH_SUMMARY_DAYS) */
  summaryDays: number;
  log: { warn(o: object, m: string): void };
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const rawDays = Math.max(1, Math.min(deps.summaryDays, deps.ttlDays.traffic));
  const ovDeps = { reader: deps.reader, builder: deps.builder, cache: null as unknown as ChOverviewDeps['cache'], log: deps.log } satisfies ChOverviewDeps;

  function need() {
    if (!deps.reader || !deps.builder) throw unavailable();
    return { reader: deps.reader, builder: deps.builder };
  }
  /** 今天(台灣時間)00:00 */
  const todayStart = () => taipeiDayStartMs(ymd(now()));
  /** 每小時摘要(細)的起點:今天往前 rawDays 天(含今天)的 00:00;之前的改用彙總 */
  const detailStart = () => todayStart() - (rawDays - 1) * DAY;
  /** 原始表還有資料的起點(TTL) */
  const rawStart = (kind: 'traffic' | 'threat') => now() - deps.ttlDays[kind] * DAY;

  /* ───────── 期間分析 ───────── */

  interface Part {
    list: unknown[];
    /** 粗的摘要(彙總),沒有資料為 null */
    coarse: Summary | null;
    days: AiDayRow[];
    missing: number;
    state: 'ok' | 'not-ready' | 'stale';
    detail: [number, number] | null;
    coarseRange: [number, number] | null;
  }

  /** 彙總 → 一份粗的摘要(格式同 FTP 摘要,mergeSummaries 可直接合併;沒有的排行留空) */
  function coarseSummary(days: AiDayRow[], tops: { actions: Record<string, number>; app: TopRow[]; zone: TopRow[]; src: TopRow[]; blockSrc: TopRow[] }): Summary | null {
    const rows = days.reduce((s, d) => s + d.sessions, 0);
    if (!rows) return null;
    const sum = (k: keyof AiDayRow) => days.reduce((s, d) => s + d[k], 0);
    const block = sum('deny');
    const has = days.filter((d) => d.sessions > 0);
    return {
      rows,
      allow: rows - block,
      block,
      bytes: sum('bytes'),
      sent: sum('sent'),
      recv: sum('recv'),
      timeMin: `${ymd(has[0]!.day)} 00:00:00`,
      timeMax: `${ymd(has.at(-1)!.day)} 23:59:59`,
      hours: {},
      actions: tops.actions,
      top: { app: tops.app, zone: tops.zone, src: tops.src, blockSrc: tops.blockSrc },
      scan: [],
    };
  }

  /** 一段日期期間 [fromMs, toMs) 的資料:細的部分讀每小時摘要,粗的部分讀彙總 */
  async function loadPart(fromMs: number, toMs: number): Promise<Part> {
    const { reader, builder } = need();
    const split = detailStart();
    const detail: [number, number] | null = toMs > Math.max(fromMs, split) ? [Math.max(fromMs, split), toMs] : null;
    const coarseRange: [number, number] | null = fromMs < split ? [fromMs, Math.min(toMs, split)] : null;
    const part: Part = { list: [], coarse: null, days: [], missing: 0, state: 'ok', detail, coarseRange };
    if (detail) {
      const r = await builder.summaries('traffic', detail[0], detail[1]);
      Object.assign(part, { list: r.list, missing: r.missing, state: r.state });
    }
    if (coarseRange) {
      const [days, tops] = await Promise.all([reader.aiDays(coarseRange[0], coarseRange[1]), reader.aiTops(coarseRange[0], coarseRange[1], TOP_MAX)]);
      part.days = days;
      part.coarse = coarseSummary(days, tops);
    }
    return part;
  }

  const merge = (p: Part, topN: number) => mergeSummaries(p.coarse ? [...p.list, p.coarse] : p.list, topN) as unknown as Merged;

  /** 超過 rawDays 的期間:每天一列(連線數、阻擋、流量、威脅嚴重度) */
  function coarseSection(p: Part) {
    if (!p.coarseRange || !p.days.length) return '';
    const [a, b] = p.coarseRange;
    return [
      `\n## 超過 ${rawDays} 天的期間 ${dayText(a, b)}：每天彙總（資料較粗）`,
      `這段期間的原始 log 已超過保留期限，只有每天 / 每小時彙總：上面的排行只含動作、App、區域流向與來源 IP（被擋最多的來源 IP 只算到 90 天內），沒有目的 IP、Port、規則、國家、結束原因、資料外流、AI 應用與疑似掃描，也沒有逐小時統計。判斷時要說明這段資料較粗。`,
      '（日期｜連線數｜阻擋｜流量｜送出｜接收｜威脅 critical / high / medium）',
      ...p.days.map((d) => `- ${ymd(d.day)}｜${num(d.sessions)}｜${num(d.deny)}｜${bytes(d.bytes)}｜${bytes(d.sent)}｜${bytes(d.recv)}｜${num(d.critical)} / ${num(d.high)} / ${num(d.medium)}`),
    ].join('\n');
  }

  /**
   * 期間分析的 TRAFFIC 資料(串流開始前呼叫:ClickHouse 失敗回 503、沒有資料回 404、整段超過保留期限回 404 NETOPS_PA_OUT_OF_RETENTION)。
   * from / to 為 'yyyy/MM/dd'。回傳 buildContext 的文字(另附超過 rawDays 的每天彙總)與 meta 用的粒度、完整度
   */
  async function analysisContext(from: string, to: string) {
    need();
    const fromMs = taipeiDayStartMs(from);
    const toMs = taipeiDayStartMs(to) + DAY;
    const cov = await checkCoverage(ovDeps, 'traffic', fromMs, toMs);
    return viaClickHouse(async () => {
      const span = toMs - fromMs;
      const [cur, prev] = await Promise.all([loadPart(fromMs, toMs), loadPart(fromMs - span, fromMs)]);
      const pFrom = ymd(fromMs - span);
      // buildContext 是同步的:先讀好目前與前一段期間,summarize 只做合併
      const summarize = (f: string, _t: string, topN: number) => {
        const p = f === from ? cur : f === pFrom ? prev : null;
        if (!p) return mergeSummaries([], topN) as unknown as Merged;
        const m = merge(p, topN);
        m.hours = m.hours.filter((h) => h.hour.slice(0, 10) >= f && h.hour.slice(0, 10) <= _t);
        return m;
      };
      const describe = () =>
        [cur.list.length ? `ClickHouse 每小時摘要 ${cur.list.length} 小時` : '', cur.coarse ? `每天彙總 ${cur.days.filter((d) => d.sessions).length} 天（較粗）` : ''].filter(Boolean).join('＋') || 'ClickHouse';
      const ctx = context(summarize, from, to, { source: describe });
      if (!ctx) throw new AppError(404, 'NETOPS_PA_NO_DATA', '這段期間 ClickHouse 沒有 PA log 資料');
      const notes = [
        cur.missing ? `（注意：有 ${num(cur.missing)} 小時的每小時摘要還沒建好，排行可能不完整）` : '',
        cur.state !== 'ok' ? '（注意：每小時摘要尚未更新完成，排行可能不完整）' : '',
        cov.partial ? `（注意：期間開始早於 ClickHouse 最早的資料 ${cov.coverage.from}，之前沒有資料）` : '',
      ].filter(Boolean);
      const grain: Grain = {
        detail: cur.detail ? { from: isoDay(cur.detail[0]), to: isoDay(cur.detail[1] - 1) } : null,
        coarse: cur.coarseRange ? { from: isoDay(cur.coarseRange[0]), to: isoDay(cur.coarseRange[1] - 1) } : null,
        rawDays,
      };
      return {
        text: [ctx.text, coarseSection(cur), notes.join('\n')].filter(Boolean).join('\n'),
        rows: ctx.rows,
        hours: cur.list.length,
        days: cur.days.filter((d) => d.sessions).length,
        missing: cur.missing,
        state: cur.state,
        grain,
        coverage: cov.coverage,
        partial: cov.partial,
      };
    });
  }

  /* ───────── PA 其他類型 log ───────── */

  /** 一種類型的期間摘要文字(同 pa-events importer eventsContext) */
  function eventLines(type: string, m: ReturnType<typeof mergeEvents>, topN: number, note = '') {
    const lines = [`### ${DEFS[type]!.label}（${type}）：${num(m.rows)} 筆，${m.timeMin} ~ ${m.timeMax}${note}`];
    for (const k of m.kpis) lines.push(`- ${k.title}：${k.items.slice(0, 8).map((x) => `${x.key} ${num(x.n)}`).join('、')}`);
    for (const tp of m.tops) if (tp.items.length) lines.push(`- ${tp.title}：${tp.items.slice(0, topN).map((x) => `${x.key}（${num(x.n)}）`).join('、')}`);
    return lines.join('\n');
  }

  /** 威脅類累計列 → aggText 的列([小時, ...dims, 次數, 最早, 最晚]) */
  const aggRows = (type: string, rows: AiThreatRow[]) =>
    rows.map((r) => [r.first.slice(0, 13), ...DEFS[type]!.dims.map(([, , fn]) => String(fn(r) ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 120)), r.n, r.first, r.last]);

  /** FTP 摘要的文字去掉標題(合併到同一節) */
  const body = (text: string) => text.replace(/^## [^\n]*\n\n/, '');

  /**
   * 期間內 PA 其他類型 log 的摘要(分析、問答沒有 IP 時):from / to 為 'yyyy/MM/dd'。
   * 威脅類最近 rawDays 天讀每小時摘要;更早(保留期限內)的威脅列前幾種組合;解密、GlobalProtect、User-ID 讀 FTP 摘要
   */
  async function eventsContext(from: string, to: string, topN = 10) {
    const { reader, builder } = need();
    const fromMs = taipeiDayStartMs(from);
    const toMs = taipeiDayStartMs(to) + DAY;
    const split = detailStart();
    const out: string[] = [];
    await viaClickHouse(async () => {
      if (toMs > Math.max(fromMs, split)) {
        for (const type of CH_EVENT_TYPES) {
          const { list, missing } = await builder.summaries(type, Math.max(fromMs, split), toMs);
          const m = mergeEvents(type, list, topN);
          if (m.rows) out.push(eventLines(type, m, topN, `${fromMs < split ? `（${dayText(Math.max(fromMs, split), toMs)}）` : ''}${missing ? `（${num(missing)} 小時的摘要還沒建好，可能不完整）` : ''}`));
        }
      }
      const oldFrom = Math.max(fromMs, rawStart('threat'));
      const oldTo = Math.min(toMs, split);
      if (oldFrom < oldTo) {
        const r = await reader.aiThreatGroups(['threat'], { ips: [], ports: [] }, oldFrom, oldTo, OLD_THREAT_TOP);
        if (r.rows.length) {
          const a = agg('threat', aggRows('threat', r.rows), OLD_THREAT_TOP);
          out.push(`### 威脅（threat）${dayText(oldFrom, oldTo)}（超過 ${rawDays} 天，只列次數最多的 ${OLD_THREAT_TOP} 種組合）\n${a.text}`);
        }
      }
      if (fromMs < rawStart('threat')) out.push(`（${ymd(fromMs)} ~ ${ymd(rawStart('threat'))} 超過威脅類原始 log 保留期限（${deps.ttlDays.threat} 天），沒有威脅明細，只有每天彙總的嚴重度筆數）`);
    });
    const ftp = deps.events.eventsContext(from, to, { types: [...FTP_EVENT_TYPES], topN });
    if (ftp) out.push(body(ftp));
    return out.length ? `## PA 其他 log 摘要（${from} ~ ${to}）\n\n${out.join('\n\n')}` : '';
  }

  /* ───────── 問答 ───────── */

  /** 串流開始前:ClickHouse 未設定或連不上回 503;TRAFFIC 與威脅類都沒有任何資料回 404 */
  async function prepareQuestion() {
    need();
    const [t, e] = await Promise.all([dataDays(ovDeps, 'traffic'), dataDays(ovDeps, 'threat')]);
    if (!t.length && !e.length) throw new AppError(404, 'NETOPS_PA_NO_DATA', 'ClickHouse 目前還沒有 PA log 資料');
  }

  /** 範例紀錄(同 evidence.js 的範例格式) */
  const sampleLine = (r: LogRecord) =>
    `- ${r.time}｜${r.action}｜${r.src}:${r.sport} → ${r.dst}:${r.dport}/${r.proto}｜${r.app}｜規則 ${r.rule}｜${r.fromZone}→${r.toZone}｜${r.endReason}｜送 ${r.sent}B 收 ${r.recv}B 封包 ${r.packets}${r.srcUser ? `｜使用者 ${r.srcUser}` : ''}${r.category && r.category !== 'any' ? `｜URL 類別 ${r.category}` : ''}`;

  /**
   * 問題有 IP / Port:原始 TRAFFIC 的連線組合統計與範例(from / to 為 'yyyy/MM/dd HH:mm',含結束那一分鐘)。
   * 超過保留期限的部分不查並標示;符合的組合超過 FLOW_LIMIT 時只取前面的,標示 partial
   */
  async function trafficEvidence(cond: AiCond, from: string, to: string, signal?: AbortSignal) {
    const { reader } = need();
    const fromMs = taipeiTimeMs(from);
    const toMs = taipeiTimeMs(to) + 60_000;
    const start = Math.max(fromMs, rawStart('traffic'));
    const { label } = condition(cond, from, to);
    const t0 = now();
    const col = collector();
    let samples: LogRecord[] = [];
    let truncated = false;
    if (start < toMs) {
      const [flows, smp] = await viaClickHouse(() => Promise.all([reader.aiTrafficFlows(cond, start, toMs, FLOW_LIMIT, signal), reader.aiTrafficSamples(cond, start, toMs, SAMPLE_LIMIT, signal)]));
      for (const f of flows.rows as AiFlowRow[]) col.addFlow(f);
      samples = smp;
      truncated = flows.truncated;
    }
    const st = col.stats();
    const skipped = start > fromMs ? { from: minuteText(fromMs), to: minuteText(Math.min(start, toMs)) } : null;
    const notes = [
      skipped ? `（${skipped.from} ~ ${skipped.to} 超過原始 TRAFFIC 保留期限（${deps.ttlDays.traffic} 天），這段沒有資料可查，不代表沒有連線）` : '',
      truncated ? `（符合的連線組合太多，只取次數最多的 ${num(FLOW_LIMIT)} 列，資料不完整）` : '',
    ].join('');
    const seconds = Math.round((now() - t0) / 100) / 10;
    const sampleText = samples.length ? `\n\n### 範例紀錄（每種連線組合一筆，最新的在前，最多 ${SAMPLE_LIMIT} 筆）\n${samples.map(sampleLine).join('\n')}` : '';
    return {
      info: {
        label,
        source: 'clickhouse' as const,
        matched: st.n,
        allow: st.allow,
        block: st.block,
        flows: st.flows,
        samples: samples.length,
        from: start < toMs ? minuteText(start) : '',
        to: minuteText(toMs - 60_000),
        skipped,
        seconds,
        partial: truncated,
      },
      text: `## 系統查詢條件：${label}\n時間 ${from} ~ ${to}；查 ClickHouse 原始 TRAFFIC（同一小時、同一組合已累計）${notes}\n\n${col.text()}${sampleText}`,
      cacheable: !truncated,
    };
  }

  /**
   * 問題有 IP:PA 其他 log 中與這些 IP 相關的紀錄(同 importer eventsForIps 的文字;只比對 IP,不比對 Port)。
   * 威脅類查 ClickHouse(保留期限內);解密、GlobalProtect、User-ID 讀 FTP 摘要
   */
  async function eventsForIps(ips: string[], from: string, to: string, test: (ip: string) => boolean, signal?: AbortSignal) {
    const { reader } = need();
    const fromMs = taipeiTimeMs(from);
    const toMs = taipeiTimeMs(to) + 60_000;
    const start = Math.max(fromMs, rawStart('threat'));
    const parts: string[] = [];
    const hits: { type: string; label: string; total: number; kinds: number }[] = [];
    let truncated = false;
    if (start < toMs) {
      const r = await viaClickHouse(() => reader.aiThreatGroups(CH_EVENT_TYPES, { ips, ports: [] }, start, toMs, THREAT_LIMIT, signal));
      truncated = r.truncated;
      for (const type of CH_EVENT_TYPES) {
        const rows = r.rows.filter((x) => x.type === type);
        if (!rows.length) continue;
        const a = agg(type, aggRows(type, rows));
        hits.push({ type, label: DEFS[type]!.label, total: a.total, kinds: a.kinds });
        parts.push(`### ${DEFS[type]!.label}（${type}）：${num(a.total)} 次、${a.kinds} 種組合${truncated ? '（組合太多，只取次數最多的部分，可能不完整）' : ''}\n${a.text}`);
      }
    }
    if (start > fromMs) parts.push(`（${minuteText(fromMs)} ~ ${minuteText(Math.min(start, toMs))} 超過威脅類原始 log 保留期限（${deps.ttlDays.threat} 天），這段沒有查）`);
    const ftp = deps.events.eventsForIps(from, to, test, FTP_EVENT_TYPES);
    if (ftp.text) parts.push(body(ftp.text));
    hits.push(...ftp.hits);
    return { text: hits.length || parts.length ? `## PA 其他 log（威脅 / URL / 資料過濾 / WildFire / 解密 / GlobalProtect / User-ID）中與問題 IP 相關的紀錄\n\n${parts.join('\n\n')}` : '', hits };
  }

  /* ───────── 外部 IP 學習 ───────── */

  /** 最近 days 天(含今天)的每小時摘要(原始 TRAFFIC 建的;iplearn 的 recentSummaries) */
  async function recentSummaries(days: number) {
    const { builder } = need();
    const fromMs = todayStart() - (days - 1) * DAY;
    const { list } = await viaClickHouse(() => builder.summaries('traffic', fromMs, now()));
    return { summaries: list, from: ymd(fromMs), to: ymd(now()), files: list.length };
  }

  return { rawDays, analysisContext, eventsContext, prepareQuestion, trafficEvidence, eventsForIps, recentSummaries };
}
