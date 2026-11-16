// @vitest-environment happy-dom
/**
 * IP 對照表(AC3):
 *   - 名稱快取:收下 names、回應出現但沒有名稱的 IP 移除舊名稱、沒有 names 欄不動
 *   - GIpLabel / GTable ip 欄 / TopList:IP 旁邊顯示名稱(報讀文字含完整說明),沒有對照只顯示 IP
 *   - 單筆表單的 IP 檢查
 *   - IP 對照表頁:清單、單筆新增(先檢查)、匯入預覽 → 確認(有刪除時再確認)、關閉預覽會丟棄、沒有寫入權限不顯示編輯按鈕
 * API 以假資料替換,不連任何服務。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import ui from '@/ui';
import { IP_LABEL_KEY } from '@/ui/ipLabel';
import { absorbNames, clearIpNames, ipLabel, ipNameOf } from '@/composables/ipNames';
import { ipFieldError } from '@/composables/ipNameForm';
import type { ImportPreview, IpNameEntry } from '@/api/ipNames';
import GTable from '@/ui/components/GTable.vue';
import TopList from '@/components/TopList.vue';

const perms = vi.hoisted(() => ({ write: true }));
vi.mock('@/api/gateway', async (orig) => {
  const real = await orig<typeof import('@/api/gateway')>();
  return { ...real, can: (code: string) => (code === 'netops.ip-name-page.write' ? perms.write : true) };
});
const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  exportFile: vi.fn(),
  template: vi.fn(),
  preview: vi.fn(),
  confirm: vi.fn(),
  discard: vi.fn(),
}));
vi.mock('@/api/ipNames', async (orig) => {
  const real = await orig<typeof import('@/api/ipNames')>();
  return { ...real, ipNames: api };
});
const fb = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('@/ui/feedback', async (orig) => {
  const real = await orig<typeof import('@/ui/feedback')>();
  return { ...real, confirm: fb.confirm };
});

const L = (name: string, department = '', device = '', deviceType = '') => ({ name, department, device, deviceType });
const provide = { [IP_LABEL_KEY as symbol]: ipLabel };

afterEach(() => clearIpNames());

describe('名稱快取', () => {
  it('收下 names;回應出現但沒有名稱的 IP 移除舊名稱;沒有 names 欄不動', () => {
    absorbNames({ items: [{ src: '10.1.1.5', dst: '8.8.8.8' }], names: { '10.1.1.5': L('王小明', '資訊處') } });
    expect(ipNameOf('10.1.1.5')?.name).toBe('王小明');
    absorbNames({ items: [{ src: '10.1.1.5' }] });
    expect(ipNameOf('10.1.1.5')?.name).toBe('王小明');
    absorbNames({ items: [{ src: '10.1.1.5' }], names: {} });
    expect(ipNameOf('10.1.1.5')).toBeUndefined();
    absorbNames({ names: { 'not-ip': L('x'), '10.1.1.6': 'bad' } });
    expect(ipNameOf('10.1.1.6')).toBeUndefined();
  });

  it('ipLabel:短文字用姓名,沒有時設備名稱或部門;title 含部門與設備', () => {
    absorbNames({ names: { '10.1.1.5': L('王小明', '資訊處', 'NB-01', '筆電'), '10.1.2.0': L('', '機房', '') } });
    expect(ipLabel('10.1.1.5')).toEqual({ text: '王小明', title: '王小明 · 資訊處 · NB-01(筆電)' });
    expect(ipLabel('10.1.2.0')).toEqual({ text: '機房', title: '機房' });
    expect(ipLabel('8.8.8.8')).toBeUndefined();
  });

  it('ipFieldError:IPv4 與網段;IPv6、前導 0、超過 /32 不行', () => {
    for (const ok of ['10.1.1.5', '10.1.1.0/24', '0.0.0.0/0', ' 10.1.1.5／32 ']) expect(ipFieldError(ok)).toBe('');
    for (const bad of ['', '10.1.1', '010.1.1.1', '10.1.1.1/33', '::1', '10.1.1.256']) expect(ipFieldError(bad)).not.toBe('');
  });
});

describe('IP 旁邊顯示名稱', () => {
  it('GTable 的 ip 欄:有對照顯示名稱與報讀文字,沒有只顯示 IP', () => {
    absorbNames({ names: { '10.1.1.5': L('王小明', '資訊處') } });
    const w = mount(GTable, {
      props: { columns: [{ key: 'src', label: '來源', mono: true, ip: true }], rows: [{ id: 1, src: '10.1.1.5' }, { id: 2, src: '8.8.8.8' }], rowKey: 'id' },
      global: { plugins: [ui], provide },
    });
    const cells = w.findAll('td');
    expect(cells[0]!.text()).toContain('10.1.1.5');
    expect(cells[0]!.text()).toContain('王小明');
    expect(cells[0]!.find('.sr-only').text()).toContain('資訊處');
    expect(cells[0]!.find('.g-ip').attributes('title')).toBe('10.1.1.5:王小明 · 資訊處');
    expect(cells[1]!.text()).toBe('8.8.8.8');
  });

  it('沒有注入查詢函式時只顯示 IP(ui 不依賴應用)', () => {
    absorbNames({ names: { '10.1.1.5': L('王小明') } });
    const w = mount(defineComponent({ render: () => h(GTable, { columns: [{ key: 'src', label: '來源', ip: true }], rows: [{ id: 1, src: '10.1.1.5' }], rowKey: 'id' }) }), { global: { plugins: [ui] } });
    expect(w.find('td').text()).toBe('10.1.1.5');
  });

  it('TopList:IP 項目附名稱,aria-label 含完整說明', () => {
    absorbNames({ names: { '10.1.1.5': L('王小明', '資訊處') } });
    const w = mount(TopList, { props: { title: '來源', items: [{ key: '10.1.1.5', n: 3 }, { key: 'dns', n: 1 }] }, global: { plugins: [ui] } });
    const items = w.findAll('.item');
    expect(items[0]!.find('.who').text()).toBe('王小明');
    expect(items[0]!.attributes('aria-label')).toContain('王小明 · 資訊處');
    expect(items[1]!.find('.who').exists()).toBe(false);
  });
});

describe('IP 對照表頁', () => {
  const entry = (ip: string, name: string, extra: Partial<IpNameEntry> = {}): IpNameEntry => ({
    id: `id-${ip}`, ip, name, department: '資訊處', device: '', deviceType: '', note: '', updatedAt: '2026-11-13T01:00:00Z', updatedBy: 'S1 測試', ...extra,
  });
  const preview = (o: Partial<ImportPreview> = {}): ImportPreview => ({
    id: 'p1', fileName: 'a.xlsx', total: 2, skipped: 2, errors: [{ row: 5, ip: 'bad', message: '不是合法的 IPv4' }],
    counts: { added: 1, changed: 0, removed: 1, unchanged: 1 },
    diff: { added: [entry('10.1.1.7', '新同仁')], changed: [], removed: [entry('10.1.1.9', '離職者')], unchanged: 1 },
    expiresAt: '2026-11-13T02:00:00Z', ...o,
  });

  async function mountPage() {
    const { default: Page } = await import('@/pages/knowledge/IpNames.vue');
    const w = mount(Page, { global: { plugins: [ui], stubs: { teleport: true }, provide }, attachTo: document.body });
    await flushPromises();
    return w;
  }
  const button = (w: Awaited<ReturnType<typeof mountPage>>, text: string) => w.findAll('button').find((b) => b.text().includes(text));

  beforeEach(() => {
    perms.write = true;
    for (const f of Object.values(api)) f.mockReset();
    fb.confirm.mockReset();
    api.list.mockResolvedValue({ items: [entry('10.1.1.5', '王小明', { device: 'NB-01', deviceType: '筆電' })], total: 1, page: 1, pageSize: 50, version: 3 });
    api.discard.mockResolvedValue(undefined);
  });

  it('清單:顯示姓名、部門、設備類型;有寫入權限才有新增 / 匯入 / 修改 / 刪除', async () => {
    const w = await mountPage();
    expect(api.list).toHaveBeenCalledWith('', 1, 50);
    const text = w.text();
    expect(text).toContain('10.1.1.5');
    expect(text).toContain('王小明');
    expect(text).toContain('筆電');
    expect(button(w, '新增')).toBeTruthy();
    expect(w.find('[aria-label="刪除 10.1.1.5"]').exists()).toBe(true);
    w.unmount();
    perms.write = false;
    const r = await mountPage();
    expect(button(r, '新增')).toBeFalsy();
    expect(button(r, '匯入檔案')).toBeFalsy();
    expect(r.find('[aria-label="刪除 10.1.1.5"]').exists()).toBe(false);
    expect(button(r, '匯出 Excel')).toBeTruthy();
    r.unmount();
  });

  it('單筆新增:IP 不合法或姓名部門設備都空白時不送出;合法送出後重新載入', async () => {
    const w = await mountPage();
    await button(w, '新增')!.trigger('click');
    const save = () => button(w, '儲存')!.trigger('click');
    await save();
    expect(api.create).not.toHaveBeenCalled();
    const inputs = w.findAll('.g-modal input');
    await inputs[0]!.setValue('10.1.1.0/24');
    await save();
    expect(api.create).not.toHaveBeenCalled();
    await inputs[2]!.setValue('業務部');
    api.create.mockResolvedValue(entry('10.1.1.0/24', ''));
    await save();
    await flushPromises();
    expect(api.create).toHaveBeenCalledWith({ ip: '10.1.1.0/24', name: '', department: '業務部', device: '', deviceType: '', note: '' });
    expect(api.list).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('匯入:預覽顯示差異 → 有刪除時再確認 → 確認匯入;取消預覽會丟棄', async () => {
    api.preview.mockResolvedValue(preview());
    api.confirm.mockResolvedValue({ added: 1, changed: 0, removed: 1, unchanged: 1, total: 2 });
    const w = await mountPage();
    const input = w.find('input[type="file"]');
    const file = new File(['x'], 'a.xlsx');
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(api.preview).toHaveBeenCalledWith('a.xlsx', 'xlsx', expect.any(String));
    expect(w.text()).toContain('新同仁');
    expect(w.text()).toContain('檔案裡沒有的 1 筆會被刪除');
    // 先拒絕再確認
    fb.confirm.mockResolvedValueOnce(false);
    await button(w, '確認匯入')!.trigger('click');
    await flushPromises();
    expect(api.confirm).not.toHaveBeenCalled();
    fb.confirm.mockResolvedValueOnce(true);
    await button(w, '確認匯入')!.trigger('click');
    await flushPromises();
    expect(api.confirm).toHaveBeenCalledWith('p1');
    expect(api.discard).not.toHaveBeenCalled();
    // 再上傳一次後取消
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
    await w.findAll('.g-modal button').find((b) => b.text() === '取消')!.trigger('click');
    await flushPromises();
    expect(api.discard).toHaveBeenCalledWith('p1');
    w.unmount();
  });

  it('不是 xlsx / csv 不上傳', async () => {
    const w = await mountPage();
    const input = w.find('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'a.xls')], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(api.preview).not.toHaveBeenCalled();
    w.unmount();
  });
});
