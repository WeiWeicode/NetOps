/** AD 事件總覽與明細查詢的純函式(畫面與測試共用;規則同舊版 src/views/AdEvents.vue + AD-3) */
import { ApiError } from '@/api/gateway';

/**
 * 登入失敗原因 → 明細查詢的關鍵字:原因結尾括號內的代碼(0x25、0xC000006A),沒有代碼時用整段文字。
 * 括號接受全形與半形(舊版後端輸出全形)。
 */
export function reasonQuery(reason: string): string {
  return reason.match(/[(\uFF08](0x[0-9a-f]+)[)\uFF09]\s*$/i)?.[1] ?? reason;
}

/** AD 明細查詢的 DC 主機名 / 網域格式(與後端 routes.ts filterProps 一致) */
export const isDcToken = (v: string, max: number): boolean => v.length <= max && /^[\w.-]*$/.test(v);

/** 從 400 VALIDATION_FAILED 的 details 取出指定欄位的錯誤訊息(例如 name 欄) */
export function fieldValidationError(e: unknown, field: string): string {
  if (!(e instanceof ApiError) || e.status !== 400 || !Array.isArray(e.details)) return '';
  const hit = (e.details as { field?: string; message?: string }[]).find((d) => d?.field === field && typeof d.message === 'string');
  if (!hit?.message) return '';
  return `${hit.message}${e.requestId ? `(requestId ${e.requestId.slice(0, 12)})` : ''}`;
}

/** 判斷錯誤是否為 ClickHouse 不可用(503 NETOPS_CLICKHOUSE_UNAVAILABLE) */
export const isClickHouseUnavailable = (e: unknown): boolean =>
  e instanceof ApiError && (e.status === 503 || e.code === 'NETOPS_CLICKHOUSE_UNAVAILABLE');

/** 判斷錯誤是否為 Redis 不可用(424 NETOPS_REDIS_UNAVAILABLE) */
export const isRedisUnavailable = (e: unknown): boolean =>
  e instanceof ApiError && (e.status === 424 || e.code === 'NETOPS_REDIS_UNAVAILABLE');

/** 從 agents、days 與目前值(例:網址帶入的 computer)彙整 DC 下拉選項(去重排序;審查 Low 4) */
export function collectDcOptions(
  agentComputers: readonly string[],
  dayComputers: readonly (readonly string[] | undefined)[],
  current = '',
): { label: string; value: string }[] {
  const set = new Set<string>();
  for (const c of agentComputers) if (c.trim()) set.add(c.trim());
  for (const list of dayComputers) if (list) for (const c of list) if (c.trim()) set.add(c.trim());
  if (current.trim()) set.add(current.trim());
  return [...set].sort((a, b) => a.localeCompare(b)).map((c) => ({ label: c, value: c }));
}
