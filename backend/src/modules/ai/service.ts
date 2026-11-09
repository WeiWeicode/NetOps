/**
 * AI 分析、問答(由舊版 server/routes/ai.js 搬移,IMPL-PLAN A1、ARCHITECTURE D23;整理筆記與翻譯依 2026-11-09 決定不搬,D25)
 *   流程與送給模型的內容同舊版:期間內 PA 摘要 → 精簡文字(只送統計與彙整,不送原始 log;AGENT.md §7.4)
 *   問答:問題有 IP / Port → 先查連線組合統計,沒有統計的檔案才從 FTP 串流掃描(原始 log 不落地),彙整後送給模型
 *   事件(SSE):meta、scan(掃描進度)、evidence(查到的資料)、events(PA 其他 log)、ad(AD 事件)、notes(帶入的知識庫筆記)、
 *              thinking、content、done(見 docs/API.md §10)
 * 與舊版不同:資料不完整要明確標示(AGENT.md §5):meta / evidence 帶 missing(摘要讀不到的檔案數),
 *   notes 帶 vectorError(向量庫失敗,改用關鍵字 / IP 比對);路由驗證與 SSE 由 routes.ts、sse.ts 負責。
 */
import type { FtpConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import type { Ftp, FtpStream } from '../../infra/ftp/index.js';
import { LlmError, type ChatMessage, type Llm } from '../../infra/llm/index.js';
import { accountsIn, eventIdsIn, isAdQuestion } from '../ad/core/ad-ai.js';
import type { AdImporter } from '../ad/importer.js';
import { notesForAi } from '../kb/core/ai-notes.js';
import type { KbService } from '../kb/service.js';
import type { EventImporter } from '../pa-events/importer.js';
import { queryFlows } from '../pa/core/flows.js';
import { ipMatcher, mergeSummaries } from '../pa/core/palog.js';
import { scanFiles } from '../pa/core/scan.js';
import type { TrafficImporter } from '../pa/importer.js';
import { ASK_PROMPT, buildContext, EVENT_Q, kbSection, SYSTEM_PROMPT } from './core/context.js';
import { buildCondition, createCollector, parseQuestion } from './core/evidence.js';
import type { SseStream } from './sse.js';
import { dayOut, logTimeOut } from '../../shared/time.js';

/** 語意搜尋(kb/core/vector.js searchVectors) */
export interface VectorSearch {
  searchVectors(text: string, opts?: { limit?: number; minScore?: number }): Promise<{ id: string; title: string; score: number }[]>;
  vectorStatus(): { error: string };
}

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

type Send = SseStream['send'];
type Merged = ReturnType<typeof mergeSummaries> & { hours: { hour: string }[] };
type Cond = { ips: string[]; ports: number[] };

/** core/scan.js 的型別(同 pa/log-routes.ts) */
type ScanFiles = (
  files: { path: string; name: string; rows?: number }[],
  opts: {
    onRow(rec: Record<string, string | number>, raw: string): boolean | void;
    prefilter: ((line: string) => boolean) | null;
    parallel: number;
    seconds: number;
    isClosed(): boolean;
    onProgress(p: { filesScanned: number; files: number; rows: number }): void;
    openStream(path: string): Promise<FtpStream>;
  },
) => Promise<{ scanned: number; rows: number; filesScanned: number; files: number; seconds: number; stopReason: string }>;
const scan = scanFiles as unknown as ScanFiles;
const collector = createCollector as unknown as () => { add(r: unknown): void; addFlow(f: unknown): void; text(): string; stats(): { n: number; allow: number; block: number; flows: number } };
const condition = buildCondition as unknown as (cond: Cond, from: string, to: string) => { filter(r: unknown, raw: string): boolean; prefilter: ((line: string) => boolean) | null; flowTest(f: unknown): boolean; label: string };
const flowsQuery = queryFlows as unknown as (names: string[], opts: { from: string; to: string; prefilter: ((l: string) => boolean) | null; test(f: unknown): boolean; readFlows(n: string): Promise<string | null> }) => Promise<{ flows: unknown[]; failed: string[] }>;
const forAi = notesForAi as unknown as (notes: unknown[], whole: unknown, max: number, opts: { ips?: string[]; text?: string; vector?: { id: string; score: number }[] }) => { text: string; used: { id: string; title: string; related: boolean }[]; omitted: { id: string; title: string }[] };

export type AiService = ReturnType<typeof createAiService>;

export function createAiService(deps: {
  llm: Llm | null;
  traffic: TrafficImporter;
  events: EventImporter;
  ad: AdImporter;
  kb: KbService;
  vector: VectorSearch;
  ftp: Ftp;
  ftpConfig: FtpConfig | null;
  readFlows(name: string): Promise<string | null>;
  searchSeconds: number;
  kbMaxChars: number;
}) {
  const { traffic, events, ad, kb, vector, ftp } = deps;

  /** AI 未設定(LLM_URL 空白)時回 409:是設定狀態不是故障,回 5xx 會累積 BFF 斷路器失敗 */
  function llmOf(): Llm {
    if (!deps.llm) throw new AppError(409, 'NETOPS_AI_DISABLED', '尚未設定 AI 服務(LLM_URL),無法使用 AI 功能');
    return deps.llm;
  }

  /* ───────── 期間摘要(舊版 summarize) ───────── */

  function summarize(from: string, to: string, topN: number) {
    const files = traffic.filesInRange(from, to);
    const m = mergeSummaries(files.map((f) => traffic.readSummary(f.summary!)).filter(Boolean), topN) as Merged;
    m.hours = m.hours.filter((h) => h.hour.slice(0, 10) >= from && h.hour.slice(0, 10) <= to);
    return m;
  }
  /** 期間內 index 有、摘要檔讀不到的檔案數(分析資料不完整) */
  const missingIn = (from: string, to: string) => traffic.filesInRange(from, to).filter((f) => !traffic.readSummary(f.summary!)).length;
  const context = (from: string, to: string) => buildContext(summarize, from, to) as { text: string; files: number; rows: number } | null;

  /** 知識庫筆記 + 語意搜尋(失敗時 vectorError,改用關鍵字 / IP 比對) */
  async function notes(opts: { ips?: string[]; text: string; query: string }) {
    const before = vector.vectorStatus().error;
    const hits = opts.query ? await vector.searchVectors(opts.query) : [];
    const after = vector.vectorStatus().error;
    const vectorError = Boolean(opts.query) && after !== '' && after !== before;
    return { ...forAi(kb.listNotes(), kb.compilation(), deps.kbMaxChars, { ips: opts.ips ?? [], text: opts.text, vector: hits }), vectorError };
  }

  /* ───────── 期間整體分析 ───────── */

  /** 驗證(串流開始前,錯誤回 4xx):沒有已分析的 log 回 404 */
  function prepareAnalysis(from: string, to: string) {
    llmOf();
    const ctx = context(from, to);
    if (!ctx) throw new AppError(404, 'NETOPS_PA_NO_DATA', '這段期間沒有已分析的 log,請先到「FTP Log 檔案」同步');
    return ctx;
  }

  async function analyze(s: SseStream, input: { from: string; to: string; think: boolean; question: string }, ctx: { text: string; files: number; rows: number }) {
    const llm = llmOf();
    const { from, to, think, question } = input;
    let text = ctx.text;
    // PA 其他類型 log(威脅、URL、GlobalProtect…)的期間摘要一起分析
    const ev = events.eventsContext(from, to, { topN: 8 });
    if (ev) text += `\n\n${ev}`;
    const model = await llm.model();
    // 向量庫語意搜尋(有輸入問題時):跟問題意思相近的筆記一起排到前面
    const kbNotes = await notes({ text: `${question}\n${text}`, query: question });
    s.send('meta', { model, from: dayOut(from), to: dayOut(to), files: ctx.files, missing: missingIn(from, to), rows: ctx.rows, contextChars: text.length, notes: kbNotes.used, vectorError: kbNotes.vectorError });
    const ask = question ? `\n\n使用者另外想了解：${question}\n請在「整體結論」之後先用「## 針對提問」章節回答這個問題，再依規則完成其餘章節。` : '';
    await streamAnswer(s, llm, think, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `以下是 PA 防火牆 log 的統計摘要，請依規則分析。${ask}\n\n${text}${kbSection(kbNotes)}` },
    ]);
  }

  /* ───────── 問答:依問題中的 IP / Port 查 log ───────── */

  /** 同樣的條件 10 分鐘內不重複掃描(追問時直接沿用;同舊版,所有人共用) */
  const evidenceCache = new Map<string, { at: number; info: Record<string, unknown>; text: string }>();

  /** AI 掃描的排隊:一次一個;等候時送 scan 狀態,使用者中斷時離開隊伍 */
  let scanning: Promise<void> = Promise.resolve();
  async function scanSlot(s: SseStream, label: string): Promise<() => void> {
    let release!: () => void;
    const prev = scanning;
    scanning = new Promise<void>((r) => (release = r));
    // 200 毫秒內輪不到就告訴使用者在排隊
    const timer = setTimeout(() => s.send('scan', { label, waiting: true, filesScanned: 0, files: 0, matched: 0 }), 200);
    await Promise.race([prev, new Promise<void>((r) => s.signal.addEventListener('abort', () => r(), { once: true }))]);
    clearTimeout(timer);
    // 中斷時仍要等前一個結束才放行下一個,隊伍不會亂
    if (s.signal.aborted) {
      void prev.then(release);
      return () => {};
    }
    return release;
  }

  /** 對話紀錄:最近 6 則,每則最多 4000 字(同舊版) */
  const historyOf = (h: HistoryItem[] = []) => h.filter((m) => ['user', 'assistant'].includes(m?.role) && m.content).slice(-6).map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  /** 驗證(串流開始前):沒有已分析的 log、也不是 AD 問題時回 404 */
  function prepareQuestion(input: { from: string; to: string; question: string; history?: HistoryItem[]; source?: 'pa' | 'ad' }) {
    llmOf();
    const { from, to, question } = input;
    const history = historyOf(input.history);
    // 這次問題沒有 IP / Port 時,沿用前面問題的條件(追問)
    let cond = parseQuestion(question) as Cond;
    if (!cond.ips.length && !cond.ports.length) {
      for (const m of [...history].reverse()) {
        if (m.role !== 'user') continue;
        const c = parseQuestion(m.content) as Cond;
        if (c.ips.length || c.ports.length) {
          cond = c;
          break;
        }
      }
    }
    // source = 'ad':AD 網域的 AI 問答,只看 AD 事件記錄,不掃描防火牆 log
    const adOnly = input.source === 'ad';
    // AD 相關問題(帳號、登入、DNS、Kerberos、事件 ID…);追問沒寫關鍵字時看上一題
    const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
    const eventIds = [...new Set([...eventIdsIn(question), ...(adOnly ? eventIdsIn(lastUser) : [])])];
    const adQ = adOnly || isAdQuestion(question) || eventIds.length > 0 || (!cond.ips.length && !cond.ports.length && isAdQuestion(lastUser));
    const files = adOnly ? [] : traffic.filesInRange(from, to);
    if (!files.length && !adQ) throw new AppError(404, 'NETOPS_PA_NO_DATA', '這段時間沒有已分析的 log 檔,請先到「FTP Log 檔案」同步');
    return { history, cond, adOnly, lastUser, eventIds, adQ, files };
  }

  async function ask(s: SseStream, input: { from: string; to: string; question: string; think: boolean }, p: ReturnType<typeof prepareQuestion>) {
    const llm = llmOf();
    const { from, to, question, think } = input;
    const { history, cond, adOnly, lastUser, eventIds, adQ, files } = p;
    const closed = () => s.signal.aborted;
    const model = await llm.model();
    s.send('meta', { model, from: logTimeOut(from), to: logTimeOut(to), files: files.length, ips: cond.ips, ports: cond.ports, source: adOnly ? 'ad' : 'pa' });

    let evidence = '';
    if ((cond.ips.length || cond.ports.length) && files.length) {
      const key = JSON.stringify([cond, from, to]);
      let hit = evidenceCache.get(key);
      if (!hit || Date.now() - hit.at > 600000) {
        const { filter, prefilter, flowTest, label } = condition(cond, from, to);
        const col = collector();
        const t0 = Date.now();
        // 有連線組合統計的檔案直接查統計(快),沒有的(還沒重新分析 / 組合太多)才從 FTP 掃原始 log
        const withFlows = files.filter((f) => f.flows);
        let fq: { flows: unknown[]; failed: string[]; truncated?: boolean } = { flows: [], failed: [] };
        if (withFlows.length) {
          s.send('scan', { label, filesScanned: 0, files: files.length, matched: 0, mode: 'flows' });
          fq = await flowsQuery(withFlows.map((f) => f.flows!), { from, to, prefilter, test: flowTest, readFlows: deps.readFlows });
          for (const f of fq.flows) col.addFlow(f);
        }
        const failed = new Set(fq.failed);
        const toScan = files.filter((f) => !f.flows || failed.has(f.flows));
        const flowFiles = withFlows.length - failed.size;
        if (closed()) return;
        s.send('scan', { label, filesScanned: flowFiles, files: files.length, matched: col.stats().n });
        let r = { filesScanned: 0, files: 0, rows: 0, seconds: 0 };
        // 與舊版不同(審查修正):AI 問答的 FTP 掃描全系統同時只跑 1 個(FTP 連線與匯入、明細查詢共用,測試區只有 1 條),其餘排隊
        const release = toScan.length ? await scanSlot(s, label) : () => {};
        if (closed()) return release();
        try {
          if (toScan.length)
            r = await scan(toScan, {
              prefilter,
              parallel: deps.ftpConfig?.maxConnections ?? 1,
              seconds: deps.searchSeconds,
              isClosed: closed,
              onRow: (rec, raw) => {
                if (filter(rec, raw)) col.add(rec);
              },
              onProgress: (pr) => s.send('scan', { label, ...pr, filesScanned: flowFiles + pr.filesScanned, files: files.length, matched: col.stats().n }),
              openStream: (path) => ftp.openStream(path, { signal: s.signal }),
            });
        } catch (err) {
          if (closed()) return;
          // FTP 錯誤訊息已分類(不含主機與原始錯誤,API.md §8)
          throw err instanceof AppError ? new AppError(err.status, err.code, `掃描 log 失敗:${err.message}`) : err;
        } finally {
          release();
        }
        if (closed()) return;
        const st = col.stats();
        const partial =
          (r.filesScanned < r.files ? `（掃描逾時，FTP 只掃了 ${r.filesScanned} / ${r.files} 個 log 檔，資料不完整）` : '') +
          // 與舊版不同(審查修正):符合的連線組合太多時只取前 20 萬列(pa/core/flows.js queryFlows)
          (fq.truncated ? '（符合的連線組合太多，只取前 20 萬列，資料不完整）' : '');
        const seconds = Math.round((Date.now() - t0) / 100) / 10;
        const how = [
          flowFiles ? `${flowFiles} 個檔案查連線組合統計（同一小時、同一組合已累計，時間以小時為單位，沒有逐筆範例）` : '',
          r.files ? `${r.filesScanned} / ${r.files} 個檔案從 FTP 掃原始 log（${r.rows.toLocaleString('en-US')} 列）` : '',
        ]
          .filter(Boolean)
          .join('；');
        hit = {
          at: Date.now(),
          info: { label, matched: st.n, allow: st.allow, block: st.block, flows: st.flows, filesScanned: flowFiles + r.filesScanned, files: files.length, flowFiles, rows: r.rows, seconds, partial: Boolean(partial) },
          text: `## 系統查詢條件：${label}\n時間 ${from} ~ ${to}；${how}${partial}\n\n${col.text()}`,
        };
        // 資料不完整的結果不快取(審查修正;舊版會快取),追問時重新查
        if (!partial) {
          if (evidenceCache.size > 20) evidenceCache.delete(evidenceCache.keys().next().value!);
          evidenceCache.set(key, hit);
        }
      }
      s.send('evidence', { ...hit.info, cached: hit.at < Date.now() - 1000 });
      evidence = hit.text;
    } else if (!adQ) {
      // 沒有 IP / Port:改用期間的統計摘要
      const ctx = context(from.slice(0, 10), to.slice(0, 10));
      s.send('evidence', { label: '問題中沒有 IP / Port，改用期間的整體統計', summary: true, files: ctx?.files ?? 0, missing: missingIn(from.slice(0, 10), to.slice(0, 10)) });
      evidence = `## 問題中沒有 IP 或 Port，以下是 ${from.slice(0, 10)} ~ ${to.slice(0, 10)} 的整體統計摘要\n\n${ctx?.text ?? '（沒有資料）'}`;
    }

    const dFrom = from.slice(0, 10);
    const dTo = to.slice(0, 10);

    // PA 其他類型 log:問題有 IP → 這些 IP 的紀錄;沒有 IP 但問到威脅 / VPN / 網站等 → 期間摘要
    if (!adOnly) {
      let ev = '';
      if (cond.ips.length) {
        const ms = cond.ips.map(ipMatcher).filter(Boolean) as ((ip: string) => boolean)[];
        const r = events.eventsForIps(from, to, (ip) => ms.some((m) => m(ip)));
        if (r.text) s.send('events', { hits: r.hits });
        ev = r.text;
      } else if (EVENT_Q.test(question) || (!cond.ports.length && EVENT_Q.test(lastUser))) {
        ev = events.eventsContext(dFrom, dTo);
        if (ev) s.send('events', { summary: true });
      }
      if (ev) evidence = [evidence, ev].filter(Boolean).join('\n\n');
    }

    // AD 事件記錄:AD 相關問題整段帶入;問題有 IP 時,AD 事件中出現該 IP 才帶入
    const adHit = !adQ && cond.ips.some((ip) => !ip.includes('/') && ad.search(dFrom, dTo, { ip }).rows.length > 0);
    if (adQ || adHit) {
      const accounts = [...new Set([...accountsIn(question), ...(adOnly && !accountsIn(question).length ? accountsIn(lastUser) : [])])];
      const adText = ad.adContext(dFrom, dTo, { ips: cond.ips.filter((ip) => !ip.includes('/')), eventIds, accounts, full: adQ });
      s.send('ad', { label: adText ? `AD 事件記錄 ${dFrom}${dTo !== dFrom ? ` ~ ${dTo}` : ''}` : '這段時間沒有已匯入的 AD 事件記錄', total: adText ? ad.eventsInRange(dFrom, dTo).length : 0 });
      evidence = [evidence, adText || '## AD 事件記錄\n（這段時間沒有已匯入的 AD 事件記錄，請到「AD 事件記錄」頁從 FTP 同步）'].filter(Boolean).join('\n\n');
    }

    const kbNotes = await notes({ ips: cond.ips, text: `${question}\n${evidence}`, query: question });
    s.send('notes', { used: kbNotes.used, omitted: kbNotes.omitted, vectorError: kbNotes.vectorError });
    if (closed()) return;

    await streamAnswer(s, llm, think, [
      { role: 'system', content: ASK_PROMPT },
      ...history,
      { role: 'user', content: `${question}\n\n---\n以下是系統從防火牆 log / AD 事件記錄查到的資料：\n\n${evidence}${kbSection(kbNotes)}` },
    ]);
  }

  /** 模型串流 → SSE:thinking、content、done(同舊版 streamChat) */
  async function streamAnswer(s: SseStream, llm: Llm, think: boolean, messages: ChatMessage[]) {
    for await (const e of llm.stream({ messages, think, signal: s.signal })) {
      if (e.type === 'thinking') s.send('thinking', { chars: e.chars });
      else if (e.type === 'content') s.send('content', { text: e.text });
      else s.send('done', { finish: e.finish, truncated: e.finish === 'length' });
    }
  }

  async function status() {
    if (!deps.llm) return { enabled: false, ok: false, model: '', message: '尚未設定 AI 服務(LLM_URL)' };
    try {
      return { enabled: true, ok: true, model: await deps.llm.model(), message: '' };
    } catch (err) {
      // 不回主機位址(舊版回 config.llm.url)
      // 不回主機位址與上游原文:LlmError 的訊息是分類過的,其他錯誤只回固定文字
      return { enabled: true, ok: false, model: '', message: `無法連線 AI 服務:${err instanceof LlmError ? err.message : '回應格式錯誤'}` };
    }
  }

  return { enabled: () => Boolean(deps.llm), requireEnabled: () => void llmOf(), prepareAnalysis, analyze, prepareQuestion, ask, status, summarize };
}

