/**
 * 明細查詢頁的網址條件(總覽頁點選帶進來,或重新整理後還原):
 *   from / to:YYYY-MM-DD(整天)或 YYYY-MM-DDTHH:mm(本地時間);舊版 YYYY/MM/DD HH:mm 也接受。
 *   其他條件只收白名單內的 key,字串去頭尾空白、最長 200 字;格式不符的直接略過(不送 API、不放進畫面以外的地方)。
 * 送 API 時轉成 ISO 8601 並固定 +08:00:PA、AD 的 log 時間都是設備當地(台灣)時間(docs/API.md §1),與瀏覽器時區無關。
 */
import type { LocationQuery } from 'vue-router';

export const MAX_COND = 200;

/** 「2026-11-02」「2026-11-02T08:30」「2026/11/02 08:30」→ datetime-local 的值(YYYY-MM-DDTHH:mm);end 時整天補 23:59 */
export function toLocalInput(v: unknown, end = false): string {
  if (typeof v !== 'string') return '';
  const m = v.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!m) return '';
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? (end ? 23 : 0)), Number(mi ?? (end ? 59 : 0)));
  if (Number.isNaN(date.getTime()) || date.getMonth() !== Number(mo) - 1) return '';
  return `${y}-${mo}-${d}T${h ?? (end ? '23' : '00')}:${mi ?? (end ? '59' : '00')}`;
}

/** datetime-local 的值 → ISO 8601(固定 +08:00,例 2026-11-02T08:30:00+08:00);格式錯誤回空字串 */
export function localToIso(v: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? `${v.slice(0, 16)}:00+08:00` : '';
}

/** 依白名單取出網址條件;check 回 false 的值略過 */
export function pickQuery<K extends string>(
  q: LocationQuery,
  keys: readonly K[],
  check: Partial<Record<K, (v: string) => boolean>> = {},
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const raw = q[k];
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v || v.length > MAX_COND) continue;
    if (check[k] && !check[k]!(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 是否由本系統其他頁點選進來(vue-router 的 history.state.back 有值):是才自動查詢;
 * 外部連結或直接開網址只填入條件,由使用者按「查詢」,避免一個連結就以使用者身分送出大範圍查詢(稽核也會記在他名下)。
 */
export const cameFromApp = (): boolean => typeof window !== 'undefined' && !!(window.history.state as { back?: unknown } | null)?.back;

/** Port:數字以逗號分隔(docs/API.md §4.3) */
export const isPorts = (v: string) => /^\d{1,5}(\s*,\s*\d{1,5})*$/.test(v);

/** 事件 ID:數字以逗號分隔 */
export const isEventIds = (v: string) => /^\d{1,6}(\s*,\s*\d{1,6})*$/.test(v);

/**
 * 網址帶了 Log 明細查詢頁不支援的威脅類條件(本頁只查 TRAFFIC;時段明細抽屜的威脅類會帶 type=THREAT、threat、severity):
 * 回傳要提示「未套用」的文字,沒有則空字串(AGENT §5:不靜默忽略)。
 * 頁面要在進頁時算一次:自動查詢會用 router.replace 改寫網址(只留本頁條件),跟著網址算提示會馬上消失(C7 第二輪)
 */
export function ignoredThreatCond(q: LocationQuery): string {
  const parts: string[] = [];
  if (q.type === 'THREAT') parts.push('類型 THREAT');
  if (typeof q.threat === 'string' && q.threat) parts.push(`威脅名稱「${q.threat}」`);
  if (typeof q.severity === 'string' && q.severity) parts.push(`嚴重度 ${q.severity}`);
  return parts.join('、');
}
