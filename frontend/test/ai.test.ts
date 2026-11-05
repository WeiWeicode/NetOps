/**
 * AI 問答與分析(IMPL-PLAN A1;docs/API.md §10.1):SSE 解析、POST 串流(CSRF、錯誤)、事件 → 訊息、對話紀錄、看原始紀錄的條件
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@giganexus/web-kit', async (orig) => ({
  ...(await orig<typeof import('@giganexus/web-kit')>()),
  readCookie: () => 'csrf-1',
  refreshSession: async () => false,
  redirectToLogin: () => {},
}));

const { AiStreamError, createSseParser, streamPost } = await import('@/api/ai');
const { ApiError } = await import('@giganexus/web-kit');
const { applyEvent, historyOf, NOTE_RE, searchLink } = await import('@/composables/aiChat');

afterEach(() => vi.unstubAllGlobals());

/** SSE 回應(依指定的分段送出) */
const sse = (chunks: string[], status = 200) => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
};

describe('createSseParser', () => {
  it('依空行切事件;資料塊切在事件中間、\\r\\n、格式錯誤的事件', () => {
    const parse = createSseParser();
    expect(parse('event: open\ndata: {"a":1}\n\nevent: con')).toEqual([{ event: 'open', data: { a: 1 } }]);
    expect(parse('tent\r\ndata: {"text":"嗨"}\r\n\r\n')).toEqual([{ event: 'content', data: { text: '嗨' } }]);
    expect(parse('event: x\ndata: {壞\n\nretry: 5000\n\n')).toEqual([]);
  });
});

describe('streamPost', () => {
  it('POST 帶 CSRF 與 JSON;略過 open / heartbeat;依序交出事件', async () => {
    const fetchMock = vi.fn(async () => sse(['event: open\ndata: {}\n\n', 'event: meta\ndata: {"files":2}\n\nevent: heartbeat\ndata: {}\n\nevent: content\nda', 'ta: {"text":"A"}\n\nevent: done\ndata: {"finish":"stop"}\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const got: string[] = [];
    await streamPost('/api/netops/ai/analyses', { from: '2026-11-02' }, (e) => got.push(e.event));
    expect(got).toEqual(['meta', 'content', 'done']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/netops/ai/analyses');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-1');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init.body).toBe('{"from":"2026-11-02"}');
  });

  it('error 事件 → AiStreamError(code、message)', async () => {
    vi.stubGlobal('fetch', async () => sse(['event: meta\ndata: {}\n\nevent: error\ndata: {"code":"NETOPS_AI_UNAVAILABLE","message":"AI 分析失敗:無法連線 AI 服務"}\n\n']));
    const e = await streamPost('/api/netops/ai/questions', {}, () => {}).catch((x) => x);
    expect(e).toBeInstanceOf(AiStreamError);
    expect(e.code).toBe('NETOPS_AI_UNAVAILABLE');
  });

  it('沒收到 done 就結束(連線中途斷掉)→ AiStreamError NETOPS_STREAM_INCOMPLETE,已收到的事件照常交出', async () => {
    vi.stubGlobal('fetch', async () => sse(['event: meta\ndata: {}\n\nevent: content\ndata: {"text":"半"}\n\n']));
    const got: string[] = [];
    const e = await streamPost('/api/netops/ai/analyses', {}, (x) => got.push(x.event)).catch((x) => x);
    expect(got).toEqual(['meta', 'content']);
    expect(e).toBeInstanceOf(AiStreamError);
    expect(e.code).toBe('NETOPS_STREAM_INCOMPLETE');
  });

  it('最後一個事件沒有結尾空行也會處理', async () => {
    vi.stubGlobal('fetch', async () => sse(['event: content\ndata: {"text":"A"}\n\nevent: done\ndata: {"finish":"stop"}']));
    const got: string[] = [];
    await streamPost('/api/netops/ai/analyses', {}, (x) => got.push(x.event));
    expect(got).toEqual(['content', 'done']);
  });

  it('串流開始前的錯誤(429 等)→ ApiError', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 'NETOPS_STREAM_BUSY', message: '已達上限', requestId: 'r1' }), { status: 429, headers: { 'content-type': 'application/json' } }));
    const e = await streamPost('/api/netops/ai/questions', {}, () => {}).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(429);
    expect(e.code).toBe('NETOPS_STREAM_BUSY');
  });
});

describe('applyEvent(同舊版 PaAsk.vue 的事件處理)', () => {
  it('meta → scan → evidence → notes → thinking → content → done', () => {
    const r = { role: 'assistant' as const, content: '' } as Parameters<typeof applyEvent>[0];
    applyEvent(r, { event: 'meta', data: { ips: ['10.10.1.5'], ports: [445] } }, false);
    expect(r.status).toBe('查詢 10.10.1.5、Port 445 的 log...');
    applyEvent(r, { event: 'scan', data: { filesScanned: 1, files: 3, matched: 1200 } }, false);
    expect(r.status).toBe('掃描 log 1 / 3 個檔,找到 1,200 筆...');
    applyEvent(r, { event: 'scan', data: { mode: 'flows' } }, false);
    expect(r.status).toBe('查詢連線組合統計...');
    applyEvent(r, { event: 'evidence', data: { label: 'x', matched: 3, partial: true } }, false);
    expect(r.evidence?.partial).toBe(true);
    applyEvent(r, { event: 'notes', data: { used: [{ id: 'a', title: 'A', related: true }], omitted: [], vectorError: true } }, false);
    expect(r.vectorError).toBe(true);
    applyEvent(r, { event: 'thinking', data: { chars: 1200 } }, false);
    expect(r.status).toBe('AI 思考中...(1,200 字)');
    applyEvent(r, { event: 'content', data: { text: '## 結論' } }, false);
    applyEvent(r, { event: 'content', data: { text: '\n正常' } }, false);
    expect(r.content).toBe('## 結論\n正常');
    applyEvent(r, { event: 'done', data: { finish: 'length', truncated: true } }, false);
    expect(r.truncated).toBe(true);
  });

  it('AD 問答的 meta 狀態;沒有 IP 時整理期間統計', () => {
    const r = { role: 'assistant' as const, content: '' } as Parameters<typeof applyEvent>[0];
    applyEvent(r, { event: 'meta', data: { ips: [], ports: [] } }, true);
    expect(r.status).toBe('整理 AD 事件記錄...');
    applyEvent(r, { event: 'meta', data: { ips: [], ports: [] } }, false);
    expect(r.status).toBe('整理期間統計...');
  });
});

describe('historyOf / NOTE_RE / searchLink', () => {
  it('對話紀錄不含記錄筆記的訊息與錯誤,最多送 20 則', () => {
    const m = [
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: 'a1' },
      { role: 'user' as const, content: '請記錄 x', kind: 'note' as const },
      { role: 'assistant' as const, content: '', error: '失敗' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` })),
    ];
    const h = historyOf(m);
    expect(h).toHaveLength(20);
    expect(h.at(-1)).toEqual({ role: 'assistant', content: 'm29' });
    expect(historyOf(m.slice(0, 4))).toEqual([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  });

  it('「請記錄」類的說法當成要 AI 記錄', () => {
    for (const s of ['請記錄:10.10.130.154 是防毒伺服器', '記起來 5517 是正常的', '幫我記下這台']) expect(NOTE_RE.test(s), s).toBe(true);
    expect(NOTE_RE.test('10.10.1.5 為什麼被擋')).toBe(false);
  });

  it('看原始紀錄:PA 帶 IP / 關鍵字 / Port / 阻擋;AD 帶 IP', () => {
    const m = { role: 'assistant' as const, content: '', ips: ['10.10.1.5', '8.8.8.0/24'], ports: [443], evidence: { label: '', block: 3, allow: 0 } };
    expect(searchLink(m, '2026-11-02T00:00', '2026-11-02T23:59', false)).toEqual({ path: '/firewall/search', query: { from: '2026-11-02T00:00', to: '2026-11-02T23:59', ip: '10.10.1.5', q: '8.8.8.0', port: '443', action: 'block' } });
    expect(searchLink(m, 'a', 'b', true)).toEqual({ path: '/ad/search', query: { from: 'a', to: 'b', ip: '10.10.1.5' } });
  });
});
