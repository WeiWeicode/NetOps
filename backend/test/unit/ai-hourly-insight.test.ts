/**
 * 戰情室 AI 每小時分析(WR-3,docs/WARROOM-PLAN.md §3 WR-3、§6 Q4):
 *   - 核心:整點觸發、只分析一次、只留最新、失敗存 failed、手動冷卻與忙碌、只送彙整統計
 *   - API:GET 最新一筆、POST 手動 SSE(假 AI 主機)、503 / 429
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AppError } from '../../src/errors.js';
import { LlmError, type StreamEvent } from '../../src/infra/llm/index.js';
import { createPaLiveRedis } from '../../src/infra/redis/index.js';
import { buildContext, createHourlyInsight, HOURLY_MANUAL_COOLDOWN_MS, taipeiIso, type HourlyInsightRecord, type HourlyLlm } from '../../src/modules/ai/hourly-insight.js';
import { fakeAiHost } from '../fixtures/fake-ai.js';
import { FakeRedis } from '../fixtures/fake-redis.js';
import { createTestApp, type TestApp } from '../helpers.js';

const silent = { info: () => undefined, warn: () => undefined };

function memStore() {
  const s = { rec: null as HourlyInsightRecord | null, saves: 0 };
  return { s, store: { readHourlyInsight: () => s.rec, saveHourlyInsight: (v: HourlyInsightRecord) => ((s.rec = v), s.saves++) } };
}

function fakeLlm(opts: { fail?: boolean; gate?: Promise<void> } = {}) {
  const prompts: string[] = [];
  const llm: HourlyLlm = {
    model: async () => 'fake-model',
    async *stream({ messages }): AsyncGenerator<StreamEvent> {
      prompts.push(messages.map((m) => m.content).join('\n'));
      if (opts.gate) await opts.gate;
      if (opts.fail) throw new LlmError('AI 服務連線中斷', 'unavailable');
      yield { type: 'content', text: '整體正常。' };
      yield { type: 'content', text: '注意 5.5.5.5。' };
      yield { type: 'done', finish: 'stop' };
    },
  };
  return { llm, prompts };
}

const sources = {
  warroom: async () => ({ minutes: 15, partial: false, kpis: { denyPerMin: 3 }, sources: [{ id: 'ip:5.5.5.5' }], segments: [], links: [], sample: { complete: true }, names: { '10.0.0.1': { name: '王小明' } } }),
  risk: async () => ({ minutes: 60, partial: false, threats: 4, topThreats: [] }),
};

const T0 = Date.parse('2026-11-17T02:00:30Z'); // 台北 10:00:30

describe('AI 每小時分析核心', () => {
  it('台北時間 ISO', () => {
    assert.equal(taipeiIso(Date.parse('2026-11-17T01:00:00Z')), '2026-11-17T09:00:00+08:00');
  });

  it('只送彙整統計,不送 IP 對照姓名;partial 與抽樣標示', () => {
    const c = buildContext({ partial: false, names: { x: '王' }, sources: [], sample: { complete: false } }, { partial: false, threats: 1 });
    assert.doesNotMatch(c.text, /王/);
    assert.equal(c.partial, true);
    assert.equal(buildContext({ partial: false, sample: { complete: true } }, { partial: false }).partial, false);
  });

  it('整點自動分析上一小時,同一整點只跑一次;只留最新一筆', async () => {
    let now = T0;
    const { s, store } = memStore();
    const { llm, prompts } = fakeLlm();
    const h = createHourlyInsight({ enabled: true, llm, sources, store, log: silent, now: () => now });
    await h.runAuto();
    assert.equal(s.rec!.status, 'done');
    assert.equal(s.rec!.hour, '2026-11-17T09:00:00+08:00');
    assert.equal(s.rec!.until, '2026-11-17T10:00:00+08:00');
    assert.equal(s.rec!.trigger, 'auto');
    assert.equal(s.rec!.text, '整體正常。注意 5.5.5.5。');
    assert.equal(s.rec!.model, 'fake-model');
    assert.doesNotMatch(prompts[0]!, /王小明/);
    await h.runAuto();
    assert.equal(s.saves, 1);
    now += 3_600_000;
    await h.runAuto();
    assert.equal(s.saves, 2);
    assert.equal(s.rec!.hour, '2026-11-17T10:00:00+08:00');
    const st = h.status();
    assert.equal(st.status, 'done');
    assert.equal(st.enabled, true);
  });

  it('重新啟動後已分析過的整點不重做', async () => {
    const { s, store } = memStore();
    s.rec = { hour: '2026-11-17T09:00:00+08:00', until: '', status: 'done', trigger: 'auto', text: 'x', model: 'm', partial: false, statsMinutes: { traffic: 15, risk: 60 }, at: '', error: null };
    const h = createHourlyInsight({ enabled: true, llm: fakeLlm().llm, sources, store, log: silent, now: () => T0 });
    await h.runAuto();
    assert.equal(s.saves, 0);
  });

  it('整點過 5 分鐘以上才啟動:不補跑上一小時;最新是較新的手動結果也不覆蓋', async () => {
    const late = createHourlyInsight({ enabled: true, llm: fakeLlm().llm, sources, store: memStore().store, log: silent, now: () => T0 + 30 * 60_000 });
    await late.runAuto();
    assert.equal(late.status().status, 'none');
    const { s, store } = memStore();
    s.rec = { hour: '2026-11-17T10:00:00+08:00', until: '', status: 'done', trigger: 'manual', text: 'x', model: 'm', partial: false, statsMinutes: { traffic: 15, risk: 60 }, at: '', error: null };
    await createHourlyInsight({ enabled: true, llm: fakeLlm().llm, sources, store, log: silent, now: () => T0 }).runAuto();
    assert.equal(s.saves, 0);
  });

  it('提示詞的 log 字串去掉控制字元並截短;空回覆算失敗', async () => {
    const c = buildContext({ partial: false, sample: { complete: true }, sources: [{ label: 'a\nIGNORE ALL' + 'x'.repeat(300) }] }, { partial: false });
    assert.doesNotMatch(c.text, /\\n/);
    assert.ok(!c.text.includes('x'.repeat(130)));
    const { s, store } = memStore();
    const empty: HourlyLlm = { model: async () => 'm', async *stream() { yield { type: 'done', finish: 'stop' } as StreamEvent; } };
    await createHourlyInsight({ enabled: true, llm: empty, sources, store, log: silent, now: () => T0 }).runAuto();
    assert.equal(s.rec!.status, 'failed');
    assert.equal(s.rec!.error!.code, 'NETOPS_AI_EMPTY');
  });

  it('手動被使用者中斷:不存檔、不吃冷卻', async () => {
    const { s, store } = memStore();
    const h = createHourlyInsight({ enabled: true, llm: fakeLlm({ fail: true }).llm, sources, store, log: silent, now: () => T0 });
    const ac = new AbortController();
    ac.abort();
    await h.reserveManual()({ send: () => undefined, signal: ac.signal });
    assert.equal(s.saves, 0);
    assert.doesNotThrow(() => h.reserveManual());
  });

  it('AI 主機無法使用:存 failed,不丟出', async () => {
    const { s, store } = memStore();
    const h = createHourlyInsight({ enabled: true, llm: fakeLlm({ fail: true }).llm, sources, store, log: silent, now: () => T0 });
    await h.runAuto();
    assert.equal(s.rec!.status, 'failed');
    assert.equal(s.rec!.error!.code, 'NETOPS_AI_UNAVAILABLE');
    assert.equal(h.status().status, 'failed');
  });

  it('未啟用:不跑;手動 503', async () => {
    const { s, store } = memStore();
    const h = createHourlyInsight({ enabled: false, llm: fakeLlm().llm, sources, store, log: silent, now: () => T0 });
    await h.runAuto();
    assert.equal(s.saves, 0);
    assert.throws(() => h.reserveManual(), (e: AppError) => e.code === 'NETOPS_AI_NOT_CONFIGURED');
    assert.equal(h.status().status, 'none');
  });

  it('手動:分析這個整點到現在;冷卻 5 分鐘;進行中 409', async () => {
    let now = T0 + 25 * 60_000;
    const { s, store } = memStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = createHourlyInsight({ enabled: true, llm: fakeLlm({ gate }).llm, sources, store, log: silent, now: () => now });
    const events: string[] = [];
    const run = h.reserveManual();
    const p = run({ send: (e) => events.push(e) });
    await new Promise((r) => setImmediate(r));
    // 進行中(先於冷卻)
    assert.throws(() => h.reserveManual(), (e: AppError) => e.status === 409 && e.code === 'NETOPS_AI_HOURLY_BUSY');
    // 自動排程也不會同時跑
    await h.runAuto();
    release();
    await p;
    // 完成後仍在冷卻
    assert.throws(() => h.reserveManual(), (e: AppError) => e.status === 429 && e.code === 'NETOPS_AI_HOURLY_COOLDOWN');
    now += HOURLY_MANUAL_COOLDOWN_MS + 1;
    assert.deepEqual(events, ['meta', 'content', 'content', 'done']);
    assert.equal(s.rec!.trigger, 'manual');
    assert.equal(s.rec!.hour, '2026-11-17T10:00:00+08:00');
    assert.equal(s.saves, 1);
    assert.ok(h.status().cooldownUntil === null);
  });
});

describe('AI 每小時分析 API', () => {
  const host = fakeAiHost({ streamDelayMs: 0 });
  let t: TestApp;
  before(async () => {
    const base = await host.start();
    t = await createTestApp({ env: { LLM_URL: `${base}/v1` }, paLiveRedis: createPaLiveRedis(new FakeRedis()) });
  });
  after(async () => {
    await t.close();
    host.close();
  });

  it('還沒有分析:status none', async () => {
    const res = await t.call({ url: '/v1/ai/hourly-insight' });
    assert.equal(res.statusCode, 200);
    const b = res.json();
    assert.equal(b.status, 'none');
    assert.equal(b.enabled, true);
    assert.equal(b.text, null);
  });

  it('手動分析:SSE 逐字回傳後可讀到最新一筆;再按 429', async () => {
    const res = await t.call({ method: 'POST', url: '/v1/ai/hourly-insight/run' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    assert.match(res.body, /event: meta/);
    assert.match(res.body, /event: content/);
    assert.match(res.body, /event: done/);
    const b = (await t.call({ url: '/v1/ai/hourly-insight' })).json();
    assert.equal(b.status, 'done');
    assert.equal(b.trigger, 'manual');
    assert.equal(b.model, 'fake-model');
    assert.ok(b.text.length > 0);
    assert.ok(b.cooldownUntil);
    const again = await t.call({ method: 'POST', url: '/v1/ai/hourly-insight/run' });
    assert.equal(again.statusCode, 429);
    assert.equal(again.json().code, 'NETOPS_AI_HOURLY_COOLDOWN');
  });

  it('OpenAPI 必填欄位', async () => {
    const doc = (await t.app.inject({ url: '/openapi.json' })).json();
    assert.equal(doc.paths['/v1/ai/hourly-insight'].get['x-permission'], 'netops.pa-realtime.read');
    const run = doc.paths['/v1/ai/hourly-insight/run'].post;
    assert.equal(run['x-permission'], 'netops.ai.use');
    assert.equal(run['x-timeout-ms'], 60000);
    assert.ok(run['x-gherkin'].includes('場景'));
  });
});

describe('AI 每小時分析:沒有 LLM_URL', () => {
  it('GET enabled false;POST 503', async () => {
    const t = await createTestApp();
    try {
      assert.equal((await t.call({ url: '/v1/ai/hourly-insight' })).json().enabled, false);
      const r = await t.call({ method: 'POST', url: '/v1/ai/hourly-insight/run' });
      assert.equal(r.statusCode, 503);
      assert.equal(r.json().code, 'NETOPS_AI_NOT_CONFIGURED');
    } finally {
      await t.close();
    }
  });
});
