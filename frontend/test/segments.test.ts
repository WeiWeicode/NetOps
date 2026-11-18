/**
 * 網段設定前端邏輯(SG-2):驗證規則、重疊、匯入匯出、useSegmentSettings 的草稿 / 儲存 / 版本衝突 / 預覽(mock 後端)
 */
import { describe, expect, it } from 'vitest';
import { createSegmentMatcher, findOverlaps, normalizeCidr, parseCidr, parseImport, slash24Of, suggestId, validateConfig, exportJson } from '@/composables/segmentRules';
import { createSegmentsMock } from '@/composables/segmentsMock';
import { useSegmentSettings } from '@/composables/useSegmentSettings';
import type { SegmentConfig } from '@/api/segments';

const CFG: SegmentConfig = {
  gauge: { throughputMaxBps: 1e9, sessionMax: 64000 },
  segments: [
    { id: 'server', label: '伺服器區', kind: 'service', icon: 'server', cidrs: ['10.10.130.0/24'] },
    { id: 'office', label: '辦公', kind: 'vlan', icon: 'office', cidrs: ['10.10.0.0/16'] },
  ],
};

describe('segmentRules', () => {
  it('CIDR 解析、正規化、/24', () => {
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/8/1')).toBeNull();
    expect(normalizeCidr('10.1.2.3/24')).toBe('10.1.2.0/24');
    expect(normalizeCidr('10.1.2.3')).toBe('10.1.2.3/32');
    expect(slash24Of('10.30.1.10')).toBe('10.30.1.0/24');
    expect(slash24Of('fd00::1')).toBeNull();
  });
  it('驗證:欄位路徑同後端', () => {
    const errs = validateConfig({
      gauge: { throughputMaxBps: 0, sessionMax: 1 },
      segments: [
        { id: 'a', label: 'A', kind: 'vlan', icon: 'pc', cidrs: ['10.0.0.0/40'] },
        { id: 'a', label: '', kind: 'vlan', icon: 'pc', cidrs: [] },
        { id: 'unmatched', label: 'x', kind: 'vlan', icon: 'pc', cidrs: ['10.0.0.0/8'] },
      ],
    }).map((e) => e.field);
    expect(errs).toEqual(expect.arrayContaining(['gauge.throughputMaxBps', 'segments[0].cidrs[0]', 'segments[1].id', 'segments[1].label', 'segments[1].cidrs', 'segments[2].id']));
    expect(validateConfig(CFG)).toEqual([]);
  });
  it('重疊與最長前綴對照(網段列要整個落在規則內)', () => {
    expect(findOverlaps(CFG.segments)).toHaveLength(1);
    const m = createSegmentMatcher(CFG.segments);
    expect(m('10.10.130.5')?.id).toBe('server');
    expect(m('10.10.1.5')?.id).toBe('office');
    expect(m('10.10.130.0/25')?.id).toBe('server');
    expect(m('10.0.0.0/8')).toBeNull();
    expect(m('8.8.8.8')).toBeNull();
  });
  it('代碼建議不重複', () => {
    expect(suggestId('Office LAN', [])).toBe('office-lan');
    expect(suggestId('辦公', ['seg-1'])).toBe('seg-2');
    expect(suggestId('Office', ['office'])).toBe('office-1');
  });
  it('匯入:略過多餘欄位、補 icon;格式錯誤回訊息;匯出可再匯入', () => {
    const r = parseImport(JSON.stringify({ version: 3, source: 'file', segments: [{ id: 'x', label: 'X', kind: 'service', cidrs: ['10.0.0.0/8'] }] }));
    expect('cfg' in r && r.cfg.segments[0]).toEqual({ id: 'x', label: 'X', kind: 'service', icon: 'server', cidrs: ['10.0.0.0/8'] });
    expect(parseImport('{')).toEqual({ error: '不是合法的 JSON 檔' });
    expect(parseImport('[]')).toHaveProperty('error');
    const again = parseImport(exportJson(CFG));
    expect('cfg' in again && again.cfg).toEqual(CFG);
  });
});

describe('useSegmentSettings(mock 後端)', () => {
  const setup = () => {
    const backend = createSegmentsMock({ latencyMs: 0 });
    const s = useSegmentSettings({ backend, immediate: false });
    return { backend, s };
  };

  it('載入 → 編輯 → 驗證 → 儲存 version + 1', async () => {
    const { s } = setup();
    await s.load();
    expect(s.meta.value?.source).toBe('example');
    expect(s.dirty.value).toBe(false);
    const i = s.addSegment({ label: 'Lab' });
    expect(s.draft.segments[i]!.id).toBe('lab');
    expect(s.canSave.value).toBe(false); // CIDR 空白
    expect(s.issuesOf(`segments[${i}]`).length).toBeGreaterThan(0);
    s.draft.segments[i]!.cidrs[0] = '10.30.1.9/24';
    s.normalizeCidrAt(i, 0);
    expect(s.draft.segments[i]!.cidrs[0]).toBe('10.30.1.0/24');
    expect(s.canSave.value).toBe(true);
    expect(await s.save()).toBe(true);
    expect(s.meta.value?.version).toBe(1);
    expect(s.meta.value?.source).toBe('file');
    expect(s.dirty.value).toBe(false);
  });

  it('版本衝突:保留草稿、標示 conflict;重新載入後清除', async () => {
    const { s, backend } = setup();
    await s.load();
    s.draft.segments[0]!.label = '改名';
    backend.bumpVersion();
    expect(await s.save()).toBe(false);
    expect(s.conflict.value).toEqual({ currentVersion: 1 });
    expect(s.draft.segments[0]!.label).toBe('改名');
    expect(s.canSave.value).toBe(false);
    await s.load();
    expect(s.conflict.value).toBeNull();
    expect(s.meta.value?.version).toBe(1);
  });

  it('排序、刪除、重設', async () => {
    const { s } = setup();
    await s.load();
    const ids = () => s.draft.segments.map((x) => x.id);
    s.moveSegment(0, 2);
    expect(ids()).toEqual(['server', 'factory', 'office']);
    s.removeSegment(1);
    expect(ids()).toEqual(['server', 'office']);
    s.reset();
    expect(ids()).toEqual(['office', 'server', 'factory']);
  });

  it('預覽:未分類 IP Top;草稿有錯不送出', async () => {
    const { s } = setup();
    await s.load();
    await s.runPreview();
    expect(s.preview.value?.partial).toBe(false);
    expect(s.preview.value?.unmatched.top[0]).toEqual({ ip: '10.30.1.10', count: 260 });
    s.draft.segments[0]!.cidrs[0] = 'bad';
    s.preview.value = null;
    await s.runPreview();
    expect(s.preview.value).toBeNull();
  });

  it('匯入改草稿、匯出檔名', async () => {
    const { s } = setup();
    await s.load();
    expect(s.importText(JSON.stringify(CFG))).toBeNull();
    expect(s.draft.segments.map((x) => x.id)).toEqual(['server', 'office']);
    expect(s.overlapIdsOf('server')).toEqual(['office']);
    expect(s.dirty.value).toBe(true);
    expect(s.importText('x')).toBe('不是合法的 JSON 檔');
    expect(s.exportFile().fileName).toMatch(/^網段設定_\d{8}\.json$/);
  });
});
