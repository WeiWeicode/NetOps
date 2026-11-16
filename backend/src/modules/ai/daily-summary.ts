/**
 * AI 每日摘要排程(IMPL-PLAN AC7;ARCHITECTURE D44 ②;docs/API.md §10.4):
 *   每天自動對帳(NETOPS_RECON_TIME,預設 08:10)與每日同步(AC1)之後,自動產生「前一天」的 AI 摘要,經 infra/store 存檔,流量總覽顯示。
 *
 * 規則:
 *   - 觸發:對帳每一輪之後(recon 的 after)呼叫 kick();**不等 AI 回答**(背景跑),AI 主機無法使用時不影響對帳與同步。
 *   - 等每日同步這一輪結束(done / gave-up / 未啟用)才產生;同一時間只跑一個。
 *   - 失敗重試一次(下一次 kick 且距上次失敗 RETRY_GAP_MS 以上),仍失敗存成 failed,畫面標示「今天的摘要產生失敗」。
 *     done / failed 都存檔,重新啟動後不重做;重試次數只在記憶體(重新啟動後最多再試 2 次)。
 *   - 日誌只寫錯誤代碼與日期,不寫摘要內容(含 IP 與姓名,AQ2 不可寫進日誌)。
 * 狀態:status(day?) 給 GET /ai/daily-summary。
 */
import { AppError } from '../../errors.js';
import { LlmError } from '../../infra/llm/index.js';
import { taipeiDayStartMs, taipeiText } from '../../shared/time.js';

/** 第一次失敗後至少隔多久再試(對帳每 10 分鐘一輪) */
export const DAILY_SUMMARY_RETRY_GAP_MS = 10 * 60_000;
/** 一天最多試幾次(第一次 + 重試一次) */
export const DAILY_SUMMARY_MAX_TRIES = 2;
/** 畫面可選的日子最多列幾天 */
const LIST_MAX = 30;

/** 產生的結果(service.dailySummary) */
export interface DailySummaryResult {
  text: string;
  model: string;
  /** 資料不完整(對帳缺口、尚未對帳、前一期取不到等) */
  partial: boolean;
  /** 送給模型的資料超過上限,後面的排行已省略 */
  clipped: boolean;
  contextChars: number;
  /** 前一天的流量連線數與四類安全事件筆數(畫面顯示用,不含 IP) */
  counts: { sessions: number | null; threat: number | null; url: number | null; data: number | null; wildfire: number | null };
}

/** 存檔內容(palogs/ai-daily/YYYYMMDD.json) */
export interface DailySummaryRecord {
  /** 摘要的日期(台灣時間,YYYY-MM-DD) */
  day: string;
  state: 'done' | 'failed';
  tries: number;
  /** 完成或最後一次失敗的時間(ISO) */
  at: string;
  result: DailySummaryResult | null;
  /** 失敗原因(只放分類過的訊息,不放上游原文) */
  error: { code: string; message: string } | null;
}

/** disabled 未啟用;waiting 等對帳 / 每日同步;running 產生中;retrying 第一次失敗,稍後重試;done 完成;failed 重試後仍失敗 */
export type DailySummaryState = 'disabled' | 'waiting' | 'running' | 'retrying' | 'done' | 'failed';

export interface DailySummaryStatus {
  enabled: boolean;
  /** 每天幾點開始(同對帳,HH:MM);未啟用時 null */
  at: string | null;
  /** 今天要產生的是哪一天(前一天,YYYY-MM-DD) */
  target: string;
  /** target 的狀態 */
  state: DailySummaryState;
  /** target 的失敗原因(state = retrying / failed) */
  error: { code: string; message: string } | null;
  /** 要看的那一天:指定 day 時是那一天,否則最近一份完成的摘要;沒有時 null */
  summary: DailySummaryRecord | null;
  /** 有存檔的日子(新的在前,最多 30 天;含 failed) */
  days: { day: string; state: 'done' | 'failed' }[];
}

export interface DailySummaryStore {
  saveAiDaily(day: string, value: unknown): void;
  readAiDaily<T>(day: string): T | null;
  listAiDaily(): string[];
}

type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

export interface DailySummaryScheduler {
  /** 對帳每一輪之後呼叫:條件符合時在背景產生,不等結果、不丟出 */
  kick(): void;
  /** 測試用:跑一輪並等結果 */
  run(): Promise<void>;
  status(day?: string): DailySummaryStatus;
}

/** 分類過的錯誤(存檔與畫面用):AppError 的訊息本來就是給使用者看的;LlmError 是分類訊息;其他只留固定文字 */
export function summaryError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  if (err instanceof LlmError) return { code: 'NETOPS_AI_UNAVAILABLE', message: `AI 服務無法使用:${err.message}` };
  return { code: 'NETOPS_AI_DAILY_FAILED', message: '產生摘要時發生錯誤(細節見服務日誌)' };
}

const compact = (day: string) => day.replace(/-/g, '');
const dashed = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

export function createDailySummary({
  enabled,
  at,
  generate,
  store,
  ready,
  log,
  now = Date.now,
  signal,
}: {
  /** NETOPS_AI_DAILY_SUMMARY 開著、有 LLM_URL、有自動對帳 */
  enabled: boolean;
  /** 對帳開始時間(當天第幾分鐘;-1 = 不自動) */
  at: number;
  /** 產生某一天(YYYY-MM-DD)的摘要 */
  generate(day: string): Promise<DailySummaryResult>;
  store: DailySummaryStore;
  /** 每日同步(AC1)這一輪已結束(完成、停止重試或未啟用) */
  ready(): boolean;
  log: Log;
  now?: () => number;
  /** 服務關閉時中斷:中斷造成的失敗不算次數、不存檔(下次啟動重做) */
  signal?: AbortSignal;
}): DailySummaryScheduler {
  let memDay = '';
  let tries = 0;
  let lastFailMs = 0;
  let lastError: { code: string; message: string } | null = null;
  let running = false;

  const today = () => taipeiText(now()).slice(0, 10).replace(/\//g, '-');
  const yesterday = () => taipeiText(taipeiDayStartMs(today()) - 86_400_000).slice(0, 10).replace(/\//g, '-');
  const read = (day: string): DailySummaryRecord | null => {
    try {
      return store.readAiDaily<DailySummaryRecord>(compact(day));
    } catch {
      return null;
    }
  };

  async function run() {
    if (!enabled || running || signal?.aborted) return;
    const day = yesterday();
    if (memDay !== day) {
      memDay = day;
      tries = 0;
      lastFailMs = 0;
      lastError = null;
    }
    if (read(day) || !ready()) return;
    if (tries >= DAILY_SUMMARY_MAX_TRIES || (tries > 0 && now() - lastFailMs < DAILY_SUMMARY_RETRY_GAP_MS)) return;
    running = true;
    tries++;
    try {
      const result = await generate(day);
      store.saveAiDaily(compact(day), { day, state: 'done', tries, at: new Date(now()).toISOString(), result, error: null } satisfies DailySummaryRecord);
      lastError = null;
      log.info({ day, tries, partial: result.partial, chars: result.text.length }, 'AI 每日摘要已產生');
    } catch (err) {
      if (signal?.aborted) {
        tries--;
        return;
      }
      lastFailMs = now();
      lastError = summaryError(err);
      // 只記錯誤代碼(不記內容與上游原文)
      if (tries >= DAILY_SUMMARY_MAX_TRIES) {
        try {
          store.saveAiDaily(compact(day), { day, state: 'failed', tries, at: new Date(lastFailMs).toISOString(), result: null, error: lastError } satisfies DailySummaryRecord);
        } catch (e) {
          log.warn({ day, code: (e as { code?: unknown }).code }, 'AI 每日摘要:失敗紀錄存檔失敗');
        }
        log.warn({ day, tries, code: lastError.code }, 'AI 每日摘要重試後仍失敗,今天不再自動產生');
      } else {
        log.warn({ day, tries, code: lastError.code }, 'AI 每日摘要產生失敗,稍後重試一次');
      }
    } finally {
      running = false;
    }
  }

  function kick() {
    run().catch((err: unknown) => log.warn({ code: (err as { code?: unknown }).code }, 'AI 每日摘要發生錯誤'));
  }

  function status(day?: string): DailySummaryStatus {
    const target = yesterday();
    const rec = read(target);
    let days: { day: string; state: 'done' | 'failed' }[] = [];
    try {
      days = store
        .listAiDaily()
        .slice(0, LIST_MAX)
        .map((d) => ({ day: dashed(d), state: read(dashed(d))?.state ?? 'failed' }));
    } catch {
      days = [];
    }
    const fresh = memDay === target;
    const state: DailySummaryState = rec
      ? rec.state
      : !enabled
        ? 'disabled'
        : running && fresh
          ? 'running'
          : fresh && tries > 0
            ? 'retrying'
            : 'waiting';
    const latestDone = days.find((d) => d.state === 'done');
    const summary = day ? read(day) : latestDone ? read(latestDone.day) : null;
    return {
      enabled,
      at: enabled && at >= 0 ? `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}` : null,
      target,
      state,
      error: rec ? rec.error : state === 'retrying' ? lastError : null,
      summary,
      days,
    };
  }

  return { kick, run, status };
}
