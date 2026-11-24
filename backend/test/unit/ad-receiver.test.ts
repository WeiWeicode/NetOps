/**
 * AD-1:netops-ad-receiver(Token 對應表、身分核對、Payload 上限、重送去重、心跳)與 netops-ingest 的 AD 寫入(欄位轉換、重啟不重複)。
 * 真 Redis(Lua 水位)+ 真 ClickHouse(DDL、物化檢視、Parquet)在 test/integration/ad.int.test.ts。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildAdReceiverApp, type Log } from '../../src/ad-receiver/app.js';
import { loadAdReceiverConfig } from '../../src/ad-receiver/config.js';
import { MAX_EVENTS } from '../../src/ad-receiver/payload.js';
import { parseTokenTable, sha256Hex, TokenFileError } from '../../src/ad-receiver/tokens.js';
import { AD_ARCHIVE_KIND_LIST, ARCHIVE_KIND_LIST, archiveRelPath, exportSql, parseArchiveName } from '../../src/infra/clickhouse/archive.js';
import { AD_KEYS } from '../../src/infra/redis/ad-receiver.js';
import { INGEST_KEYS } from '../../src/infra/redis/ingest.js';
import { parseIsoTime, toAdRow } from '../../src/ingest/ad-rows.js';
import { ACCOUNT_CHANGES } from '../../src/modules/ad/core/adlog.js';
import { archiveHeartbeatFields, Archiver } from '../../src/ingest/archive.js';
import { loadIngestConfig } from '../../src/ingest/config.js';
import { adHeartbeatFields } from '../../src/ingest/main.js';
import { Writer } from '../../src/ingest/writer.js';
import { agentEvent, DC1_TOKEN, DC2_TOKEN, FakeAdReceiverRedis, msg4625, msg4728, TOKEN_FILE } from '../fixtures/fake-ad-receiver.js';
import { FakeClickHouse, FakeIngestRedis } from '../fixtures/fake-ingest.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-ad-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
const log: Log = (level, msg, extra) => void logs.push({ level, msg, extra });

function setup() {
  const redis = new FakeAdReceiverRedis();
  const app = buildAdReceiverApp({ tokens: parseTokenTable(TOKEN_FILE), redis, log, now: () => Date.UTC(2026, 10, 20, 5, 5, 15) });
  const post = (url: string, body: unknown, token: string | null = DC1_TOKEN, extraHeaders: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...(token ? { 'x-netops-ad-token': token } : {}), ...extraHeaders },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const logsBody = (events: unknown[], over: Record<string, unknown> = {}) => ({ computer: 'GSMC-DC1', domain: 'gsmc.com.tw', agentVersion: '0.1.0', events, ...over });
  return { redis, app, post, logsBody };
}

describe('DC Token 對應表', () => {
  it('解析每台 DC 一行;只存雜湊,Token 對應到 computer / domain', () => {
    const t = parseTokenTable(TOKEN_FILE);
    assert.equal(t.size, 2);
    assert.deepEqual(t.lookup(DC1_TOKEN), { computer: 'GSMC-DC1', domain: 'gsmc.com.tw' });
    assert.deepEqual(t.lookup(DC2_TOKEN), { computer: 'GSC-DC2', domain: 'gsc.com.tw' });
    for (const bad of [undefined, '', 'x', DC1_TOKEN.slice(0, 63), `${DC1_TOKEN}0`, DC1_TOKEN.toUpperCase(), 'z'.repeat(200)]) assert.equal(t.lookup(bad), null, String(bad));
  });

  it('格式錯誤、computer 或 Token 重複、一台都沒有:拒絕(訊息不帶內容)', () => {
    const h = sha256Hex(DC1_TOKEN);
    const cases = [
      `GSMC-DC1 gsmc.com.tw`,
      `GSMC_DC1 gsmc.com.tw ${h}`,
      `GSMC-DC1 gsmc..tw ${h}`,
      `GSMC-DC1 gsmc.com.tw ${h.toUpperCase()}`,
      `GSMC-DC1 gsmc.com.tw ${h}\ngsmc-dc1 gsmc.com.tw ${sha256Hex(DC2_TOKEN)}`,
      `GSMC-DC1 gsmc.com.tw ${h}\nGSC-DC2 gsc.com.tw ${h}`,
      `# 只有註解\n`,
    ];
    for (const c of cases) {
      assert.throws(() => parseTokenTable(c), TokenFileError, c);
      try {
        parseTokenTable(c);
      } catch (e) {
        assert.doesNotMatch((e as Error).message, /[0-9a-f]{64}/);
      }
    }
  });

  it('設定:只接受 AD_AGENT_TOKENS_FILE,缺檔或明文設定都啟動失敗', () => {
    const f = path.join(tmp, 'ad_agent_tokens');
    fs.writeFileSync(f, TOKEN_FILE);
    const base = { GW_ENV: 'test', REDIS_URL: 'redis://netops-redis:6379/0', AD_AGENT_TOKENS_FILE: f };
    assert.equal(loadAdReceiverConfig(base).tokens.size, 2);
    assert.throws(() => loadAdReceiverConfig({ ...base, AD_AGENT_TOKENS_FILE: '' }), /AD_AGENT_TOKENS_FILE/);
    assert.throws(() => loadAdReceiverConfig({ ...base, AD_AGENT_TOKENS_FILE: path.join(tmp, 'none') }), /ENOENT/);
    assert.throws(() => loadAdReceiverConfig({ ...base, AD_AGENT_TOKENS: 'x' }), /明文/);
    assert.throws(() => loadAdReceiverConfig({ ...base, GW_ENV: 'staging' }), /GW_ENV/);
    assert.throws(() => loadAdReceiverConfig({ ...base, REDIS_URL: '' }), /REDIS_URL/);
  });
});

describe('netops-ad-receiver:認證與身分核對(H3)', () => {
  it('沒有或錯誤的 Token 回 401,而且不解析內容(壞 JSON 也是 401)', async () => {
    const { post, logsBody, redis } = setup();
    for (const token of [null, 'x'.repeat(64)]) {
      const r = await post('/ad/v1/logs', logsBody([agentEvent(1)]), token);
      assert.equal(r.statusCode, 401);
      assert.equal(r.json().code, 'NETOPS_AD_TOKEN_INVALID');
      assert.match(r.json().requestId, /^[0-9a-f-]{36}$/);
    }
    assert.equal((await post('/ad/v1/heartbeat', '{bad', 'x'.repeat(64))).statusCode, 401);
    assert.equal(redis.stream.length, 0);
    // 日誌不含 Token
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(DC1_TOKEN));
  });

  it('編碼過的路徑(/%61d/…)、重複斜線也要驗 Token,不會繞過(資安審查 H1)', async () => {
    const { post, logsBody, redis } = setup();
    for (const url of ['/%61d/v1/logs', '/%61d/v1/heartbeat', '/ad/v1/log%73', '//ad/v1/logs', '/AD/v1/logs']) {
      const r = await post(url, logsBody([agentEvent(1)]), null);
      assert.equal(r.statusCode, 401, url);
    }
    // 有 Token 時編碼路徑照常運作(路由器解碼),身分核對一樣做
    assert.equal((await post('/%61d/v1/logs', logsBody([agentEvent(1)], { computer: 'GSC-DC2' }))).statusCode, 403);
    assert.equal(redis.stream.length, 0);
  });

  it('每台 DC 每分鐘請求數超過上限回 429(其他 DC 不受影響)', async () => {
    const redis = new FakeAdReceiverRedis();
    let t = Date.UTC(2026, 10, 20, 5, 0, 0);
    const app = buildAdReceiverApp({ tokens: parseTokenTable(TOKEN_FILE), redis, log, now: () => t, maxRequestsPerMinute: 3 });
    const hb = (token: string, computer: string, domain: string) =>
      app.inject({ method: 'POST', url: '/ad/v1/heartbeat', headers: { 'content-type': 'application/json', 'x-netops-ad-token': token }, payload: JSON.stringify({ computer, domain }) });
    for (let i = 0; i < 3; i++) assert.equal((await hb(DC1_TOKEN, 'GSMC-DC1', 'gsmc.com.tw')).statusCode, 200);
    const limited = await hb(DC1_TOKEN, 'GSMC-DC1', 'gsmc.com.tw');
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, 'NETOPS_AD_RATE_LIMITED');
    assert.equal(limited.headers['retry-after'], '60');
    assert.equal((await hb(DC2_TOKEN, 'GSC-DC2', 'gsc.com.tw')).statusCode, 200);
    t += 60_000;
    assert.equal((await hb(DC1_TOKEN, 'GSMC-DC1', 'gsmc.com.tw')).statusCode, 200);
  });

  it('computer / domain 和 Token 對應的 DC 不一致回 403(拿 DC1 的 Token 冒充 DC2)', async () => {
    const { post, logsBody, redis } = setup();
    for (const over of [{ computer: 'GSC-DC2' }, { domain: 'gsc.com.tw' }, { computer: 'GSMC-DC1X' }]) {
      const r = await post('/ad/v1/logs', logsBody([agentEvent(1)], over));
      assert.equal(r.statusCode, 403, JSON.stringify(over));
      assert.equal(r.json().code, 'NETOPS_AD_IDENTITY_MISMATCH');
    }
    const hb = await post('/ad/v1/heartbeat', { computer: 'GSC-DC2', domain: 'gsc.com.tw' });
    assert.equal(hb.statusCode, 403);
    assert.equal(redis.stream.length, 0);
    assert.equal(redis.heartbeats.size, 0);
  });

  it('大小寫不同視為同一台;寫進 Redis 的 computer / domain 以對應表為準', async () => {
    const { post, logsBody, redis } = setup();
    const r = await post('/ad/v1/logs', logsBody([agentEvent(5)], { computer: 'gsmc-dc1', domain: 'GSMC.COM.TW' }));
    assert.equal(r.statusCode, 200);
    const rec = JSON.parse(redis.stream[0]!);
    assert.deepEqual([rec.computer, rec.domain, rec.recordId], ['GSMC-DC1', 'gsmc.com.tw', '5']);
  });
});

describe('netops-ad-receiver:Payload 上限與格式', () => {
  it(`超過 ${MAX_EVENTS} 筆回 400;超過 4 MB 回 413;不是 JSON 回 400;不支援的 Content-Type 回 415`, async () => {
    const { post, logsBody, app } = setup();
    const many = await post('/ad/v1/logs', logsBody(Array.from({ length: MAX_EVENTS + 1 }, (_, i) => agentEvent(i + 1, { message: '' }))));
    assert.equal(many.statusCode, 400);
    assert.equal(many.json().code, 'NETOPS_AD_TOO_MANY_EVENTS');
    const big = await post('/ad/v1/logs', logsBody([agentEvent(1, { message: 'x'.repeat(4 * 1024 * 1024) })]));
    assert.equal(big.statusCode, 413);
    assert.equal(big.json().code, 'NETOPS_AD_PAYLOAD_TOO_LARGE');
    const bad = await post('/ad/v1/logs', '{"computer":');
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, 'NETOPS_AD_BAD_REQUEST');
    assert.doesNotMatch(bad.body, /computer|stack/i);
    const xml = await app.inject({ method: 'POST', url: '/ad/v1/logs', headers: { 'content-type': 'application/xml', 'x-netops-ad-token': DC1_TOKEN }, payload: '<x/>' });
    assert.equal(xml.statusCode, 415);
    // text/plain 會被解析成字串:不是 JSON 物件,回 400
    const text = await app.inject({ method: 'POST', url: '/ad/v1/logs', headers: { 'content-type': 'text/plain', 'x-netops-ad-token': DC1_TOKEN }, payload: 'x' });
    assert.equal(text.statusCode, 400);
    const hbBig = await post('/ad/v1/heartbeat', { computer: 'GSMC-DC1', domain: 'gsmc.com.tw', pad: 'x'.repeat(70 * 1024) });
    assert.equal(hbBig.statusCode, 413);
    // 不存在的路徑也要先驗 Token(預設拒絕);有 Token 才回 404
    assert.equal((await app.inject({ method: 'GET', url: '/nope' })).statusCode, 401);
    const none = await app.inject({ method: 'GET', url: '/nope', headers: { 'x-netops-ad-token': DC1_TOKEN } });
    assert.equal(none.statusCode, 404);
    assert.equal(none.json().code, 'NETOPS_AD_NOT_FOUND');
  });

  it('單筆格式錯誤只拒絕那一筆(回 index 與原因),其他照收;訊息截到 3,000 字;channel 原名轉底線', async () => {
    const { post, logsBody, redis } = setup();
    const r = await post(
      '/ad/v1/logs',
      logsBody([
        agentEvent(1),
        agentEvent(2, { channel: 'Application' }),
        agentEvent(3, { time: '2026-11-20 13:05:12' }),
        agentEvent(4, { recordId: -1 }),
        agentEvent(5, { logEpoch: undefined }),
        agentEvent(6, { eventId: 70000 }),
        'x',
        agentEvent(7, { channel: 'Directory Service', eventId: 2887, message: 'y'.repeat(5000) }),
        agentEvent(8, { recordId: '9007199254740993' }),
      ]),
    );
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.deepEqual([b.accepted, b.duplicates, b.rejected], [2, 0, 7]);
    assert.deepEqual(
      b.rejectedItems.map((x: { index: number }) => x.index),
      [1, 2, 3, 4, 5, 6, 8],
    );
    const ds = redis.stream.map((s) => JSON.parse(s)).find((e) => e.channel === 'Directory_Service');
    assert.equal(ds.message.length, 3000);
  });

  it('缺 events 或 computer 回 400;Redis 斷線回 503(Agent 不移水位、之後重送)', async () => {
    const { post, logsBody, redis } = setup();
    assert.equal((await post('/ad/v1/logs', { computer: 'GSMC-DC1', domain: 'gsmc.com.tw' })).statusCode, 400);
    assert.equal((await post('/ad/v1/logs', { domain: 'gsmc.com.tw', events: [] })).statusCode, 400);
    redis.fail = 1;
    const r = await post('/ad/v1/logs', logsBody([agentEvent(1)]));
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().code, 'NETOPS_AD_UNAVAILABLE');
    assert.doesNotMatch(r.body, /Connection is closed/);
    // 重送成功
    assert.equal((await post('/ad/v1/logs', logsBody([agentEvent(1)]))).json().accepted, 1);
  });
});

describe('netops-ad-receiver:重送去重(M2)與世代(H4)', () => {
  it('沒收到 200 重送同一批:全部視為重複,不再寫 Stream', async () => {
    const { post, logsBody, redis } = setup();
    const batch = logsBody([agentEvent(100), agentEvent(101), agentEvent(102)]);
    assert.deepEqual((await post('/ad/v1/logs', batch)).json().accepted, 3);
    const again = (await post('/ad/v1/logs', batch)).json();
    assert.deepEqual([again.accepted, again.duplicates], [0, 3]);
    assert.equal(redis.stream.length, 3);
  });

  it('重送時多了新事件、順序打亂、同批內重複:只寫新的', async () => {
    const { post, logsBody, redis } = setup();
    await post('/ad/v1/logs', logsBody([agentEvent(100), agentEvent(101)]));
    const r = (await post('/ad/v1/logs', logsBody([agentEvent(103), agentEvent(101), agentEvent(100), agentEvent(102), agentEvent(103)]))).json();
    assert.deepEqual([r.accepted, r.duplicates], [2, 3]);
    assert.deepEqual(
      redis.stream.map((s) => JSON.parse(s).recordId),
      ['100', '101', '102', '103'],
    );
  });

  it('Event Log 清除重編號:log_epoch + 1 後從小號開始也照收;channel 各自比對;不同 DC 互不影響', async () => {
    const { post, logsBody, redis } = setup();
    await post('/ad/v1/logs', logsBody([agentEvent(500), agentEvent(10, { channel: 'System', eventId: 7036 })]));
    const r = (await post('/ad/v1/logs', logsBody([agentEvent(1, { logEpoch: 1 }), agentEvent(2, { logEpoch: 1 }), agentEvent(11, { channel: 'System', eventId: 7036 })]))).json();
    assert.equal(r.accepted, 3);
    const dc2 = await post('/ad/v1/logs', { computer: 'GSC-DC2', domain: 'gsc.com.tw', events: [agentEvent(500)] }, DC2_TOKEN);
    assert.equal(dc2.json().accepted, 1);
    assert.equal(redis.stream.length, 6);
    assert.equal(redis.heartbeats.get('GSMC-DC1')!.received, '5');
  });
});

describe('netops-ad-receiver:心跳', () => {
  it('存最新心跳、加進 computers、Watchdog 事件進清單;回應帶各 channel 目前世代與水位', async () => {
    const { post, logsBody, redis } = setup();
    await post('/ad/v1/logs', logsBody([agentEvent(7), agentEvent(3, { logEpoch: 2 })]));
    const body = {
      computer: 'GSMC-DC1',
      domain: 'gsmc.com.tw',
      reportedAt: '2026-11-20T13:05:15.000+08:00',
      agentVersion: '0.1.0',
      watchdogVersion: '0.1.0',
      agent: { pid: 4120, serviceState: 'running', lastError: '' },
      channels: { Security: { lastRecordId: 3, logEpoch: 2, wrapRisk: false } },
      watchdogEvents: [{ type: 'agent_restarted', cause: 'hung', previousPid: 1, pid: 2 }],
    };
    const r = await post('/ad/v1/heartbeat', body);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().channels, { Security: { logEpoch: 2, lastRecordId: 3 } });
    const hb = redis.heartbeats.get('GSMC-DC1')!;
    assert.equal(hb.updatedAt, '2026-11-20T05:05:15.000Z');
    assert.equal(hb.received, '2');
    assert.equal(JSON.parse(hb.data!).agent.pid, 4120);
    assert.ok(redis.computers.has('GSMC-DC1'));
    assert.equal(JSON.parse(redis.agentEvents[0]!).event.cause, 'hung');
  });

  it('讀水位失敗回 503 NETOPS_AD_UNAVAILABLE,不回空的 channels、不寫心跳與 Watchdog 事件;恢復後照常', async () => {
    const { post, logsBody, redis } = setup();
    await post('/ad/v1/logs', logsBody([agentEvent(7)]));
    const body = {
      computer: 'GSMC-DC1',
      domain: 'gsmc.com.tw',
      reportedAt: '2026-11-20T13:05:15.000+08:00',
      agent: { pid: 4120 },
      watchdogEvents: [{ type: 'agent_restarted', cause: 'hung', previousPid: 1, pid: 2 }],
    };
    const before = { ...redis.heartbeats.get('GSMC-DC1') };
    const logStart = logs.length;
    redis.fail = 1; // 第一個 Redis 呼叫(讀水位)失敗
    const r = await post('/ad/v1/heartbeat', body);
    assert.equal(r.statusCode, 503);
    const j = r.json();
    assert.equal(j.code, 'NETOPS_AD_UNAVAILABLE');
    assert.equal(j.channels, undefined, '錯誤回應不帶 channels');
    assert.equal(typeof j.requestId, 'string');
    assert.doesNotMatch(r.body, /Connection is closed/);
    assert.deepEqual(redis.heartbeats.get('GSMC-DC1'), before, '心跳沒有寫入');
    assert.equal(redis.agentEvents.length, 0, 'Watchdog 事件沒有寫入(Agent 重送時不重複)');
    assert.ok(logs.slice(logStart).some((l) => l.level === 'warn' && l.msg === 'Redis 存取失敗' && l.extra?.computer === 'GSMC-DC1'), '這次心跳有記 Redis 錯誤');
    // Agent 下一次心跳(同樣內容)成功
    const ok = await post('/ad/v1/heartbeat', body);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json().channels, { Security: { logEpoch: 0, lastRecordId: 7 } });
    assert.equal(redis.agentEvents.length, 1);
  });

  it('心跳欄位格式錯誤回 400', async () => {
    const { post } = setup();
    const base = { computer: 'GSMC-DC1', domain: 'gsmc.com.tw' };
    for (const over of [{ reportedAt: 'yesterday' }, { agent: [] }, { watchdogEvents: ['x'] }, { watchdogEvents: Array.from({ length: 51 }, () => ({})) }, { agentVersion: 'v'.repeat(40) }])
      assert.equal((await post('/ad/v1/heartbeat', { ...base, ...over })).statusCode, 400, JSON.stringify(over).slice(0, 60));
  });

  it('/healthz 不需要 Token', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(r.statusCode, 200);
  });
});

describe('ad-rows:Stream → ad_events 欄位', () => {
  const RECV = Date.UTC(2026, 10, 20, 5, 5, 20);
  const streamJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ computer: 'GSMC-DC1', domain: 'gsmc.com.tw', channel: 'Security', eventId: 4625, recordId: '98765432', logEpoch: 0, time: '2026-11-20T13:05:12.345+08:00', level: 'Audit Failure', provider: 'Microsoft-Windows-Security-Auditing', message: msg4625('john', '10.10.112.13'), ...over });

  it('ISO 時間一定要有時區;不存在的日期拒絕', () => {
    assert.equal(parseIsoTime('2026-11-20T13:05:12.345+08:00'), Date.UTC(2026, 10, 20, 5, 5, 12, 345));
    assert.equal(parseIsoTime('2026-11-20T05:05:12Z'), Date.UTC(2026, 10, 20, 5, 5, 12));
    assert.equal(parseIsoTime('2026-11-20T13:05:12.1234567+08:00'), Date.UTC(2026, 10, 20, 5, 5, 12, 123));
    for (const bad of ['2026-11-20T13:05:12', '2026-02-30T00:00:00Z', '2026-11-20 13:05:12+08:00', '2026-11-20T25:00:00Z', 1, null]) assert.equal(parseIsoTime(bad), null, String(bad));
  });

  it('4625:帳號、來源 IP(IPv4 → IPv6)、工作站、失敗原因、is_issue;沿用 FTP 匯入的解析', () => {
    const issues = { badTime: false };
    const r = toAdRow(streamJson(), RECV, issues)!;
    assert.equal(issues.badTime, false);
    assert.deepEqual(
      [r.event_time, r.received_at, r.computer, r.ad_domain, r.channel, r.event_id, r.log_epoch, r.record_id, r.level, r.level_text, r.account, r.src_ip, r.src_ip_raw, r.workstation, r.reason, r.is_issue, r.privileged, r.source],
      ['2026-11-20 13:05:12', '2026-11-20T05:05:20.000Z', 'GSMC-DC1', 'gsmc.com.tw', 'Security', 4625, 0, '98765432', 'audit_failure', 'Audit Failure', 'john', '::ffff:10.10.112.13', '10.10.112.13', 'PC-john', '不明的使用者名稱或錯誤密碼。', 1, 0, 'agent'],
    );
  });

  it('4728 加入特權群組:actor / target / group、privileged = 1', () => {
    const r = toAdRow(streamJson({ eventId: 4728, level: 'Audit Success', message: msg4728('admin1', '王小明', 'Domain Admins') }), RECV, { badTime: false })!;
    assert.deepEqual([r.actor, r.target, r.group_name, r.privileged, r.is_issue, r.src_ip, r.level], ['admin1', '王小明', 'Domain Admins', 1, 1, '::', 'audit_success']);
  });

  it('時間偏差過大(未來 > 1 天、過去 > 366 天)改用收到時間;Agent 離線幾天後補送的保留原時間', () => {
    for (const time of ['2026-11-22T13:05:12+08:00', '2025-11-01T00:00:00+08:00']) {
      const issues = { badTime: false };
      assert.equal(toAdRow(streamJson({ time }), RECV, issues)!.event_time, '2026-11-20 13:05:20', time);
      assert.equal(issues.badTime, true);
    }
    const issues = { badTime: false };
    assert.equal(toAdRow(streamJson({ time: '2026-11-10T08:00:00+08:00' }), RECV, issues)!.event_time, '2026-11-10 08:00:00');
    assert.equal(issues.badTime, false);
  });

  it('缺必要欄位或不是 JSON 物件回 null', () => {
    for (const bad of ['{', '[]', streamJson({ computer: '' }), streamJson({ channel: 'Application' }), streamJson({ recordId: '0' }), streamJson({ recordId: '01' }), streamJson({ logEpoch: -1 }), streamJson({ eventId: '4625' })])
      assert.equal(toAdRow(bad, RECV, { badTime: false }), null, bad.slice(0, 80));
  });
});

describe('netops-ingest:AD 事件寫入(M2:ingest 重啟重讀不重複)', () => {
  const T0 = Date.UTC(2026, 10, 20, 5, 5, 20);
  const make = (redis: FakeIngestRedis, ch: FakeClickHouse, onWait: () => void = () => undefined) => {
    let now = T0;
    redis.onIdle = () => {
      now += 10_000;
    };
    return new Writer(redis, ch, { batchMs: 5_000, batchMax: 5_000 }, async (ms) => void ((now += ms), onWait()), () => now, ['ad']);
  };
  const ev = (recordId: number) => JSON.stringify({ computer: 'GSMC-DC1', domain: 'gsmc.com.tw', channel: 'Security', eventId: 4625, recordId: String(recordId), logEpoch: 0, time: '2026-11-20T13:05:12+08:00', level: 'Audit Failure', provider: 'p', message: msg4625('john', '10.1.1.1') });

  it('Stream 鍵:AD 是 netops:ad:log:events(接收端與 ingest 相同)', () => {
    assert.equal(INGEST_KEYS.log('ad'), AD_KEYS.log);
  });

  it('寫 ad_events,成功後 ACK;只讀 AD 的 Stream,不碰 PA', async () => {
    const redis = new FakeIngestRedis();
    const ch = new FakeClickHouse();
    const w = make(redis, ch);
    await w.init();
    redis.add('ad', ev(1));
    redis.add('ad', ev(2));
    redis.add('traffic', { time: '2026/11/20 13:05:12' });
    await w.cycle(new AbortController().signal);
    assert.equal(ch.tables.ad.length, 2);
    assert.equal(ch.tables.traffic.length, 0);
    assert.equal(redis.acked.ad?.length, 2);
    assert.equal(w.status.counts.ad.inserted, 2);
    assert.equal(ch.calls[0]!.table, 'ad');
  });

  it('INSERT 成功、ACK 前重啟:重讀待處理清單、同一個去重 token,ad_events 不重複', async () => {
    const redis = new FakeIngestRedis();
    const ch = new FakeClickHouse();
    const stop = new AbortController();
    // ACK 失敗後的退避期間停止:模擬寫完 ClickHouse、還沒 ACK 就當機
    const w1 = make(redis, ch, () => stop.abort());
    await w1.init();
    for (let i = 1; i <= 3; i++) redis.add('ad', ev(i));
    redis.failAck = 1;
    await w1.cycle(stop.signal);
    assert.equal(ch.tables.ad.length, 3);
    assert.equal(redis.acked.ad?.length ?? 0, 0);
    // 新的程序:先補待處理清單
    const w2 = make(redis, ch);
    await w2.init();
    await w2.drainPending(new AbortController().signal);
    assert.equal(ch.tables.ad.length, 3, '同一批重送被去重 token 擋下');
    assert.equal(ch.calls.length, 2);
    assert.equal(ch.calls[0]!.token, ch.calls[1]!.token);
    assert.equal(redis.acked.ad?.length, 3);
  });

  it('壞資料(缺 recordId)計為 malformed 並 ACK,不卡住後面的事件', async () => {
    const redis = new FakeIngestRedis();
    const ch = new FakeClickHouse();
    const w = make(redis, ch);
    await w.init();
    redis.add('ad', JSON.stringify({ computer: 'GSMC-DC1', channel: 'Security' }));
    redis.add('ad', ev(9));
    await w.cycle(new AbortController().signal);
    assert.equal(w.status.counts.ad.malformed, 1);
    assert.equal(ch.tables.ad.length, 1);
    assert.equal(redis.acked.ad?.length, 2);
  });

  it('心跳:AD 的狀態寫在 adState 與 read:ad 等欄位,不覆蓋 PA 的 state;AD Archiver 欄位加 adArchive 前綴', async () => {
    const redis = new FakeIngestRedis();
    const w = make(redis, new FakeClickHouse());
    await w.init();
    const f = adHeartbeatFields(w, T0);
    assert.equal(f.adState, 'ok');
    assert.equal(f['read:ad'], '0');
    assert.equal('state' in f, false);
    assert.deepEqual(adHeartbeatFields(null), {});
    assert.deepEqual(archiveHeartbeatFields(null, 'adArchive'), { adArchiveState: 'disabled' });
  });
});

describe('AD 冷歸檔(AD7):ad-archive/YYYY/ad_events_YYYY-MM-DD.parquet', () => {
  it('種類、檔名、匯出 SQL;PA 的種類清單不含 AD', () => {
    assert.deepEqual([...AD_ARCHIVE_KIND_LIST], ['ad']);
    assert.equal(ARCHIVE_KIND_LIST.includes('ad'), false);
    assert.equal(archiveRelPath('ad', '2026-11-20'), '2026/ad_events_2026-11-20.parquet');
    assert.deepEqual(parseArchiveName('ad_events_2026-11-20.parquet'), { kind: 'ad', day: '2026-11-20', ext: '' });
    const sql = exportSql('ad');
    assert.match(sql, /FROM netops\.ad_events/);
    assert.match(sql, /EXCEPT \(src_ip\)/);
  });

  it('Archiver 含 AD 時一定要有 AD 的保留天數', () => {
    const deps = { ch: {} as never, cold: {} as never, lock: {} as never, log: () => undefined };
    const o = { dir: tmp, staging: tmp, keepDays: 14, alertDays: 2, ttlDays: { traffic: 3, threat: 3 }, maxBytes: 1 };
    assert.throws(() => new Archiver(deps, { ...o, kinds: AD_ARCHIVE_KIND_LIST }), /ad 的原始表保留天數/);
    assert.deepEqual(new Archiver(deps, { ...o, ttlDays: { ...o.ttlDays, ad: 3 }, kinds: AD_ARCHIVE_KIND_LIST }).kinds, ['ad']);
  });

  it('ingest 設定:AD 歸檔目錄預設 /archive-ad、保留天數正式區 90;KEEP_DAYS 不能少於 AD 保留天數', () => {
    const pw = path.join(tmp, 'pw');
    fs.writeFileSync(pw, 'secret');
    const env = { GW_ENV: 'prod', REDIS_URL: 'redis://r:6379/0', CLICKHOUSE_URL: 'http://ch:8123', CLICKHOUSE_USER: 'netops_writer', CLICKHOUSE_PASSWORD_FILE: pw, NETOPS_ARCHIVE_ENABLED: '1', CLICKHOUSE_COLD_PASSWORD_FILE: pw };
    const c = loadIngestConfig(env).archive!;
    assert.equal(c.adDir, '/archive-ad');
    assert.equal(c.ttlDays.ad, 90);
    assert.equal(loadIngestConfig({ ...env, GW_ENV: 'test' }).archive!.ttlDays.ad, 3);
    assert.throws(() => loadIngestConfig({ ...env, GW_ENV: 'test', NETOPS_TTL_AD_DAYS: '30', INGEST_ARCHIVE_KEEP_DAYS: '14' }), /不能少於原始表保留天數 30/);
    assert.throws(() => loadIngestConfig({ ...env, INGEST_AD_ARCHIVE_DIR: 'relative' }), /絕對路徑/);
  });
});

describe('migrations/005:物化檢視的事件清單和 adlog.js 一致', () => {
  it('account_changes 的 event_id 清單 = ACCOUNT_CHANGES;三個粒度相同;TTL 用佔位符', () => {
    const sql = fs.readFileSync(path.join(import.meta.dirname, '../../../deploy/clickhouse/migrations/005-ad1-ad-events.sql'), 'utf8');
    const lists = [...sql.matchAll(/countIf\(l\.event_id IN \(([\d, ]+)\)\) AS account_changes/g)].map((m) => m[1]!.split(',').map((x) => Number(x.trim())).sort());
    assert.equal(lists.length, 3);
    const want = Object.keys(ACCOUNT_CHANGES).map(Number).sort();
    for (const l of lists) assert.deepEqual(l, want);
    for (const ph of ['{{TTL_AD_RAW}}', '{{TTL_HEAT_5M}}', '{{TTL_HEAT_1H}}', '{{TTL_HEAT_1D}}']) assert.ok(sql.includes(ph), ph);
    assert.match(sql, /ORDER BY \(toStartOfHour\(event_time\), channel, event_id, computer, log_epoch, record_id\)/);
  });
});
