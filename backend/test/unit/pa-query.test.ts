/**
 * C5 PA 精準查詢(netops-api 端):參數上限無法繞過、全系統一次一個(第 2 個 429)、冷卻、管理平面 CPU 門檻、執行者未啟用 409、
 * 只有本人可查、Redis 失敗 424、送出失敗時名額與冷卻還回去。Redis 以本檔的記憶體假實作代替(只實作用到的指令)。
 * PA-560 端(netops-pa 執行者)的測試在 pa-collector/tests/test_pa_query.py。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPaQueryStore, PAQ_KEYS, type PaQueryClient } from '../../src/infra/redis/pa-query.js';
import { toJob, validateQuery } from '../../src/modules/pa-query/service.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { createTestApp } from '../helpers.js';

const NOW = Date.parse('2026-11-12T10:00:00+08:00');

class FakeClient implements PaQueryClient {
  strings = new Map<string, { v: string; exp: number }>();
  hashes = new Map<string, Record<string, string>>();
  lists = new Map<string, string[]>();
  t = NOW;
  fail = false;
  failMulti = false;
  private live(k: string) {
    const e = this.strings.get(k);
    if (e && e.exp <= this.t) this.strings.delete(k);
    return this.strings.get(k);
  }
  private check() {
    if (this.fail) throw new Error('connect ECONNREFUSED');
  }
  async get(k: string) {
    this.check();
    return this.live(k)?.v ?? null;
  }
  async set(k: string, v: string, _ex: 'EX', sec: number, _nx: 'NX') {
    this.check();
    if (this.live(k)) return null;
    this.strings.set(k, { v, exp: this.t + sec * 1000 });
    return 'OK' as const;
  }
  async ttl(k: string) {
    this.check();
    const e = this.live(k);
    return e ? Math.ceil((e.exp - this.t) / 1000) : -2;
  }
  async del(...ks: string[]) {
    let n = 0;
    for (const k of ks) n += Number(this.strings.delete(k) || this.hashes.delete(k));
    return n;
  }
  async hgetall(k: string) {
    this.check();
    return { ...(this.hashes.get(k) ?? {}) };
  }
  multi(cmds: (string | number)[][]) {
    return {
      exec: async () => {
        if (this.failMulti) return [[new Error('OOM'), null]] as [Error | null, unknown][];
        for (const [c, k, ...rest] of cmds) {
          if (c === 'hset') {
            const h = this.hashes.get(String(k)) ?? {};
            for (let i = 0; i < rest.length; i += 2) h[String(rest[i])] = String(rest[i + 1]);
            this.hashes.set(String(k), h);
          } else if (c === 'lpush') this.lists.set(String(k), [String(rest[0]), ...(this.lists.get(String(k)) ?? [])]);
        }
        return cmds.map(() => [null, 1]) as [Error | null, unknown][];
      },
    };
  }
  async quit() {
    return 'OK';
  }
  /** 模擬 netops-pa 心跳 / CPU 快照 */
  heartbeat(queryEnabled = '1', ageSec = 3) {
    this.hashes.set(PAQ_KEYS.heartbeat, { queryEnabled, updatedAt: new Date(this.t - ageSec * 1000).toISOString() });
  }
  cpu(mgmt: number) {
    this.strings.set(PAQ_KEYS.cpu, { v: JSON.stringify({ mgmt }), exp: this.t + 60_000 });
  }
  /** 模擬 netops-pa 完成工作:更新 Hash、釋放名額、設全域間隔 */
  finish(id: string, fields: Record<string, string>) {
    Object.assign(this.hashes.get(PAQ_KEYS.job(id))!, fields);
    this.strings.delete(PAQ_KEYS.active);
    this.strings.set(PAQ_KEYS.coolGlobal, { v: '1', exp: this.t + 10_000 });
  }
}

const SESSION = { kind: 'session', ip: '10.10.130.124' };
const LOG = { kind: 'log', ip: '10.10.130.124', logType: 'traffic', from: '2026-11-12T09:45:00+08:00', to: '2026-11-12T10:00:00+08:00' };

async function setup() {
  const c = new FakeClient();
  c.heartbeat();
  c.cpu(5);
  const t = await createTestApp({ ftp: createFakeFtp(), paQuery: { store: createPaQueryStore(c), now: () => c.t } });
  return { c, t };
}

describe('參數驗證(上限無法繞過)', () => {
  it('log:15 分鐘、1 小時內、時區、單一 IP;session:單一 IP', () => {
    assert.deepEqual(validateQuery(LOG as never, NOW), { logType: 'traffic', ip: '10.10.130.124', from: '2026-11-12T01:45:00.000Z', to: '2026-11-12T02:00:00.000Z', nlogs: 500 });
    const bad = [
      { ...LOG, from: '2026-11-12T09:44:59+08:00' },
      { ...LOG, from: '2026-11-12T08:40:00+08:00', to: '2026-11-12T08:50:00+08:00' },
      { ...LOG, to: '2026-11-12T10:05:00+08:00', from: '2026-11-12T10:01:00+08:00' },
      { ...LOG, from: '2026-11-12T09:50:00' },
      { ...LOG, ip: '10.0.0.0/8' },
      { ...LOG, ip: 'fe80::1%eth0' },
      { ...SESSION, ip: '10.10.130.*' },
      { ...LOG, from: undefined },
    ];
    for (const b of bad) assert.throws(() => validateQuery(b as never, NOW), (e: { code?: string }) => e.code === 'VALIDATION_FAILED', JSON.stringify(b));
    assert.deepEqual(validateQuery({ kind: 'session', ip: '2001:db8::1', direction: 'dst' }, NOW), { ip: '2001:db8::1', direction: 'dst' });
  });

  it('工作轉換:錯誤代碼只接受 NETOPS_ 開頭;結果壞掉時給空陣列', () => {
    const j = toJob('x', { status: 'failed', kind: 'log', error: '<script>', message: 'm' });
    assert.equal(j.error?.code, 'NETOPS_PA_QUERY_FAILED');
    assert.deepEqual(toJob('x', { status: 'done', result: 'not json', truncated: '1' }).result, { rows: [], count: 0, truncated: true });
    assert.equal(toJob('x', { status: 'weird' }).status, 'failed');
  });
});

describe('/v1/pa-query', () => {
  it('送出 202 → 工作進佇列、名額與每人冷卻;netops-pa 完成後本人可取結果,別人 404', async () => {
    const { c, t } = await setup();
    try {
      const r = await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: SESSION });
      assert.equal(r.statusCode, 202);
      const id = r.json().id as string;
      assert.deepEqual(c.lists.get(PAQ_KEYS.jobs), [id]);
      assert.equal(await c.get(PAQ_KEYS.active), id);
      assert.equal(await c.ttl(PAQ_KEYS.coolUser('emp:S112009')), 60);
      const h = c.hashes.get(PAQ_KEYS.job(id))!;
      assert.equal(h.emp, 'emp:S112009');
      assert.deepEqual(JSON.parse(h.params!), { ip: '10.10.130.124', direction: 'src' });
      assert.equal((await t.call({ url: `/v1/pa-query/jobs/${id}` })).json().status, 'queued');
      c.finish(id, { status: 'done', result: JSON.stringify([{ src: '10.10.130.124' }]), truncated: '0', mgmtCpu: '4.5' });
      const done = (await t.call({ url: `/v1/pa-query/jobs/${id}` })).json();
      assert.equal(done.status, 'done');
      assert.equal(done.mgmtCpu, 4.5);
      assert.equal(done.result.rows[0].src, '10.10.130.124');
      const other = await t.call({ url: `/v1/pa-query/jobs/${id}`, emp: 'S000002' });
      assert.equal(other.statusCode, 404);
      assert.equal(other.json().code, 'NETOPS_PA_QUERY_NOT_FOUND');
    } finally {
      await t.close();
    }
  });

  it('同時第 2 個 429 + Retry-After;每人冷卻 60 秒;全域間隔 10 秒', async () => {
    const { c, t } = await setup();
    try {
      const first = await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: SESSION });
      const second = await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: SESSION, emp: 'S000002' });
      assert.equal(second.statusCode, 429);
      assert.equal(second.json().code, 'NETOPS_PA_QUERY_BUSY');
      assert.equal(second.headers['retry-after'], '90');
      assert.equal(second.json().details.retryAfter, 90);
      // 第 2 個沒有拿到冷卻(不懲罰沒送出的人)
      assert.equal(await c.ttl(PAQ_KEYS.coolUser('emp:S000002')), -2);
      c.finish(first.json().id, { status: 'done', result: '[]' });
      const g = await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: SESSION, emp: 'S000002' });
      assert.equal(g.statusCode, 429);
      assert.match(g.json().message, /間隔/);
      c.t += 11_000;
      assert.equal((await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: SESSION, emp: 'S000002' })).statusCode, 202);
      // S112009 自己還在 60 秒冷卻內
      c.strings.delete(PAQ_KEYS.active);
      c.strings.delete(PAQ_KEYS.coolGlobal);
      const self = await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: SESSION });
      assert.equal(self.statusCode, 429);
      assert.match(self.json().message, /60 秒/);
      const st = (await t.call({ url: '/v1/pa-query/status' })).json();
      assert.equal(st.enabled, true);
      assert.ok(st.userCoolSec > 0 && st.userCoolSec <= 49);
    } finally {
      await t.close();
    }
  });

  it('管理平面 CPU > 50% 先擋 429;執行者未啟用 / 心跳過期 409;Redis 失敗 424', async () => {
    const { c, t } = await setup();
    try {
      c.cpu(60);
      const r = await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: LOG });
      assert.equal(r.statusCode, 429);
      assert.match(r.json().message, /60%/);
      assert.equal(await c.get(PAQ_KEYS.active), null);
      c.cpu(5);
      c.heartbeat('0');
      assert.equal((await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: LOG })).json().code, 'NETOPS_PA_QUERY_DISABLED');
      c.heartbeat('1', 120);
      assert.equal((await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: LOG })).statusCode, 409);
      c.heartbeat('1');
      c.fail = true;
      const d = await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: LOG });
      assert.equal(d.statusCode, 424);
      assert.equal(d.json().code, 'NETOPS_REDIS_UNAVAILABLE');
    } finally {
      await t.close();
    }
  });

  it('建立工作失敗時名額與冷卻還回去;參數不合法 400 不佔名額', async () => {
    const { c, t } = await setup();
    try {
      c.failMulti = true;
      assert.equal((await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: SESSION })).statusCode, 424);
      assert.equal(await c.get(PAQ_KEYS.active), null);
      assert.equal(await c.ttl(PAQ_KEYS.coolUser('emp:S112009')), -2);
      c.failMulti = false;
      const bad = await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: { ...LOG, from: '2026-11-12T09:40:00+08:00' } });
      assert.equal(bad.statusCode, 400);
      assert.equal((await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: { ...SESSION, ip: '1.2.3.4 or 1' } })).statusCode, 400);
      assert.equal(await c.get(PAQ_KEYS.active), null);
    } finally {
      await t.close();
    }
  });

  it('沒有 Redis(dev)時 409', async () => {
    const t = await createTestApp({ ftp: createFakeFtp(), paQuery: { store: null } });
    try {
      assert.equal((await t.call({ method: 'POST', url: '/v1/pa-query/jobs', payload: SESSION })).json().code, 'NETOPS_PA_QUERY_DISABLED');
    } finally {
      await t.close();
    }
  });
});
