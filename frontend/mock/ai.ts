/**
 * 假 Gateway:AI(docs/API.md §10)。不連 AI 主機:分析、問答回固定的 SSE 事件(逐字送出,看得到串流效果);
 * 語意搜尋回空清單;外部 IP 學習模擬 6 秒的背景執行。
 * 問題含「錯誤」時回 error 事件,含「忙碌」時回 429(看畫面的錯誤顯示)。
 */
import type { MockCtx } from './types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SSE:立即送 open,依序送事件(每個間隔 ms) */
async function stream(ctx: MockCtx, events: [string, unknown][], ms = 60) {
  const res = ctx.raw;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  let closed = false;
  res.on('close', () => (closed = true));
  const send = (event: string, data: unknown) => !closed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('open', { requestId: 'mock', heartbeatSec: 15 });
  for (const [e, d] of events) {
    if (closed) return;
    await sleep(ms);
    send(e, d);
  }
  res.end();
}

const ANSWER = `## 結論
🟡 需注意:10.10.1.5 連往 8.8.8.8:53 被 **interzone-default** 擋下 1,240 次。

## 查到的紀錄
| 來源 → 目的 | 動作 | 規則 | 次數 |
| --- | --- | --- | --- |
| 10.10.1.5 → 8.8.8.8:udp/53 | deny | interzone-default | 1,240 |

## 原因判斷
沒有任何允許規則符合(可能是 DNS 設定指向外部)。

## 建議處理
1. 確認 10.10.1.5 的 DNS 設定是否應改為內部 DNS。<img src=x onerror=alert(1)>
2. 若是合法需求,新增 LAN → WAN 的 dns 規則,只開必要的範圍。
3. 參考:[請重新登入確認](https://evil.example/login)、[流量總覽](/netops/firewall/dashboard)`;

const contentEvents = (text: string): [string, unknown][] => text.match(/[\s\S]{1,24}/g)!.map((t) => ['content', { text: t }]);

let learn = { busy: false, startedAt: null as string | null, finishedAt: null as string | null, done: 0, total: 0, log: [] as string[] };

/**
 * AC2:分析的 meta(ClickHouse 來源):最近 30 天(到 2026-11-13)用每小時摘要,更早的部分是每天彙總(較粗)
 */
function analysisMeta(from: string, to: string) {
  const RAW_FROM = '2026-10-15';
  const coarse = from && from < RAW_FROM ? { from, to: to < RAW_FROM ? to : '2026-10-14' } : null;
  const detail = !to || to >= RAW_FROM ? { from: from > RAW_FROM ? from : RAW_FROM, to } : null;
  const days = coarse ? Math.round((Date.parse(coarse.to) - Date.parse(coarse.from)) / 86_400_000) + 1 : 0;
  const hours = detail ? (Math.round((Date.parse(detail.to) - Date.parse(detail.from)) / 86_400_000) + 1) * 24 : 0;
  return {
    model: 'Qwen3.6-35B-A3B-FP8',
    from,
    to,
    source: 'clickhouse',
    files: hours + days,
    hours,
    days,
    missing: 1,
    rows: 1234567,
    contextChars: 18000,
    notes: [{ id: '202611021030-a1b2c3', title: '10.10.130.66 FTP 伺服器', related: false }],
    vectorError: false,
    grain: { detail, coarse, rawDays: 30 },
    coverage: { from: '2026-08-01', to: '2026-11-13' },
    partial: false,
    summaryState: 'ok',
  };
}

export function handleAi(ctx: MockCtx): boolean {
  const { method, path, body } = ctx;
  const b = (body ?? {}) as Record<string, unknown>;
  if (path === '/api/netops/ai/status' && method === 'GET') {
    if (!ctx.need('netops.ai.use')) return true;
    ctx.send(200, { enabled: true, ok: true, model: 'Qwen3.6-35B-A3B-FP8(假)', message: '' });
    return true;
  }
  if (path === '/api/netops/ai/analyses' && method === 'POST') {
    if (!ctx.need('netops.ai.use')) return true;
    void stream(ctx, [
      ['meta', analysisMeta(String(b.from ?? ''), String(b.to || b.from || ''))],
      ...(b.think ? ([['thinking', { chars: 400 }], ['thinking', { chars: 800 }]] as [string, unknown][]) : []),
      ...contentEvents(ANSWER.replace('## 結論', '## 整體結論')),
      ['done', { finish: 'stop', truncated: false }],
    ]);
    return true;
  }
  if (path === '/api/netops/ai/questions' && method === 'POST') {
    if (!ctx.need('netops.ai.use')) return true;
    const q = String(b.question ?? '');
    if (q.includes('忙碌')) return ctx.fail(429, 'NETOPS_STREAM_BUSY', 'AI 回答進行中的數量已達上限,請等目前的回答完成或關閉其他分頁後再試'), true;
    const ips = q.match(/(?:\d{1,3}\.){3}\d{1,3}/g) ?? [];
    const events: [string, unknown][] = [['meta', { model: 'Qwen3.6-35B-A3B-FP8', from: b.from, to: b.to, files: 6, ips, ports: [], source: b.source }]];
    if (q.includes('錯誤')) events.push(['error', { code: 'NETOPS_AI_UNAVAILABLE', message: 'AI 分析失敗:無法連線 AI 服務' }]);
    else {
      if (ips.length && b.source !== 'ad') {
        // AC2:ClickHouse 來源(測試區);問題含「舊」時模擬期間有一段超過 30 天保留期限
        const label = `${ips.join(' 與 ')} 的連線`;
        events.push(['scan', { label, source: 'clickhouse', step: 'traffic' }]);
        events.push(['evidence', { label, source: 'clickhouse', matched: 1240, allow: 0, block: 1240, flows: 3, samples: 3, from: '2026/10/14 12:00', to: '2026/11/13 11:59', skipped: q.includes('舊') ? { from: '2026/10/01 00:00', to: '2026/10/14 12:00' } : null, seconds: 0.8, partial: false, cached: false }]);
        events.push(['scan', { label: '查詢威脅類 log', source: 'clickhouse', step: 'threat' }]);
        events.push(['events', { hits: [{ type: 'threat', label: '威脅', total: 12, kinds: 2 }] }]);
      } else if (b.source === 'ad') events.push(['ad', { label: 'AD 事件記錄 2026/11/02', total: 3200 }]);
      else events.push(['evidence', { label: '問題中沒有 IP / Port,改用期間的整體統計', summary: true, source: 'clickhouse', hours: 72, days: 0, missing: 0, grain: { detail: { from: '2026-11-11', to: '2026-11-13' }, coarse: null, rawDays: 30 } }]);
      events.push(['notes', { used: [{ id: '202611021030-a1b2c3', title: '10.10.130.66 FTP 伺服器', related: true }], omitted: [], vectorError: false }]);
      if (b.think) events.push(['thinking', { chars: 600 }]);
      events.push(...contentEvents(ANSWER), ['done', { finish: 'stop', truncated: false }]);
    }
    void stream(ctx, events);
    return true;
  }
  if (path === '/api/netops/kb/semantic-search' && method === 'GET') {
    if (!ctx.need('netops.kb.read')) return true;
    ctx.send(200, { items: [], vector: vectorStatus() });
    return true;
  }
  if (path === '/api/netops/kb/vector-status' && method === 'GET') {
    if (!ctx.need('netops.kb.read')) return true;
    ctx.send(200, vectorStatus());
    return true;
  }
  if (path === '/api/netops/kb/vector-syncs' && method === 'POST') {
    if (!ctx.need('netops.kb.write')) return true;
    ctx.fail(409, 'NETOPS_VECTOR_SYNC_DISABLED', '沒有啟用向量庫同步(VECTOR_SYNC);目前只做語意搜尋');
    return true;
  }
  if (path === '/api/netops/kb/ip-learning' && method === 'GET') {
    if (!ctx.need('netops.kb.read')) return true;
    ctx.send(200, learnStatus());
    return true;
  }
  if (path === '/api/netops/kb/ip-learnings' && method === 'POST') {
    if (!ctx.need('netops.kb.write')) return true;
    if (learn.busy) return ctx.fail(409, 'NETOPS_IPLEARN_BUSY', '外部 IP 自動學習正在執行中'), true;
    learn = { busy: true, startedAt: new Date().toISOString(), finishedAt: null, done: 0, total: 6, log: ['開始:2026/10/30～2026/11/05 共 42 個外部 IP,這次查 6 個'] };
    const tick = setInterval(() => {
      learn.done++;
      learn.log.push(`已查 ${learn.done} / ${learn.total}`);
      if (learn.done >= learn.total) {
        clearInterval(tick);
        learn.busy = false;
        learn.finishedAt = new Date().toISOString();
        learn.log.push('完成:寫入 / 更新 3 則知識庫筆記');
      }
    }, 1000);
    ctx.send(202, learnStatus());
    return true;
  }
  return false;
}

const vectorStatus = () => ({ enabled: true, sync: false, collection: 'NetOpsKb', ok: true, points: 128, lastSync: null, error: '', syncing: false, upserted: 0, deleted: 0 });
const learnStatus = () => ({
  enabled: true,
  hour: -1,
  ...learn,
  phase: learn.busy ? `查詢 RDAP ${learn.done} / ${learn.total}` : '',
  error: '',
  learnedIps: 120,
  groups: 35,
  notes: 30,
  lastRun: { at: '2026/11/04 03:00', by: '每日自動', range: '2026/10/29～2026/11/04', candidates: 42, looked: 10, cached: 30, manualSkip: 2, failed: 1, groups: 5, notes: 4 },
});
