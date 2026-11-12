// @vitest-environment happy-dom
/**
 * 日期區間欄位掛載測試:點欄位打開面板、快捷選項直接套用、手動輸入按「套用」才更新、
 * 開始晚於結束時不能套用、超過保留期限的快捷選項停用、Esc 關閉。
 */
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ui from '@/ui';
import DateRangeField from '@/components/DateRangeField.vue';

describe('DateRangeField', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 9, 30));
  });
  afterEach(() => vi.useRealTimers());

  const make = (props: Record<string, unknown> = {}) =>
    mount(DateRangeField, { props: { from: '2026-11-12', to: '2026-11-12', maxDays: 92, coverage: { from: '2026-11-12', to: '2026-11-12' }, ...props }, global: { plugins: [ui] }, attachTo: document.body });

  it('顯示目前期間;點欄位打開面板,快捷選項直接套用', async () => {
    const w = make();
    expect(w.find('.control').text()).toContain('2026-11-12');
    expect(w.find('.panel').exists()).toBe(false);
    await w.find('.control').trigger('click');
    expect(w.find('.control').attributes('aria-expanded')).toBe('true');
    const chips = w.findAll('.chip');
    // 昨天整個在資料範圍之前:停用
    expect(chips.find((c) => c.text() === '昨天')!.attributes('disabled')).toBeDefined();
    await chips.find((c) => c.text() === '最近 7 天')!.trigger('click');
    expect(w.emitted('update:from')?.at(-1)).toEqual(['2026-11-06']);
    // 結束本來就是 2026-11-12:沒有變就不會送出 update:to
    expect(w.find('.panel').exists()).toBe(false);
    w.unmount();
  });

  it('手動輸入按套用才更新;開始晚於結束不能套用;Esc 關閉', async () => {
    const w = make();
    await w.find('.control').trigger('click');
    const [a, b] = w.findAll('input');
    await a!.setValue('2026-11-12');
    await b!.setValue('2026-11-09');
    expect(w.emitted('update:from')).toBeUndefined();
    const apply = w.findAll('button').find((x) => x.text() === '套用')!;
    expect(apply.attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('開始不可晚於結束');
    await a!.setValue('2026-11-09');
    await b!.setValue('2026-11-10');
    await apply.trigger('click');
    expect(w.emitted('update:from')?.at(-1)).toEqual(['2026-11-09']);
    expect(w.emitted('update:to')?.at(-1)).toEqual(['2026-11-10']);
    await w.find('.control').trigger('click');
    await w.find('.drf').trigger('keydown', { key: 'Escape' });
    expect(w.find('.panel').exists()).toBe(false);
    w.unmount();
  });

  it('時間模式用 datetime-local;停用時打不開', async () => {
    const w = make({ mode: 'datetime', from: '2026-11-12T08:00', to: '2026-11-12T09:00', maxDays: 30 });
    expect(w.find('.control').text()).toContain('2026-11-12 08:00 ~ 09:00');
    await w.find('.control').trigger('click');
    expect(w.find('input').attributes('type')).toBe('datetime-local');
    w.unmount();
    const d = make({ disabled: true });
    await d.find('.control').trigger('click');
    expect(d.find('.panel').exists()).toBe(false);
    d.unmount();
  });
});
