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

export function toSliceQuery(p: ChartPick, range: DateRange, ctx: { bucketSeconds?: number } = {}): SliceQuery | null {
  const day = lastDay(range);
  const timeCell = (type: SliceQuery['type']): SliceQuery | null => {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(p.name) || !ctx.bucketSeconds) return null;
    // 一格超過 1 天時(不會發生:每天格最大)仍限 1 天
    return { start: p.name, end: plusSeconds(p.name, Math.min(ctx.bucketSeconds, 86400)), type };
  };
  switch (p.chart) {
    case 'trend':
      return timeCell('traffic');
    case 'allowDeny': {
      const q = timeCell('traffic');
      return q && p.series === 'deny' ? { ...q, action: 'block' } : q;
    }
    case 'timeline': {
      const q = timeCell('threat');
      return q && (SEVERITIES as readonly string[]).includes(p.series ?? '') ? { ...q, severity: p.series as Severity } : q;
    }
    case 'topIp':
      return { ...day, type: 'traffic', ip: p.name, sort: 'bytes' };
    case 'topApp':
      return { ...day, type: 'traffic', app: p.name, sort: 'bytes' };
    case 'sankey': {
      const q: SliceQuery = { ...day, type: 'traffic', sort: 'bytes' };
      for (const id of p.name.split('>')) {
        const v = id.slice(2);
        if (id.startsWith('z:')) q.fromZone = v;
        else if (id.startsWith('a:') && v !== '其他') q.app = v;
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
