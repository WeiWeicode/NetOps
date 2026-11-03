/**
 * 取得目前使用者(web-kit 快取的 /api/auth/me):換頁時若超過 5 分鐘未更新就重新取得,
 * 讓 GigaItApp 調整後的應用 / 選單 / 按鈕權限生效(同入口網 composables/session.ts;API 權限由 BFF 以 pv 立即生效)。
 */
import { loadMe, type NetopsMe } from '@/api/gateway';

const MAX_AGE_MS = 5 * 60 * 1000;
let loadedAt = 0;

/** 回傳 null = 未登入;BFF 無法連線時丟出錯誤 */
export async function ensureMe(): Promise<NetopsMe | null> {
  const stale = Date.now() - loadedAt > MAX_AGE_MS;
  const me = (await loadMe(stale)) as NetopsMe | null;
  if (stale && me) loadedAt = Date.now();
  return me;
}
