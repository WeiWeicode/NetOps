/**
 * 假 Redis(R1 測試用):只實作 infra/redis 用到的指令,資料格式同 netops-pa 寫入的鍵(PA-LIVE-PLAN §4)。
 * fail = true 時所有指令拋錯(模擬 Redis 停止)。
 */
import type { RedisClient } from '../../src/infra/redis/index.js';

type Entry = [string, string[]];

export class FakeRedis implements RedisClient {
  strings = new Map<string, string>();
  hashes = new Map<string, Record<string, string>>();
  streams = new Map<string, Entry[]>();
  zsets = new Map<string, Map<string, number>>();
  fail = false;
  private seq = 0;

  private check() {
    if (this.fail) throw new Error('connect ECONNREFUSED');
  }

  // ---------- 測試寫入(模擬 netops-pa) ----------
  addLog(type: string, data: Record<string, unknown>, ms = Date.now()) {
    const key = `netops:pa:log:${type}`;
    const list = this.streams.get(key) ?? [];
    const id = `${ms}-${this.seq++}`;
    list.push([id, ['d', JSON.stringify(data)]]);
    list.sort((a, b) => cmp(a[0], b[0]));
    this.streams.set(key, list);
    return id;
  }
  addSeries(metric: string, data: Record<string, unknown>, ms: number) {
    const key = `netops:pa:series:${metric}`;
    const list = this.streams.get(key) ?? [];
    list.push([`${ms}-0`, ['d', JSON.stringify(data)]]);
    this.streams.set(key, list);
  }
  setHeartbeat(fields: Record<string, string>) {
    this.hashes.set('netops:pa:heartbeat', fields);
  }
  setSnap(metric: string, data: Record<string, unknown>) {
    this.strings.set(`netops:pa:snap:${metric}`, JSON.stringify(data));
  }
  setAgg(type: string, bucket: string, fields: Record<string, number>) {
    this.hashes.set(`netops:pa:agg:${type}:${bucket}`, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])));
  }
  setTop(type: string, dim: string, bucket: string, members: Record<string, number>) {
    this.zsets.set(`netops:pa:top:${type}:${dim}:${bucket}`, new Map(Object.entries(members)));
  }

  // ---------- RedisClient ----------
  async get(key: string) {
    this.check();
    return this.strings.get(key) ?? null;
  }
  async hgetall(key: string) {
    this.check();
    return { ...(this.hashes.get(key) ?? {}) };
  }
  async xrange(key: string, start: string, end: string, _c: 'COUNT', n: number) {
    this.check();
    return (this.streams.get(key) ?? []).filter((e) => inRange(e[0], start, end)).slice(0, n);
  }
  async xrevrange(key: string, end: string, start: string, _c: 'COUNT', n: number) {
    this.check();
    return (this.streams.get(key) ?? [])
      .filter((e) => inRange(e[0], start, end))
      .reverse()
      .slice(0, n);
  }
  async zrevrange(key: string, start: number, stop: number, _w: 'WITHSCORES') {
    this.check();
    const sorted = [...(this.zsets.get(key) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(start, stop + 1).flatMap(([m, s]) => [m, String(s)]);
  }
  async quit() {
    return 'OK';
  }
}

/** Stream ID 比較 */
function cmp(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am! - bm! || (as ?? 0) - (bs ?? 0);
}

/** start / end 支援 -、+、( 排除、只有毫秒 */
function inRange(id: string, start: string, end: string): boolean {
  const lo = start === '-' ? null : start;
  const hi = end === '+' ? null : end;
  if (lo) {
    const ex = lo.startsWith('(');
    const v = norm(ex ? lo.slice(1) : lo, '0');
    if (ex ? cmp(id, v) <= 0 : cmp(id, v) < 0) return false;
  }
  if (hi) {
    const ex = hi.startsWith('(');
    const v = norm(ex ? hi.slice(1) : hi, String(Number.MAX_SAFE_INTEGER));
    if (ex ? cmp(id, v) >= 0 : cmp(id, v) > 0) return false;
  }
  return true;
}
const norm = (v: string, seq: string) => (v.includes('-') ? v : `${v}-${seq}`);
