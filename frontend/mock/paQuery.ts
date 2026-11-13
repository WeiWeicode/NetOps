/**
 * 假 Gateway:PA 精準查詢(docs/API.md §3.3;C5)。MOCK=admin 才有按鈕權限 netops.pa-live.query。
 *   ip 10.0.0.98 → 429(冷卻倒數);10.0.0.97 → rejected(管理平面 CPU 過高);10.0.0.96 → failed(逾時);其他約 3 秒後 done
 */
import type { MockCtx } from './types.ts';

interface Job {
  id: string;
  owner: string;
  kind: 'log' | 'session';
  params: Record<string, unknown>;
  createdAt: string;
  doneAt: number;
  outcome: 'done' | 'rejected' | 'failed';
}
const jobs = new Map<string, Job>();

function view(j: Job) {
  const finished = Date.now() >= j.doneAt;
  const status = finished ? j.outcome : 'running';
  const rows =
    j.kind === 'session'
      ? Array.from({ length: 6 }, (_, i) => ({ id: 1000 + i, app: ['ssl', 'dns', 'ms-rdp'][i % 3]!, state: 'ACTIVE', src: String(j.params.ip), sport: 50000 + i, dst: '8.8.8.8', dport: 443, proto: 6, fromZone: 'trust', toZone: 'untrust', startTime: 'Wed Nov 12 09:59:00 2026', bytes: 1000 * (i + 1), rule: 'Allow-Web' }))
      : Array.from({ length: 12 }, (_, i) => ({ time: `2026/11/12 09:${String(45 + i).padStart(2, '0')}:00`, action: 'allow', src: String(j.params.ip), sport: 51000 + i, dst: '1.1.1.1', dport: 53, app: 'dns', bytes: 120 + i }));
  return {
    id: j.id,
    kind: j.kind,
    status,
    params: j.params,
    createdAt: j.createdAt,
    startedAt: j.createdAt,
    finishedAt: finished ? new Date(j.doneAt).toISOString() : null,
    mgmtCpu: j.outcome === 'rejected' ? 63.5 : 4.2,
    error: !finished || j.outcome === 'done' ? null : j.outcome === 'rejected' ? { code: 'NETOPS_PA_QUERY_CPU_HIGH', message: 'PA-560 管理平面 CPU 63.5% 超過 50%,為保護設備不送出查詢,請稍後再試' } : { code: 'NETOPS_PA_QUERY_TIMEOUT', message: 'PA-560 超過 60 秒沒有完成,已取消查詢' },
    result: finished && j.outcome === 'done' ? { rows, count: rows.length, truncated: false } : null,
  };
}

export function handlePaQuery(c: MockCtx): boolean {
  if (!c.path.startsWith('/api/netops/pa-query/')) return false;
  if (!c.need('netops.pa-query.read')) return true;
  if (c.method === 'GET' && c.path === '/api/netops/pa-query/status') {
    const busy = [...jobs.values()].some((j) => Date.now() < j.doneAt);
    c.send(200, { enabled: true, executor: true, heartbeatAgeSec: 2, activeSec: busy ? 30 : 0, globalCoolSec: 0, userCoolSec: 0, mgmtCpu: 4.2 });
    return true;
  }
  if (c.method === 'POST' && c.path === '/api/netops/pa-query/jobs') {
    const b = (c.body ?? {}) as Record<string, unknown>;
    if (b.ip === '10.0.0.98') {
      c.send(429, { code: 'NETOPS_PA_QUERY_BUSY', message: '已有 PA 查詢在執行(全系統一次一個),請 12 秒後再試', requestId: 'mock', details: { retryAfter: 12 } });
      return true;
    }
    const id = crypto.randomUUID();
    const kind = b.kind === 'log' ? 'log' : 'session';
    const outcome = b.ip === '10.0.0.97' ? 'rejected' : b.ip === '10.0.0.96' ? 'failed' : 'done';
    const j: Job = { id, owner: c.user, kind, params: b, createdAt: new Date().toISOString(), doneAt: Date.now() + (outcome === 'rejected' ? 500 : 3000), outcome };
    jobs.set(id, j);
    c.send(202, { ...view(j), status: 'queued' });
    return true;
  }
  const m = /^\/api\/netops\/pa-query\/jobs\/([0-9a-f-]{36})$/.exec(c.path);
  if (c.method === 'GET' && m) {
    const j = jobs.get(m[1]!);
    if (!j || j.owner !== c.user) return c.fail(404, 'NETOPS_PA_QUERY_NOT_FOUND', '找不到這個查詢'), true;
    c.send(200, view(j));
    return true;
  }
  return false;
}
