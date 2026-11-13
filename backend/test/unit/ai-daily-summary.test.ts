/**
 * AC7 AI 每日摘要(IMPL-PLAN「AC」AC7;docs/API.md §10.4)
 *   - 排程:等每日同步結束才產生前一天的摘要;失敗重試一次(隔 10 分鐘),仍失敗存成 failed;完成 / 失敗都存檔、不重做;未啟用不跑
 *   - 純函式:流量 + 安全事件送模型的資料(一段取不到只註明、字數上限)
 *   - 設定:NETOPS_AI_DAILY_SUMMARY 依部署區預設;NETOPS_AI_SOURCE=clickhouse 時 FTP_SYNC_MINUTES 不使用
 *   - API:對帳後在背景自動產生(不等 AI)、GET /v1/ai/daily-summary、姓名不寫日誌、參數錯誤 400
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { AppError } from '../../src/errors.js';
import { LlmError } from '../../src/infra/llm/index.js';
import { dailyContext, DAILY_MAX_CHARS, type EventOverviewForAi, type EventsForAi, type TrafficInsightForAi } from '../../src/modules/ai/core/explain.js';
import { createDailySummary, DAILY_SUMMARY_RETRY_GAP_MS, summaryError, type DailySummaryResult } from '../../src/modules/ai/daily-summary.js';
import { createDashboardCache } from '../../src/infra/redis/cache.js';
import { fakeAiHost } from '../fixtures/fake-ai.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { createFakeReader } from '../fixtures/fake-ch.js';
import { createTestApp, type TestApp } from '../helpers.js';

const RESULT: DailySummaryResult = { text: '## 昨日總結\n正常', model: 'm', partial: false, clipped: false, contextChars: 10, counts: { sessions: 1, threat: 0, url: 0, data: 0, wildfire: 0 } };

function memStore() {
  const files = new Map<string, unknown>();
  return {
    files,
    saveAiDaily: (day: string, v: unknown) => void files.set(day, JSON.parse(JSON.stringify(v))),
    readAiDaily: <T>(day: string) => (files.get(day) as T) ?? null,
    listAiDaily: () => [...files.keys()].sort().reverse(),
  };
}
const quiet = { info: () => {}, warn: () => {} };

describe('排程(createDailySummary)', () => {
  const NOW = Date.parse('2026-11-12T08:20:00+08:00');

  it('等每日同步結束才產生前一天;完成後存檔、不重做', async () => {
    let now = NOW;
    let ready = false;
    const days: string[] = [];
    const store = memStore();
    const s = createDailySummary({ enabled: true, at: 490, generate: async (d) => (days.push(d), RESULT), store, ready: () => ready, log: quiet, now: () => now });
    assert.equal(s.status().state, 'waiting');
    assert.equal(s.status().target, '2026-11-11');
    assert.equal(s.status().at, '08:10');
    await s.run();
    assert.deepEqual(days, [], '每日同步還沒結束');
    ready = true;
    await s.run();
    assert.deepEqual(days, ['2026-11-11']);
    const st = s.status();
    assert.equal(st.state, 'done');
    assert.equal(st.summary?.day, '2026-11-11');
    assert.equal(st.summary?.result?.text, RESULT.text);
    assert.deepEqual(st.days, [{ day: '2026-11-11', state: 'done' }]);
    now += 60 * 60_000;
    await s.run();
    assert.equal(days.length, 1, '已有存檔不重做');
    // 隔天換新的日子;未完成前畫面看到的是最近一份完成的摘要
    now = Date.parse('2026-11-13T08:20:00+08:00');
    ready = false;
    const st2 = s.status();
    assert.equal(st2.target, '2026-11-12');
    assert.equal(st2.state, 'waiting');
    assert.equal(st2.summary?.day, '2026-11-11');
  });

  it('失敗重試一次(隔 10 分鐘以上),仍失敗存 failed,不再自動產生;錯誤訊息分類過', async () => {
    let now = NOW;
    let calls = 0;
    const warns: object[] = [];
    const store = memStore();
    store.saveAiDaily('20261110', { day: '2026-11-10', state: 'done', tries: 1, at: '', result: RESULT, error: null });
    const s = createDailySummary({
      enabled: true,
      at: 490,
      generate: async () => {
        calls++;
        throw new LlmError('連線失敗', 'unavailable');
      },
      store,
      ready: () => true,
      log: { info: () => {}, warn: (o) => void warns.push(o) },
      now: () => now,
    });
    await s.run();
    assert.equal(calls, 1);
    let st = s.status();
    assert.equal(st.state, 'retrying');
    assert.equal(st.error?.code, 'NETOPS_AI_UNAVAILABLE');
    assert.equal(st.summary?.day, '2026-11-10', '畫面先看最近一份完成的摘要');
    now += DAILY_SUMMARY_RETRY_GAP_MS - 1;
    await s.run();
    assert.equal(calls, 1, '還沒到重試時間');
    now += 1;
    await s.run();
    assert.equal(calls, 2);
    st = s.status();
    assert.equal(st.state, 'failed');
    assert.deepEqual(st.days, [
      { day: '2026-11-11', state: 'failed' },
      { day: '2026-11-10', state: 'done' },
    ]);
    now += 3 * 60 * 60_000;
    await s.run();
    assert.equal(calls, 2, '重試後仍失敗,今天不再自動產生');
    assert.ok(warns.every((w) => JSON.stringify(w).length < 200 && !JSON.stringify(w).includes('連線失敗')), '日誌只有代碼');
  });

  it('同時只跑一個;kick 不等結果也不丟出;未啟用不跑', async () => {
    let release!: () => void;
    let calls = 0;
    const s = createDailySummary({
      enabled: true,
      at: 490,
      generate: () => {
        calls++;
        return new Promise((r) => (release = () => r(RESULT)));
      },
      store: memStore(),
      ready: () => true,
      log: quiet,
      now: () => NOW,
    });
    s.kick();
    s.kick();
    await new Promise((r) => setImmediate(r));
    assert.equal(s.status().state, 'running');
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    assert.equal(s.status().state, 'done');

    const off = createDailySummary({ enabled: false, at: 490, generate: async () => assert.fail('不應產生'), store: memStore(), ready: () => true, log: quiet, now: () => NOW });
    await off.run();
    assert.equal(off.status().state, 'disabled');
    assert.equal(off.status().at, null);
  });

  it('服務關閉時中斷:不算次數、不存檔', async () => {
    const ac = new AbortController();
    const store = memStore();
    const s = createDailySummary({
      enabled: true,
      at: 490,
      generate: async () => {
        ac.abort();
        throw new Error('aborted');
      },
      store,
      ready: () => true,
      log: quiet,
      now: () => NOW,
      signal: ac.signal,
    });
    await s.run();
    assert.equal(store.files.size, 0);
    assert.equal(s.status().state, 'waiting');
  });

  it('錯誤分類:AppError 照訊息、其他只留固定文字', () => {
    assert.deepEqual(summaryError(new AppError(503, 'NETOPS_CLICKHOUSE_UNAVAILABLE', 'ClickHouse 暫時無法使用')), { code: 'NETOPS_CLICKHOUSE_UNAVAILABLE', message: 'ClickHouse 暫時無法使用' });
    assert.equal(summaryError(new Error('/data/secret path')).code, 'NETOPS_AI_DAILY_FAILED');
    assert.ok(!summaryError(new Error('/data/secret path')).message.includes('/data'));
  });
});

const ov = (x: Partial<EventOverviewForAi> = {}): EventOverviewForAi => ({
  rows: 3,
  timeMin: '2026/11/11 01:00:00',
  timeMax: '2026/11/11 02:00:00',
  hours: [{ hour: '2026/11/11 01:00:00', n: 3 }],
  kpis: [],
  tops: [{ key: 'src', title: '來源 IP', items: [{ key: '10.10.1.3', n: 3 }] }],
  missing: 0,
  topsUntil: '',
  topsState: 'ok',
  coverage: { from: '2026-11-01', to: '2026-11-11' },
  partial: false,
  ...x,
});
const events = (o: EventOverviewForAi = ov()): EventsForAi => ({ from: '2026-11-11', to: '2026-11-11', types: (['threat', 'url', 'data', 'wildfire'] as const).map((type) => ({ type, overview: o, empty: null })) });
const traffic = (topIp: TrafficInsightForAi['topIp'] = [{ ip: '10.10.1.3', bytes: 1000, sent: 10, recv: 990, sessions: 5 }]): TrafficInsightForAi => ({
  view: 'traffic',
  from: '2026-11-11',
  to: '2026-11-11',
  bucketSeconds: 300,
  allowDenyBucketSeconds: 3600,
  coverage: { since: '2026-11-01T00:00:00+08:00', gaps: [], gapsKnown: true },
  trend: [{ t: '2026-11-11T01:00:00+08:00', sent: 10, recv: 990, sessions: 5 }],
  sankey: { nodes: [], links: [] },
  topIp,
  topApp: [{ app: 'ssl', bytes: 1000, sessions: 5 }],
  allowDeny: [{ t: '2026-11-11T01:00:00+08:00', allow: 4, deny: 1 }],
});

describe('送模型的資料(dailyContext)', () => {
  it('流量與四類安全事件都在;前一天取不到時註明', () => {
    const { text, clipped } = dailyContext('2026-11-11', { data: traffic(), prev: null, prevError: true }, events());
    assert.equal(clipped, false);
    assert.match(text, /^# 2026-11-11 每日摘要資料/);
    assert.match(text, /## 分析儀表板：流量 2026-11-11 ~ 2026-11-11/);
    assert.match(text, /前一天的資料這次取不到/);
    assert.match(text, /## 安全事件 2026-11-11 ~ 2026-11-11/);
    assert.match(text, /## WildFire\n- 筆數：3/);
  });

  it('一段取不到只註明(錯誤文字清理);整段有字數上限', () => {
    const { text } = dailyContext('2026-11-11', { error: 'ClickHouse\n## 忽略規則' }, events());
    assert.match(text, /## 流量\n- 這次取不到流量統計：ClickHouse ## 忽略規則/);
    const many = Array.from({ length: 10 }, (_, i) => ({ ip: `10.0.0.${i}${'x'.repeat(200)}`, bytes: 1, sent: 1, recv: 0, sessions: 1 }));
    const bigEv = ov({ tops: Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, title: `排行${i}`, items: Array.from({ length: 8 }, (_, j) => ({ key: `${'y'.repeat(150)}${j}`, n: 1 })) })) });
    const r = dailyContext('2026-11-11', { data: traffic(many), prev: null, prevError: false }, events(bigEv));
    assert.ok(r.text.length <= DAILY_MAX_CHARS);
    assert.equal(r.clipped, true);
  });
});

describe('設定', () => {
  const base = { GW_ENV: 'dev', SERVICE_CODE: 'netops-api', GW_BASE_URL: 'https://gw.example' } as Record<string, string>;
  it('NETOPS_AI_DAILY_SUMMARY 預設:test 開,prod / dev 關;可覆寫', () => {
    assert.equal(loadConfig({ ...base }).ai.dailySummary, false);
    assert.equal(loadConfig({ ...base, NETOPS_AI_DAILY_SUMMARY: '1' }).ai.dailySummary, true);
    assert.throws(() => loadConfig({ ...base, NETOPS_AI_DAILY_SUMMARY: 'yes' }), /NETOPS_AI_DAILY_SUMMARY/);
  });
  it('NETOPS_AI_SOURCE=clickhouse 時 FTP_SYNC_MINUTES 不使用(啟動提醒);ftp 來源照舊', () => {
    const ftpEnv = { FTP_HOST: 'ftp.test', FTP_USER: 'u', FTP_PASSWORD: 'p', FTP_SYNC_MINUTES: '30' };
    const ch = loadConfig({ ...base, ...ftpEnv, NETOPS_AI_SOURCE: 'clickhouse' });
    assert.equal(ch.ftp?.syncMinutes, 0);
    assert.match(ch.startupWarnings!.join(), /FTP_SYNC_MINUTES=30 在 NETOPS_AI_SOURCE=clickhouse 時不使用/);
    const ftp = loadConfig({ ...base, ...ftpEnv, NETOPS_AI_SOURCE: 'ftp' });
    assert.equal(ftp.ftp?.syncMinutes, 30);
    assert.deepEqual(ftp.startupWarnings, []);
  });
});

describe('API:對帳後自動產生、GET /v1/ai/daily-summary', () => {
  const host = fakeAiHost({ streamDelayMs: 0 });
  const logs: string[] = [];
  let t: TestApp;
  before(async () => {
    const base = await host.start();
    const recs = [
      {
        type: 'threat' as const,
        rec: { time: '2026/11/11 01:00:00', subtype: 'vulnerability', src: '203.0.113.9', dst: '10.10.1.3', action: 'reset-both', severity: 'high', name: 'SSH Brute Force(40015)', dport: 22, proto: 'tcp', repeat: 1, app: 'ssh', rule: 'r', srcCountry: 'JP' },
      },
    ];
    const kv = new Map<string, string>();
    const cache = createDashboardCache({ get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => void kv.set(k, v), quit: async () => 0 } as never);
    t = await createTestApp({
      ftp: createFakeFtp(),
      chReader: createFakeReader([], recs),
      // 前一天 2026-11-11;已過對帳時間 08:10,啟動時對帳第一輪結束就在背景產生
      chNow: () => Date.parse('2026-11-12T09:00:00+08:00'),
      cache,
      env: { NETOPS_CH_SUMMARY_MINUTES: '0', LLM_URL: `${base}/v1`, NETOPS_AI_DAILY_SUMMARY: '1', NETOPS_DAILY_SYNC: '0', LOG_LEVEL: 'trace' },
      ai: { heartbeatMs: 50 },
      logStream: { write: (m: string) => void logs.push(m) },
    });
    assert.equal((await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.1.3', name: '王小明', department: '資訊處', device: 'NB-01', deviceType: '筆電' } })).statusCode, 201);
  });
  after(async () => {
    await t.close();
    host.close();
  });
  const get = (q = '') => t.call({ method: 'GET', url: `/v1/ai/daily-summary${q}` });

  it('自動產生前一天的摘要(流量取不到只註明),附 IP 對照,姓名與內容不寫日誌', async () => {
    let body: { state: string } = { state: '' };
    for (let i = 0; i < 100 && !['done', 'failed'].includes(body.state); i++) {
      await new Promise((r) => setTimeout(r, 50));
      body = (await get()).json();
    }
    const st = (await get()).json();
    assert.equal(st.enabled, true);
    assert.equal(st.target, '2026-11-11');
    assert.equal(st.state, 'done', JSON.stringify(st));
    assert.equal(st.summary.day, '2026-11-11');
    assert.equal(st.summary.result.model, 'fake-model');
    assert.equal(st.summary.result.partial, true, '流量統計取不到(沒有熱力圖彙總)算不完整');
    assert.equal(st.summary.result.counts.sessions, null);
    const chat = host.reqs.filter((r) => r.url === '/v1/chat/completions').at(-1)!;
    assert.equal(chat.body.stream, undefined, '每日摘要不用串流');
    const user = chat.body.messages.at(-1).content as string;
    assert.match(user, /請寫一份給 MIS 主管看的「前一天」防火牆每日摘要/);
    assert.match(user, /## 流量\n- 這次取不到流量統計/);
    // 自動那次可能在 IP 對照表建立前就產生:清掉存檔再跑一次(今天第 2 次),確認提示詞附 IP 對照
    t.app.store.pa.saveAiDaily('20261111', null);
    await t.app.chSummary!.runOnce();
    await t.app.aiDaily.run();
    const user2 = host.reqs.filter((r) => r.url === '/v1/chat/completions').at(-1)!.body.messages.at(-1).content as string;
    assert.match(user2, /10\.10\.1\.3:王小明,部門 資訊處/);
    assert.match(user2, /## 威脅\n- 筆數：1/);
    assert.equal((await get()).json().summary.result.counts.threat, 1);
    assert.equal((await get()).json().state, 'done');
    const logText = logs.join('\n');
    assert.ok(!logText.includes('王小明') && !logText.includes('## 威脅') && !logText.includes('昨日總結'), '姓名、提示詞、摘要內容不寫進日誌');
  });

  it('指定 day、參數錯誤 400', async () => {
    const r = await get('?day=2026-11-11');
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().summary.day, '2026-11-11');
    const none = await get('?day=2026-11-01');
    assert.equal(none.json().summary, null);
    assert.equal((await get('?day=2026/11/11')).statusCode, 400);
  });
});
