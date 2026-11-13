// @vitest-environment happy-dom
/**
 * GEChart(V-b1;VIZ-RULES-DESIGN §6.4、§8):動態載入 ECharts、prefers-reduced-motion 關動畫、明暗切換重建主題、點擊正規化成 ChartPick。
 * ECharts 以假模組替換(happy-dom 沒有版面,真的 ECharts 量不到大小);真的 ECharts 由 vite build 與瀏覽器驗證。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GEChart from '@/ui/charts/GEChart.vue';

const fake = vi.hoisted(() => {
  const charts: { theme: unknown; options: Record<string, unknown>[]; handlers: Record<string, (e: unknown) => void>; disposed: boolean }[] = [];
  return {
    charts,
    lib: {
      echarts: {
        init: (_el: unknown, theme: unknown) => {
          const c = { theme, options: [] as Record<string, unknown>[], handlers: {} as Record<string, (e: unknown) => void>, disposed: false };
          charts.push(c);
          return {
            setOption: (o: Record<string, unknown>) => c.options.push(o),
            showLoading: () => undefined,
            hideLoading: () => undefined,
            resize: () => undefined,
            on: (ev: string, fn: (e: unknown) => void) => (c.handlers[ev] = fn),
            dispose: () => (c.disposed = true),
          };
        },
      },
      buildTheme: () => ({ theme: document.documentElement.dataset.theme }),
      themeKey: () => `${document.documentElement.dataset.theme}/${document.documentElement.dataset.style}`,
    },
  };
});
vi.mock('@/ui/charts/echarts', () => fake.lib);

function setMotion(reduce: boolean) {
  window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  fake.charts.length = 0;
  document.documentElement.dataset.theme = 'light';
});

describe('GEChart', () => {
  it('掛載後才載入 ECharts;option 加上 aria 描述;reduced-motion 時 animation = false', async () => {
    setMotion(true);
    const w = mount(GEChart, { props: { option: { series: [] }, ariaLabel: '測試圖表', chart: 'trend' } });
    await flushPromises();
    expect(fake.charts).toHaveLength(1);
    const o = fake.charts[0]!.options.at(-1)!;
    expect(o.animation).toBe(false);
    expect(o.aria).toEqual({ enabled: true, label: { description: '測試圖表' } });
    w.unmount();
    expect(fake.charts[0]!.disposed).toBe(true);
  });

  it('沒有 reduced-motion 時保留動畫;點擊正規化成 ChartPick(桑基連線 name = source>target)', async () => {
    setMotion(false);
    const w = mount(GEChart, { props: { option: { series: [] }, ariaLabel: 'x', chart: 'sankey' } });
    await flushPromises();
    expect(fake.charts[0]!.options.at(-1)!.animation).toBe(true);
    fake.charts[0]!.handlers.click!({ seriesName: 's', name: 'a:ssl', value: 3, data: { name: 'a:ssl' } });
    fake.charts[0]!.handlers.click!({ seriesName: 's', dataType: 'edge', data: { source: 'z:LAN', target: 'a:ssl', value: 9 } });
    const picks = w.emitted('pick')!.map((e) => e[0]);
    expect(picks[0]).toMatchObject({ chart: 'sankey', series: 's', name: 'a:ssl', value: 3 });
    expect(picks[1]).toMatchObject({ chart: 'sankey', name: 'z:LAN>a:ssl' });
    w.unmount();
  });

  it('明暗切換(<html data-theme>)時重建圖表套用新主題', async () => {
    setMotion(false);
    document.documentElement.dataset.theme = 'light';
    const w = mount(GEChart, { props: { option: {}, ariaLabel: 'x' } });
    await flushPromises();
    document.documentElement.dataset.theme = 'dark';
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.charts).toHaveLength(2);
    expect(fake.charts[0]!.disposed).toBe(true);
    expect(fake.charts[1]!.theme).toEqual({ theme: 'dark' });
    w.unmount();
  });
});
