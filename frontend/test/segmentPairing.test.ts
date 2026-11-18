/**
 * SG-4 搭配 A–D 的前端邏輯:名稱只在有權限時查詢、未分類 IP 加入 / 建 /24、從對照表網段列匯入、IP 對照表所屬網段、戰情室設備名稱
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpNameEntry, IpNameList } from '@/api/ipNames';
import type { SegmentSettings } from '@/api/segments';
import { createNameCache, useIpNameCidrImport, useSegmentDeviceNames, useSegmentLookup, useUnmatchedAssist } from '@/composables/useSegmentPairing';
import { createSegmentsMock } from '@/composables/segmentsMock';
import { useSegmentSettings } from '@/composables/useSegmentSettings';

const label = (device: string, department = '') => ({ name: '', department, device, deviceType: '' });
const flush = () => new Promise((r) => setTimeout(r, 0));

async function settingsWithPreview() {
  const s = useSegmentSettings({ backend: createSegmentsMock({ latencyMs: 0 }), immediate: false });
  await s.load();
  await s.runPreview();
  return s;
}

describe('名稱快取', () => {
  it('沒有權限不呼叫 lookup、label 回 null', async () => {
    const lookup = vi.fn();
    const c = createNameCache(lookup, () => false);
    await c.ensure(['10.0.0.1']);
    expect(lookup).not.toHaveBeenCalled();
    expect(c.label('10.0.0.1')).toBeNull();
  });
  it('有權限:去重、只查單一 IPv4、查不到也記住', async () => {
    const lookup = vi.fn(async (ips: string[]) => ({ names: Object.fromEntries(ips.filter((i) => i === '10.0.0.1').map((i) => [i, label('NB-01')])) }));
    const c = createNameCache(lookup, () => true);
    await c.ensure(['10.0.0.1', '10.0.0.1', '10.0.0.2', '10.0.0.0/24', 'x']);
    await c.ensure(['10.0.0.2']);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]![0]).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(c.label('10.0.0.1')?.device).toBe('NB-01');
    expect(c.label('10.0.0.2')).toBeNull();
  });
});

describe('A 未分類 IP 協助分類', () => {
  it('列出未分類 IP + 名稱;加入網段、建 /24', async () => {
    const s = await settingsWithPreview();
    const lookup = vi.fn(async () => ({ names: { '10.30.1.10': label('PLC-01', '生管') } }));
    const a = useUnmatchedAssist(s, createNameCache(lookup, () => true));
    await flush();
    expect(a.rows[0]).toEqual({ ip: '10.30.1.10', count: 260, slash24: '10.30.1.0/24', label: label('PLC-01', '生管') });
    expect(a.addToSegment('192.168.5.20', 0)).toBe(true);
    expect(s.draft.segments[0]!.cidrs).toContain('192.168.5.20/32');
    expect(a.addToSegment('192.168.5.20', 0)).toBe(false);
    const i = a.createSlash24('10.30.1.10');
    expect(s.draft.segments[i]).toMatchObject({ label: '生管', cidrs: ['10.30.1.0/24'] });
    expect(a.createSlash24('10.30.1.11')).toBe(-1);
    expect(s.issues).toEqual([]);
  });
  it('沒有權限:只有 IP', async () => {
    const s = await settingsWithPreview();
    const a = useUnmatchedAssist(s, createNameCache(vi.fn(), () => false));
    expect(a.rows[0]!.label).toBeNull();
    expect(a.canSeeNames).toBe(false);
    expect(s.draft.segments[a.createSlash24('10.30.1.10')]!.label).toBe('網段 10.30.1.0/24');
  });
});

describe('B 從 IP 對照表網段列建立', () => {
  const entry = (id: string, ip: string, department = '', note = ''): IpNameEntry => ({ id, ip, name: '', department, device: '', deviceType: '', note, updatedAt: '', updatedBy: '' });
  it('只取 CIDR 列、標出已涵蓋、同名稱併成一個網段', async () => {
    const s = await settingsWithPreview();
    const rows = [entry('1', '10.30.1.0/24', '生管'), entry('2', '10.30.2.0/24', '生管'), entry('3', '10.10.130.0/25', '', '機房'), entry('4', '10.10.1.5', '資訊')];
    const list = vi.fn(async (_q: string, page: number): Promise<IpNameList> => ({ items: page === 1 ? rows : [], total: rows.length, page, pageSize: 100, version: 1 }));
    const b = useIpNameCidrImport(s, list);
    await b.load();
    expect(b.candidates.map((c) => [c.cidr, c.label, c.coveredBy?.id ?? null])).toEqual([
      ['10.30.1.0/24', '生管', null],
      ['10.30.2.0/24', '生管', null],
      ['10.10.130.0/25', '機房', 'server'],
    ]);
    b.toggle('1');
    b.toggle('2');
    expect(b.importSelected()).toBe(1);
    expect(s.draft.segments.at(-1)).toMatchObject({ label: '生管', cidrs: ['10.30.1.0/24', '10.30.2.0/24'] });
    expect(s.issues).toEqual([]);
  });
});

describe('C IP 對照表顯示所屬網段', () => {
  const settings = (source: SegmentSettings['source']): SegmentSettings => ({
    version: 1,
    source,
    updatedAt: null,
    updatedBy: null,
    overlaps: [],
    gauge: { throughputMaxBps: 1, sessionMax: 1 },
    segments: [{ id: 'server', label: '伺服器區', kind: 'service', icon: 'server', cidrs: ['10.10.130.0/24'] }],
  });
  it('依網段設定算出;範例不顯示;沒有權限不呼叫', async () => {
    const c = useSegmentLookup({ get: async () => settings('file'), allowed: () => true, immediate: false });
    await c.load();
    expect(c.available).toBe(true);
    expect(c.segmentOf('10.10.130.9')).toEqual({ id: 'server', label: '伺服器區' });
    expect(c.segmentOf('10.10.0.0/16')).toBeNull();
    const ex = useSegmentLookup({ get: async () => settings('example'), allowed: () => true, immediate: false });
    await ex.load();
    expect(ex.segmentOf('10.10.130.9')).toBeNull();
    const get = vi.fn();
    const no = useSegmentLookup({ get, allowed: () => false, immediate: false });
    await no.load();
    expect(get).not.toHaveBeenCalled();
    expect(no.available).toBe(false);
  });
});

describe('D 戰情室設備名稱', () => {
  it('有權限顯示設備名稱;沒有只看 IP', async () => {
    const d = useSegmentDeviceNames(createNameCache(async () => ({ names: { '10.10.130.5': label('DB-01') } }), () => true));
    await d.ensure(['10.10.130.5', '10.10.130.6']);
    expect(d.deviceOf('10.10.130.5')).toBe('DB-01');
    expect(d.deviceOf('10.10.130.6')).toBeNull();
    const no = useSegmentDeviceNames(createNameCache(vi.fn(), () => false));
    await no.ensure(['10.10.130.5']);
    expect(no.deviceOf('10.10.130.5')).toBeNull();
  });
});
