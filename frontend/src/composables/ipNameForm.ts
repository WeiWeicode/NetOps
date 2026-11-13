/**
 * IP 對照表單筆編輯的前端檢查(IMPL-PLAN AC3;後端 modules/ip-names/core.ts parseIp 會再檢查一次):
 * IPv4 或 IPv4 網段,不接受前導 0;第一版不支援 IPv6
 */
const IP_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(\/(3[0-2]|[12]?\d))?$/;

export function ipFieldError(raw: string): string {
  const v = raw.trim().replace(/／/g, '/');
  if (!v) return '請輸入 IP 或網段';
  if (v.includes(':')) return '目前只支援 IPv4';
  return IP_RE.test(v) ? '' : '格式例:10.10.1.5 或 10.10.1.0/24';
}
