/**
 * 圖表點擊 → 時段明細條件(V-b1;VIZ-RULES-DESIGN §6.3):統一儀表板的點擊聯動。
 *   const { toSliceQuery } = useChartPick()
 *   const q = toSliceQuery(pick, range, { bucketSeconds })   // null = 這個點擊不開明細
 *   if (q) slice.open(q)
 * 時段明細一次最多 1 天:時間類圖表(趨勢、Allow / Deny、威脅時序)用被點的那一格;
 * 其他圖表(排行、桑基、國家…)用期間的最後一天(含今天時到現在為止)加上被點的條件。
 */
import type { DateRange } from '@/api/insight';
import type { SliceQuery } from '@/api/slice';
import type { ChartPick } from '@/ui/charts/viz-types';
import { addDays, plusSeconds } from './vizTime';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Severity = (typeof SEVERITIES)[number];

/** 期間最後一天 [to 00:00, to+1 00:00) */
const lastDay = (r: DateRange) => ({ start: `${r.to}T00:00:00+08:00`, end: `${addDays(r.to, 1)}T00:00:00+08:00` });

/**
 * ctx.bucketSeconds:趨勢 / 威脅時序的格寬(API 回應的 bucketSeconds);ctx.allowDenyBucketSeconds:Allow vs Deny 的格寬
 * (流量 API 的 allowDenyBucketSeconds,和趨勢不同:2–31 天時趨勢每小時、Allow / Deny 每天)
 */
export function toSliceQuery(p: ChartPick, range: DateRange, ctx: { bucketSeconds?: number; allowDenyBucketSeconds?: number } = {}): SliceQuery | null {
  const day = lastDay(range);
  const timeCell = (type: SliceQuery['type'], sec = ctx.bucketSeconds): SliceQuery | null => {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(p.name) || !sec) return null;
    // 一格超過 1 天時(不會發生:每天格最大)仍限 1 天
    return { start: p.name, end: plusSeconds(p.name, Math.min(sec, 86400)), type };
  };
  switch (p.chart) {
    case 'trend':
      return timeCell('traffic');
    case 'allowDeny': {
      const q = timeCell('traffic', ctx.allowDenyBucketSeconds ?? ctx.bucketSeconds);
      return q && p.series === 'deny' ? { ...q, action: 'block' } : q;
    }
    case 'timeline': {
      const q = timeCell('threat');
      return q && (SEVERITIES as readonly string[]).includes(p.series ?? '') ? { ...q, severity: p.series as Severity } : q;
    }
    case 'topIp':
      // 排行依來源 IP 彙總,明細也只比對來源(ip 會連目的一起算,數字比排行大)
      return { ...day, type: 'traffic', src: p.name, sort: 'bytes' };
    case 'topApp':
      return { ...day, type: 'traffic', app: p.name, sort: 'bytes' };
    case 'sankey': {
      // 連線的 data 帶 source / target(節點 id);節點的 name 就是 id(GEChart 已換成 id)。名稱裡有「>」也不會拆錯
      const d = p.data as { source?: string; target?: string } | undefined;
      const ids = d?.source && d.target ? [d.source, d.target] : [p.name];
      const q: SliceQuery = { ...day, type: 'traffic', sort: 'bytes' };
      for (const id of ids) {
        const v = id.slice(2);
        // 「其他」App、「未知」區域是彙總出來的,沒有條件可用
        if (v === '其他' || v === '未知') continue;
        if (id.startsWith('z:')) q.fromZone = v;
        else if (id.startsWith('a:')) q.app = v;
        else if (id.startsWith('d:')) q.toZone = v;
      }
      return q;
    }
    case 'severity':
      return (SEVERITIES as readonly string[]).includes(p.name) ? { ...day, type: 'threat', severity: p.name as Severity } : null;
    case 'country': {
      // 時段明細的國家條件比對 PA 的英文全名(包含);「未知」沒有條件可用
      const c = (p.data as { country?: string; iso2?: string | null } | undefined) ?? {};
      return c.iso2 && c.country ? { ...day, type: 'threat', country: c.country } : null;
    }
    case 'topInternalSrc':
      return { ...day, type: 'threat', src: p.name };
    case 'topServerDst':
      return { ...day, type: 'threat', dst: p.name };
    case 'topNames':
      return { ...day, type: 'threat', threatName: p.name };
    default:
      return null;
  }
}

export function useChartPick() {
  return { toSliceQuery };
}
