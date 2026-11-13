// @vitest-environment happy-dom
/**
 * AC7 流量總覽「AI 每日摘要」卡片:提示文字(失敗 / 重試 / 等待 / 未啟用)、日期標籤、
 *   卡片顯示摘要與筆數、資料不完整、預設收合 + 展開(aria-expanded,鍵盤可操作)、選以前的日子帶 day、AI 回答經 DOMPurify、讀取失敗可重試
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailySummaryRecord, DailySummaryStatus } from '@/api/ai';

const calls: (string | undefined)[] = [];
let respond: (day?: string) => Promise<DailySummaryStatus> = async () => status();
vi.mock('@/api/ai', () => ({
  ai: {
    dailySummary: (day?: string) => {
      calls.push(day);
      return respond(day);
    },
  },
}));

import ui from '@/ui';
import DailySummaryCard from '@/components/DailySummaryCard.vue';
import { dailySummaryNotice, summaryDayLabel } from '@/composables/useDailySummary';

const rec = (o: Partial<DailySummaryRecord> = {}): DailySummaryRecord => ({
  day: '2026-11-13',
  state: 'done',
  tries: 1,
  at: '2026-11-14T00:31:00.000Z',
  result: {
    text: '## 昨日總結\n流量正常<img src=x onerror="alert(1)">\n\n## 需要注意\n1. 10.10.1.3',
    model: 'fake-model',
    partial: false,
    clipped: false,
    contextChars: 100,
    counts: { sessions: 1234, threat: 5, url: null, data: 0, wildfire: 1 },
  },
  error: null,
  ...o,
});
function status(o: Partial<DailySummaryStatus> = {}): DailySummaryStatus {
  return {
    enabled: true,
    at: '08:10',
    target: '2026-11-13',
    state: 'done',
    error: null,
    summary: rec(),
    days: [
      { day: '2026-11-13', state: 'done' },
      { day: '2026-11-12', state: 'failed' },
    ],
    ...o,
  };
}

afterEach(() => {
  calls.length = 0;
  respond = async () => status();
});

describe('提示與標籤(純函式)', () => {
  it('日期標籤含星期', () => {
    expect(summaryDayLabel('2026-11-13')).toBe('11/13(五)');
    expect(summaryDayLabel('bad')).toBe('bad');
  });
  it('失敗、重試、等待、未啟用;看到的是較早的摘要時說明', () => {
    const older = rec({ day: '2026-11-12' });
    expect(dailySummaryNotice(status({ state: 'failed', error: { code: 'X', message: '連線逾時' }, summary: older }), null)).toEqual({
      tone: 'danger',
      title: '今天的摘要產生失敗',
      text: '11/13(五)的摘要重試後仍失敗:連線逾時,以下是 11/12(四) 的摘要',
    });
    expect(dailySummaryNotice(status({ state: 'retrying', error: { code: 'X', message: 'AI 忙碌' } }), null)?.text).toContain("第一次產生失敗(AI 忙碌),約 10 分鐘後自動重試一次");
    expect(dailySummaryNotice(status({ state: 'waiting', summary: null }), null)?.text).toMatch(/每天 08:10 對帳與每日同步完成後自動產生/);
    expect(dailySummaryNotice(status({ state: 'disabled', enabled: false }), null)?.text).toMatch(/未啟用/);
    expect(dailySummaryNotice(status(), null)).toBeNull();
    expect(dailySummaryNotice(null, null)).toBeNull();
  });
});

describe('AI 每日摘要卡片', () => {
  const mountCard = async () => {
    const w = mount(DailySummaryCard, { global: { plugins: [ui] }, attachTo: document.body });
    await flushPromises();
    return w;
  };

  it('顯示摘要、筆數與狀態;回答經 DOMPurify;預設收合,按鈕展開(aria-expanded)', async () => {
    const w = await mountCard();
    expect(calls).toEqual([undefined]);
    expect(w.text()).toContain('AI 每日摘要');
    expect(w.text()).toContain('已產生');
    expect(w.text()).toContain('11/13(五)');
    expect(w.text()).toContain('連線數 1,234');
    expect(w.text()).toContain('威脅 5');
    expect(w.text()).not.toContain('URL 過濾'); // 取不到的類型不顯示
    // 回答經 AiMarkdown(DOMPurify;happy-dom 的 DOMPurify 不完整,過濾效果在瀏覽器驗證,同 aiExplain.mount.test)
    expect(w.find('.ai-md').text()).toContain('昨日總結');
    const body = w.find('.summary-body');
    expect(body.classes()).toContain('collapsed');
    const btn = w.findAll('button').find((b) => b.text() === '展開全文')!;
    expect(btn.attributes('aria-expanded')).toBe('false');
    expect(btn.attributes('aria-controls')).toBe(body.attributes('id'));
    await btn.trigger('click');
    expect(w.find('.summary-body').classes()).not.toContain('collapsed');
    expect(w.findAll('button').find((b) => b.text() === '收合')!.attributes('aria-expanded')).toBe('true');
    w.unmount();
  });

  it('今天的摘要產生失敗:標示失敗並顯示較早的摘要;資料不完整要提示', async () => {
    respond = async () => status({ state: 'failed', error: { code: 'NETOPS_AI_UNAVAILABLE', message: 'AI 服務無法使用:連線逾時' }, summary: rec({ day: '2026-11-12', result: { ...rec().result!, partial: true } }) });
    const w = await mountCard();
    expect(w.find('[role="alert"]').text()).toContain('今天的摘要產生失敗');
    expect(w.text()).toContain('AI 服務無法使用:連線逾時');
    expect(w.text()).toContain('以下是 11/12(四) 的摘要');
    expect(w.text()).toContain('資料不完整');
    w.unmount();
  });

  it('選以前的日子帶 day;選回最新的不帶;失敗的日子顯示原因', async () => {
    respond = async (day) => (day === '2026-11-12' ? status({ summary: rec({ day: '2026-11-12', state: 'failed', result: null, error: { code: 'X', message: '重試後仍失敗:逾時' } }) }) : status());
    const w = await mountCard();
    const sel = w.find('select');
    expect(sel.findAll('option').map((o) => o.text())).toEqual(['11/13(五)', '11/12(四) 失敗']);
    expect(w.find('label').text()).toContain('摘要日期');
    await sel.setValue('2026-11-12');
    await flushPromises();
    expect(calls.at(-1)).toBe('2026-11-12');
    expect(w.text()).toContain('11/12(四) 的摘要產生失敗');
    expect(w.text()).toContain('重試後仍失敗:逾時');
    await w.find('select').setValue('2026-11-13');
    await flushPromises();
    expect(calls.at(-1)).toBeUndefined();
    w.unmount();
  });

  it('讀取失敗可重試;還沒有摘要時說明何時產生', async () => {
    respond = async () => {
      throw new Error('網路錯誤');
    };
    const w = await mountCard();
    expect(w.text()).toContain('無法取得每日摘要');
    respond = async () => status({ state: 'waiting', summary: null, days: [] });
    await w.findAll('button').find((b) => b.text() === '重試')!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('等待產生');
    expect(w.text()).toContain('對帳與每日同步完成後自動產生');
    expect(w.find('select').exists()).toBe(false);
    w.unmount();
  });
});
