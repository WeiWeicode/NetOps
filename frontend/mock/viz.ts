/**
 * 假 Gateway:活動熱力圖、時段明細、分析儀表板(docs/API.md §4.4、§4.5;V-b1)。資料來自 mock/fixtures/viz.ts。
 * 用特定條件造出各種狀態(HANDOFF-GEMINI-VIZ §8 第 5 項):
 *   熱力圖  date 早於 2026-01-01:資料起點在 2026-01-01(之前的格子 v = null);日視圖超過 1 年:422
 *   時段明細 start 早於 29 天前:409 NETOPS_COLD_ARCHIVE_DISABLED(冷歸檔未提供)
 *           ip=10.0.0.98:429 NETOPS_COLD_QUERY_BUSY(retryAfter 10)
 *           ip=10.0.0.99:202 轉成工作,約 4 秒後 done
 *           ip=10.0.0.97:source = cold(看冷資料徽章);ip=10.0.0.96:source = mixed
 *           ip=10.0.0.95:503 NETOPS_CLICKHOUSE_UNAVAILABLE
 */
import { heatmapResponse, sliceResult, threatInsight, trafficInsight, type Granularity, type Metric } from './fixtures/viz.ts';
import type { MockCtx } from './types.ts';

const DAY = 86_400_000;
const SINCE = Date.parse('2026-01-01T00:00:00+08:00');
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

interface Job {
  id: string;
  owner: string;
  createdAt: string;
  doneAt: number;
  cancelled: boolean;
  result: ReturnType<typeof sliceResult>;
}
const jobs = new Map<string, Job>();

function jobView(j: Job) {
  const done = !j.cancelled && Date.now() >= j.doneAt;
  return {
    id: j.id,
    kind: 'pa-slice',
    status: j.cancelled ? 'cancelled' : done ? 'done' : 'running',
    createdAt: j.createdAt,
    startedAt: j.createdAt,
    finishedAt: done ? new Date(j.doneAt).toISOString() : null,
    progress: null,
    error: null,
    result: done ? j.result : null,
  };
}

export function handleViz(c: MockCtx): boolean {
  const q = (k: string) => c.url.searchParams.get(k) ?? undefined;
  if (c.method === 'GET' && c.path === '/api/netops/pa/heatmap') {
    if (!c.need('netops.pa.read')) return true;
    const granularity = q('granularity') as Granularity;
    const metric = q('metric') as Metric | 'ad';
    const date = q('date') ?? today();
    if (metric === 'ad') return c.fail(409, 'NETOPS_HEATMAP_METRIC_UNAVAILABLE', 'AD 異常指標在 AD 階段(V-d)開放'), true;
    if (granularity === 'day' && Date.parse(`${date}T00:00:00+08:00`) < Date.now() - 365 * DAY) {
      c.send(422, { code: 'NETOPS_HEATMAP_OUT_OF_RETENTION', message: '日視圖(每 5 分鐘)只保留 1 年', requestId: 'mock', details: { earliest: new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10) } });
      return true;
    }
    c.send(200, heatmapResponse({ granularity, metric, date, now: Date.now(), since: date < '2026-01-01' ? SINCE : undefined }));
    return true;
  }
  if (c.method === 'GET' && c.path === '/api/netops/pa/slice') {
    if (!c.need('netops.pa-log.read')) return true;
    const start = q('start') ?? '';
    const end = q('end') ?? '';
    const ip = q('ip');
    const base = { start, end, type: q('type') as 'traffic' | 'threat' | undefined, severity: (q('severity') || undefined) as Parameters<typeof sliceResult>[0]['severity'], rows: Number(q('rows') ?? 100) };
    if (Date.parse(start) < Date.now() - 29 * DAY) {
      c.send(409, { code: 'NETOPS_COLD_ARCHIVE_DISABLED', message: '這段時間的明細要從冷歸檔讀取,冷歸檔尚未提供', requestId: 'mock', details: { hotFrom: new Date(Date.now() - 29 * DAY).toISOString() } });
      return true;
    }
    if (ip === '10.0.0.98') {
      c.send(429, { code: 'NETOPS_COLD_QUERY_BUSY', message: '已有冷資料查詢在執行,請 10 秒後再試', requestId: 'mock', details: { retryAfter: 10 } });
      return true;
    }
    if (ip === '10.0.0.95') return c.fail(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', 'PA log 資料庫(ClickHouse)暫時無法使用'), true;
    if (ip === '10.0.0.99') {
      const j: Job = { id: crypto.randomUUID(), owner: c.user, createdAt: new Date().toISOString(), doneAt: Date.now() + 4000, cancelled: false, result: sliceResult(base) };
      jobs.set(j.id, j);
      c.send(202, jobView(j));
      return true;
    }
    c.send(200, sliceResult({ ...base, source: ip === '10.0.0.97' ? 'cold' : ip === '10.0.0.96' ? 'mixed' : 'hot' }));
    return true;
  }
  const m = /^\/api\/netops\/pa\/slices\/([0-9a-f-]{36})$/.exec(c.path);
  if (m) {
    if (!c.need('netops.pa-log.read')) return true;
    const j = jobs.get(m[1]!);
    if (c.method === 'DELETE') {
      if (j && j.owner === c.user) j.cancelled = true;
      c.send(204, null);
      return true;
    }
    if (!j || j.owner !== c.user) return c.fail(404, 'NETOPS_JOB_NOT_FOUND', '找不到這個工作'), true;
    c.send(200, jobView(j));
    return true;
  }
  if (c.method === 'GET' && (c.path === '/api/netops/pa/insight/traffic' || c.path === '/api/netops/pa/insight/threat')) {
    if (!c.need('netops.pa.read')) return true;
    const r = { from: q('from') ?? today(), to: q('to') ?? today(), now: Date.now() };
    c.send(200, c.path.endsWith('traffic') ? trafficInsight(r) : threatInsight(r));
    return true;
  }
  return false;
}
