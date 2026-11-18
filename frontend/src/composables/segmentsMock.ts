/**
 * 網段設定 mock 後端(SG-2):畫面(SG-3)在後端上測試區前可開發。只由 useSegmentSettings 在 mock 模式使用(正式建置一律關閉,見 resolveMock)。
 *   - 記憶體保存設定與 version;save 版本不符丟 409 NETOPS_SEGMENTS_VERSION_CONFLICT
 *   - bumpVersion():模擬「別人剛改過」
 *   - preview:依 CIDR 對照固定的假流量
 */
import { ApiError } from '@/api/gateway';
import { SEGMENTS_VERSION_CONFLICT, type SegmentConfig, type SegmentPreview, type SegmentSettings } from '@/api/segments';
import { createSegmentMatcher, findOverlaps, validateConfig } from './segmentRules';

const EXAMPLE: SegmentConfig = {
  gauge: { throughputMaxBps: 1_000_000_000, sessionMax: 64_000 },
  segments: [
    { id: 'office', label: '辦公網段(範例)', kind: 'vlan', icon: 'office', cidrs: ['10.10.112.0/22'] },
    { id: 'server', label: '伺服器區(範例)', kind: 'service', icon: 'server', cidrs: ['10.10.130.0/24'] },
    { id: 'factory', label: '廠區網段(範例)', kind: 'vlan', icon: 'factory', cidrs: ['10.20.0.0/16'] },
  ],
};

/** 假流量:內部 IP → 近 5 分鐘連線數 */
const TRAFFIC: [string, number][] = [
  ['10.10.112.15', 820],
  ['10.10.113.40', 410],
  ['10.10.130.5', 1530],
  ['10.10.130.21', 640],
  ['10.20.3.7', 300],
  ['10.30.1.10', 260],
  ['10.30.1.11', 180],
  ['192.168.5.20', 95],
  ['172.16.8.3', 40],
];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createSegmentsMock(opts: { latencyMs?: number } = {}) {
  const ms = opts.latencyMs ?? 200;
  let state: SegmentSettings = { ...copy(EXAMPLE), version: 0, source: 'example', updatedAt: null, updatedBy: null, overlaps: [] };
  const invalid = (cfg: SegmentConfig) => {
    const errors = validateConfig(cfg);
    if (errors.length) throw new ApiError(400, 'VALIDATION_FAILED', '參數驗證失敗', 'mock', errors);
  };
  return {
    async get(): Promise<SegmentSettings> {
      await delay(ms);
      return copy(state);
    },
    async save(version: number, cfg: SegmentConfig): Promise<SegmentSettings> {
      await delay(ms);
      if (version !== state.version) throw new ApiError(409, SEGMENTS_VERSION_CONFLICT, '網段設定已被其他人修改,請重新載入後再編輯', 'mock', { currentVersion: state.version });
      invalid(cfg);
      state = { ...copy(cfg), version: state.version + 1, source: 'file', updatedAt: new Date().toISOString(), updatedBy: 'MOCK 測試人員', overlaps: findOverlaps(cfg.segments) };
      return copy(state);
    },
    async preview(cfg: SegmentConfig): Promise<SegmentPreview> {
      await delay(ms);
      invalid(cfg);
      const match = createSegmentMatcher(cfg.segments);
      const conn = new Map<string, number>();
      const um: { ip: string; count: number }[] = [];
      for (const [ip, n] of TRAFFIC) {
        const m = match(ip);
        if (m) conn.set(m.id, (conn.get(m.id) ?? 0) + n);
        else um.push({ ip, count: n });
      }
      return {
        generatedAt: new Date().toISOString(),
        minutes: 5,
        partial: false,
        segments: cfg.segments.map((s) => ({ id: s.id, label: s.label, conn: conn.get(s.id) ?? 0 })),
        unmatched: { conn: um.reduce((x, u) => x + u.count, 0), top: um.sort((a, b) => b.count - a.count).slice(0, 20) },
        overlaps: findOverlaps(cfg.segments),
        sample: { traffic: TRAFFIC.length, trafficSec: 300, complete: true },
      };
    },
    /** 模擬別人剛儲存(下一次 save 會 409) */
    bumpVersion() {
      state = { ...state, version: state.version + 1 };
    },
  };
}
