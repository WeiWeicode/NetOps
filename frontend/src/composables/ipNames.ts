/**
 * IP 對照表的名稱快取(IMPL-PLAN AC3):PA 各 API 回應的 names(只含該回應出現的 IP)收進全站快取,
 * 畫面以 GIpLabel / GTable 的 ip 欄顯示(main.ts provide IP_LABEL_KEY)。看得到 PA 的人就看得到名稱,不需要對照表權限。
 *   - 回應有 names 時:該回應出現、但 names 沒有的 IP 從快取移除(對照被刪除或改網段後不會一直顯示舊名稱)
 *   - 前端不存 localStorage(姓名、部門屬個資;重新整理即清除)
 */
import { shallowReactive } from 'vue';
import type { IpLabel } from '@/ui/ipLabel';

export interface IpNameLabel {
  name: string;
  department: string;
  device: string;
  deviceType: string;
}

/** 快取上限(超過時清空重來,避免長時間開著即時監控佔記憶體) */
export const IP_NAME_CACHE_MAX = 20_000;
const cache = shallowReactive(new Map<string, IpNameLabel>());

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** 回應中「整個值就是 IPv4」的字串(同後端 collectIps;走訪上限避免大回應卡住畫面) */
export function ipsIn(value: unknown, max = 5000): Set<string> {
  const out = new Set<string>();
  let budget = 200_000;
  const walk = (v: unknown, depth: number) => {
    if (budget-- <= 0 || out.size >= max || depth > 12) return;
    if (typeof v === 'string') {
      if (v.length >= 7 && v.length <= 15 && IPV4.test(v)) out.add(v);
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'names') walk(x, depth + 1);
  };
  walk(value, 0);
  return out;
}

/** 收下回應的 names;沒有 names 欄(舊版後端、不是 PA API)時不動快取 */
export function absorbNames(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const names = (payload as { names?: unknown }).names;
  if (!names || typeof names !== 'object' || Array.isArray(names)) return;
  const got = names as Record<string, unknown>;
  for (const ip of ipsIn(payload)) if (!(ip in got)) cache.delete(ip);
  if (cache.size > IP_NAME_CACHE_MAX) cache.clear();
  for (const [ip, v] of Object.entries(got)) {
    if (!IPV4.test(ip) || !v || typeof v !== 'object') continue;
    const l = v as Record<string, unknown>;
    cache.set(ip, { name: str(l.name), department: str(l.department), device: str(l.device), deviceType: str(l.deviceType) });
  }
}

export const ipNameOf = (ip: string | null | undefined): IpNameLabel | undefined => (ip ? cache.get(ip) : undefined);

/** 短文字:姓名,沒有時設備名稱,再沒有時部門 */
export const ipNameText = (l: IpNameLabel): string => l.name || l.device || l.department;

/** 完整說明:姓名 · 部門 · 設備(類型) */
export function ipNameTitle(l: IpNameLabel): string {
  const dev = l.device && l.deviceType ? `${l.device}(${l.deviceType})` : l.device || l.deviceType;
  return [l.name, l.department, dev].filter(Boolean).join(' · ');
}

/** GIpLabel 的查詢函式(main.ts provide) */
export function ipLabel(ip: string): IpLabel | undefined {
  const l = cache.get(ip);
  if (!l) return undefined;
  const text = ipNameText(l);
  return text ? { text, title: ipNameTitle(l) } : undefined;
}

/** 測試用 */
export const clearIpNames = (): void => cache.clear();
