/**
 * Gateway BFF 呼叫(全站唯一入口,頁面不直接 fetch):一律經 Gateway web-kit(FRONTEND-GUIDE §6)
 *   - 同網域 /api/...(本系統 /api/netops/* 經 BFF 轉 netops-api),Cookie 由瀏覽器自動帶上,前端不接觸 Token(AGENT.md §7.1)
 *   - 非 GET 自動帶 X-CSRF-Token(gn_csrf);401 先 Refresh 一次,失敗才導向入口網 /login?redirect=...
 *   - 錯誤統一為 ApiError { status, code, message, requestId, details }
 */
import { ApiError, http as kit, readCookie, redirectToLogin, refreshSession, useAuth, type Me, type RequestOptions } from '@giganexus/web-kit';
import { hasIcon } from '@/ui/icons';

export { ApiError, loadMe, logout, useAuth } from '@giganexus/web-kit';

const auth = useAuth();
export const can = (code: string): boolean => auth.can(code);
export const canAll = (codes: readonly string[] | undefined): boolean => !codes || codes.every((c) => auth.can(c));
/** 選單 / 目錄在 BFF 的設定(名稱、上層、排序、圖示) */
export const menuOf = (code: string | undefined) => auth.menuOf(code);
/** 選單 / 頁面 / Tab 名稱:以 BFF 的權限名稱為準(GigaItApp「選單管理」可改名),沒有時用前端預設文字 */
export const menuTitle = (permission: string | undefined, fallback: string): string => auth.nameOf(permission) ?? fallback;
/** 選單 / 頁面圖示:以 BFF 為準(須是 ui/icons.ts 登記的名稱),沒有或不認得時用前端預設 */
export function menuIcon(permission: string | undefined, fallback: string): string {
  const icon = auth.menuOf(permission)?.icon;
  return hasIcon(icon) ? icon : fallback;
}

/** 應用登記(Gateway PRD §8.3.3) */
export interface AppEntry {
  code: string;
  name: string;
  basePath: string;
  icon: string;
}
export type NetopsMe = Me & { apps?: AppEntry[] };

export type Query = Record<string, string | number | boolean | undefined | null>;
export type ApiPath = `/api/${string}`;
type Opts = RequestOptions & { query?: Query };

/** 組查詢字串:略過 undefined / null / 空字串 */
export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams(
    Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return qs ? `${path}?${qs}` : path;
}

export const http = {
  get: <T = unknown>(path: ApiPath, opts: Opts = {}) => kit.get<T>(withQuery(path, opts.query), opts),
  post: <T = unknown>(path: ApiPath, body?: unknown, opts: Opts = {}) => kit.post<T>(withQuery(path, opts.query), body, opts),
  put: <T = unknown>(path: ApiPath, body?: unknown, opts: Opts = {}) => kit.put<T>(withQuery(path, opts.query), body, opts),
  patch: <T = unknown>(path: ApiPath, body?: unknown, opts: Opts = {}) => kit.patch<T>(withQuery(path, opts.query), body, opts),
  delete: <T = unknown>(path: ApiPath, opts: Opts = {}) => kit.delete<T>(withQuery(path, opts.query), opts),
};

/** Content-Disposition 的檔名(filename*=UTF-8''… 優先) */
export function filenameOf(header: string | null, fallback: string): string {
  const name = rawFilename(header);
  // 去掉路徑與 Windows 不允許的字元、控制字元
  const safe = name?.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').trim();
  return safe || fallback;
}

function rawFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // 編碼錯誤時改用一般檔名
    }
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain?.[1]?.trim();
}

/**
 * 下載檔案(docs/API.md §1 下載):fetch 取得 Blob 後存檔,帶 Cookie 與 CSRF、不帶 Bearer;
 * 401 先 Refresh 一次;失敗時丟 ApiError(與 http 相同,頁面用 toast.fromError 顯示)。
 */
export async function download(path: ApiPath, query: Query | undefined, fallbackName: string, retried = false): Promise<void> {
  const url = withQuery(path, query);
  const token = readCookie('gn_csrf');
  const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: '*/*', ...(token ? { 'X-CSRF-Token': token } : {}) } });
  if (res.status === 401 && !retried) {
    if (await refreshSession()) return download(path, query, fallbackName, true);
    redirectToLogin();
    return;
  }
  if (!res.ok) {
    const requestId = res.headers.get('X-Request-Id');
    let e: { code?: string; message?: string; requestId?: string; details?: unknown } = {};
    try {
      e = await res.json();
    } catch {
      // 非 JSON 錯誤
    }
    throw new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? res.statusText, e.requestId ?? requestId, e.details);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filenameOf(res.headers.get('Content-Disposition'), fallbackName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 太早撤銷時部分瀏覽器(Firefox、Safari)下載會失敗
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

/** 錯誤訊息附 requestId 前 12 碼,方便回報時查日誌(AGENT.md §5);欄位錯誤(details)一併列出 */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    // Gateway 找不到路由:netops-api 已註冊、但路由草稿還沒在 GigaItApp「服務與路由」發佈(2026-11-09 驗收 §4.4)
    if (e.code === 'ROUTE_NOT_FOUND') return `功能尚未啟用(路由未發佈)${e.requestId ? `(requestId ${e.requestId.slice(0, 12)})` : ''}`;
    const fields = Array.isArray(e.details)
      ? (e.details as { field?: string; message?: string }[])
          .map((d) => [d.field, d.message].filter(Boolean).join(':'))
          .filter(Boolean)
          .join(';')
      : '';
    return `${e.message}${fields ? `(${fields})` : ''}${e.requestId ? `(requestId ${e.requestId.slice(0, 12)})` : ''}`;
  }
  if (e instanceof TypeError) return '無法連線伺服器,請確認網路';
  return e instanceof Error ? e.message : String(e);
}
