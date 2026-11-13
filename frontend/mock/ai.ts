/**
 * 假 Gateway:AI(docs/API.md §10)。不連 AI 主機:分析、問答回固定的 SSE 事件(逐字送出,看得到串流效果);
 * 語意搜尋回空清單;外部 IP 學習模擬 6 秒的背景執行。
 * 問題含「錯誤」時回 error 事件,含「忙碌」時回 429(看畫面的錯誤顯示)。
 */
import type { MockCtx } from './types.ts';
import { heatmapResponse, type Granularity, type Metric } from './fixtures/viz.ts';

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

const EXPLAIN_SLICE = `## 這個時段發生什麼事
這 1 小時主要是 **10.10.1.5(王小明,資訊處)** 的 ssl 流量,佔總流量約 62%;其次是 10.10.130.66(FTP 伺服器)對外的 ftp-data。

## 值得注意
- 🟡 阻擋 1,240 次集中在 10.10.1.5 → 8.8.8.8:53(interzone-default),可能是 DNS 設定指向外部。
- 🟢 沒有高嚴重度威脅。<img src=x onerror=alert(1)>

## 建議下一步
1. 點開 10.10.1.5 的 Log 明細,確認 udp/53 被擋的時間分布。
2. 參考:[請重新登入確認](https://evil.example/login)`;

const EXPLAIN_INSIGHT = `## 本期摘要
本期連線數 1,234,567 次,比前一期 **增加 18%**;流量高峰在 11/12 14:00(平均的 3.2 倍)。

## 異常與變化
| 項目 | 本期 | 前一期 | 變化 |
| --- | --- | --- | --- |
| 阻擋 | 45,120 | 30,002 | +50% |
| 高嚴重度威脅 | 12 | 4 | +200% |

- 10.10.1.5(王小明)的上傳 12.4 GB,是第二名的 4 倍。

## 建議追查
1. 點開 11/12 14:00 的時段明細,看 10.10.1.5 上傳到哪裡。`;

const EXPLAIN_EVENTS = `## 本期摘要
本期共 1,284 筆威脅、5,230 筆 URL 過濾、37 筆資料過濾；WildFire 這段期間沒有資料。最值得注意的是 **10.10.1.3（王小明，NB-01）** 被外部 IP 203.0.113.9 嘗試 SSH 暴力破解。

## 值得注意
- **SSH Brute Force(40015)** 共 412 筆，來源 203.0.113.9（JP），動作 reset-both，已攔下。
- URL 過濾被擋最多的是 10.10.2.15（賭博類網站 380 筆）。
- 資料過濾有 12 筆上傳 .xlsx 到 dropbox，來源 10.10.3.21。
- WildFire 沒有資料，可能還沒收到這類 log，不代表沒有送檢。

## 建議追查
1. 到 **Log 明細查詢** 查來源 203.0.113.9，確認 10.10.1.3 的 SSH 服務是否需要對外。
2. 確認 10.10.3.21 上傳 .xlsx 的內容是否合規，必要時通知部門主管。`;
const EXPLAIN_THREAT = `## 這是什麼威脅
**SSH Brute Force Attempt(40015)** 是 SSH 暴力破解:短時間內大量嘗試登入 SSH(tcp/22),通常是外部掃描或殭屍網路。<img src=x onerror=alert(1)>

## 本期影響
- 共 **1,284 筆**,集中在 08:00–09:00;方向是外部 → 內部(用戶端 → 伺服器)。
- 影響主機:**10.10.130.66(FTP 伺服器)** 1,102 筆、10.10.1.5(王小明)182 筆。
- 防火牆動作全部是 reset-both,**已攔下**。

## 處理建議
1. 確認 10.10.130.66 是否需要對外開 SSH;不需要就關閉或限制來源。
2. 檢查 10.10.130.66 的登入紀錄,確認沒有成功登入。
3. 參考:[請重新登入確認](https://evil.example/login)`;

/** 熱力圖回答:提到前兩個異常時段(畫面上的按鈕會標「回答提到」) */
const explainHeatmap = (labels: string[]) => `## 異常時段
${labels
  .slice(0, 2)
  .map((l, i) => `${i + 1}. **${l}**:${i ? '阻擋數是同時段中位數的 6.2 倍,下班時間。' : '流量是同一小時中位數的 9.8 倍,集中在 10.10.1.5(王小明)。'}`)
  .join('\n')}

## 可能原因
- 可能是排程備份或系統更新(下班時間大量下載)。<img src=x onerror=alert(1)>

## 建議追查
1. 點下方的異常時段按鈕開時段明細,看 10.10.1.5 連到哪裡。`;

/** 假熱力圖的異常格:值最大的前 6 格(威脅指標先列有嚴重 / 高的) */
function mockCells(p: Record<string, string>) {
  const granularity = (p.granularity ?? 'year') as Granularity;
  const metric = (p.metric ?? 'threat') as Metric;
  const r = heatmapResponse({ granularity, metric, date: p.date ?? new Date().toISOString().slice(0, 10), now: Date.now() });
  const step = r.bucketSeconds * 1000;
  const cells = r.cells
    .filter((c) => c.v !== null && c.v > 0)
    .sort((a, b) => (b.v ?? 0) - (a.v ?? 0))
    .slice(0, 6)
    .map((c, i) => ({
      t: c.t,
      end: new Date(Date.parse(c.t) + step + 8 * 3600_000).toISOString().replace('Z', '+08:00').replace('.000', ''),
      v: c.v ?? 0,
      kind: metric === 'threat' ? 'severity' : 'high',
      ratio: metric === 'threat' ? null : Math.round((9.8 - i) * 10) / 10,
      offHours: i % 2 === 1,
      partial: i === 3,
    }));
  // 流量另加一格「偏低」
  const low = metric === 'traffic' ? r.cells.find((c) => c.v !== null && c.v > 0 && !cells.some((x) => x.t === c.t)) : undefined;
  if (low) cells.push({ t: low.t, end: new Date(Date.parse(low.t) + step + 8 * 3600_000).toISOString().replace('Z', '+08:00').replace('.000', ''), v: low.v ?? 0, kind: 'low', ratio: 0.1, offHours: false, partial: false });
  const start = (t: string) => (granularity === 'year' ? t.slice(0, 10) : t.slice(0, 16)).replace(/-/g, '/').replace('T', ' ');
  return { r, cells, labels: cells.map((c) => start(c.t)) };
}

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
  // AC4 AI 解讀:時段明細(slice)/ 分析儀表板(insight)。時段的 IP 含 .66 時模擬「時段明細還在查」;view=threat 時模擬前一期不足、資料有缺口
  if (path === '/api/netops/ai/explanations' && method === 'POST') {
    if (!ctx.need('netops.ai.use')) return true;
    const p = (b.params ?? {}) as Record<string, string>;
    const slice = b.kind === 'slice';
    // AC6:安全事件摘要(WildFire 模擬沒有資料;期間超過一天時 URL 過濾模擬統計不完整)
    if (b.kind === 'events') {
      const multi = String(p.from) !== String(p.to ?? p.from);
      const types = [
        { type: 'threat', rows: 1284, empty: false, partial: false },
        { type: 'url', rows: 5230, empty: false, partial: multi },
        { type: 'data', rows: 37, empty: false, partial: false },
        { type: 'wildfire', rows: 0, empty: true, partial: false },
      ];
      const meta = { model: 'Qwen3.6-35B-A3B-FP8', source: 'clickhouse', contextChars: 3100, clipped: false, notes: [], vectorError: false, kind: 'events', from: p.from, to: p.to ?? p.from, partial: multi, types };
      const events: [string, unknown][] = [['meta', meta]];
      if (b.think) events.push(['thinking', { chars: 500 }]);
      events.push(...contentEvents(EXPLAIN_EVENTS), ['done', { finish: 'stop', truncated: false }]);
      void stream(ctx, events, 40);
      return true;
    }
    // AC5:威脅說明(名稱含 old 時模擬一部分超過保留期限)、熱力圖異常格
    if (b.kind === 'threat' || b.kind === 'heatmap') {
      const base5 = { model: 'Qwen3.6-35B-A3B-FP8', source: 'clickhouse', contextChars: 1800, clipped: false, notes: [], vectorError: false, gapsKnown: true };
      let meta: Record<string, unknown>;
      let text: string;
      if (b.kind === 'threat') {
        const old = String(p.name ?? '').toLowerCase().includes('old');
        meta = { ...base5, kind: 'threat', name: p.name, match: /^\d+$/.test(String(p.name)) ? 'id' : 'name', from: p.from, to: p.to, count: 1284, partial: false, skipped: old ? { from: p.from, to: '2026-11-04T00:00:00+08:00' } : null };
        text = EXPLAIN_THREAT;
      } else {
        const m = mockCells(p);
        meta = { ...base5, kind: 'heatmap', granularity: m.r.granularity, metric: m.r.metric, date: m.r.date, from: m.r.from, to: m.r.to, partial: m.cells.some((c) => c.partial), nulls: m.r.cells.filter((c) => c.v === null).length, cells: m.cells };
        text = explainHeatmap(m.labels);
      }
      const events: [string, unknown][] = [['meta', meta]];
      if (b.think) events.push(['thinking', { chars: 500 }]);
      events.push(...contentEvents(text), ['done', { finish: 'stop', truncated: false }]);
      void stream(ctx, events, 40);
      return true;
    }
    const base = { model: 'Qwen3.6-35B-A3B-FP8', source: 'clickhouse', contextChars: 2400, clipped: false, notes: [{ id: '202611021030-a1b2c3', title: '10.10.130.66 FTP 伺服器', related: true }], vectorError: false };
    const meta = slice
      ? { ...base, kind: 'slice', type: p.type ?? 'traffic', start: p.start, end: p.end, sliceSource: 'hot', partial: false, gapsKnown: true, waited: String(p.ip ?? p.src ?? '').includes('.66') }
      : { ...base, kind: 'insight', view: p.view, from: p.from, to: p.to, partial: p.view === 'threat', gapsKnown: true, prev: p.view !== 'threat' };
    const events: [string, unknown][] = [];
    if (slice && meta.waited) events.push(['scan', { label: '查詢時段明細', source: 'clickhouse', step: 'slice', waiting: true }], ['heartbeat', {}], ['heartbeat', {}]);
    events.push(['meta', meta]);
    if (b.think) events.push(['thinking', { chars: 500 }]);
    const text = slice ? EXPLAIN_SLICE : EXPLAIN_INSIGHT;
    events.push(...contentEvents(text), ['done', { finish: 'stop', truncated: false }]);
    void stream(ctx, events, 40);
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
