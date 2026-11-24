/**
 * AD-3 單元測試(docs/AD-AGENT-PLAN.md §5、§6.1;需求方 2026-11-24 D1–D5):
 *   - NETOPS_AD_SOURCE 設定;ClickHouse 查詢條件全部參數化
 *   - DC Agent 心跳白名單與 ok / stale / offline 判定;GET /v1/ad/agents(Redis 停止 424)
 *   - 查詢來源切換:clickhouse 時總覽 / 明細 / 匯出改查 ClickHouse(注入假 reader),附 names;computer / name 條件
 *   - 對帳比對:Security 只比 23 種、DC 名稱忽略大小寫與網域後段;路由(期間外 400、佇列滿 409、沒有缺口 409)
 *   - 世代判定(CSV 分段錨定 + 水位保護):錨定、未裝 Agent、prev / next、清除重編號無錨點 → ambiguous、水位之上 → waiting
 *   - 補漏執行(假 FTP + 假 ClickHouse):只寫缺的列、重做不重複、Agent 晚到不重複、工作驗證
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { adWhere, type AdChReader, type AdOverview } from '../../src/infra/clickhouse/ad-reader.js';
import type { AdBackfillCh, AdKeyRow } from '../../src/infra/clickhouse/ad-backfill.js';
import type { AdBackfillJob, AdBackfillQueue } from '../../src/infra/redis/ad-backfill.js';
import type { AdStatusRedis } from '../../src/infra/redis/ad-status.js';
import { loadAd } from '../../src/config.js';
import { agentState, groupAgentEvents, toAgentStatus } from '../../src/modules/ad/agents.js';
import { adContext, adContextFromSummary } from '../../src/modules/ad/core/ad-ai.js';
import { compareAd, filesFor, ftpCounts } from '../../src/modules/ad/reconcile.js';
import { dcKey, extraFilter } from '../../src/modules/ad/source.js';
import { anchorKey, decide, segmentEpochs, splitSegments, type CsvRow, type EpochContext } from '../../src/ingest/ad-epoch.js';
import { backfillGroup, runAdBackfill, validateAdJob } from '../../src/ingest/ad-backfill.js';
import { csvTimeSec, csvToAdRow } from '../../src/ingest/ad-rows.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { createTestApp, type TestApp } from '../helpers.js';

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
/** 台灣時間 'yyyy/MM/dd' */
const tpDay = (ms: number) => {
  const d = new Date(ms + 8 * 3600_000);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
};

describe('AD-3 設定', () => {
  it('NETOPS_AD_SOURCE 未設定為 ftp;clickhouse 沒有 ClickHouse 設定、錯值都啟動失敗', () => {
    assert.equal(loadAd({}, 'test', true).source, 'ftp');
    assert.equal(loadAd({ NETOPS_AD_SOURCE: 'ClickHouse' }, 'test', true).source, 'clickhouse');
    assert.throws(() => loadAd({ NETOPS_AD_SOURCE: 'clickhouse' }, 'test', false), /CLICKHOUSE_URL/);
    assert.throws(() => loadAd({ NETOPS_AD_SOURCE: 'redis' }, 'test', true), /只能是/);
    const d = loadAd({}, 'prod', false);
    assert.deepEqual([d.heartbeatStaleSec, d.heartbeatOfflineSec, d.ttlDays], [90, 180, 90]);
    assert.equal(loadAd({}, 'test', false).ttlDays, 3);
    assert.throws(() => loadAd({ AD_HEARTBEAT_STALE_SEC: '200', AD_HEARTBEAT_OFFLINE_SEC: '100' }, 'test', false), /必須大於/);
  });
});

describe('AD ClickHouse 查詢條件', () => {
  it('使用者輸入只進 query_params,不進 SQL;eventId 非數字為 0 筆', () => {
    const evil = "x' OR 1=1 --";
    const { where, params } = adWhere({ fromMs: 0, toMs: 1000, q: evil, account: evil, ip: evil, computer: evil, dcDomain: evil, channel: evil, level: evil, eventId: '4625, 4771', issueOnly: true, ipRanges: [['10.0.0.1', '10.0.0.9']] });
    assert.ok(!where.includes(evil), where);
    assert.ok(Object.values(params).includes(evil));
    assert.match(where, /event_id IN \{p\d+:Array\(UInt32\)\}/);
    assert.match(where, /is_issue = 1/);
    assert.match(where, /arrayExists/);
    assert.ok(Object.values(params).includes('[4625,4771]'));
    assert.match(adWhere({ fromMs: 0, toMs: 1, eventId: ',' }).where, / AND 0$/);
    assert.match(adWhere({ fromMs: 0, toMs: 1, ipRanges: [['bad', 'x']] }).where, / AND 0$/);
  });

  it('computer 與 dcDomain 正規化(小寫、FQDN、大寫網域)並使用 query_params(審查 M2)', () => {
    const a = adWhere({ fromMs: 0, toMs: 1000, computer: 'gsmc-dc1', dcDomain: 'GSMC.COM.TW' });
    assert.match(a.where, /upper\(splitByChar\('\.', computer\)\[1\]\) = \{p\d+:String\}/);
    assert.match(a.where, /lower\(ad_domain\) = \{p\d+:String\}/);
    assert.ok(Object.values(a.params).includes('GSMC-DC1'));
    assert.ok(Object.values(a.params).includes('gsmc.com.tw'));
    const b = adWhere({ fromMs: 0, toMs: 1000, computer: 'GSMC-DC1.gsmc.com.tw' });
    assert.ok(Object.values(b.params).includes('GSMC-DC1'));
    assert.ok(!b.where.includes('GSMC-DC1'));
  });
});

describe('DC Agent 狀態', () => {
  const now = Date.parse('2026-11-24T10:00:00+08:00');
  const hb = (ageSec: number, data: unknown = {}) => ({
    computer: 'GSMC-DC1',
    fields: { data: JSON.stringify(data), updatedAt: new Date(now - ageSec * 1000).toISOString(), domain: 'gsmc.com.tw', agentVersion: '0.4.0', reportedAt: new Date(now).toISOString(), received: '42' },
  });
  it('state:90 秒內 ok、超過 stale、超過 180 秒 offline、沒有心跳 unknown', () => {
    const o = { now, staleSec: 90, offlineSec: 180 };
    assert.equal(toAgentStatus(hb(30), [], o).state, 'ok');
    assert.equal(toAgentStatus(hb(120), [], o).state, 'stale');
    assert.equal(toAgentStatus(hb(200), [], o).state, 'offline');
    assert.equal(toAgentStatus({ computer: 'X', fields: {} }, [], o).state, 'unknown');
    assert.equal(agentState(null, 90, 180), 'unknown');
  });
  it('只取白名單欄位、型別不符改 null、字串截斷與去除控制字元', () => {
    const s = toAgentStatus(
      hb(10, {
        watchdogVersion: '0.4.0',
        token: 'SECRET',
        agent: { pid: 'x', statusOk: true, lastError: `a\u0000b${'z'.repeat(500)}`, cpuPct: 0.5, rssMb: 11, secret: 'no', skippedEvents: 3 },
        channels: { Security: { lastRecordId: 99, logEpoch: 1, wrapRisk: true, oldestEventAt: 'not-a-date', evil: 1 }, Other: { lastRecordId: 1 } },
      }),
      [],
      { now, staleSec: 90, offlineSec: 180 },
    );
    const json = JSON.stringify(s);
    assert.ok(!json.includes('SECRET') && !json.includes('"secret"') && !json.includes('evil'), json);
    assert.equal(s.agent.pid, null);
    assert.equal(s.agent.lastError.length, 300);
    assert.ok(!s.agent.lastError.includes('\u0000'));
    assert.deepEqual(Object.keys(s.channels), ['Security']);
    assert.equal(s.channels.Security!.oldestEventAt, null);
    assert.equal(s.channels.Security!.wrapRisk, true);
    assert.equal(s.received, 42);
    assert.equal(s.watchdogVersion, '0.4.0');
  });
  it('Watchdog 事件:每台最近 24 小時、最多 20 筆、壞 JSON 略過', () => {
    const ev = (computer: string, agoMs: number, type = 'agent_restarted') => JSON.stringify({ computer, receivedAt: new Date(now - agoMs).toISOString(), event: { type, cause: 'hung', detail: 'd', at: new Date(now - agoMs).toISOString() } });
    const raw = ['{bad', ev('GSMC-DC1', 1000), ev('GSMC-DC1', 2 * DAY_MS), ...Array.from({ length: 30 }, () => ev('GSC-DC2', 5000))];
    const m = groupAgentEvents(raw, now);
    assert.equal(m.get('GSMC-DC1')!.length, 1);
    assert.equal(m.get('GSC-DC2')!.length, 20);
    assert.equal(m.get('GSMC-DC1')![0]!.cause, 'hung');
  });
});

describe('AI 文字:adContext 改用 adContextFromSummary 後輸出不變', () => {
  it('同一份統計與符合事件,兩個入口文字相同', async () => {
    const { summarizeAd } = await import('../../src/modules/ad/core/adlog.js');
    const events = [
      { time: '2026/11/20 10:00:00', eventId: 4625, level: 'audit_failure', provider: 'p', computer: 'GSMC-DC1', recordId: '1', channel: 'Security', message: '失敗 10.1.1.1', account: 'bob', ip: '10.1.1.1', reason: '密碼錯誤' },
      { time: '2026/11/20 09:00:00', eventId: 7036, level: 'info', provider: 'scm', computer: 'GSMC-DC1', recordId: '2', channel: 'System', message: '服務' },
    ];
    const days = [{ day: '2026/11/20', files: [{ channel: 'Security', rows: 1 }] }];
    const a = adContext(events as never, days as never, '2026/11/20', '2026/11/20', { ips: ['10.1.1.1'] } as never);
    const b = adContextFromSummary(summarizeAd(events as never, 20) as never, {
      computers: ['GSMC-DC1'],
      secEmpty: false,
      from: '2026/11/20',
      to: '2026/11/20',
      ips: ['10.1.1.1'],
      eventIds: [],
      accounts: [],
      full: true,
      match: [events[0]] as never,
      matchTotal: 1,
    } as never);
    assert.equal(a, b);
    assert.match(a, /共 1 筆,列前 25 筆|共 1 筆，列前 25 筆/);
    assert.equal(adContext([], days as never, '2026/11/20', '2026/11/20'), '');
  });
});

describe('對帳比對', () => {
  it('Security 只算 23 種;DC 名稱忽略大小寫與網域後段;ok / gap / excess', () => {
    const f = ftpCounts([
      { computer: 'GSMC-DC1.gsmc.com.tw', channel: 'Security', eventId: 4625 },
      { computer: 'gsmc-dc1', channel: 'Security', eventId: 4740 },
      { computer: 'GSMC-DC1', channel: 'Security', eventId: 4672 },
      { computer: 'GSMC-DC1', channel: 'System', eventId: 7036 },
      { computer: 'GSC-DC2', channel: 'System', eventId: 7036 },
    ]);
    assert.equal(f.get('GSMC-DC1|Security'), 2);
    const items = compareAd(f, [
      { computer: 'GSMC-DC1', channel: 'Security', n: 1, agent: 1, ftp: 0 },
      { computer: 'GSMC-DC1', channel: 'System', n: 1, agent: 1, ftp: 0 },
      { computer: 'GSMC-DC1', channel: 'DNS_Server', n: 3, agent: 3, ftp: 0 },
    ]);
    const by = Object.fromEntries(items.map((x) => [`${x.computer}|${x.channel}`, x]));
    assert.equal(by['GSMC-DC1|Security']!.status, 'gap');
    assert.equal(by['GSMC-DC1|Security']!.diff, 1);
    assert.equal(by['GSMC-DC1|System']!.status, 'ok');
    assert.equal(by['GSMC-DC1|DNS_Server']!.status, 'excess');
    assert.equal(by['GSC-DC2|System']!.status, 'gap');
    assert.equal(dcKey('gsmc-dc1.gsmc.com.tw'), 'GSMC-DC1');
  });
  it('補漏檔案只取缺口記錄的 CSV,路徑在 AD 目錄的日期資料夾下', () => {
    const files = filesFor('/AD_Log_Backup', '2026/11/23', [{ name: 'Security_GSMC-DC1.csv', channel: 'Security' }, { name: 'System.csv', channel: 'System' }, { name: 'x.txt', channel: 'Security' }], new Set(['Security']));
    assert.deepEqual(files, ['/AD_Log_Backup/20261123/Security_GSMC-DC1.csv']);
  });
  it('ftp 來源的 computer / ipRanges 條件', () => {
    const e = (computer: string, ip: string) => ({ computer, ip }) as never;
    assert.equal(extraFilter({ computer: 'gsmc-dc1' })(e('GSMC-DC1.gsmc.com.tw', '')), true);
    assert.equal(extraFilter({ computer: 'GSC-DC2' })(e('GSMC-DC1', '')), false);
    assert.equal(extraFilter({ ipRanges: [['10.0.0.1', '10.0.0.9']] })(e('X', '10.0.0.5')), true);
    assert.equal(extraFilter({ ipRanges: [['10.0.0.1', '10.0.0.9']] })(e('X', '10.0.1.5')), false);
    assert.equal(extraFilter({ dcDomain: 'gsmc.com.tw' })(e('GSMC-DC1.gsmc.com.tw', '')), true);
  });
});

describe('FTP 補寫世代判定(D1)', () => {
  const row = (t: number, rid: number, eventId = 4625): CsvRow => ({ t, rid, eventId });
  const ctx = (o: Partial<EpochContext>): EpochContext => ({ hasAgent: true, anchors: new Map(), prevAgent: () => null, nextAgent: () => null, watermark: new Map(), ...o });

  it('RecordID 變小處切段', () => {
    const segs = splitSegments([row(3, 12), row(1, 10), row(2, 11), row(4, 1), row(5, 2)]);
    assert.deepEqual(
      segs.map((s) => s.map((r) => r.rid)),
      [
        [10, 11, 12],
        [1, 2],
      ],
    );
  });
  it('RecordID 與時間小幅倒序不切段(程式碼審查 H1);清除後重新編號才切', () => {
    assert.equal(splitSegments([row(5, 1_000_002), row(6, 1_000_001), row(7, 1_000_003)]).length, 1);
    assert.equal(splitSegments([row(5, 1_000_002), row(6, 3)]).length, 2);
    // 小的記錄(RecordID 只有幾千)清除後從 1 開始
    assert.equal(splitSegments([row(5, 4000), row(6, 4001), row(7, 1)]).length, 2);
  });
  it('錨定:段內有 Agent 列對得上就用它的世代(一天中段清除:兩段各自錨定)', () => {
    const rows = [row(100, 500), row(101, 501), row(200, 1), row(201, 2)];
    const s = segmentEpochs(rows, ctx({ anchors: new Map([[anchorKey(501, 101, 4625), 3], [anchorKey(2, 201, 4625), 4]]) }));
    assert.deepEqual(
      s.map((x) => [x.epoch, x.by]),
      [
        [3, 'anchor'],
        [4, 'anchor'],
      ],
    );
  });
  it('未裝 Agent(沒有 Agent 資料):世代 0,全部可寫(D2)', () => {
    const c = ctx({ hasAgent: false });
    const s = segmentEpochs([row(1, 5), row(2, 6)], c);
    assert.deepEqual([s[0]!.epoch, s[0]!.by], [0, 'no-agent']);
    assert.deepEqual(decide(row(2, 6), 0, c, null), { kind: 'write', epoch: 0 });
  });
  it('沒有錨點:前一筆 Agent 列 RecordID 較小 → 沿用其世代;Agent 安裝前 → 下一筆 Agent 列的世代', () => {
    assert.deepEqual(segmentEpochs([row(50, 900)], ctx({ prevAgent: () => ({ epoch: 2, rid: 800 }) }))[0]!.by, 'prev');
    const s = segmentEpochs([row(50, 100)], ctx({ nextAgent: () => ({ epoch: 0, rid: 150 }) }))[0]!;
    assert.deepEqual([s.epoch, s.by], [0, 'next']);
  });
  it('Agent 停機期間被清除(新 log 的小 RecordID、沒有錨點)→ ambiguous,不寫(原建議的漏洞 B)', () => {
    const c = ctx({ prevAgent: () => ({ epoch: 0, rid: 98_765_432 }), nextAgent: () => ({ epoch: 1, rid: 40 }) });
    const s = segmentEpochs([row(50, 5)], c)[0]!;
    assert.deepEqual([s.epoch, s.by], [null, 'ambiguous']);
    assert.deepEqual(decide(row(50, 5), s.epoch, c, 1), { kind: 'ambiguous' });
  });
  it('水位保護:目前世代 RecordID 大於水位 → waiting(原建議的漏洞 A);舊世代不受限', () => {
    const c = ctx({ watermark: new Map([[0, 999], [1, 500]]) });
    assert.deepEqual(decide(row(1, 501), 1, c, 1), { kind: 'waiting', epoch: 1 });
    assert.deepEqual(decide(row(1, 500), 1, c, 1), { kind: 'write', epoch: 1 });
    assert.deepEqual(decide(row(1, 5000), 0, c, 1), { kind: 'write', epoch: 0 });
  });
});

describe('CSV → ad_events 列', () => {
  it('時間只到秒、台灣時間;source = ftp;不合法回 null', () => {
    assert.equal(csvTimeSec('2026/11/23 08:00:00'), Date.parse('2026-11-23T08:00:00+08:00') / 1000);
    assert.equal(csvTimeSec('2026/02/30 08:00:00'), null);
    const r = csvToAdRow({ time: '2026/11/23 08:00:01', eventId: 4625, level: 'audit_failure', levelText: '稽核失敗', recordId: '123', channel: 'Security', message: 'm', ip: '10.1.1.1', account: 'bob' }, { computer: 'GSMC-DC1', domain: 'gsmc.com.tw', epoch: 2, receivedMs: 0 })!;
    assert.equal(r.event_time, '2026-11-23 08:00:01');
    assert.deepEqual([r.source, r.log_epoch, r.record_id, r.computer, r.ad_domain, r.is_issue, r.src_ip], ['ftp', 2, '123', 'GSMC-DC1', 'gsmc.com.tw', 1, '::ffff:10.1.1.1']);
    assert.equal(csvToAdRow({ time: 'x', eventId: 1, level: 'info', recordId: '1', channel: 'Security' }, { computer: 'A', domain: '', epoch: 0, receivedMs: 0 }), null);
    assert.equal(csvToAdRow({ time: '2026/11/23 08:00:01', eventId: 1, level: 'info', recordId: '0', channel: 'Security' }, { computer: 'A', domain: '', epoch: 0, receivedMs: 0 }), null);
  });
});

/* ───────── 補漏執行(假 FTP + 假 ClickHouse + 假佇列) ───────── */

const AD_DIR = '/AD_Log_Backup';
const NOW = Date.now();
const DAY = tpDay(NOW - DAY_MS);
const YMD = DAY.replace(/\//g, '');
const D = DAY.replace(/\//g, '-');
const csv = (rows: [string, number, number, string?][], computer = 'GSMC-DC1.gsmc.com.tw') =>
  ['TimeCreated,EventID,Level,Provider,Computer,RecordID,Message', ...rows.map(([hms, id, rid, msg]) => `"${D} ${hms}",${id},"稽核失敗","Microsoft-Windows-Security-Auditing","${computer}",${rid},"${msg ?? `帳戶登入失敗。\r\n\t帳戶名稱:\t\tbob\r\n\t來源網路位址:\t10.1.1.${rid % 200}`}"`)].join('\r\n') + '\r\n';
const sec = (hms: string) => Date.parse(`${D}T${hms}+08:00`) / 1000;

interface FakeRow {
  computer: string;
  channel: string;
  epoch: number;
  rid: number;
  t: number;
  eventId: number;
  source: string;
}

function fakeCh(rows: FakeRow[]) {
  const tokens = new Set<string>();
  const ch = {
    async insertJson(_t: string, lines: readonly string[], token: string) {
      if (tokens.has(token)) return;
      tokens.add(token);
      for (const l of lines) {
        const r = JSON.parse(l);
        rows.push({ computer: r.computer, channel: r.channel, epoch: r.log_epoch, rid: Number(r.record_id), t: Date.parse(r.event_time.replace(' ', 'T') + '+08:00') / 1000, eventId: r.event_id, source: r.source });
      }
    },
  };
  const of = (c: string, chn: string) => rows.filter((r) => r.computer === c && r.channel === chn);
  const q: AdBackfillCh = {
    async agentComputers() {
      return [...new Set(rows.filter((r) => r.source === 'agent').map((r) => r.computer))].map((c) => ({ computer: c, domain: 'gsmc.com.tw' }));
    },
    async keysInRange(c, chn, lo, hi) {
      return of(c, chn)
        .filter((r) => r.rid >= lo && r.rid <= hi)
        .map((r): AdKeyRow => ({ epoch: r.epoch, rid: r.rid, t: r.t, eventId: r.eventId, source: r.source }));
    },
    async agentEpochs(c, chn) {
      const m = new Map<number, number>();
      for (const r of of(c, chn).filter((x) => x.source === 'agent')) m.set(r.epoch, Math.max(m.get(r.epoch) ?? 0, r.rid));
      return [...m].map(([epoch, maxRid]) => ({ epoch, maxRid }));
    },
    async agentBefore(c, chn, t) {
      const r = of(c, chn)
        .filter((x) => x.source === 'agent' && x.t <= t)
        .sort((a, b) => b.t - a.t || b.epoch - a.epoch || b.rid - a.rid)[0];
      return r ? { epoch: r.epoch, rid: r.rid } : null;
    },
    async agentAfter(c, chn, t) {
      const r = of(c, chn)
        .filter((x) => x.source === 'agent' && x.t >= t)
        .sort((a, b) => a.t - b.t || a.epoch - b.epoch || a.rid - b.rid)[0];
      return r ? { epoch: r.epoch, rid: r.rid } : null;
    },
  };
  return { ch, q };
}

function fakeQueue() {
  const jobs = new Map<string, AdBackfillJob>();
  const queue: AdBackfillQueue = {
    enqueue: async () => null,
    get: async (id) => jobs.get(id) ?? null,
    take: async () => null,
    update: async (id, f) => void jobs.set(id, { ...jobs.get(id)!, ...(f as object) }),
    finish: async () => undefined,
    failInterrupted: async () => [],
    close: async () => undefined,
  };
  return { queue, jobs };
}

let jobN = 0;
function job(files: string[], scope = [{ computer: 'GSMC-DC1', channel: 'Security' }]): AdBackfillJob {
  return { id: `00000000-0000-4000-8000-${String(++jobN).padStart(12, '0')}`, day: DAY, files, scope, state: 'running', createdBy: 't', createdAt: '', startedAt: null, finishedAt: null, read: 0, skipped: 0, inserted: 0, waitingAgent: 0, ambiguous: 0, invalid: 0, error: null };
}

async function run(rows: FakeRow[], j: AdBackfillJob, hwm: Record<string, string>, ftpFiles: Record<string, string>) {
  const ftp = createFakeFtp();
  for (const [n, c] of Object.entries(ftpFiles)) ftp.put(`${AD_DIR}/${YMD}/${n}`, c);
  const { ch, q } = fakeCh(rows);
  const { queue, jobs } = fakeQueue();
  jobs.set(j.id, j);
  await runAdBackfill(j, { ch: ch as never, q, ftp, queue, log: () => undefined, signal: new AbortController().signal, rules: { adDir: AD_DIR, ttlDays: 3 }, now: () => NOW });
  return jobs.get(j.id)!;
}
const keys = (rows: FakeRow[]) => rows.map((r) => `${r.computer}|${r.channel}|${r.epoch}|${r.rid}`);
const noDup = (rows: FakeRow[]) => assert.equal(new Set(keys(rows)).size, rows.length, '有重複的 (computer, channel, log_epoch, record_id)');

describe('AD FTP 補漏執行', () => {
  const agent = (rid: number, hms: string, epoch = 0, eventId = 4625): FakeRow => ({ computer: 'GSMC-DC1', channel: 'Security', epoch, rid, t: sec(hms), eventId, source: 'agent' });
  const file = `${AD_DIR}/${YMD}/Security_GSMC-DC1.csv`;

  it('只補缺的列(錨定世代);FQDN 對到 Agent 名稱;重做 0 筆;Agent 另收的 4672 不影響', async () => {
    const rows = [agent(100, '01:00:00', 2), agent(102, '03:00:00', 2), agent(103, '03:30:00', 2, 4672)];
    const content = csv([
      ['01:00:00', 4625, 100],
      ['02:00:00', 4625, 101],
      ['03:00:00', 4625, 102],
    ]);
    const j1 = await run(rows, job([file]), { 'Security:2': '103' }, { 'Security_GSMC-DC1.csv': content });
    assert.equal(j1.state, 'done', String(j1.error));
    assert.deepEqual([j1.read, j1.skipped, j1.inserted, j1.waitingAgent, j1.ambiguous], [3, 2, 1, 0, 0]);
    const added = rows.find((r) => r.source === 'ftp')!;
    assert.deepEqual([added.computer, added.epoch, added.rid], ['GSMC-DC1', 2, 101]);
    const j2 = await run(rows, job([file]), { 'Security:2': '103' }, { 'Security_GSMC-DC1.csv': content });
    assert.deepEqual([j2.inserted, j2.skipped], [0, 3]);
    noDup(rows);
  });

  it('Agent 晚到:水位之上的列不補(waitingAgent);Agent 之後送來也不重複(漏洞 A)', async () => {
    const rows = [agent(100, '01:00:00')];
    const content = csv([
      ['01:00:00', 4625, 100],
      ['02:00:00', 4625, 101],
      ['03:00:00', 4625, 102],
    ]);
    const j = await run(rows, job([file]), { 'Security:0': '100' }, { 'Security_GSMC-DC1.csv': content });
    assert.deepEqual([j.inserted, j.waitingAgent], [0, 2]);
    // Agent 恢復後從水位 100 之後送 101、102
    rows.push(agent(101, '02:00:00'), agent(102, '03:00:00'));
    noDup(rows);
  });

  it('Agent 漏掉的列(水位已越過)才補;Agent 停機期間清除重編號無錨點 → ambiguous 不寫(漏洞 B)', async () => {
    const rows = [agent(500, '01:00:00', 0), agent(40, '05:00:00', 1)];
    const content = csv([
      ['01:00:00', 4625, 500],
      ['02:00:00', 4625, 501],
      ['03:00:00', 1102, 1],
      ['03:10:00', 4625, 2],
    ]);
    const j = await run(rows, job([file]), { 'Security:0': '501', 'Security:1': '40' }, { 'Security_GSMC-DC1.csv': content });
    assert.equal(j.state, 'done', String(j.error));
    // 501:世代 0(錨定 500)、舊世代不受水位限制 → 補;1、2:新段沒有錨點,prev(世代 0、RecordID 501)> 段的 RecordID → ambiguous
    assert.deepEqual([j.inserted, j.ambiguous, j.skipped], [1, 2, 1]);
    noDup(rows);
  });

  it('未裝 Agent 的 DC:世代 0、全部寫入;CSV 新舊檔名重複只算一次(D2)', async () => {
    const rows: FakeRow[] = [];
    const content = csv(
      [
        ['01:00:00', 4625, 7],
        ['02:00:00', 4625, 8],
      ],
      'GSC-DC2.gsc.com.tw',
    );
    const j = await run(rows, job([`${AD_DIR}/${YMD}/Security_GSC-DC2.csv`, `${AD_DIR}/${YMD}/Security.csv`], [{ computer: 'GSC-DC2', channel: 'Security' }]), {}, { 'Security_GSC-DC2.csv': content, 'Security.csv': content });
    assert.deepEqual([j.read, j.inserted], [2, 2]);
    assert.ok(rows.every((r) => r.epoch === 0 && r.computer === 'GSC-DC2' && r.source === 'ftp'));
    noDup(rows);
  });

  it('範圍外的 DC 與記錄、不是這一天的列不讀', async () => {
    const rows: FakeRow[] = [];
    const content = csv([['01:00:00', 4625, 7]]);
    const j = await run(rows, job([file], [{ computer: 'OTHER-DC', channel: 'Security' }]), {}, { 'Security_GSMC-DC1.csv': content });
    assert.deepEqual([j.read, j.inserted], [0, 0]);
  });

  it('工作驗證:目錄外、.. 、非 csv、日期超過保留期、範圍不正確 → 失敗', async () => {
    const rules = { adDir: AD_DIR, ttlDays: 3, now: NOW };
    assert.equal(validateAdJob(job([file]), rules), null);
    assert.match(validateAdJob(job(['/etc/passwd']), rules)!, /AD 目錄/);
    assert.match(validateAdJob(job([`${AD_DIR}/${YMD}/../x.csv`]), rules)!, /AD 目錄/);
    assert.match(validateAdJob(job([`${AD_DIR}/${YMD}/a.txt`]), rules)!, /AD 目錄/);
    assert.match(validateAdJob({ ...job([file]), day: tpDay(NOW - 10 * DAY_MS) }, rules)!, /保留期間/);
    assert.match(validateAdJob(job([file], [{ computer: 'a b', channel: 'Security' }]), rules)!, /範圍/);
    assert.match(validateAdJob(job([file], [{ computer: 'A', channel: 'Evil' }]), rules)!, /範圍/);
    const j = await run([], job(['/etc/passwd']), {}, {});
    assert.equal(j.state, 'failed');
  });

  it('20 萬筆以上大量列:segmentEpochs 與 backfillGroup 不觸發 RangeError(審查 M1)', async () => {
    const N = 200_005;
    const baseT = Math.floor(NOW / 1000) - 3600;
    const rows: CsvRow[] = Array.from({ length: N }, (_, i) => ({ t: baseT + Math.floor(i / 100), rid: 1000 + i, eventId: 4625 }));
    const ctx: EpochContext = {
      hasAgent: true,
      anchors: new Map(),
      prevAgent: () => ({ epoch: 2, rid: 500 }),
      nextAgent: () => null,
      watermark: new Map([[2, 999]]),
    };
    const segs = segmentEpochs(rows, ctx);
    assert.equal(segs.length, 1);
    assert.deepEqual([segs[0]!.epoch, segs[0]!.by, segs[0]!.rows.length], [2, 'prev', N]);

    let rangeSeen: [number, number] | null = null;
    const q: AdBackfillCh = {
      agentComputers: async () => [],
      keysInRange: async (_c, _ch, lo, hi) => ((rangeSeen = [lo, hi]), []),
      agentEpochs: async () => [{ epoch: 2, maxRid: 999 }],
      agentBefore: async () => ({ epoch: 2, rid: 500 }),
      agentAfter: async () => null,
    };
    const dayStr = tpDay(NOW - DAY_MS);
    const items = rows.map((row) => ({
      ev: { time: `${dayStr} 08:00:00`, eventId: 4625, level: 'audit_failure', levelText: '', provider: 'p', computer: 'GSMC-DC1', recordId: String(row.rid), channel: 'Security', message: '' },
      rawComputer: 'GSMC-DC1',
      row,
    }));
    const r = await backfillGroup(
      { computer: 'GSMC-DC1', channel: 'Security' },
      items,
      { ch: { insertJson: async () => undefined }, q, jobId: 'big-1', domain: 'gsmc.com.tw', now: NOW, dcName: 'GSMC-DC1' },
    );
    assert.deepEqual(rangeSeen, [1000, 1000 + N - 1]);
    assert.equal(r.waitingAgent, N);
  });
});

/* ───────── 路由(注入假 ClickHouse reader、假 Redis) ───────── */

function fakeReader(): AdChReader & { calls: string[] } {
  const calls: string[] = [];
  const ev = { time: '2026/11/23 08:00:00', eventId: 4625, level: 'audit_failure', levelText: 'Audit Failure', provider: 'p', computer: 'GSMC-DC1', recordId: '10', channel: 'Security', message: 'm', account: 'bob', actor: '', target: '', group: '', privileged: false, ip: '10.9.9.9', workstation: '', reason: '', dcDomain: 'gsmc.com.tw', source: 'agent', logEpoch: 0 };
  const ov: AdOverview = { total: 1, byChannel: { Security: 1 }, byLevel: { audit_failure: 1 }, timeMin: ev.time, timeMax: ev.time, hours: [{ hour: '2026/11/23 08', n: 1, issue: 1 }], events: [], issues: [], failAccounts: [], failIps: [{ key: '10.9.9.9', n: 1 }], failReasons: [], accountChanges: [], privilegedChanges: 0, accountsCreated: 0, privLogons: [] };
  return {
    calls,
    days: async () => (calls.push('days'), [{ day: '2026/11/23', events: 1, agent: 1, ftp: 0, computers: ['GSMC-DC1'] }]),
    overview: async () => (calls.push('overview'), ov),
    search: async (f, offset, limit) => (calls.push(`search:${f.computer ?? ''}:${f.dcDomain ?? ''}:${f.ipRanges ? 'ranges' : ''}:${offset}:${limit}`), { rows: [ev], total: 1, scanned: 5 }),
    computers: async () => [{ computer: 'GSMC-DC1', dcDomain: 'gsmc.com.tw', events: 1 }],
    aiMatches: async () => ({ rows: [], total: 0 }),
    hasIp: async () => false,
    reconCounts: async () => [{ computer: 'GSMC-DC1', channel: 'Security', n: 0, agent: 0, ftp: 0 }],
  };
}

describe('AD 路由(clickhouse 來源)', () => {
  let t: TestApp;
  const reader = fakeReader();
  let redisUp = true;
  const now = Date.now();
  const status: AdStatusRedis = {
    heartbeats: async () => {
      if (!redisUp) throw new Error('down');
      return [{ computer: 'GSMC-DC1', fields: { data: '{}', updatedAt: new Date(now - 10_000).toISOString(), domain: 'gsmc.com.tw', received: '1' } }];
    },
    agentEvents: async () => [],
    watermarks: async () => ({}),
    close: async () => undefined,
  };
  before(async () => {
    // 測試用的假密碼檔(不是任何環境的密碼);PA 的 ClickHouse 查詢注入 null,不連線
    const pw = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ad3-')), 'pw');
    fs.writeFileSync(pw, 'test-only');
    t = await createTestApp({ env: { NETOPS_AD_SOURCE: 'clickhouse', CLICKHOUSE_URL: 'http://127.0.0.1:1', CLICKHOUSE_PASSWORD_FILE: pw }, chReader: null, ad: { reader, status, backfillQueue: null, now: () => now } });
  });
  after(async () => t?.close());

  it('GET /ad/agents:狀態與摘要;Redis 停止 424', async () => {
    const r = await t.call({ url: '/v1/ad/agents' });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.items[0].state, 'ok');
    assert.equal(b.summary.ok, 1);
    assert.deepEqual([b.staleSec, b.offlineSec, b.source], [90, 180, 'clickhouse']);
    redisUp = false;
    const down = await t.call({ url: '/v1/ad/agents' });
    assert.equal(down.statusCode, 424);
    assert.equal(down.json().code, 'NETOPS_REDIS_UNAVAILABLE');
    // days 仍可用,agents 為 null
    const days = await t.call({ url: '/v1/ad/days' });
    assert.equal(days.statusCode, 200, days.body);
    assert.equal(days.json().agents, null);
    assert.equal(days.json().days[0].day, '2026-11-23');
    redisUp = true;
  });

  it('總覽、明細查 ClickHouse;附 names 欄位;computer 條件;source 標示', async () => {
    const ov = await t.call({ url: '/v1/ad/overview?from=2026-11-23' });
    assert.equal(ov.statusCode, 200, ov.body);
    assert.equal(ov.json().source, 'clickhouse');
    assert.ok('names' in ov.json());
    const ev = await t.call({ url: '/v1/ad/events?from=2026-11-23T00:00:00%2B08:00&to=2026-11-23T23:59:00%2B08:00&computer=GSMC-DC1&pageSize=10&page=2' });
    assert.equal(ev.statusCode, 200, ev.body);
    const b = ev.json();
    assert.equal(b.items[0].time, '2026-11-23T08:00:00+08:00');
    assert.deepEqual([b.items[0].source, b.items[0].dcDomain, b.items[0].logEpoch, b.scanned], ['agent', 'gsmc.com.tw', 0, 5]);
    assert.ok(reader.calls.includes('search:GSMC-DC1:::10:10'));
    // 小寫、FQDN、大寫網域都會正規化後才進 reader.search(審查 M2)
    const norm1 = await t.call({ url: '/v1/ad/events?from=2026-11-23T00:00:00%2B08:00&to=2026-11-23T23:59:00%2B08:00&computer=gsmc-dc1&dcDomain=GSMC.COM.TW' });
    assert.equal(norm1.statusCode, 200, norm1.body);
    assert.ok(reader.calls.includes('search:GSMC-DC1:gsmc.com.tw::0:50'));
    const norm2 = await t.call({ url: '/v1/ad/events?from=2026-11-23T00:00:00%2B08:00&to=2026-11-23T23:59:00%2B08:00&computer=GSMC-DC1.gsmc.com.tw' });
    assert.equal(norm2.statusCode, 200, norm2.body);
    assert.ok(reader.calls.includes('search:GSMC-DC1:::0:50'));
    const bad = await t.call({ url: '/v1/ad/events?from=2026-11-23T00:00:00%2B08:00&to=2026-11-23T23:59:00%2B08:00&computer=a%20b' });
    assert.equal(bad.statusCode, 400);
    const noName = await t.call({ url: '/v1/ad/events?from=2026-11-23T00:00:00%2B08:00&to=2026-11-23T23:59:00%2B08:00&name=nobody' });
    assert.equal(noName.statusCode, 400);
  });

  it('匯出加 DC 網域、來源 IP 名稱、資料來源欄', async () => {
    const r = await t.call({ url: '/v1/ad/events/export?from=2026-11-23T00:00:00%2B08:00&to=2026-11-23T23:59:00%2B08:00' });
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.body, /DC 網域,來源 IP 名稱 \/ 部門,資料來源/);
    assert.match(r.body, /gsmc\.com\.tw,,Agent/);
  });

  it('對帳:期間外 400;沒有 Redis 佇列時補漏 424;查詢工作不存在 424(沒有佇列)', async () => {
    const out = await t.call({ method: 'POST', url: '/v1/ad/reconciliations', payload: { day: '2020-01-01' } });
    assert.equal(out.statusCode, 400);
    const list = await t.call({ url: `/v1/ad/reconciliations?from=${tpDay(now - 2 * DAY_MS).replace(/\//g, '-')}&to=${tpDay(now).replace(/\//g, '-')}` });
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(Array.isArray(list.json().items));
    const day = tpDay(now - DAY_MS).replace(/\//g, '-');
    const rec = await t.call({ method: 'POST', url: '/v1/ad/reconciliations', payload: { day } });
    assert.equal(rec.statusCode, 200, rec.body);
    assert.equal(rec.json().status, 'pending');
    const bf = await t.call({ method: 'POST', url: '/v1/ad/backfills', payload: { day } });
    assert.equal(bf.statusCode, 424);
  });

  it('OpenAPI:新路由的權限與必填欄位', async () => {
    const spec = t.app.swagger() as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const op = (p: string, m: string) => spec.paths[p]![m]!;
    assert.equal(op('/v1/ad/agents', 'get')['x-permission'], 'netops.ad.read');
    assert.equal(op('/v1/ad/reconciliations', 'get')['x-permission'], 'netops.ftp.read');
    assert.equal(op('/v1/ad/reconciliations', 'post')['x-permission'], 'netops.ftp.write');
    assert.equal(op('/v1/ad/backfills', 'post')['x-permission'], 'netops.ftp.write');
    assert.equal(op('/v1/ad/backfills/{id}', 'get')['x-permission'], 'netops.ftp.read');
    for (const [p, m] of [
      ['/v1/ad/agents', 'get'],
      ['/v1/ad/backfills', 'post'],
    ] as const)
      for (const k of ['operationId', 'summary', 'description', 'x-gherkin']) assert.ok(op(p, m)[k], `${p} ${m} 缺 ${k}`);
  });
});
