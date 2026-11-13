// @vitest-environment happy-dom
/**
 * AC4 AI 解讀面板(時段明細「AI 解讀這個時段」、儀表板「AI 摘要本期異常」):
 *   送出的參數只有條件、回答經 AiMarkdown、資料限制的提示、換條件清掉舊回答、autoStart、停止、錯誤
 */
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

type On = (e: { event: string; data: unknown }) => void;
let script: (on: On, signal?: AbortSignal) => Promise<void> = async () => {};
const calls: unknown[] = [];
vi.mock('@/api/ai', () => ({
  AiStreamError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  ai: {
    explain: async (body: unknown, on: On, signal?: AbortSignal) => {
      calls.push(body);
      await script(on, signal);
    },
  },
}));

const { default: ui } = await import('@/ui');
const { default: AiExplainPanel } = await import('@/components/AiExplainPanel.vue');
const { explainNotices } = await import('@/composables/useAiExplain');
const { AiStreamError } = await import('@/api/ai');

const sliceInput = { kind: 'slice' as const, params: { start: '2026-11-11T08:00:00+08:00', end: '2026-11-11T09:00:00+08:00', ip: '10.10.1.3' } };
const meta = (over: Record<string, unknown> = {}) => ({ kind: 'slice', model: 'm', source: 'clickhouse', partial: false, gapsKnown: true, contextChars: 100, clipped: false, notes: [], vectorError: false, ...over });
const answer = (m: Record<string, unknown>) => async (on: On) => {
  on({ event: 'meta', data: m });
  on({ event: 'content', data: { text: '## 這個時段發生什麼事\n主要是 <img src=x onerror=alert(1)> ssl' } });
  on({ event: 'done', data: { finish: 'stop', truncated: false } });
};
const mountPanel = (props: Record<string, unknown> = {}) =>
  mount(AiExplainPanel, { props: { input: sliceInput, title: 'AI 解讀這個時段', startLabel: 'AI 解讀', ...props }, global: { plugins: [ui] }, attachTo: document.body });
const button = (w: ReturnType<typeof mountPanel>, label: string) => w.findAll('button').find((b) => b.text().includes(label));

describe('explainNotices', () => {
  it('資料不完整、未對帳、前一期不比較、資料截斷都要提示', () => {
    expect(explainNotices(null)).toEqual([]);
    expect(explainNotices(meta({ partial: true }) as never).map((n) => n.tone)).toEqual(['warning']);
    const t = explainNotices(meta({ kind: 'insight', gapsKnown: false, prev: false, clipped: true, vectorError: true }) as never).map((n) => n.text);
    expect(t.join('|')).toMatch(/尚未完成每日 FTP 對帳.*不和前一期比較.*只送前面的部分.*語意搜尋失敗/);
  });
});

describe('AiExplainPanel(AC4)', () => {
  it('按下按鈕才開始;只送條件;回答經 AiMarkdown;完成後可重新解讀與複製', async () => {
    calls.length = 0;
    script = answer(meta());
    const w = mountPanel();
    expect(calls).toHaveLength(0);
    expect(w.text()).toContain('只把統計與排行');
    await button(w, 'AI 解讀')!.trigger('click');
    await flushPromises();
    expect(calls).toEqual([{ ...sliceInput, think: false }]);
    expect(w.text()).toContain('這個時段發生什麼事');
    // 回答經 AiMarkdown(renderMarkdown + DOMPurify;happy-dom 的 DOMPurify 不完整,過濾效果在瀏覽器驗證)
    expect(w.find('.ai-md').exists()).toBe(true);
    expect(button(w, '重新解讀')).toBeTruthy();
    expect(button(w, '複製')).toBeTruthy();
    expect(w.find('[role="status"]').exists()).toBe(false);
    w.unmount();
  });

  it('深入思考:送 think: true', async () => {
    calls.length = 0;
    script = answer(meta());
    const w = mountPanel();
    await w.find('input[type="checkbox"]').setValue(true);
    await button(w, 'AI 解讀')!.trigger('click');
    await flushPromises();
    expect((calls[0] as { think: boolean }).think).toBe(true);
    w.unmount();
  });

  it('資料不完整與前一期不比較時顯示提示', async () => {
    script = answer(meta({ kind: 'insight', partial: true, prev: false }));
    const w = mountPanel({ autoStart: true, input: { kind: 'insight', params: { view: 'traffic', from: '2026-11-05', to: '2026-11-11' } } });
    await flushPromises();
    expect(w.text()).toContain('資料落在已知缺口內');
    expect(w.text()).toContain('不和前一期比較');
    w.unmount();
  });

  it('等時段明細時顯示進度(aria-live);停止後保留已收到的內容並標示不完整', async () => {
    script = async (on, signal) => {
      on({ event: 'scan', data: { step: 'slice', waiting: true } });
      await new Promise<void>((_r, reject) =>
        signal?.addEventListener('abort', () => {
          on({ event: 'content', data: { text: '部分回答' } });
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }),
      );
    };
    const w = mountPanel();
    await button(w, 'AI 解讀')!.trigger('click');
    await nextTick();
    const status = w.find('[role="status"]');
    expect(status.attributes('aria-live')).toBe('polite');
    expect(status.text()).toContain('時段明細還在查詢');
    await button(w, '停止')!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('部分回答');
    expect(w.text()).toContain('已停止,回答不完整');
    w.unmount();
  });

  it('換了條件:清掉舊回答(進行中的也中斷)', async () => {
    script = answer(meta());
    const w = mountPanel();
    await button(w, 'AI 解讀')!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('這個時段發生什麼事');
    await w.setProps({ input: { ...sliceInput, params: { ...sliceInput.params, ip: '10.10.1.4' } } });
    await flushPromises();
    expect(w.text()).not.toContain('這個時段發生什麼事');
    expect(button(w, 'AI 解讀')).toBeTruthy();
    w.unmount();
  });

  it('串流錯誤顯示訊息;沒有條件時按鈕停用', async () => {
    script = async () => {
      throw new AiStreamError('NETOPS_AI_UNAVAILABLE', 'AI 分析失敗:連不到 AI 服務');
    };
    const w = mountPanel();
    await button(w, 'AI 解讀')!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('連不到 AI 服務');
    await w.setProps({ input: null });
    expect(button(w, 'AI 解讀')!.attributes('disabled')).toBeDefined();
    w.unmount();
  });
});
