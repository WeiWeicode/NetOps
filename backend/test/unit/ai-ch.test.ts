/**
 * AC2 AI 改查 ClickHouse(IMPL-PLAN AC2、ARCHITECTURE D44;docs/API.md §10.1)
 *   - 設定:NETOPS_AI_SOURCE 依部署區(test = clickhouse,prod / dev = ftp,AQ4「Keep old path」);外部 IP 學習上限 30 天
 *   - 長期間路徑 fixture(測試區 TTL 3 天驗不到,IMPL-PLAN AC2「測試區與正式區」):100 天的假資料,
 *     原始表保留 TRAFFIC 30 天、威脅類 90 天(fake-ch rawSince),彙總不受影響;「現在」= 2026-11-13 12:00
 *       30 天分界(細 / 粗)、92 天分析、問答 TRAFFIC 30 天與威脅 90 天的保留期限、15 筆範例、外部 IP 學習 30 天
 *   - API:clickhouse 來源的 SSE 事件(meta / scan / evidence 的 ClickHouse 欄位)、不掃 FTP;ClickHouse 失敗在串流開始前回 503
 * FTP 舊路徑的測試在 ai.test.ts、ai-core.test.ts(dev 預設 ftp)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { IPLEARN_MAX_DAYS, loadConfig } from '../../src/config.js';
import { AppError } from '../../src/errors.js';
import type { ChEventType, LogRecord } from '../../src/infra/clickhouse/reader.js';
import { createStore } from '../../src/infra/store/index.js';
import { createChAiSource, FTP_EVENT_TYPES, SAMPLE_LIMIT } from '../../src/modules/ai/ch-source.js';
import { candidatesFrom } from '../../src/modules/iplearn/core/iplearn.js';
import { createChSummaryBuilder, type ChSummaryBuilder } from '../../src/modules/pa/ch-summary.js';
import { createEventImporter } from '../../src/modules/pa-events/importer.js';
import { fakeAiHost } from '../fixtures/fake-ai.js';
import { createFakeReader, trafficRecord, type FakeReader } from '../fixtures/fake-ch.js';
import { createFakeFtp, type FakeFtp } from '../fixtures/fake-ftp.js';
import { createTestApp, type TestApp } from '../helpers.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-13T12:00:00+08:00');
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const pad = (n: number) => String(n).padStart(2, '0');
/** NOW 往前 d 天的台灣日期 'yyyy/MM/dd' */
const dayBack = (d: number) => {
  const t = new Date(NOW + 8 * 3600_000 - d * DAY);
  return `${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}`;
};

/**
 * 100 天(含今天)的假資料:每天 10:00 4 筆 TRAFFIC(第 1 筆 10.10.1.1 → 203.0.113.<天 % 20>,第 0 筆 deny);
 * 每天 09:00 2 筆威脅(198.51.100.7 → 10.10.1.1,high)
 */
function fixture() {
  const traffic: LogRecord[] = [];
  const threats: { type: ChEventType; rec: LogRecord }[] = [];
  for (let d = 0; d < 100; d++) {
    const day = dayBack(d);
    for (let i = 0; i < 4; i++) traffic.push(trafficRecord(`${day} 10:${pad(i)}:00`, i, i === 1 ? { dst: `203.0.113.${d % 20}`, dstCountry: 'Japan' } : {}));
    for (let i = 0; i < 2; i++)
      threats.push({
        type: 'threat',
        rec: { time: `${day} 09:${pad(i)}:00`, subtype: 'vulnerability', src: '198.51.100.7', dst: '10.10.1.1', action: 'alert', severity: 'high', name: 'Old Scan(1)', dport: 445, proto: 'tcp', repeat: 1, app: 'ms-ds-smb', rule: 'r', srcCountry: 'JP', dstCountry: '', natSrc: '', natDst: '' },
      });
  }
  const reader = createFakeReader(traffic, threats);
  reader.rawSince = { traffic: NOW - 30 * DAY, threat: NOW - 90 * DAY };
  return reader;
}

describe('設定(AC2)', () => {
  const base = { SERVICE_CODE: 'netops-api', GW_JWKS_URL: 'http://127.0.0.1/jwks' };
  it('NETOPS_AI_SOURCE 預設依部署區:test = clickhouse;prod、dev = ftp(正式區 C6 前沿用舊路徑,AQ4);其他值啟動失敗', () => {
    assert.equal(loadConfig({ ...base, GW_ENV: 'dev' }).ai.source, 'ftp');
    assert.equal(loadConfig({ ...base, GW_ENV: 'dev', NETOPS_AI_SOURCE: 'clickhouse' }).ai.source, 'clickhouse');
    assert.equal(loadConfig({ ...base, GW_ENV: 'dev', NETOPS_AI_SOURCE: 'FTP' }).ai.source, 'ftp');
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'dev', NETOPS_AI_SOURCE: 'redis' }), /NETOPS_AI_SOURCE/);
  });
  it('外部 IP 學習天數上限 30(原 60)', () => {
    assert.equal(IPLEARN_MAX_DAYS, 30);
    assert.equal(loadConfig({ ...base, GW_ENV: 'dev', IPLEARN_DAYS: '30' }).ai.ipLearn.days, 30);
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'dev', IPLEARN_DAYS: '31' }), /IPLEARN_DAYS/);
  });
});

describe('ClickHouse 資料來源:長期間 fixture(30 天分界、92 天、威脅 90 天、IP 學習 30 天)', () => {
  let reader: FakeReader;
  let builder: ChSummaryBuilder;
  let src: ReturnType<typeof createChAiSource>;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-ai-ch-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  before(async () => {
    reader = fixture();
    const store = createStore(dir).pa;
    builder = createChSummaryBuilder({ reader, store, log: silent, days: 30, minutes: 0, now: () => NOW });
    await builder.runOnce();
    assert.equal(builder.status().lastError, null);
    const events = createEventImporter({ ftp: createFakeFtp(), store, ftpConfig: null, log: silent as never });
    src = createChAiSource({ reader, builder, events, ttlDays: { traffic: 30, threat: 90 }, summaryDays: 30, log: silent, now: () => NOW });
  });

  it('30 天內只用每小時摘要(原始 TRAFFIC 建的),沒有「較粗」的段落', async () => {
    const c = await src.analysisContext(dayBack(6), dayBack(0));
    assert.equal(c.rows, 7 * 4);
    assert.deepEqual(c.grain, { detail: { from: dayBack(6).replace(/\//g, '-'), to: dayBack(0).replace(/\//g, '-') }, coarse: null, rawDays: 30 });
    assert.equal(c.hours, 7);
    assert.equal(c.days, 0);
    assert.ok(!c.text.includes('資料較粗'));
    assert.match(c.text, /ClickHouse 每小時摘要 7 小時/);
    // 細的部分有完整排行(目的 IP、規則、結束原因)
    assert.match(c.text, /## 連線次數最多的目的 IP\n1\. /);
  });

  it('跨 30 天分界:最近 30 天(含今天)用每小時摘要,更早用每天彙總並註明較粗;筆數兩段加總正確', async () => {
    const c = await src.analysisContext(dayBack(43), dayBack(1));
    assert.equal(c.rows, 43 * 4, '細 + 粗的筆數');
    assert.deepEqual(c.grain.detail, { from: dayBack(29).replace(/\//g, '-'), to: dayBack(1).replace(/\//g, '-') });
    assert.deepEqual(c.grain.coarse, { from: dayBack(43).replace(/\//g, '-'), to: dayBack(30).replace(/\//g, '-') });
    assert.equal(c.hours, 29);
    assert.equal(c.days, 14);
    assert.ok(c.text.includes(`## 超過 30 天的期間 ${dayBack(43)} ~ ${dayBack(30)}：每天彙總（資料較粗）`));
    // 每天一列(14 天)、阻擋 = 每天 1 筆 deny
    const lines = c.text.split('\n').filter((l) => /^- \d{4}\/\d{2}\/\d{2}｜4｜1｜/.test(l));
    assert.equal(lines.length, 14);
    // 粗的部分也併進排行:App 與來源 IP 次數 = 兩段合計
    assert.match(c.text, /## 連線次數最多的來源 IP（次數｜流量）\n1\. 10\.10\.1\.\d｜43 次/);
  });

  it('92 天(上限):前一段同長度期間也從彙總比較;只有每天彙總的期間仍可分析', async () => {
    const c = await src.analysisContext(dayBack(91), dayBack(0));
    assert.equal(c.rows, 92 * 4);
    assert.equal(c.days, 62);
    assert.match(c.text, /前一段同長度期間 .+：連線紀錄 32 筆/, '前一段只有 8 天(100 − 92)有資料');
    const old = await src.analysisContext(dayBack(60), dayBack(40));
    assert.equal(old.grain.detail, null);
    assert.equal(old.rows, 21 * 4);
    assert.match(old.text, /每天彙總 21 天（較粗）/);
  });

  it('威脅類:30 天內讀每小時摘要,30–90 天讀原始威脅表的前幾種組合,超過 90 天註明保留期限', async () => {
    const t = await src.eventsContext(dayBack(95), dayBack(0));
    assert.match(t, /### 威脅（threat）：60 筆/, '30 天內(含今天)每天 2 筆');
    assert.match(t, new RegExp(`### 威脅（threat）${dayBack(90)} ~ ${dayBack(30)}（超過 30 天`));
    assert.match(t, /Old Scan\(1\)｜120 次/, '90 天前那天 09:00 已過期(NOW − 90 天 = 12:00):89..30 天前共 60 天 × 2 筆');
    assert.match(t, /超過威脅類原始 log 保留期限（90 天）/);
  });

  it('問答:原始 TRAFFIC 只查 30 天內並標示略過的期間;範例最多 15 筆;不掃 FTP', async () => {
    const r = await src.trafficEvidence({ ips: ['10.10.1.1'], ports: [] }, `${dayBack(35)} 00:00`, `${dayBack(0)} 11:59`);
    assert.equal(r.info.source, 'clickhouse');
    assert.equal(r.info.matched, 30, '30 天內每天 1 筆(10.10.1.1)');
    assert.equal(r.info.samples, SAMPLE_LIMIT);
    assert.deepEqual(r.info.skipped, { from: `${dayBack(35)} 00:00`, to: `${dayBack(30)} 12:00` });
    assert.equal(r.info.partial, false);
    assert.match(r.text, /超過原始 TRAFFIC 保留期限（30 天），這段沒有資料可查，不代表沒有連線/);
    assert.match(r.text, /### 範例紀錄（每種連線組合一筆，最新的在前，最多 15 筆）/);
    assert.equal(r.text.split('\n').filter((l) => /^- \d{4}\/.+｜送 \d+B/.test(l)).length, SAMPLE_LIMIT);
    // 兩個 IP:之間的連線;Port 條件
    const two = await src.trafficEvidence({ ips: ['10.10.1.1', `203.0.113.${0}`], ports: [] }, `${dayBack(29)} 00:00`, `${dayBack(0)} 11:59`);
    assert.ok(two.info.matched >= 1 && two.info.matched <= 2);
    const port = await src.trafficEvidence({ ips: [], ports: [53] }, `${dayBack(2)} 00:00`, `${dayBack(0)} 11:59`);
    assert.equal(port.info.matched, 3 * 2, 'dport 53 是偶數筆');
  });

  it('問答:整段超過 30 天時不查原始表,回「沒有符合」並標示', async () => {
    const before = reader.calls.length;
    const r = await src.trafficEvidence({ ips: ['10.10.1.1'], ports: [] }, `${dayBack(50)} 00:00`, `${dayBack(40)} 23:59`);
    assert.equal(r.info.matched, 0);
    assert.equal(r.info.from, '');
    assert.ok(r.text.includes('這段時間 log 中沒有符合條件的紀錄'));
    assert.ok(!reader.calls.slice(before).includes('aiTrafficFlows'));
  });

  it('問答:威脅類 90 天內依 IP 查(不比對 Port),超過 90 天的部分註明', async () => {
    const r = await src.eventsForIps(['198.51.100.7'], `${dayBack(95)} 00:00`, `${dayBack(85)} 23:59`, (ip) => ip === '198.51.100.7');
    // 90 天前那天 09:00 早於 NOW − 90 天(12:00)→ 89..85 共 5 天 × 2 筆
    assert.deepEqual(r.hits, [{ type: 'threat', label: '威脅', total: 10, kinds: 1 }]);
    assert.match(r.text, /超過威脅類原始 log 保留期限（90 天），這段沒有查/);
    assert.match(r.text, /威脅 Old Scan\(1\)/);
    assert.deepEqual([...FTP_EVENT_TYPES], ['decryption', 'globalprotect', 'userid']);
  });

  it('外部 IP 學習:最近 30 天的每小時摘要(原始 TRAFFIC 建的),排行可挑出外部目的 IP', async () => {
    const r = await src.recentSummaries(30);
    assert.equal(r.files, 30);
    assert.equal(r.from, dayBack(29));
    assert.equal(r.to, dayBack(0));
    const c = candidatesFrom(r.summaries) as Map<string, unknown>;
    assert.ok([...c.keys()].some((ip) => ip.startsWith('203.0.113.')));
  });

  it('ClickHouse 未設定或連不上:回 503 NETOPS_CLICKHOUSE_UNAVAILABLE(不改用 FTP)', async () => {
    const none = createChAiSource({ reader: null, builder: null, events: null as never, ttlDays: { traffic: 30, threat: 90 }, summaryDays: 30, log: silent, now: () => NOW });
    await assert.rejects(none.analysisContext(dayBack(1), dayBack(0)), (e: AppError) => e.status === 503 && e.code === 'NETOPS_CLICKHOUSE_UNAVAILABLE');
    reader.failing = true;
    try {
      await assert.rejects(src.trafficEvidence({ ips: ['10.10.1.1'], ports: [] }, `${dayBack(1)} 00:00`, `${dayBack(0)} 11:59`), (e: AppError) => e.status === 503);
      await assert.rejects(src.eventsForIps(['1.1.1.1'], `${dayBack(1)} 00:00`, `${dayBack(0)} 11:59`, () => true), (e: AppError) => e.status === 503);
    } finally {
      reader.failing = false;
    }
  });
});

/** SSE 回應 → [{ event, data }] */
const sse = (body: string) =>
  body
    .split('\n\n')
    .filter((b) => b.includes('event: '))
    .map((b) => ({ event: /event: (.+)/.exec(b)![1]!, data: JSON.parse(/data: (.+)/.exec(b)![1]!) }));

describe('API:NETOPS_AI_SOURCE=clickhouse', () => {
  const host = fakeAiHost({ streamDelayMs: 0 });
  let t: TestApp;
  let reader: FakeReader;
  let ftp: FakeFtp;
  before(async () => {
    const base = await host.start();
    reader = fixture();
    ftp = createFakeFtp();
    t = await createTestApp({ ftp, chReader: reader, chNow: () => NOW, env: { NETOPS_AI_SOURCE: 'clickhouse', NETOPS_CH_SUMMARY_MINUTES: '0', NETOPS_TTL_TRAFFIC_DAYS: '30', NETOPS_TTL_THREAT_DAYS: '90', LLM_URL: `${base}/v1` }, ai: { heartbeatMs: 50 } });
    await t.app.chSummary!.runOnce();
  });
  after(async () => {
    await t.close();
    host.close();
  });
  const chats = () => host.reqs.splice(0).filter((r) => r.url === '/v1/chat/completions');

  it('期間分析:meta 標示 source、粒度(超過 30 天較粗)與覆蓋範圍;送給模型的是統計與每天彙總', async () => {
    host.reqs.splice(0);
    const res = await t.call({ method: 'POST', url: '/v1/ai/analyses', payload: { from: dayBack(40).replace(/\//g, '-'), to: dayBack(1).replace(/\//g, '-') } });
    assert.equal(res.statusCode, 200);
    const ev = sse(res.body);
    const meta = ev.find((e) => e.event === 'meta')!.data;
    assert.equal(meta.source, 'clickhouse');
    assert.equal(meta.rows, 40 * 4);
    assert.deepEqual(meta.grain.coarse, { from: dayBack(40).replace(/\//g, '-'), to: dayBack(30).replace(/\//g, '-') });
    assert.equal(meta.grain.rawDays, 30);
    assert.equal(meta.partial, false);
    assert.ok(ev.some((e) => e.event === 'done'));
    const body = JSON.stringify(chats()[0]!.body);
    assert.ok(body.includes('資料較粗'));
    assert.ok(!body.includes('個匯出檔'), '來源說明改成 ClickHouse');
  });

  it('問答有 IP:scan / evidence 是 ClickHouse 欄位,範例最多 15 筆;不連 FTP', async () => {
    host.reqs.splice(0);
    let opened = 0;
    const open = ftp.openStream.bind(ftp);
    ftp.openStream = (...a: Parameters<FakeFtp['openStream']>) => (opened++, open(...a));
    const res = await t.call({ method: 'POST', url: '/v1/ai/questions', payload: { from: `${dayBack(20).replace(/\//g, '-')}T00:00:00+08:00`, to: `${dayBack(0).replace(/\//g, '-')}T11:59:00+08:00`, question: '10.10.1.1 最近連到哪些外部 IP' } });
    assert.equal(res.statusCode, 200);
    const ev = sse(res.body);
    assert.equal(ev.find((e) => e.event === 'meta')!.data.dataSource, 'clickhouse');
    const scan = ev.find((e) => e.event === 'scan')!.data;
    assert.deepEqual({ source: scan.source, step: scan.step }, { source: 'clickhouse', step: 'traffic' });
    const evidence = ev.find((e) => e.event === 'evidence')!.data;
    assert.equal(evidence.source, 'clickhouse');
    assert.equal(evidence.matched, 21);
    assert.equal(evidence.samples, SAMPLE_LIMIT);
    assert.equal(evidence.skipped, null);
    assert.equal(evidence.cached, false);
    assert.ok(!('filesScanned' in evidence), '沒有 FTP 掃描的欄位');
    assert.deepEqual(ev.find((e) => e.event === 'events')!.data.hits.map((h: { type: string; total: number }) => [h.type, h.total]), [['threat', 42]]);
    assert.equal(opened, 0, '不掃 FTP 原始 log');
    const prompt = JSON.stringify(chats()[0]!.body);
    assert.ok(prompt.includes('查 ClickHouse 原始 TRAFFIC'));
    // 追問(沒有 IP)沿用前面的條件,10 分鐘內不重查
    const again = await t.call({ method: 'POST', url: '/v1/ai/questions', payload: { from: `${dayBack(20).replace(/\//g, '-')}T00:00:00+08:00`, to: `${dayBack(0).replace(/\//g, '-')}T11:59:00+08:00`, question: '那被擋的呢', history: [{ role: 'user', content: '10.10.1.1 最近連到哪些外部 IP' }, { role: 'assistant', content: '...' }] } });
    const ev2 = sse(again.body);
    // 沿用快取:不再送 traffic 的 scan,筆數相同
    assert.equal(ev2.find((e) => e.event === 'evidence')!.data.matched, 21);
    assert.ok(!ev2.some((e) => e.event === 'scan' && e.data.step === 'traffic'));
  });

  it('問答沒有 IP:期間整體統計(ClickHouse);ClickHouse 連不上時串流開始前回 503', async () => {
    const res = await t.call({ method: 'POST', url: '/v1/ai/questions', payload: { from: `${dayBack(2).replace(/\//g, '-')}T00:00:00+08:00`, to: `${dayBack(0).replace(/\//g, '-')}T11:59:00+08:00`, question: '最近有什麼異常' } });
    const evd = sse(res.body).find((e) => e.event === 'evidence')!.data;
    assert.deepEqual({ summary: evd.summary, source: evd.source, hours: evd.hours }, { summary: true, source: 'clickhouse', hours: 3 });
    reader.failing = true;
    try {
      // 每天有資料的日期有 2 分鐘的記憶:換一個 app 才會重查;這裡驗分析(每次都查每小時彙總)
      const a = await t.call({ method: 'POST', url: '/v1/ai/analyses', payload: { from: dayBack(40).replace(/\//g, '-'), to: dayBack(1).replace(/\//g, '-') } });
      assert.equal(a.statusCode, 503);
      assert.equal(a.json().code, 'NETOPS_CLICKHOUSE_UNAVAILABLE');
    } finally {
      reader.failing = false;
    }
  });

  it('外部 IP 學習:天數 31 回 400', async () => {
    const r = await t.call({ method: 'POST', url: '/v1/kb/ip-learnings', payload: { days: 31 } });
    assert.equal(r.statusCode, 400);
  });
});
