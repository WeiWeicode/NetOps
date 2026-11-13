// @vitest-environment happy-dom
/**
 * AC6 安全事件頁「AI 摘要安全事件」:資料限制提示(explainNotices)、按鈕權限、只送期間、四類筆數(點了切換類型)、關閉時中斷
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

type On = (e: { event: string; data: unknown }) => void;
let script: (on: On, signal?: AbortSignal) => Promise<void> = async () => {};
const calls: unknown[] = [];
vi.mock('@/api/ai', () => ({
  AiStreamError: class extends Error {},
  ai: {
    explain: async (body: unknown, on: On, signal?: AbortSignal) => {
      calls.push(body);
      await script(on, signal);
    },
  },
}));
let perms = new Set<string>();
vi.mock('@/api/gateway', async (orig) => ({ ...(await orig<object>()), can: (code: string) => perms.has(code) }));
const day = { coverage: { from: '2026-11-10', to: '2026-11-11' }, days: ['2026-11-11', '2026-11-10'] };
vi.mock('@/api/paEvents', () => ({
  paEvents: {
    types: async () => ({
      types: [
        { type: 'threat', label: '威脅', source: 'clickhouse', files: 3, rows: 30, ...day },
        { type: 'url', label: 'URL 過濾', source: 'clickhouse', files: 3, rows: 10, ...day },
      ],
    }),
    overview: async (type: string, from: string, to: string) => ({
      type,
      label: type === 'url' ? 'URL 過濾' : '威脅',
      source: 'clickhouse',
      from,
      to,
      files: 1,
      rows: 30,
      timeMin: '2026-11-11T01:00:00+08:00',
      timeMax: '2026-11-11T01:59:00+08:00',
      hours: [],
      kpis: [],
      tops: [],
      missing: 0,
      topsState: 'ok',
      topsUntil: '2026-11-11T02:00:00+08:00',
      coverage: day.coverage,
      partial: false,
      import: { busy: false, failed: 0 },
    }),
  },
}));

const { default: ui } = await import('@/ui');
const { default: Events } = await import('@/pages/firewall/Events.vue');
const { explainNotices } = await import('@/composables/useAiExplain');

const base = { model: 'm', source: 'clickhouse', partial: false, contextChars: 100, clipped: false, notes: [], vectorError: false };
const types = [
  { type: 'threat', rows: 30, empty: false, partial: false },
  { type: 'url', rows: 10, empty: false, partial: true },
  { type: 'data', rows: 0, empty: true, partial: false },
  { type: 'wildfire', rows: 0, empty: true, partial: false },
];

describe('explainNotices(AC6 events)', () => {
  it('列出不完整與沒有資料的類型;不提示 FTP 對帳', () => {
    const n = explainNotices({ ...base, kind: 'events', types } as never);
    expect(n).toEqual([
      { tone: 'warning', text: 'URL 過濾 的統計不完整(期間早於最早的資料或統計還沒建好),AI 看到的數量可能少於實際' },
      { tone: 'info', text: '資料過濾、WildFire 這段期間沒有資料(還沒收到這類 log 或超過保留期限),不代表沒有發生' },
    ]);
    expect(explainNotices({ ...base, kind: 'events', types: [types[0]], clipped: true } as never).map((x) => x.text)).toEqual(['排行較多,只送前面的部分給 AI']);
  });
});

describe('安全事件頁 AI 摘要(AC6)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  async function setup() {
    const actions = document.createElement('div');
    actions.id = 'page-actions';
    document.body.appendChild(actions);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/firewall/events', component: Events }] });
    await router.push('/firewall/events?type=threat');
    await router.isReady();
    const w = mount(Events, { global: { plugins: [ui, router] }, attachTo: document.body });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 350)); // 頁面的 debounce
    await flushPromises();
    return { w, router };
  }
  const aiButton = () => [...document.querySelectorAll('#page-actions button')].find((b) => b.textContent?.includes('AI 摘要安全事件')) as HTMLButtonElement | undefined;

  it('沒有按鈕權限時不顯示', async () => {
    perms = new Set(['netops.pa-ask.use']);
    const { w } = await setup();
    expect(aiButton()).toBeUndefined();
    w.unmount();
  });

  it('只送期間;回答下方列出四類筆數,點了切換類型並關閉對話框;Esc 關閉時中斷', async () => {
    perms = new Set(['netops.pa-events.ai']);
    calls.length = 0;
    let aborted = false;
    script = async (on, signal) => {
      on({ event: 'meta', data: { ...base, kind: 'events', from: '2026-11-11', to: '2026-11-11', types } });
      on({ event: 'content', data: { text: '## 本期摘要\n威脅 30 筆' } });
      await new Promise<void>((_r, reject) =>
        signal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }),
      );
    };
    const { w, router } = await setup();
    const btn = aiButton()!;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    btn.click();
    await flushPromises();
    expect(calls).toEqual([{ kind: 'events', params: { from: '2026-11-11', to: '2026-11-11' }, think: false }]);
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('期間 2026-11-11(威脅、URL 過濾、資料過濾、WildFire)');
    expect(dialog.textContent).toContain('本期摘要');
    const items = [...dialog.querySelectorAll('.ev-ai__type')] as HTMLButtonElement[];
    expect(items.map((b) => b.getAttribute('aria-label'))).toEqual(['威脅,30 次,切換到這個類型', 'URL 過濾,10 次,不完整,切換到這個類型', '資料過濾,0 次,沒有資料', 'WildFire,0 次,沒有資料']);
    expect(items.map((b) => b.disabled)).toEqual([false, false, true, true]);
    expect(dialog.textContent).toContain('URL 過濾 的統計不完整');

    // 點 URL 過濾 → 關閉對話框(串流中斷)並切換類型
    items[1]!.click();
    await nextTick();
    await flushPromises();
    expect(aborted).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(router.currentRoute.value.query.type).toBe('url');

    // 再開一次,Esc 關閉也會中斷
    aborted = false;
    aiButton()!.click();
    await flushPromises();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    await flushPromises();
    expect(aborted).toBe(true);
    w.unmount();
  });
});
