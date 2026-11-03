/**
 * Gateway BFF 呼叫(全站唯一入口,頁面不直接 fetch):一律經 Gateway web-kit(FRONTEND-GUIDE §6)
 *   - 同網域 /api/...(本系統 /api/netops/* 經 BFF 轉 netops-api),Cookie 由瀏覽器自動帶上,前端不接觸 Token(AGENT.md §7.1)
 *   - 非 GET 自動帶 X-CSRF-Token(gn_csrf);401 先 Refresh 一次,失敗才導向入口網 /login?redirect=...
 *   - 錯誤統一為 ApiError { status, code, message, requestId, details }
 */
import { ApiError, http as kit, useAuth, type Me, type RequestOptions } from '@giganexus/web-kit';
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

/** 錯誤訊息附 requestId 前 12 碼,方便回報時查日誌(AGENT.md §5);欄位錯誤(details)一併列出 */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
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
