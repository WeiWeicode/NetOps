/**
 * 應用切換與應用層守衛(Gateway FRONTEND-GUIDE §7.4;同 GigaItApp composables/apps.ts):
 * 應用清單取自 /api/auth/me 的 apps(已依權限過濾)。
 * NetOps 在 D1 才登記到 gw.app,登記前 apps 不會有 netops:暫時以 netops.app.access 判斷並補上本系統。
 * TODO(D1 登記 gw.app 後):移除 permission 推導,只用 me.apps。
 */
import type { AppEntry } from '@/api/gateway';
import { NETOPS } from '@/api/perms';

export const CURRENT_APP = 'netops';
const SELF: AppEntry = { code: CURRENT_APP, name: '資訊網通管理系統', basePath: '/netops/', icon: 'shield' };

export interface AppsResult {
  apps: AppEntry[];
  /** true = 本系統由權限暫時推導(gw.app 尚未登記),應用切換下拉需標示 */
  derived: boolean;
}

export function resolveApps(me: { apps?: AppEntry[]; permissions: string[] } | null): AppsResult {
  if (!me) return { apps: [], derived: false };
  const apps = Array.isArray(me.apps) ? me.apps : [];
  if (apps.some((a) => a.code === CURRENT_APP) || !me.permissions.includes(NETOPS.app)) return { apps, derived: false };
  return { apps: [...apps, SELF], derived: true };
}

/** 應用層守衛:沒有本系統的應用權限 → 以 /?denied=netops 導回入口網(入口網顯示提示) */
export function hasCurrentApp(r: AppsResult): boolean {
  return r.apps.some((a) => a.code === CURRENT_APP);
}

export const DENIED_URL = `/?denied=${CURRENT_APP}`;
