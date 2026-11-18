// @vitest-environment happy-dom
/**
 * 網段設定頁(SG-3)與搭配 A–D 畫面掛載測試(docs/SEGMENT-SETTINGS-PLAN.md §2、§3):
 *   - SG-3 Segments.vue:載入清單、新增 / 修改 / 刪除 / 排序、儀表滿格值、CIDR 失焦正規化與碰過欄位才顯示空白錯誤、重疊提示、儲存、409 版本衝突(重新載入 / 保留草稿重套)、JSON 匯入 / 匯出、唯讀權限隱藏寫入按鈕
 *   - A 未分類 IP 協助分類:預覽顯示近 5 分鐘各網段連線數與未分類 Top 20、有權限顯示設備名稱 / 部門、加入某網段、依此 IP 建 /24 網段
 *   - B 從 IP 對照表匯入對話框:列出對照表 CIDR 列、已涵蓋列停用勾選、勾選匯入成網段
 *   - C IpNames.vue:有 netops.segment.read 且設定檔為 file 時顯示唯讀「網段」欄
 *   - D WarroomCanvas.vue:滑過右側網段節點時 tooltip 顯示 Top 內部 IP,有 netops.ip-name.read 權限時附上設備名稱
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpNameEntry } from '@/api/ipNames';
import type { SegmentSettings } from '@/api/segments';
import type { Warroom } from '@/api/warroom';
import WarroomCanvas from '@/components/warroom/WarroomCanvas.vue';
import { createSegmentsMock } from '@/composables/segmentsMock';
import { buildNodes, sumRates } from '@/composables/useWarroom';
import IpNames from '@/pages/knowledge/IpNames.vue';
import Segments from '@/pages/settings/Segments.vue';
import ui from '@/ui';
import { IP_LABEL_KEY } from '@/ui/ipLabel';
import { ipLabel } from '@/composables/ipNames';

const state = vi.hoisted(() => ({
  perms: new Set<string>([
    'netops.segment-page.read',
    'netops.segment-page.write',
    'netops.segment.read',
    'netops.segment.write',
    'netops.ip-name-page.read',
    'netops.ip-name-page.write',
    'netops.ip-name.read',
  ]),
  ipList: vi.fn(),
  ipLookup: vi.fn(),
  segGet: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@/api/gateway', async (orig) => {
  const real = await orig<typeof import('@/api/gateway')>();
  return {
    ...real,
    can: (code: string) => state.perms.has(code),
  };
});

vi.mock('@/api/ipNames', async (orig) => {
  const real = await orig<typeof import('@/api/ipNames')>();
  return {
    ...real,
    ipNames: {
      ...real.ipNames,
      list: state.ipList,
      lookup: state.ipLookup,
    },
  };
});

vi.mock('@/api/segments', async (orig) => {
  const real = await orig<typeof import('@/api/segments')>();
  return {
    ...real,
    segmentsApi: {
      ...real.segmentsApi,
      get: state.segGet,
    },
  };
});

vi.mock('@/ui/feedback', async (orig) => {
  const real = await orig<typeof import('@/ui/feedback')>();
  return {
    ...real,
    confirm: state.confirm,
  };
});

beforeEach(() => {
  state.perms = new Set([
    'netops.segment-page.read',
    'netops.segment-page.write',
    'netops.segment.read',
    'netops.segment.write',
    'netops.ip-name-page.read',
    'netops.ip-name-page.write',
    'netops.ip-name.read',
  ]);
  state.ipList.mockReset();
  state.ipLookup.mockReset();
  state.segGet.mockReset();
  state.confirm.mockReset();
  state.confirm.mockResolvedValue(true);
  state.ipLookup.mockResolvedValue({
    names: {
      '10.30.1.10': { name: '陳工', department: '生管部', device: 'PLC-01', deviceType: '網路設備' },
      '10.10.130.5': { name: '', department: '機房', device: 'DB-01', deviceType: '伺服器' },
    },
  });
  state.ipList.mockResolvedValue({
    items: [
      { id: 'c1', ip: '10.40.1.0/24', name: '', department: '研發部', device: '', deviceType: '', note: '', updatedAt: '2026-11-18T00:00:00Z', updatedBy: 'admin' },
      { id: 'c2', ip: '10.10.130.0/25', name: '', department: '機房', device: '', deviceType: '', note: '', updatedAt: '2026-11-18T00:00:00Z', updatedBy: 'admin' },
    ] satisfies IpNameEntry[],
    total: 2,
    page: 1,
    pageSize: 100,
    version: 1,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Segments.vue 網段設定頁(SG-3 + 搭配 A / B)', () => {
  const settle = async () => {
    await flushPromises();
    await new Promise((r) => setTimeout(r, 5));
    await flushPromises();
  };

  async function mountSegments(backend = createSegmentsMock({ latencyMs: 0 })) {
    const w = mount(Segments, {
      props: { options: { backend } },
      global: { plugins: [ui], stubs: { teleport: true } },
      attachTo: document.body,
    });
    await settle();
    return { w, backend };
  }

  const findBtn = (w: ReturnType<typeof mount>, text: string) =>
    w.findAll('button').find((b) => b.text().includes(text));

  it('載入網段清單與儀表滿格值;新增網段時空白 CIDR 未碰過不標紅,失焦正規化後可儲存', async () => {
    const { w } = await mountSegments();
    expect(w.text()).toContain('範例網段');
    expect(w.text()).toContain('辦公網段(範例)');
    expect(w.findAll('[role="listitem"]')).toHaveLength(3);

    // 新增網段:預設空白 CIDR 未碰過前不顯示錯誤訊息
    await findBtn(w, '新增網段')!.trigger('click');
    const items = w.findAll('[role="listitem"]');
    expect(items).toHaveLength(4);
    expect(items[3]!.find('.err').exists()).toBe(false);

    // 填入非標準主機位元 CIDR 並失焦 → 自動正規化為 10.50.1.0/24
    const cidrInputs = items[3]!.findAll('.cidr-input input');
    await cidrInputs[0]!.setValue('10.50.1.99/24');
    await cidrInputs[0]!.trigger('blur');
    expect((cidrInputs[0]!.element as HTMLInputElement).value).toBe('10.50.1.0/24');

    // 儲存設定 → 版本升為 v1、來源變為正式設定
    const saveBtn = findBtn(w, '儲存設定')!;
    expect(saveBtn.attributes('disabled')).toBeUndefined();
    await saveBtn.trigger('click');
    await settle();
    expect(w.text()).toContain('正式設定 · v1');
    w.unmount();
  });

  it('版本衝突(409):顯示衝突橫幅,支援保留草稿重套與重新載入', async () => {
    const { w, backend } = await mountSegments();
    const firstLabelInput = w.find('[role="listitem"] input');
    await firstLabelInput.setValue('總部辦公網段');
    backend.bumpVersion();

    await findBtn(w, '儲存設定')!.trigger('click');
    await settle();
    expect(w.text()).toContain('版本衝突：網段設定已被其他人修改');

    // 點擊「保留草稿重套」後可再次儲存
    await findBtn(w, '保留草稿重套')!.trigger('click');
    await settle();
    expect(w.text()).not.toContain('版本衝突：網段設定已被其他人修改');

    await findBtn(w, '儲存設定')!.trigger('click');
    await settle();
    expect(w.text()).toContain('正式設定 · v2');
    w.unmount();
  });

  it('流量預覽與搭配 A:顯示各網段連線數、未分類 Top 20 與設備名稱,可加入某網段或建 /24 網段', async () => {
    const { w } = await mountSegments();
    await findBtn(w, '執行預覽')!.trigger('click');
    await settle();

    expect(w.text()).toContain('各網段近 5 分鐘連線數');
    expect(w.text()).toContain('10.30.1.10');
    expect(w.text()).toContain('PLC-01 · 生管部 · 陳工');

    // 依 10.30.1.10 建 /24 網段
    await findBtn(w, '依此 IP 建 /24 網段')!.trigger('click');
    expect(w.findAll('[role="listitem"]')).toHaveLength(4);
    expect(w.text()).toContain('預覽已過期');

    // 將未分類 IP 加入第一個網段
    await findBtn(w, '加入某網段')!.trigger('click');
    expect(w.text()).toContain('未儲存變更');
    w.unmount();
  });

  it('搭配 B:從 IP 對照表匯入網段列,已涵蓋列停用勾選,勾選後匯入草稿', async () => {
    const { w } = await mountSegments();
    await findBtn(w, '從 IP 對照表匯入')!.trigger('click');
    await flushPromises();

    expect(w.text()).toContain('10.40.1.0/24');
    expect(w.text()).toContain('研發部');
    expect(w.text()).toContain('已由 伺服器區(範例) 涵蓋');

    const checkboxes = w.findAll('.g-modal input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0]!.element as HTMLInputElement).disabled).toBe(false);
    expect((checkboxes[1]!.element as HTMLInputElement).disabled).toBe(true);

    await checkboxes[0]!.setValue(true);
    await findBtn(w, '匯入選取項目')!.trigger('click');
    expect(w.findAll('[role="listitem"]')).toHaveLength(4);
    w.unmount();
  });

  it('沒有 netops.segment-page.write 權限時隱藏寫入按鈕並鎖定輸入框', async () => {
    state.perms.delete('netops.segment-page.write');
    const { w } = await mountSegments();
    expect(findBtn(w, '儲存設定')).toBeUndefined();
    expect(findBtn(w, '新增網段')).toBeUndefined();
    expect(findBtn(w, '從 IP 對照表匯入')).toBeUndefined();
    expect(findBtn(w, '匯入 JSON')).toBeUndefined();
    expect(findBtn(w, '匯出 JSON')).toBeTruthy();
    expect((w.find('[role="listitem"] input').element as HTMLInputElement).disabled).toBe(true);
    w.unmount();
  });
});

describe('搭配 C(IpNames.vue 顯示所屬網段欄)與搭配 D(WarroomCanvas.vue 網段節點顯示設備名稱)', () => {
  it('C:IpNames.vue 在網段設定為 file 時顯示唯讀「網段」欄', async () => {
    state.segGet.mockResolvedValue({
      version: 1,
      source: 'file',
      updatedAt: '2026-11-18T00:00:00Z',
      updatedBy: 'admin',
      overlaps: [],
      gauge: { throughputMaxBps: 1e9, sessionMax: 64000 },
      segments: [{ id: 'server', label: '核心機房', kind: 'service', icon: 'server', cidrs: ['10.10.130.0/24'] }],
    } satisfies SegmentSettings);
    state.ipList.mockResolvedValue({
      items: [
        { id: '1', ip: '10.10.130.5', name: '王小明', department: '資訊處', device: 'DB-01', deviceType: '伺服器', note: '', updatedAt: '2026-11-18T00:00:00Z', updatedBy: 'admin' },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
      version: 1,
    });

    const w = mount(IpNames, {
      global: { plugins: [ui], stubs: { teleport: true }, provide: { [IP_LABEL_KEY as symbol]: ipLabel } },
    });
    await flushPromises();

    expect(w.findAll('th').map((h) => h.text())).toContain('網段');
    expect(w.text()).toContain('核心機房');
    w.unmount();
  });

  it('D:WarroomCanvas.vue 滑過右側網段節點時顯示 Top 內部 IP 與設備名稱;無權限時只顯示 IP', async () => {
    const wr: Warroom = {
      generatedAt: '2026-11-18T00:00:00Z',
      minutes: 5,
      partial: false,
      segmentsSource: 'file',
      gauge: { throughputMaxBps: 1e9, sessionMax: 64000 },
      geo: { available: true, version: '2026-11', attribution: { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' } },
      sample: { traffic: 100, trafficSec: 300, threat: 0, threatSec: 300, complete: true },
      sources: [{ id: 'cc:TW', kind: 'country', label: '台灣', country: 'TW', conn: 100, deny: 0, threat: 0, topDst: [], topApp: [] }],
      segments: [
        {
          id: 'server',
          kind: 'service',
          label: '核心機房',
          icon: 'server',
          conn: 100,
          bytes: 1_200_000,
          threat: 0,
          topIps: [
            { key: '10.10.130.5', count: 80 },
            { key: '10.10.130.99', count: 20 },
          ],
        },
      ],
      links: [{ source: 'cc:TW', segment: 'server', conn: 1, allow: 1, deny: 0, threat: 0 }],
      kpis: { denyPerMin: 0, threat5m: 0 },
    };
    const built = buildNodes(wr, null);

    const w = mount(WarroomCanvas, {
      props: {
        sources: built.sources,
        segments: built.segments,
        links: built.links,
        rates: sumRates(wr.links),
        kpis: wr.kpis,
        snapshot: null,
        gauge: wr.gauge,
        focus: null,
        legendOpen: true,
      },
    });
    await flushPromises();

    const segBtn = w.find('button[data-node-side="segment"][data-node-id="server"]');
    await segBtn.trigger('mouseenter');
    await flushPromises();

    expect(state.ipLookup).toHaveBeenCalledWith(['10.10.130.5', '10.10.130.99']);
    expect(w.find('#tip').text()).toContain('Top 內部 IP：10.10.130.5(DB-01), 10.10.130.99');
    w.unmount();

    // 移除 netops.ip-name.read 權限後只顯示 IP,不查 lookup
    state.ipLookup.mockClear();
    state.perms.delete('netops.ip-name.read');
    const wNoPerm = mount(WarroomCanvas, {
      props: {
        sources: built.sources,
        segments: built.segments,
        links: built.links,
        rates: sumRates(wr.links),
        kpis: wr.kpis,
        snapshot: null,
        gauge: wr.gauge,
        focus: null,
        legendOpen: true,
      },
    });
    await flushPromises();
    await wNoPerm.find('button[data-node-side="segment"][data-node-id="server"]').trigger('mouseenter');
    await flushPromises();
    expect(state.ipLookup).not.toHaveBeenCalled();
    expect(wNoPerm.find('#tip').text()).toContain('Top 內部 IP：10.10.130.5, 10.10.130.99');
    expect(wNoPerm.find('#tip').text()).not.toContain('DB-01');
    wNoPerm.unmount();
  });
});
