// @vitest-environment happy-dom
/**
 * AC5 AI 解讀:威脅「AI 說明這個威脅與處理建議」(ThreatAiDialog)、熱力圖「AI 指出異常格」(anomalyChips、面板 slot)
 *   只送條件(威脅名稱 + 期間 / 熱力圖條件)、資料限制提示、異常時段按鈕(回答提到的排前面)、關閉時中斷
 */
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

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

const { default: ui } = await import('@/ui');
const { default: AiExplainPanel } = await import('@/components/AiExplainPanel.vue');
const { default: ThreatAiDialog } = await import('@/components/ThreatAiDialog.vue');
const { anomalyChips, explainNotices } = await import('@/composables/useAiExplain');

const base = { model: 'm', source: 'clickhouse', partial: false, gapsKnown: true, contextChars: 100, clipped: false, notes: [], vectorError: false };
const cells = [
  { t: '2026-11-11T03:00:00+08:00', end: '2026-11-11T04:00:00+08:00', v: 9000, kind: 'high', ratio: 9.8, offHours: true, partial: false },
  { t: '2026-11-12T14:00:00+08:00', end: '2026-11-12T15:00:00+08:00', v: 7000, kind: 'high', ratio: 4.1, offHours: false, partial: true },
  { t: '2026-11-13T10:00:00+08:00', end: '2026-11-13T11:00:00+08:00', v: 1, kind: 'low', ratio: 0.1, offHours: false, partial: false },
] as const;
const heatMeta = (over: Record<string, unknown> = {}) => ({ ...base, kind: 'heatmap', granularity: 'month', metric: 'traffic', date: '2026-11-13', nulls: 0, cells: [...cells], ...over }) as never;

describe('anomalyChips(熱力圖異常時段按鈕)', () => {
  it('開始時間寫法同送 AI 的資料;回答提到的排前面,其餘照原順序', () => {
    const chips = anomalyChips(heatMeta(), '1. **2026/11/12 14:00** 流量偏高');
    expect(chips.map((c) => [c.label, c.mentioned])).toEqual([
      ['2026/11/12 14:00–15:00', true],
      ['2026/11/11 03:00–04:00', false],
      ['2026/11/13 10:00–11:00', false],
    ]);
  });

  it('年視圖只寫日期;不是熱力圖或沒有格子時沒有按鈕', () => {
    const year = anomalyChips(heatMeta({ granularity: 'year', cells: [{ ...cells[0], t: '2026-11-11T00:00:00+08:00', end: '2026-11-12T00:00:00+08:00' }] }), '');
    expect(year.map((c) => [c.label, c.mentioned])).toEqual([['2026/11/11', false]]);
    expect(anomalyChips(null, '')).toEqual([]);
    expect(anomalyChips({ ...base, kind: 'slice' } as never, '')).toEqual([]);
    expect(anomalyChips(heatMeta({ cells: [] }), '')).toEqual([]);
  });
});

describe('explainNotices(AC5)', () => {
  it('威脅超過保留期限、沒有紀錄;熱力圖沒有資料的格子', () => {
    const t = explainNotices({ ...base, kind: 'threat', count: 0, skipped: { from: '2026-11-01T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00' } } as never);
    expect(t.map((n) => n.tone)).toEqual(['warning', 'info']);
    expect(t[0]!.text).toContain('2026/11/01 00:00 ~ 2026/11/09 00:00 超過威脅 log 保留期限');
    expect(t[1]!.text).toContain('沒有這個威脅的紀錄');
    expect(explainNotices(heatMeta({ nulls: 1234 })).map((n) => n.text)).toEqual(['有 1,234 格沒有資料(不是 0),沒有算進統計']);
  });
});

describe('AiExplainPanel 的 slot(熱力圖)', () => {
  it('回答下方把 meta 與回答交給 slot', async () => {
    script = async (on) => {
      on({ event: 'meta', data: heatMeta() });
      on({ event: 'content', data: { text: '2026/11/11 03:00 異常' } });
      on({ event: 'done', data: { finish: 'stop' } });
    };
    const Host = defineComponent(() => () =>
      h(
        AiExplainPanel,
        { input: { kind: 'heatmap', params: { granularity: 'month', metric: 'traffic', date: '2026-11-13' } }, title: 't', startLabel: '開始分析', autoStart: true },
        { default: ({ meta, text }: { meta: never; text: string }) => h('ul', { class: 'chips' }, anomalyChips(meta, text).map((c) => h('li', `${c.label}${c.mentioned ? '*' : ''}`))) },
      ),
    );
    const w = mount(Host, { global: { plugins: [ui] }, attachTo: document.body });
    await flushPromises();
    expect(w.findAll('.chips li').map((x) => x.text())).toEqual(['2026/11/11 03:00–04:00*', '2026/11/12 14:00–15:00', '2026/11/13 10:00–11:00']);
    w.unmount();
  });
});

describe('ThreatAiDialog(AC5)', () => {
  const props = { name: 'SSH Brute Force Attempt(40015)', from: '2026-11-11T08:00:00+08:00', to: '2026-11-11T09:00:00+08:00', severity: 'high' };
  const Host = defineComponent({
    setup() {
      const open = ref(false);
      return () => h('div', [h('button', { class: 'opener', onClick: () => (open.value = true) }, 'open'), h(ThreatAiDialog, { ...props, open: open.value, 'onUpdate:open': (v: boolean) => (open.value = v) })]);
    },
  });

  it('開啟時自動開始,只送威脅名稱與期間;顯示名稱與嚴重度文字;關閉時中斷', async () => {
    calls.length = 0;
    let aborted = false;
    script = async (on, signal) => {
      on({ event: 'meta', data: { ...base, kind: 'threat', count: 12, skipped: null } });
      on({ event: 'content', data: { text: '## 這是什麼威脅\nSSH 暴力破解' } });
      await new Promise<void>((_r, reject) =>
        signal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }),
      );
    };
    const w = mount(Host, { global: { plugins: [ui] }, attachTo: document.body });
    expect(calls).toHaveLength(0);
    await w.find('.opener').trigger('click');
    await flushPromises();
    expect(calls).toEqual([{ kind: 'threat', params: { name: props.name, from: props.from, to: props.to }, think: false }]);
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('SSH Brute Force Attempt(40015)');
    expect(dialog.textContent).toContain('嚴重度 高');
    expect(dialog.textContent).toContain('2026-11-11 08:00–09:00');
    expect(dialog.textContent).toContain('這是什麼威脅');
    // Esc 關閉 → 面板卸載 → 串流中斷
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    await flushPromises();
    expect(aborted).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    w.unmount();
  });
});
