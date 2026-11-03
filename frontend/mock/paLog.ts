/**
 * 假 Gateway:PA Log 明細查詢(docs/API.md §4.3,工作模式;後端 feature/netops-b2-logs 合併前前端先接這裡)。
 * 工作約 4 秒完成,期間回報進度;結果、分頁、匯出、取消都照 API.md。也提供 GET /pa/options。
 */
import type { MockCtx } from './types.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const APPS = ['ssl', 'web-browsing', 'dns-base', 'ms-rdp', 'openai-chatgpt'];
const RULES = ['Allow-Web', 'Allow-DNS', 'Deny-All', 'Block-SMB-Out'];
const ZONES = ['trust', 'untrust', 'dmz'];
const ACTIONS = ['allow', 'deny', 'drop', 'reset-both'];

interface Search {
  id: string;
  body: Record<string, string>;
  createdAt: string;
  startedAt: string;
  status: string;
  finishedAt: string | null;
  doneAt: number;
  rows: Record<string, unknown>[];
}
const searches = new Map<string, Search>();

function fakeRows(body: Record<string, string>) {
  const from = new Date(body.from ?? Date.now()).getTime();
  const to = new Date(body.to ?? Date.now()).getTime();
  const n = Math.min(137, Math.max(0, Math.round((to - from) / 60_000)));
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(from + ((to - from) * i) / Math.max(1, n));
    const action = body.action === 'block' ? ACTIONS[1 + (i % 3)]! : body.action || ACTIONS[i % 7 === 0 ? 1 : 0]!;
    const local = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}+08:00`;
    return {
      time: local,
      subtype: action === 'allow' ? 'end' : 'deny',
      action,
      src: body.src || `10.10.${i % 9}.${(i * 7) % 250}`,
      sport: 50000 + i,
      dst: body.dst || ['8.8.8.8', '10.10.130.66', '20.190.1.10'][i % 3]!,
      dport: Number(body.port?.split(',')[0]) || [443, 53, 445][i % 3]!,
      proto: body.proto || (i % 3 === 1 ? 'udp' : 'tcp'),
      app: body.app || APPS[i % APPS.length]!,
      rule: body.rule || (action === 'allow' ? RULES[i % 2]! : RULES[2]!),
      fromZone: body.fromZone || 'trust',
      toZone: body.toZone || 'untrust',
      srcUser: body.user || (i % 4 === 0 ? 'gsmc\\s112009' : ''),
      natSrc: '',
      natDst: '',
      bytes: 1234 + i * 977,
      sent: 600 + i * 300,
      recv: 634 + i * 677,
      packets: 10 + i,
      elapsed: i % 30,
      endReason: action === 'allow' ? 'tcp-fin' : 'policy-deny',
      category: 'any',
      srcCountry: '10.0.0.0-10.255.255.255',
      dstCountry: body.country || 'United States',
      appRisk: 4,
      threat: '',
      severity: '',
      url: '',
    };
  });
}

function view(s: Search) {
  const now = Date.now();
  if (s.status === 'running' && now >= s.doneAt) Object.assign(s, { status: 'done', finishedAt: new Date().toISOString() });
  const files = 4;
  const ratio = s.status === 'done' ? 1 : Math.min(0.95, 1 - (s.doneAt - now) / 4000);
  return {
    id: s.id,
    kind: 'pa-log-search',
    status: s.status,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    progress: { filesScanned: Math.floor(files * ratio), files, rows: Math.round(260_000 * ratio), found: Math.round(s.rows.length * ratio) },
    error: null,
    result:
      s.status === 'done'
        ? {
            from: s.body.from,
            to: s.body.to,
            total: s.rows.length,
            limit: 2000,
            files,
            filesScanned: files,
            scanned: 260_000,
            seconds: 3.9,
            // 關鍵字 timeout 模擬掃描逾時(結果不完整)
            stopReason: s.body.q === 'timeout' ? 'timeout' : '',
          }
        : null,
  };
}

export function handlePaLog({ method, path, url, body, need, send, fail, sendFile }: MockCtx): boolean {
  if (method === 'GET' && path === '/api/netops/pa/options') {
    if (!need('netops.pa.read')) return true;
    send(200, { apps: APPS, rules: RULES, zones: ZONES, actions: ACTIONS });
    return true;
  }
  if (!path.startsWith('/api/netops/pa/log-searches')) return false;
  if (!need('netops.pa-log.read')) return true;
  if (method === 'POST' && path === '/api/netops/pa/log-searches') {
    const b = (body ?? {}) as Record<string, string>;
    if (!b.from || !b.to) return (fail(400, 'VALIDATION_FAILED', 'from、to 必填'), true);
    if ([...searches.values()].filter((s) => s.status === 'running').length >= 2) return (fail(409, 'NETOPS_JOB_LIMIT_EXCEEDED', '進行中的工作超過上限'), true);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const s: Search = { id, body: b, createdAt: now, startedAt: now, status: 'running', finishedAt: null, doneAt: Date.now() + 4000, rows: fakeRows(b) };
    searches.set(id, s);
    send(202, view(s));
    return true;
  }
  const m = path.match(/^\/api\/netops\/pa\/log-searches\/([^/]+)(\/rows|\/export)?$/);
  const s = m && searches.get(m[1]!);
  if (method === 'DELETE' && m && !m[2]) {
    if (s && s.status === 'running') Object.assign(s, { status: 'cancelled', finishedAt: new Date().toISOString() });
    send(204, null);
    return true;
  }
  if (!s) return (fail(404, 'NETOPS_JOB_NOT_FOUND', '工作不存在、已逾期或服務重新啟動後失效'), true);
  const v = view(s);
  if (!m![2]) return (send(200, v), true);
  if (s.status !== 'done') return (fail(409, 'NETOPS_JOB_NOT_DONE', '工作尚未完成'), true);
  if (m![2] === '/rows') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 50));
    send(200, { items: s.rows.slice((page - 1) * pageSize, page * pageSize), total: s.rows.length, page, pageSize });
    return true;
  }
  // 匯出:欄名中文、UTF-8 BOM(實際由後端產生)
  const keys = Object.keys(s.rows[0] ?? { time: '' });
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  sendFile(
    'text/csv; charset=utf-8',
    'PA_log.csv',
    `\uFEFF${[keys.map(esc).join(','), ...s.rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\r\n')}`,
  );
  return true;
}
