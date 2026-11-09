/**
 * A1 AI API(docs/API.md §10;IMPL-PLAN A1):分析、問答(SSE),語意搜尋、向量庫、外部 IP 自動學習(翻譯與整理筆記依 2026-11-09 決定不搬)
 *   - SSE 依 S0 §3.6:標頭、立即送 open、事件順序、名額滿回 429(不回 5xx)
 *   - 驗證錯誤在串流開始前回 4xx;模型錯誤以 error 事件回傳,不含主機位址
 *   - 送給模型的內容:問答帶查到的 log 彙整與知識庫筆記(不送原始 log 檔)
 * 模型、Qdrant、RDAP 都是本機假服務(AGENT.md §9)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createFakeFtp, type FakeFtp } from '../fixtures/fake-ftp.js';
import { fakeAiHost } from '../fixtures/fake-ai.js';
import { trafficCsv } from '../fixtures/fake-logs.js';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

/** SSE 回應 → [{ event, data }] */
const events = (body: string) =>
  body
    .split('\n\n')
    .filter((b) => b.includes('event: '))
    .map((b) => ({ event: /event: (.+)/.exec(b)![1]!, data: JSON.parse(/data: (.+)/.exec(b)![1]!) }));
const names = (body: string) => events(body).map((e) => e.event);

const FILES: Record<string, string> = {
  '/PA-560_traffic_2026_11_02_last_calendar_day_0.csv': trafficCsv('2026/11/01', 1500, 41),
  '/PA-560_traffic_2026_11_03_last_calendar_day_0.csv': trafficCsv('2026/11/02', 1500, 42),
};

/** AD 問答:不需要已分析的 PA log,適合測串流本身(名額、斷線、模型錯誤) */
const AD_ASK = { from: '2026-12-01T00:00:00+08:00', to: '2026-12-01T23:00:00+08:00', question: '帳號被鎖定', source: 'ad' };

describe('AI 未設定(LLM_URL 空白)', () => {
  let t: TestApp;
  before(async () => (t = await createTestApp()));
  after(async () => t.close());

  it('狀態回 enabled false;分析、問答、外部 IP 學習回 409 NETOPS_AI_DISABLED(不回 5xx)', async () => {
    assert.deepEqual((await t.call({ url: '/v1/ai/status' })).json(), { enabled: false, ok: false, model: '', message: '尚未設定 AI 服務(LLM_URL)' });
    for (const [url, payload] of [
      ['/v1/ai/analyses', { from: '2026-11-02' }],
      ['/v1/ai/questions', { from: '2026-11-02T00:00:00+08:00', to: '2026-11-02T23:59:00+08:00', question: '10.10.1.5' }],
      ['/v1/kb/ip-learnings', {}],
    ] as const) {
      const res = await t.call({ method: 'POST', url, payload });
      assert.equal(res.statusCode, 409, url);
      assert.equal(res.json().code, 'NETOPS_AI_DISABLED', url);
    }
    assert.equal((await t.call({ url: '/v1/kb/ip-learning' })).json().enabled, false);
    assert.equal((await t.call({ method: 'POST', url: '/v1/kb/vector-syncs' })).json().code, 'NETOPS_VECTOR_SYNC_DISABLED');
  });

  it('翻譯與整理筆記不搬(2026-11-09,D25):沒有這兩支 API', async () => {
    for (const url of ['/v1/ai/translations', '/v1/ai/notes']) assert.equal((await t.call({ method: 'POST', url, payload: { text: 'x', target: 'en' } })).statusCode, 404, url);
  });
});

describe('AI 已設定', () => {
  const host = fakeAiHost({ streamDelayMs: 0 });
  let t: TestApp;
  let ftp: FakeFtp;
  let base = '';

  before(async () => {
    base = await host.start();
    ftp = createFakeFtp();
    for (const [p, s] of Object.entries(FILES)) ftp.put(p, Buffer.from(s));
    t = await createTestApp({ ftp, env: { LLM_URL: `${base}/v1`, EMBED_URL: `${base}/v1`, QDRANT_URL: base }, ai: { heartbeatMs: 50 } });
    const items = Object.keys(FILES).map((p) => ({ path: p, size: ftp.files.get(p)!.data.length, modified: '2026-11-03T00:05:00.000Z' }));
    assert.equal((await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items } })).statusCode, 200);
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/pa/status' })).json().traffic.busy);
    fs.writeFileSync(path.join(t.dataDir, 'knowledge', '202611011030-a1b2c3.md'), '---\ntitle: 內部 PC 網段\nips: 10.10.1.0/24\ntags: 網段\nauthor: S112009 佳緯\ncreated: 2026/11/01 10:30\nupdated: 2026/11/01 10:30\nupdatedBy: S112009 佳緯\nsource: \n---\n\n使用者電腦。\n');
  });
  after(async () => {
    await t.close();
    host.close();
  });
  const chats = () => host.reqs.splice(0).filter((r) => r.url === '/v1/chat/completions');

  it('狀態:模型名稱,不回主機位址', async () => {
    const s = (await t.call({ url: '/v1/ai/status' })).json();
    assert.deepEqual(s, { enabled: true, ok: true, model: 'fake-model', message: '' });
    assert.ok(!JSON.stringify(s).includes('127.0.0.1'));
  });

  it('期間分析:SSE 標頭、事件順序;只送統計摘要與知識庫', async () => {
    host.reqs.splice(0);
    const res = await t.call({ method: 'POST', url: '/v1/ai/analyses', payload: { from: '2026-11-01', to: '2026-11-02', question: '有沒有掃描' } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
    const n = names(res.body).filter((e) => e !== 'heartbeat');
    assert.deepEqual(n, ['open', 'meta', 'content', 'content', 'done']);
    const meta = events(res.body).find((e) => e.event === 'meta')!.data;
    assert.equal(meta.model, 'fake-model');
    assert.equal(meta.files, 2);
    assert.equal(meta.missing, 0);
    assert.equal(meta.from, '2026-11-01');
    assert.equal(events(res.body).at(-1)!.data.truncated, true);
    const [c] = chats();
    const user = c!.body.messages[1].content as string;
    assert.ok(user.includes('# 分析範圍：2026/11/01 ~ 2026/11/02'));
    assert.ok(user.includes('使用者另外想了解：有沒有掃描'));
    assert.ok(user.includes('內部 PC 網段'), '帶入知識庫');
    assert.ok(!user.includes('Receive Time'), '不送原始 log');
  });

  it('期間分析:沒有資料 404、日期錯誤 400(串流開始前)', async () => {
    const a = await t.call({ method: 'POST', url: '/v1/ai/analyses', payload: { from: '2026-12-01' } });
    assert.equal(a.statusCode, 404);
    assert.equal(a.json().code, 'NETOPS_PA_NO_DATA');
    const b = await t.call({ method: 'POST', url: '/v1/ai/analyses', payload: { from: '2026/11/01' } });
    assert.equal(b.statusCode, 400);
  });

  it('問答:問題有 IP → 查連線組合統計、彙整後送給模型;追問沿用條件、同條件用快取', async () => {
    host.reqs.splice(0);
    const payload = { from: '2026-11-01T00:00:00+08:00', to: '2026-11-02T23:59:00+08:00', question: '10.10.1.5 為什麼連不到 8.8.8.8' };
    const res = await t.call({ method: 'POST', url: '/v1/ai/questions', payload });
    assert.equal(res.statusCode, 200);
    const ev = events(res.body);
    const meta = ev.find((e) => e.event === 'meta')!.data;
    assert.deepEqual(meta.ips, ['10.10.1.5', '8.8.8.8']);
    assert.equal(meta.from, '2026-11-01T00:00:00+08:00');
    const evidence = ev.find((e) => e.event === 'evidence')!.data;
    assert.equal(evidence.flowFiles, 2, '兩個檔案都有連線組合統計,不掃 FTP');
    assert.equal(evidence.partial, false);
    assert.equal(evidence.cached, false);
    const notes = ev.find((e) => e.event === 'notes')!.data;
    assert.equal(notes.vectorError, false);
    assert.ok(notes.used.some((n: { related: boolean }) => n.related), '10.10.1.5 在筆記的網段內');
    assert.equal(ev.at(-1)!.event, 'done');
    const [c] = chats();
    const user = c!.body.messages.at(-1).content as string;
    assert.ok(user.includes('## 系統查詢條件：10.10.1.5 與 8.8.8.8 之間的連線（不分方向）'));
    assert.ok(c!.body.messages[0].content.startsWith('你是企業 IT 的資深網路與資安顧問，協助 MIS'), '問答提示');

    // 追問:沒有 IP 時沿用前面的條件,10 分鐘內用快取
    const follow = await t.call({ method: 'POST', url: '/v1/ai/questions', payload: { ...payload, question: '那要怎麼開放?', history: [{ role: 'user', content: payload.question }, { role: 'assistant', content: '被擋了' }] } });
    const ev2 = events(follow.body);
    assert.deepEqual(ev2.find((e) => e.event === 'meta')!.data.ips, ['10.10.1.5', '8.8.8.8']);
    // 用快取:不再查統計 / 掃描(cached 旗標同舊版,命中超過 1 秒才為 true)
    assert.ok(!ev2.some((e) => e.event === 'scan'));
    assert.equal(ev2.find((e) => e.event === 'evidence')!.data.matched, evidence.matched);
    const [c2] = chats();
    assert.deepEqual(c2!.body.messages.slice(1, 3), [{ role: 'user', content: payload.question }, { role: 'assistant', content: '被擋了' }]);
  });

  it('問答:FTP 掃描(沒有連線組合統計的檔案),逾時標 partial', async () => {
    // 刪掉一個統計檔:改從 FTP 掃原始 log
    const flows = fs.readdirSync(path.join(t.dataDir, 'palogs/flows'));
    fs.rmSync(path.join(t.dataDir, 'palogs/flows', flows[0]!));
    const res = await t.call({ method: 'POST', url: '/v1/ai/questions', payload: { from: '2026-11-01T00:00:00+08:00', to: '2026-11-02T23:59:00+08:00', question: '10.10.2.20 port 443' } });
    const ev = events(res.body);
    const evidence = ev.find((e) => e.event === 'evidence')!.data;
    assert.equal(evidence.flowFiles, 1);
    assert.equal(evidence.filesScanned, 2);
    assert.ok(evidence.rows > 0, '從 FTP 掃了原始 log');
    assert.ok(ev.some((e) => e.event === 'scan'));
    chats();
  });

  it('問答:驗證(期間超過 31 天、結束早於開始、沒有時區、問題空白)回 400', async () => {
    for (const payload of [
      { from: '2026-10-01T00:00:00+08:00', to: '2026-11-02T00:00:00+08:00', question: 'x' },
      { from: '2026-11-02T00:00:00+08:00', to: '2026-11-01T00:00:00+08:00', question: 'x' },
      { from: '2026-11-01T00:00', to: '2026-11-02T00:00', question: 'x' },
      { from: '2026-11-01T00:00:00+08:00', to: '2026-11-02T00:00:00+08:00', question: '   ' },
    ]) assert.equal((await t.call({ method: 'POST', url: '/v1/ai/questions', payload })).statusCode, 400, JSON.stringify(payload));
    // 沒有 PA 資料且不是 AD 問題 → 404;AD 問題(source ad)→ 200,標示沒有 AD 資料
    const none = await t.call({ method: 'POST', url: '/v1/ai/questions', payload: { from: '2026-12-01T00:00:00+08:00', to: '2026-12-01T23:00:00+08:00', question: '10.10.1.5' } });
    assert.equal(none.statusCode, 404);
    const adq = await t.call({ method: 'POST', url: '/v1/ai/questions', payload: { from: '2026-12-01T00:00:00+08:00', to: '2026-12-01T23:00:00+08:00', question: '帳號被鎖定', source: 'ad' } });
    assert.equal(adq.statusCode, 200);
    assert.equal(events(adq.body).find((e) => e.event === 'ad')!.data.label, '這段時間沒有已匯入的 AD 事件記錄');
    chats();
  });

  it('同時進行的 AI 回答每人 2 個,超過回 429 NETOPS_STREAM_BUSY', async () => {
    host.setStreamDelay(300);
    try {
      const p = { method: 'POST' as const, url: '/v1/ai/analyses', payload: { from: '2026-11-01' } };
      const a = t.call(p);
      const b = t.call(p);
      await new Promise((r) => setTimeout(r, 100));
      const c = await t.call(p);
      assert.equal(c.statusCode, 429);
      assert.equal(c.json().code, 'NETOPS_STREAM_BUSY');
      // 別人不受影響
      const other = t.call({ ...p, emp: 'S000001' });
      for (const r of await Promise.all([a, b, other])) assert.equal(r.statusCode, 200);
      assert.ok(names((await a).body).includes('heartbeat'), '等模型時有心跳');
    } finally {
      host.setStreamDelay(0);
      chats();
    }
  });

  it('語意搜尋與向量庫狀態;沒開 VECTOR_SYNC 時不能同步', async () => {
    host.points.set('p1', { id: 'p1', payload: { noteId: '202611011030-a1b2c3', title: '內部 PC 網段' } });
    const res = await t.call({ url: '/v1/kb/semantic-search?q=' + encodeURIComponent('使用者電腦在哪個網段') });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // 假 Qdrant 固定回 202611011030-a1b2c3(score 0.712)
    assert.equal(body.items[0].id, '202611011030-a1b2c3');
    assert.equal(body.items[0].score, 0.712);
    assert.equal(body.vector.sync, false);
    const st = (await t.call({ url: '/v1/kb/vector-status' })).json();
    assert.equal(st.enabled, true);
    assert.equal((await t.call({ method: 'POST', url: '/v1/kb/vector-syncs' })).json().code, 'NETOPS_VECTOR_SYNC_DISABLED');
    assert.ok(host.reqs.splice(0).every((r) => r.method !== 'PUT' && !r.url.includes('delete')), '沒有寫入 Qdrant');
  });

  it('模型連不到:error 事件,訊息不含主機位址', async () => {
    const t2 = await createTestApp({ env: { LLM_URL: 'http://127.0.0.1:1/v1' } });
    try {
      // AD 問答不需要 PA 資料:驗證通過後開始串流,取模型名稱時失敗
      const res = await t2.call({ method: 'POST', url: '/v1/ai/questions', payload: AD_ASK });
      assert.equal(res.statusCode, 200, '已開始串流,錯誤以事件回傳(不回 5xx)');
      const err = events(res.body).find((e) => e.event === 'error')!.data;
      assert.equal(err.code, 'NETOPS_AI_UNAVAILABLE');
      assert.ok(!err.message.includes('127.0.0.1'), err.message);
      assert.equal((await t2.call({ url: '/v1/ai/status' })).json().ok, false);
    } finally {
      await t2.close();
    }
  });
});

describe('外部 IP 自動學習 API', () => {
  const host = fakeAiHost();
  let t: TestApp;
  before(async () => {
    const base = await host.start();
    const ftp = createFakeFtp();
    for (const [p, s] of Object.entries(FILES)) ftp.put(p, Buffer.from(s));
    // RDAP 用假回應;其他(假 AI 主機)照常連線
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://rdap.')) {
        const ip = u.replace(/^.*\//, '');
        return new Response(JSON.stringify({ handle: 'H', name: `NET ${ip}`, startAddress: ip.replace(/\.\d+$/, '.0'), endAddress: ip.replace(/\.\d+$/, '.255') }));
      }
      return fetch(url, init);
    }) as typeof fetch;
    t = await createTestApp({ ftp, env: { LLM_URL: `${base}/v1` }, ai: { fetch: fakeFetch } });
    const items = Object.keys(FILES).map((p) => ({ path: p, size: ftp.files.get(p)!.data.length, modified: '2026-11-03T00:05:00.000Z' }));
    await t.call({ method: 'POST', url: '/v1/ftp/pa/analyses', payload: { items } });
    await waitFor(async () => !(await t.call({ url: '/v1/ftp/pa/status' })).json().traffic.busy);
  });
  after(async () => {
    await t.close();
    host.close();
  });

  it('送出 202、執行中 409、完成後有結果;狀態帶 hour', async () => {
    const s0 = (await t.call({ url: '/v1/kb/ip-learning' })).json();
    assert.equal(s0.enabled, true);
    assert.equal(s0.hour, -1);
    const res = await t.call({ method: 'POST', url: '/v1/kb/ip-learnings', payload: { days: 60 } });
    assert.equal(res.statusCode, 202);
    const again = await t.call({ method: 'POST', url: '/v1/kb/ip-learnings', payload: {} });
    assert.ok(again.statusCode === 409 || again.statusCode === 202);
    if (again.statusCode === 409) assert.equal(again.json().code, 'NETOPS_IPLEARN_BUSY');
    await waitFor(async () => !(await t.call({ url: '/v1/kb/ip-learning' })).json().busy, 20000);
    const done = (await t.call({ url: '/v1/kb/ip-learning' })).json();
    assert.equal(done.error, '');
    assert.ok(done.result, JSON.stringify(done.log));
    assert.match(done.finishedAt, /\+08:00$/);
    assert.equal((await t.call({ method: 'POST', url: '/v1/kb/ip-learnings', payload: { days: 61 } })).statusCode, 400);
  });
});

describe('AI 串流的名額與生命週期(S0 §3.6;審查補測)', () => {
  const host = fakeAiHost({ streamDelayMs: 0 });
  let base = '';
  before(async () => (base = await host.start()));
  after(() => host.close());
  const ASK = { method: 'POST' as const, url: '/v1/ai/questions', payload: AD_ASK };
  /** 假模型延遲 400 毫秒才開始回答,讓前面的請求佔住名額 */
  const slow = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/chat/completions')) await new Promise((r) => setTimeout(r, 400));
    return fetch(url, init);
  }) as typeof fetch;

  it('分析與問答共用每人名額;結束後歸還', async () => {
    const t = await createTestApp({ env: { LLM_URL: `${base}/v1` }, ai: { fetch: slow } });
    try {
      const a = t.call(ASK);
      const b = t.call(ASK);
      await new Promise((r) => setTimeout(r, 100));
      const c = await t.call(ASK);
      assert.equal(c.statusCode, 429);
      assert.equal(c.json().code, 'NETOPS_STREAM_BUSY');
      for (const r of await Promise.all([a, b])) assert.equal(r.statusCode, 200);
      const again = await t.call(ASK);
      assert.equal(again.statusCode, 200, '結束後歸還名額');
      assert.ok(events(again.body).some((e) => e.event === 'done'));
    } finally {
      await t.close();
    }
  });

  it('全系統上限(AI_MAX_STREAMS):別人也被擋', async () => {
    const t = await createTestApp({ env: { LLM_URL: `${base}/v1`, AI_MAX_STREAMS: '2' }, ai: { fetch: slow } });
    try {
      const a = t.call({ ...ASK, emp: 'S000001' });
      const b = t.call({ ...ASK, emp: 'S000002' });
      await new Promise((r) => setTimeout(r, 100));
      const c = await t.call({ ...ASK, emp: 'S000003' });
      assert.equal(c.statusCode, 429);
      await Promise.all([a, b]);
    } finally {
      await t.close();
    }
  });

  it('用戶端中途斷線:中斷模型呼叫並歸還名額', async () => {
    let aborted = 0;
    let calls = 0;
    // 第一次模型呼叫一直不回(直到被中斷),之後照常
    const hang = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/chat/completions') && ++calls === 1)
        return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => (aborted++, rej(new DOMException('aborted', 'AbortError')))));
      return fetch(url, init);
    }) as typeof fetch;
    const t = await createTestApp({ env: { LLM_URL: `${base}/v1`, AI_MAX_STREAMS_PER_USER: '1' }, ai: { fetch: hang } });
    try {
      await t.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (t.app.server.address() as AddressInfo).port;
      const token = await t.token();
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/ai/questions', headers: { 'content-type': 'application/json', 'x-internal-token': token } }, (res) => {
          assert.equal(res.statusCode, 200);
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => {});
        req.end(JSON.stringify(AD_ASK));
        setTimeout(() => reject(new Error('沒有收到第一個事件')), 3000);
      });
      await waitFor(() => aborted === 1, 3000);
      // 名額已歸還(每人 1 個):同一人可以再問一次並完成
      const again = await t.call(ASK);
      assert.equal(again.statusCode, 200);
      assert.ok(events(again.body).some((e) => e.event === 'done'));
    } finally {
      await t.close();
    }
  });
});
