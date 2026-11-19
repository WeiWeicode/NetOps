/**
 * PA 安全規則測試共用資料(PR-2、PR-5):規則、物件、命中數、假 Redis
 */
import { PA_POLICY_KEYS, type PaPolicyClient } from '../../src/infra/redis/pa-policy.js';
import type { PolicyRule } from '../../src/modules/pa-policy/core.js';

export const rule = (position: number, name: string, extra: Partial<PolicyRule> = {}): Record<string, unknown> => ({
  position,
  name,
  uuid: `uuid-${name}`,
  type: 'universal',
  tags: [],
  fromZones: ['trust'],
  toZones: ['untrust'],
  sources: ['any'],
  sourceUsers: ['any'],
  destinations: ['any'],
  applications: ['any'],
  services: ['application-default'],
  action: 'allow',
  profileGroup: 'default',
  profiles: {},
  logStart: false,
  logEnd: true,
  disabled: false,
  ...extra,
});

export const OBJECTS = {
  addresses: [
    { name: 'Net_48', type: 'ip-netmask', value: '10.10.48.0/24' },
    { name: 'Host_5', type: 'ip-netmask', value: '10.10.49.5' },
    { name: 'Range_A', type: 'ip-range', value: '10.20.0.1-10.20.0.9' },
    { name: 'Web_FQDN', type: 'fqdn', value: 'example.com' },
  ],
  addressGroups: [
    { name: 'GSC Group', static: ['Net_48', 'Host_5', 'Nested'], dynamic: null },
    { name: 'Nested', static: ['Range_A'], dynamic: null },
    { name: 'Loop', static: ['Loop'], dynamic: null },
    { name: 'DAG', static: [], dynamic: "'tag1'" },
  ],
  services: [{ name: 'tcp-8443', protocol: 'tcp', destinationPort: '8443', sourcePort: null }],
  serviceGroups: [{ name: 'Web-Svc', members: ['tcp-8443', 'service-https'] }],
  applicationGroups: [{ name: 'Office', members: ['ms-office365', 'outlook-web'] }],
  tags: [],
};

export const SNAP = {
  fetchedAt: '2026-11-19T01:00:00Z',
  hash: 'a'.repeat(64),
  vsys: 'vsys1',
  rules: [
    rule(1, 'Allow-GSC', { sources: ['GSC Group'], services: ['Web-Svc'], applications: ['Office'] }),
    rule(2, 'Deny-FQDN', { destinations: ['Web_FQDN'], action: 'deny', profileGroup: null }),
    rule(3, 'Old-Rule', { sources: ['10.30.0.0/16'], disabled: true }),
  ],
  objects: OBJECTS,
};
export const HITS = {
  fetchedAt: '2026-11-19T01:00:00Z',
  items: {
    'Allow-GSC': { hitCount: 100, lastHit: '2026-11-19T00:00:00Z' },
    'Deny-FQDN': { hitCount: 0, lastHit: null },
    'Old-Rule': { hitCount: 5, lastHit: '2026-01-01T00:00:00Z' },
    'intrazone-default': { hitCount: 9, lastHit: '2026-11-19T00:00:00Z' },
    'interzone-default': { hitCount: 1, lastHit: null },
  },
};

/** 假的 Redis(只實作 pa-policy 用到的指令;ttl 以呼叫時間計) */
export class FakePolicyClient implements PaPolicyClient {
  strings = new Map<string, { v: string; exp: number | null }>();
  hashes = new Map<string, Record<string, string>>();
  fail = false;
  clock = () => Date.now();
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
    return { ...(this.hashes.get(k) ?? {}) };
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
    ks.forEach((k) => this.strings.delete(k));
    return ks.length;
  }
  async quit() {
    return 'OK';
  }
  put(snap: unknown, hits: unknown = HITS) {
    this.strings.set(PA_POLICY_KEYS.snapshot, { v: JSON.stringify(snap), exp: null });
    this.strings.set(PA_POLICY_KEYS.hits, { v: JSON.stringify(hits), exp: null });
    this.hashes.set(PA_POLICY_KEYS.status, { state: 'ok', lastOkAt: '2026-11-19T01:00:00Z', mgmtCpu: '12' });
    this.hashes.set(PA_POLICY_KEYS.heartbeat, { policyEnabled: '1' });
  }
}

