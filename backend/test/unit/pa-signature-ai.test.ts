/**
 * PA 威脅特徵碼 TS-3 AI 摘要單元與 API 測試(docs/THREAT-SIGNATURE-PLAN.md §5.3):
 *   - 純函式:只挑新增高危(critical / high)、有命中優先 + 嚴重度排序、超過 50 筆只送前 50 筆並告知總數
 *   - 隱私與安全:嚴格驗證送給 LLM 的內容不含任何 IP(IPv4/IPv6)、姓名、部門、AD 帳號、規則名稱、知識庫或原始 log
 *   - API(POST /v1/ai/explanations kind: pa-signature):SSE 串流、days 7|30|90 驗證、since / rebuilt / baselineOnly / stale、
 *     Redis / ClickHouse 不可用皆不回 5xx、LLM 未設定回 409
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createPaPolicyRedis } from '../../src/infra/redis/pa-policy.js';
import {
  createPaSignatureRedis,
  PA_SIGNATURE_KEYS,
  type PaSignatureClient,
} from '../../src/infra/redis/pa-signature.js';
import { PA_SIGNATURE_PROMPT } from '../../src/modules/ai/core/explain.js';
import {
  buildSignatureAiContext,
  PA_SIGNATURE_AI_DISCLAIMER,
  pickHighRiskSignatures,
  SIG_AI_MAX_ITEMS,
} from '../../src/modules/pa-signature/ai.js';
import type { SigItem, SigMeta } from '../../src/modules/pa-signature/core.js';
import { fakeAiHost } from '../fixtures/fake-ai.js';
import { createFakeReader, type FakeReader } from '../fixtures/fake-ch.js';
import { FakePolicyClient, HITS as POLICY_HITS, OBJECTS, rule as policyRule } from '../fixtures/pa-policy.js';
import { createTestApp, type TestApp } from '../helpers.js';

const NOW = Date.parse('2026-11-20T02:00:00Z');
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/;
const IPV6_RE = /(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f:]{0,20}|::(?:[0-9a-f]{1,4}:?)+/i;

function makeSig(id: string, overrides: Partial<SigItem> = {}): SigItem {
  return {
    id,
    kind: 'vulnerability',
    name: `Sample Threat ${id}`,
    severity: 'high',
    category: 'code-execution',
    affectedHost: 'server',
    engineVersion: '9.0',
    defaultAction: 'reset-both',
    cves: [`CVE-2026-${id.slice(-4).padStart(4, '0')}`],
    vendorIds: ['Vendor-A'],
    disabled: false,
    timeAttribute: null,
    ...overrides,
  };
}

const BASE_META: SigMeta = {
  fetchedAt: '2026-11-20T01:30:00Z',
  checkedAt: '2026-11-20T01:45:00Z',
  threatVersion: '9174-10355',
  threatReleaseDate: '2026/11/20 00:00:00 CST',
  appVersion: '9174-10355',
  appReleaseDate: '2026/11/20 00:00:00 CST',
  avVersion: '5749-6277',
  avReleaseDate: '2026/11/19 20:00:00 CST',
  wildfireVersion: '1136765-1141451',
  wildfireReleaseDate: '2026/11/20 01:00:00 CST',
  urlFilteringVersion: '20261120.20001',
  counts: { vulnerability: 25450, spyware: 9566, total: 35016 },
  hash: 'a'.repeat(64),
};

/** 精簡假 Redis(同 pa-signature.test.ts) */
class FakeSigRedisClient implements PaSignatureClient {
  strings = new Map<string, { v: string; exp: number | null }>();
  hashes = new Map<string, { v: Record<string, string>; exp: number | null }>();
  fail = false;
  clock = () => NOW;

  private check() {
    if (this.fail) throw new Error('ECONNREFUSED');
  }
  async get(k: string) {
    this.check();
    const e = this.strings.get(k);
    return e && (e.exp === null || e.exp > this.clock()) ? e.v : null;
  }
  async hgetall(k: string) {
    this.check();
    const e = this.hashes.get(k);
    if (!e || (e.exp !== null && e.exp <= this.clock())) return {};
    return { ...e.v };
  }
  async set(k: string, v: string, _ex: 'EX', sec: number, nx?: 'NX') {
    this.check();
    if (nx && (await this.get(k)) !== null) return null;
    this.strings.set(k, { v, exp: this.clock() + sec * 1000 });
    return 'OK' as const;
  }
  async ttl(k: string) {
    this.check();
    const e = this.strings.get(k);
    if (!e || (e.exp !== null && e.exp <= this.clock())) return -2;
    return e.exp === null ? -1 : Math.ceil((e.exp - this.clock()) / 1000);
  }
  async del(...ks: string[]) {
    for (const k of ks) {
      this.strings.delete(k);
      this.hashes.delete(k);
    }
    return ks.length;
  }
  multi() {
    return { exec: async () => [] as [Error | null, unknown][] };
  }
  async quit() {
    return 'OK';
  }

  putSnapshot(opts: {
    threatVersion: string;
    hash: string;
    fetchedAt?: string;
    checkedAt?: string;
    vuln: SigItem[];
    spyware: SigItem[];
    profiles?: Record<string, unknown>;
  }) {
    const fetchedAt = opts.fetchedAt ?? '2026-11-20T01:30:00Z';
    const checkedAt = opts.checkedAt ?? fetchedAt;
    const meta = {
      ...BASE_META,
      fetchedAt,
      checkedAt,
      threatVersion: opts.threatVersion,
      counts: { vulnerability: opts.vuln.length, spyware: opts.spyware.length, total: opts.vuln.length + opts.spyware.length },
      hash: opts.hash,
    };
    this.strings.set(PA_SIGNATURE_KEYS.meta, { v: JSON.stringify(meta), exp: null });
    this.strings.set(PA_SIGNATURE_KEYS.itemsVulnerability, { v: JSON.stringify(opts.vuln), exp: null });
    this.strings.set(PA_SIGNATURE_KEYS.itemsSpyware, { v: JSON.stringify(opts.spyware), exp: null });
    if (opts.profiles) this.strings.set(PA_SIGNATURE_KEYS.profiles, { v: JSON.stringify(opts.profiles), exp: null });
    this.hashes.set(PA_SIGNATURE_KEYS.status, {
      v: { state: 'ok', threatVersion: opts.threatVersion, lastOkAt: fetchedAt, lastRunAt: checkedAt },
      exp: null,
    });
    this.hashes.set(PA_SIGNATURE_KEYS.heartbeat, { v: { signatureEnabled: '1' }, exp: null });
  }
}

describe('TS-3 純函式:高危挑選與統計組裝', () => {
  it('只挑 critical / high,有命中優先 → severity → 命中數 → ID;超過 50 筆截斷並告知總數', () => {
    // 60 筆 unhit critical + 10 筆 high(其中 2 筆有命中)+ 20 筆 medium / low
    const items: SigItem[] = [];
    for (let i = 1; i <= 60; i++) {
      items.push(makeSig(String(30000 + i), { severity: 'critical', name: `Crit Vuln ${i}` }));
    }
    for (let i = 1; i <= 10; i++) {
      items.push(makeSig(String(40000 + i), { severity: 'high', name: `High Vuln ${i}` }));
    }
    for (let i = 1; i <= 20; i++) {
      items.push(makeSig(String(50000 + i), { severity: i % 2 === 0 ? 'medium' : 'low', name: `MedLow ${i}` }));
    }
    // 讓兩筆 high 與一筆 critical 有命中
    const hitCounts: Record<string, number> = {
      '40005': 12,
      '40002': 30,
      '30059': 5,
    };

    const { picked, totalHighRisk, truncated } = pickHighRiskSignatures(items, hitCounts, SIG_AI_MAX_ITEMS);
    assert.equal(totalHighRisk, 70);
    assert.equal(picked.length, 50);
    assert.equal(truncated, true);
    // 前三筆必須是有命中的:先 critical(30059),再 high 依命中數(40002 -> 40005)
    assert.deepEqual(
      picked.slice(0, 3).map((x) => x.id),
      ['30059', '40002', '40005'],
    );
    // 第 4 筆開始是未命中的 critical 依 ID 升冪
    assert.equal(picked[3]!.id, '30001');
    assert.ok(picked.every((x) => x.severity === 'critical' || x.severity === 'high'));

    const ctx = buildSignatureAiContext({
      meta: BASE_META,
      stale: false,
      days: 30,
      baselineAt: '2026-10-01T00:00:00Z',
      since: null,
      rebuilt: false,
      baselineOnly: false,
      latestVersion: {
        threatVersion: BASE_META.threatVersion,
        releaseDate: BASE_META.threatReleaseDate,
        fetchedAt: BASE_META.fetchedAt,
        savedAt: '2026-11-20T01:31:00Z',
        isBaseline: false,
        rebuilt: false,
        counts: BASE_META.counts,
        added: 90,
        changed: 5,
        removed: 2,
        hash: BASE_META.hash,
      },
      newItems: items,
      hitCounts,
      hitStats: {
        '30059': { id: '30059', hits: 5, repeats: 8, blocked: 4, alerted: 1, actions: { 'reset-both': 4, alert: 1 }, unprotectedRuleCount: 1 },
        '40002': { id: '40002', hits: 30, repeats: 30, blocked: 30, alerted: 0, actions: { 'reset-both': 30 }, unprotectedRuleCount: 0 },
        '40005': { id: '40005', hits: 12, repeats: 15, blocked: 0, alerted: 12, actions: { alert: 12 }, unprotectedRuleCount: 2 },
      },
      topApps: [
        { app: 'ssl', sessions: 120000 },
        { app: 'ms-ds-smb', sessions: 45000 },
      ],
      coverage: {
        totalAllowEnabled: 100,
        covered: 80,
        missingBoth: 10,
        missingVulnerability: 5,
        missingSpyware: 3,
        unknown: 2,
        profilesAvailable: true,
      },
    });

    assert.equal(ctx.totalNew, 90);
    assert.equal(ctx.totalHighRiskNew, 70);
    assert.equal(ctx.sentSignatures, 50);
    assert.equal(ctx.truncatedSignatures, true);
    assert.match(ctx.text, /近 30 天新增特徵總數：90 筆/);
    assert.match(ctx.text, /新增高危特徵（critical \/ high）總數：70 筆.*僅列出前 50 筆/);
    assert.match(ctx.text, /其餘 20 筆高危與中低危未列出/);
    assert.match(ctx.text, /ID 30059/);
    assert.match(ctx.text, /ID 40002/);
    assert.match(ctx.text, /ID 40005/);
    assert.doesNotMatch(ctx.text, /MedLow/);
    assert.match(ctx.text, /ssl｜120,000 次/);
    assert.match(ctx.text, /缺少防護缺口：共 18 條/);
    assert.match(ctx.text, /無法判定：2 條/);
    assert.doesNotMatch(ctx.text, IPV4_RE);
    assert.doesNotMatch(ctx.text, IPV6_RE);
  });

  it('基準版本、歷史不足 since、rebuilt、外部依賴失敗皆明確標示', () => {
    const ctx = buildSignatureAiContext({
      meta: BASE_META,
      stale: true,
      days: 90,
      baselineAt: '2026-11-15T00:00:00Z',
      since: '2026-11-15',
      rebuilt: true,
      baselineOnly: true,
      latestVersion: null,
      newItems: [],
      hitCounts: null,
      hitStats: null,
      topApps: null,
      coverage: null,
    });
    assert.equal(ctx.hitsAvailable, false);
    assert.equal(ctx.appsAvailable, false);
    assert.equal(ctx.coverageAvailable, false);
    assert.equal(ctx.sentSignatures, 0);
    assert.match(ctx.text, /超過 2 小時未更新/);
    assert.match(ctx.text, /自 2026-11-15 起建立基準統計/);
    assert.match(ctx.text, /目前僅有首次基準版本/);
    assert.match(ctx.text, /精簡索引遺失或損壞而重建/);
    assert.match(ctx.text, /ClickHouse 暫時無法連線.*命中統計/);
    assert.match(ctx.text, /ClickHouse 暫時無法連線.*App 統計/);
    assert.match(ctx.text, /尚未取得 PA 安全規則快照/);
  });

  it('提示詞與免責常數遵守「AI 建議,需網通確認」只放開頭原則與 F2 零新增高危措辭規則', () => {
    assert.match(PA_SIGNATURE_AI_DISCLAIMER, /AI 建議,需網通確認/);
    assert.match(PA_SIGNATURE_PROMPT, /畫面開頭已固定標示「AI 建議，需網通確認」/);
    assert.match(PA_SIGNATURE_PROMPT, /不需要重複輸出免責警語/);
    assert.match(PA_SIGNATURE_PROMPT, /不要寫出 PA 指令或 API 呼叫/);
    assert.match(PA_SIGNATURE_PROMPT, /近 N 天沒有新增高危特徵，因此沒有新特徵命中可統計/);
    assert.match(PA_SIGNATURE_PROMPT, /不可寫成整體環境「沒有任何命中」/);
  });

  it('F2:新增高危特徵 0 筆且 ClickHouse 正常時,命中段落明確寫「近 N 天沒有新增高危特徵，因此沒有新特徵命中可統計」', () => {
    const ctx30 = buildSignatureAiContext({
      meta: BASE_META,
      stale: false,
      days: 30,
      baselineAt: '2026-11-20T00:16:00Z',
      since: '2026-11-20',
      rebuilt: false,
      baselineOnly: true,
      latestVersion: null,
      newItems: [],
      hitCounts: { '32256': 7065 },
      hitStats: {},
      topApps: [{ app: 'ssl', sessions: 50000 }],
      coverage: {
        totalAllowEnabled: 152,
        covered: 151,
        missingBoth: 1,
        missingVulnerability: 0,
        missingSpyware: 0,
        unknown: 0,
        profilesAvailable: true,
      },
    });
    assert.equal(ctx30.hitsAvailable, true);
    assert.equal(ctx30.totalHighRiskNew, 0);
    assert.match(ctx30.text, /近 30 天沒有新增高危特徵，因此沒有新特徵命中可統計/);
    assert.match(ctx30.text, /不代表整體環境沒有既有威脅特徵命中/);
    assert.doesNotMatch(ctx30.text, /0 \/ 0 個有命中/);

    // 7 天且僅有低危新增(高危仍 0 筆)時同樣明確標示
    const ctx7 = buildSignatureAiContext({
      meta: BASE_META,
      stale: false,
      days: 7,
      baselineAt: '2026-10-01T00:00:00Z',
      since: null,
      rebuilt: false,
      baselineOnly: false,
      latestVersion: null,
      newItems: [makeSig('50001', { severity: 'low', name: 'Low Info Sig' })],
      hitCounts: { '50001': 3 },
      hitStats: {},
      topApps: [],
      coverage: null,
    });
    assert.match(ctx7.text, /近 7 天沒有新增高危特徵，因此沒有新特徵命中可統計/);
    assert.match(ctx7.text, /中低危 \/ 資訊等級特徵（共 1 筆）：1 個有命中，共 3 筆/);
  });
});

describe('TS-3 API:POST /v1/ai/explanations kind pa-signature', () => {
  const host = fakeAiHost({ streamDelayMs: 0 });
  let t: TestApp;
  let sigRedis: FakeSigRedisClient;
  let policyRedis: FakePolicyClient;
  let ch: FakeReader;
  let clock = NOW;

  before(async () => {
    const base = await host.start();
    sigRedis = new FakeSigRedisClient();
    sigRedis.clock = () => clock;
    policyRedis = new FakePolicyClient();
    policyRedis.clock = () => clock;
    ch = createFakeReader();
    t = await createTestApp({
      env: { LLM_URL: `${base}/v1` },
      ai: { heartbeatMs: 50 },
      chReader: ch,
      paPolicy: { redis: createPaPolicyRedis(policyRedis), now: () => clock, syncMs: 0 },
      paSignature: { redis: createPaSignatureRedis(sigRedis), now: () => clock, syncMs: 0 },
    });
  });

  beforeEach(() => {
    host.reqs.splice(0);
    sigRedis.fail = false;
    ch.failing = false;
    ch.traffic.splice(0);
    ch.threats.splice(0);
    clock = NOW;
  });

  after(async () => {
    await t.close();
    host.close();
  });

  it('尚未有快照時回 404 NETOPS_PA_SIGNATURE_UNAVAILABLE(不回 5xx);Redis 故障回 424', async () => {
    const r1 = await t.call({ method: 'POST', url: '/v1/ai/explanations', payload: { kind: 'pa-signature', params: { days: 30 } } });
    assert.equal(r1.statusCode, 404, r1.body);
    assert.equal(r1.json().code, 'NETOPS_PA_SIGNATURE_UNAVAILABLE');

    sigRedis.fail = true;
    const r2 = await t.call({ method: 'POST', url: '/v1/ai/explanations', payload: { kind: 'pa-signature', params: { days: 30 } } });
    assert.equal(r2.statusCode, 424, r2.body);
    assert.equal(r2.json().code, 'NETOPS_PA_SIGNATURE_UNAVAILABLE');
  });

  it('days 只接受 7 / 30 / 90', async () => {
    const r = await t.call({ method: 'POST', url: '/v1/ai/explanations', payload: { kind: 'pa-signature', params: { days: 14 } } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, 'VALIDATION_FAILED');
  });

  it('完整流程:SSE 串流且送給 LLM 的內容嚴格不含 IP、姓名、部門、AD 帳號、規則名稱、知識庫與原始 log', async () => {
    // 1. 寫入含真實格式 IP / 人名 / 部門的 IP 對照與知識庫筆記
    assert.equal(
      (await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.1.50', name: '王小明', department: '資訊處' } })).statusCode,
      201,
    );
    assert.equal(
      (
        await t.call({
          method: 'POST',
          url: '/v1/kb/notes',
          payload: { title: '王小明主機備忘', ips: ['10.10.1.50'], content: '10.10.1.50 王小明主機曾連 198.51.100.77 機密筆記' },
        })
      ).statusCode,
      201,
    );

    // 2. 寫入含人名 / IP 的安全規則(驗證規則名稱、說明、使用者皆不外洩)
    policyRedis.put(
      {
        fetchedAt: '2026-11-20T01:00:00Z',
        hash: 'f'.repeat(64),
        rules: [
          policyRule(1, 'Allow_王小明_10.10.1.50', {
            action: 'allow',
            profileGroup: null,
            description: '林美玲申請放行 10.10.1.50',
            sourceUsers: ['gsmc\\linml'],
          }),
          policyRule(2, 'Allow_Covered_Web', {
            action: 'allow',
            profileGroup: 'Strict-PG',
          }),
        ],
        objects: OBJECTS,
      },
      POLICY_HITS,
    );

    const profiles = {
      fetchedAt: '2026-11-20T01:30:00Z',
      vsys: 'vsys1',
      profileGroups: { 'Strict-PG': { vulnerability: ['Vulnerability_POC'], spyware: ['Spyware_POC'] } },
      vulnerabilityProfiles: ['Vulnerability_POC'],
      spywareProfiles: ['Spyware_POC'],
    };

    // 3. 基準版(10 天前)
    clock = NOW - 10 * 86_400_000;
    sigRedis.putSnapshot({
      threatVersion: '9173-10354',
      hash: '1'.repeat(64),
      fetchedAt: new Date(clock).toISOString(),
      vuln: [makeSig('30001', { name: 'Legacy Base Vuln', severity: 'high' })],
      spyware: [],
      profiles,
    });
    assert.equal((await t.call({ url: '/v1/pa-signatures' })).statusCode, 200);

    // 4. 更新版(現在):新增 2 筆高危 + 1 筆低危
    clock = NOW;
    sigRedis.putSnapshot({
      threatVersion: '9174-10355',
      hash: '2'.repeat(64),
      fetchedAt: '2026-11-20T01:30:00Z',
      vuln: [
        makeSig('30001', { name: 'Legacy Base Vuln', severity: 'high' }),
        makeSig('91001', {
          name: 'Apache HTTP Server Remote Code Execution',
          severity: 'critical',
          defaultAction: 'alert',
          cves: ['CVE-2026-91001'],
          vendorIds: ['Apache'],
        }),
        makeSig('91002', {
          name: 'Low Severity Info Leak',
          severity: 'low',
          cves: [],
        }),
      ],
      spyware: [
        makeSig('92001', {
          kind: 'spyware',
          name: 'Generic C2 Beacon Traffic',
          severity: 'high',
          category: 'spyware',
          defaultAction: 'reset-both',
          cves: [],
          vendorIds: [],
        }),
      ],
      profiles,
    });

    // 5. ClickHouse 放進含 IP / 帳號 / URL / fileDigest / 含人名規則的威脅 log 與流量 App
    ch.traffic.push(
      { time: '2026/11/19 10:00:00', app: 'web-browsing', src: '10.10.1.50', dst: '198.51.100.77', action: 'allow', bytes: 5000 },
      { time: '2026/11/19 10:05:00', app: 'web-browsing', src: '10.10.1.51', dst: '198.51.100.78', action: 'allow', bytes: 3000 },
      { time: '2026/11/19 10:10:00', app: 'ssl', src: '2001:db8::1', dst: '2001:db8::2', action: 'allow', bytes: 2000 },
    );
    ch.threats.push(
      {
        type: 'threat',
        rec: {
          time: '2026/11/20 08:15:00',
          name: 'Apache HTTP Server Remote Code Execution(91001)',
          severity: 'critical',
          action: 'alert',
          repeat: 3,
          rule: 'Allow_王小明_10.10.1.50',
          src: '10.10.1.50',
          dst: '198.51.100.77',
          natSrc: '203.0.113.9',
          srcUser: 'gsmc\\wangxm',
          url: 'https://evil.example/raw-payload-xyz',
          filedigest: 'deadbeef123456',
        },
      },
      {
        type: 'threat',
        rec: {
          time: '2026/11/20 08:20:00',
          name: 'Apache HTTP Server Remote Code Execution(91001)',
          severity: 'critical',
          action: 'reset-both',
          repeat: 1,
          rule: 'Allow_Covered_Web',
          src: '10.10.1.51',
          dst: '198.51.100.78',
          srcUser: 'gsmc\\chenab',
        },
      },
    );

    const res = await t.call({
      method: 'POST',
      url: '/v1/ai/explanations',
      payload: { kind: 'pa-signature', params: { days: 30 } },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.headers['content-type'] ?? '', /text\/event-stream/);
    assert.equal(res.headers['x-accel-buffering'], 'no');

    // 驗證 SSE meta 事件
    const metaMatch = /event: meta\ndata: (\{.*\})\n/.exec(res.body);
    assert.ok(metaMatch, `缺少 meta 事件:${res.body}`);
    const meta = JSON.parse(metaMatch![1]!) as Record<string, unknown>;
    assert.equal(meta.kind, 'pa-signature');
    assert.equal(meta.source, 'pa-signature');
    assert.equal(meta.threatVersion, '9174-10355');
    assert.equal(meta.days, 30);
    assert.equal(meta.since, '2026-11-10'); // 基準在 10 天前 → 歷史不足 30 天
    assert.equal(meta.totalNew, 3);
    assert.equal(meta.totalHighRiskNew, 2);
    assert.equal(meta.sentSignatures, 2);
    assert.equal(meta.truncatedSignatures, false);
    assert.equal(meta.hitsAvailable, true);
    assert.equal(meta.appsAvailable, true);
    assert.equal(meta.coverageAvailable, true);
    assert.deepEqual(meta.notes, []);
    assert.match(res.body, /event: content\n/);
    assert.match(res.body, /event: done\n/);

    // 驗證送給 LLM 的所有訊息(system + user)
    const chat = host.reqs.find((r) => r.url === '/v1/chat/completions')!;
    assert.ok(chat, '應該呼叫 LLM chat/completions');
    const allPrompt = (chat.body.messages as { role: string; content: string }[]).map((m) => m.content).join('\n');

    // 應該包含統計與特徵資訊
    assert.match(allPrompt, /9174-10355/);
    assert.match(allPrompt, /ID 91001/);
    assert.match(allPrompt, /CVE-2026-91001/);
    assert.match(allPrompt, /ID 92001/);
    assert.match(allPrompt, /web-browsing｜2 次/);
    assert.match(allPrompt, /近30天命中 2 筆（阻擋 1、告警 1/);
    assert.match(allPrompt, /其中 1 條命中規則缺防護/);
    assert.match(allPrompt, /缺少防護缺口：共 1 條/);
    assert.match(allPrompt, /自 2026-11-10 起建立基準統計/);

    // 嚴格驗證:絕無 IP、姓名、部門、AD 帳號、規則名稱、知識庫或原始 log
    assert.doesNotMatch(allPrompt, IPV4_RE, '不可送出任何 IPv4 位址');
    assert.doesNotMatch(allPrompt, IPV6_RE, '不可送出任何 IPv6 位址');
    assert.doesNotMatch(allPrompt, /王小明|林美玲|資訊處|wangxm|linml|chenab/i, '不可送出姓名、部門或 AD 帳號');
    assert.doesNotMatch(allPrompt, /Allow_王小明|Allow_Covered_Web/, '不可送出安全規則名稱');
    assert.doesNotMatch(allPrompt, /evil\.example|raw-payload-xyz|deadbeef123456/, '不可送出原始 log URL 或雜湊');
    assert.doesNotMatch(allPrompt, /機密筆記|IP 對照表|知識庫/, '不可附帶 IP 對照表或知識庫筆記');
  });

  it('超過 50 筆新增高危特徵透過 API 只送前 50 筆並告知總數', async () => {
    const vuln = [makeSig('30001', { name: 'Legacy Base Vuln', severity: 'high' })];
    for (let i = 1; i <= 65; i++) {
      vuln.push(makeSig(String(95000 + i), { severity: i <= 40 ? 'critical' : 'high', name: `Bulk High ${i}` }));
    }
    clock = NOW + 60_000;
    sigRedis.putSnapshot({
      threatVersion: '9175-10356',
      hash: '3'.repeat(64),
      fetchedAt: new Date(clock).toISOString(),
      vuln,
      spyware: [],
    });

    const res = await t.call({
      method: 'POST',
      url: '/v1/ai/explanations',
      payload: { kind: 'pa-signature', params: {} }, // 省略 days 預設 30
    });
    assert.equal(res.statusCode, 200, res.body);
    const metaMatch = /event: meta\ndata: (\{.*\})\n/.exec(res.body);
    const meta = JSON.parse(metaMatch![1]!) as Record<string, unknown>;
    assert.equal(meta.days, 30);
    assert.equal(meta.totalHighRiskNew, 65);
    assert.equal(meta.sentSignatures, 50);
    assert.equal(meta.truncatedSignatures, true);

    const chat = host.reqs.find((r) => r.url === '/v1/chat/completions')!;
    const user = (chat.body.messages as { content: string }[]).at(-1)!.content;
    assert.match(user, /新增高危特徵（critical \/ high）總數：65 筆.*僅列出前 50 筆/);
    // 確認確實只列了 50 條編號(1. ~ 50., 沒有 51.)
    assert.match(user, /\n50\. ID /);
    assert.doesNotMatch(user, /\n51\. ID /);
  });

  it('ClickHouse 失敗時不回 5xx,改正常串流並在 meta 與提示詞明確標示缺漏', async () => {
    ch.failing = true;
    const res = await t.call({
      method: 'POST',
      url: '/v1/ai/explanations',
      payload: { kind: 'pa-signature', params: { days: 7 } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const metaMatch = /event: meta\ndata: (\{.*\})\n/.exec(res.body);
    const meta = JSON.parse(metaMatch![1]!) as Record<string, unknown>;
    assert.equal(meta.days, 7);
    assert.equal(meta.hitsAvailable, false);
    assert.equal(meta.appsAvailable, false);
    assert.equal(meta.partial, true);

    const chat = host.reqs.find((r) => r.url === '/v1/chat/completions')!;
    const user = (chat.body.messages as { content: string }[]).at(-1)!.content;
    assert.match(user, /ClickHouse 暫時無法連線/);
  });

  it('精簡索引遺失重建(rebuilt)後,meta.rebuilt 為 true 且提示詞明確標示差異無法計算', async () => {
    // 刪掉 latest-index.json.gz 並推一版新版本觸發 P2 重建
    const latestGz = path.join(t.dataDir, 'pa-signature', 'latest-index.json.gz');
    if (fs.existsSync(latestGz)) fs.unlinkSync(latestGz);
    clock = NOW + 120_000;
    sigRedis.putSnapshot({
      threatVersion: '9176-10357',
      hash: '4'.repeat(64),
      fetchedAt: new Date(clock).toISOString(),
      vuln: [makeSig('30001', { name: 'Legacy Base Vuln', severity: 'high' })],
      spyware: [],
    });

    const res = await t.call({
      method: 'POST',
      url: '/v1/ai/explanations',
      payload: { kind: 'pa-signature', params: { days: 30 } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const metaMatch = /event: meta\ndata: (\{.*\})\n/.exec(res.body);
    const meta = JSON.parse(metaMatch![1]!) as Record<string, unknown>;
    assert.equal(meta.rebuilt, true);
    assert.equal(meta.partial, true);

    const chat = host.reqs.find((r) => r.url === '/v1/chat/completions')!;
    const user = (chat.body.messages as { content: string }[]).at(-1)!.content;
    assert.match(user, /精簡索引遺失或損壞而重建/);
    // F2:本版重建(無新增高危特徵)且 ClickHouse 正常 → 明確告知沒有新特徵命中可統計
    assert.match(user, /近 30 天沒有新增高危特徵，因此沒有新特徵命中可統計/);
  });
});

describe('TS-3 API:未設定 LLM_URL 回 409 NETOPS_AI_DISABLED', () => {
  let t: TestApp;
  before(async () => {
    const sigRedis = new FakeSigRedisClient();
    sigRedis.putSnapshot({ threatVersion: '9174-10355', hash: 'a'.repeat(64), vuln: [makeSig('30001')], spyware: [] });
    t = await createTestApp({ paSignature: { redis: createPaSignatureRedis(sigRedis), now: () => NOW, syncMs: 0 } });
  });
  after(async () => t.close());

  it('未設定 LLM_URL 回 409', async () => {
    const res = await t.call({ method: 'POST', url: '/v1/ai/explanations', payload: { kind: 'pa-signature', params: { days: 30 } } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'NETOPS_AI_DISABLED');
  });
});
