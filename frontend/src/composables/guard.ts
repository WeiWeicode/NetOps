/**
 * 路由守衛的判斷(純函式,供 router.ts 與測試使用;規則同入口網與 GigaItApp,FRONTEND-GUIDE §7.4、§7.5.3):
 *   未登入 → 登入頁;沒有本系統應用權限 → 整頁導回入口網 /?denied=netops;
 *   任一層缺少選單 / Tab 權限或 API 讀取權限 → 同頁第一個可看的 Tab;從 / 進來的預設首頁 → 第一個可見功能;其餘 → /403。
 */
import { isNavigationFailure, NavigationFailureType } from 'vue-router';
import type { AppEntry } from '@/api/gateway';
import { DENIED_URL, hasCurrentApp, resolveApps } from './apps';

export interface GuardInput {
  me: { apps?: AppEntry[]; permissions: string[] } | null;
  /** to.matched 各層的 meta */
  matched: readonly { permission?: string; requires?: readonly string[] }[];
  path: string;
  /** 由 / 轉到預設首頁 */
  fromRoot: boolean;
  can: (code: string) => boolean;
  /** 目前功能頁(第二層)第一個可看的 Tab;沒有時 null */
  pageFirstTab: () => string | null;
  /** 第一個可見的功能頁與 Tab;沒有時 null */
  firstAllowed: () => string | null;
}

export type GuardDecision = { kind: 'allow' } | { kind: 'login' } | { kind: 'leave'; url: string } | { kind: 'redirect'; to: string };

export function decideGuard(i: GuardInput): GuardDecision {
  if (!i.me) return { kind: 'login' };
  if (!hasCurrentApp(resolveApps(i.me))) return { kind: 'leave', url: DENIED_URL };
  const ok = (m: GuardInput['matched'][number] | undefined) => !!m && (!m.permission || i.can(m.permission)) && (m.requires ?? []).every(i.can);
  if (i.matched.every(ok)) return { kind: 'allow' };
  // 有此功能頁、只是目前的 Tab 沒權限:改到同頁第一個有權限的 Tab
  if (ok(i.matched[1])) {
    const t = i.pageFirstTab();
    if (t && t !== i.path) return { kind: 'redirect', to: t };
  }
  if (i.fromRoot) {
    const first = i.firstAllowed();
    if (first && first !== i.path) return { kind: 'redirect', to: first };
  }
  return { kind: 'redirect', to: '/403' };
}

/**
 * 第一次導覽被守衛中止(導向登入頁、整頁導回入口網時 return false):router.isReady() 會以不帶訊息的 NavigationFailure 拒絕。
 * 這不是錯誤,呼叫端吞掉、維持載入畫面等頁面離開,不要讓它變成未處理的 Promise 拒絕被監控回報(D1 驗收 2026-11-05 §4.4)。
 * 其他錯誤(守衛丟出例外等)照常往外丟。
 */
export const isLeavingNavigation = (err: unknown): boolean => isNavigationFailure(err, NavigationFailureType.aborted);
