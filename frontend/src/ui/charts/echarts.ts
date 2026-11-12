/**
 * ECharts 按需引入、主題與世界地圖(V-b1;VIZ-RULES-DESIGN §6.5、決策 D40、V9)。
 * **只由 GEChart.vue 以動態 import() 載入**:ui/index.ts 會全域註冊 charts/G*.vue,若在元件頂層 import 這個檔,
 * ECharts(約 150–200 KB gzip)與地圖會進首頁 bundle。圖表元件(Gemini)一律經 GEChart,不直接 import 這裡。
 *   - 圖表:Line、Bar、Pie、Sankey、Treemap、Map;Renderer 用 SVG(和既有自刻 SVG 圖表一致,文字清楚)
 *   - 主題:從 CSS 變數讀(--chart-1..8、--text*、--line、--glass-strong…),明暗 / 風格切換時 GEChart 重新套用;頁面不自己指定顏色
 *   - 地圖:Natural Earth 1:110m(world/world.geo.json,feature.properties.name = ISO2),打包進前端,不連外部 CDN
 */
import { BarChart, LineChart, MapChart, PieChart, SankeyChart, TreemapChart } from 'echarts/charts';
import { AriaComponent, DataZoomComponent, GeoComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import world from './world/world.geo.json';

echarts.use([LineChart, BarChart, PieChart, SankeyChart, TreemapChart, MapChart, GridComponent, TooltipComponent, LegendComponent, VisualMapComponent, GeoComponent, AriaComponent, DataZoomComponent, SVGRenderer]);
// 地圖名稱 'world';series / geo 用 map: 'world',資料的 name 用 ISO2(api/insight.ts CountryCount.iso2)
echarts.registerMap('world', world as unknown as Parameters<typeof echarts.registerMap>[1]);

export { echarts };
export const WORLD_MAP = 'world';

/** 讀 CSS 變數(color-mix 等由瀏覽器算好;讀不到時用 fallback) */
export function cssVar(name: string, fallback = '', el: Element = document.documentElement): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/** 嚴重度固定對應語意色(critical = danger、high = warning、medium = info、low = cyan、info = 次要文字) */
export const severityColors = () => ({
  critical: cssVar('--c-danger', '#e0483e'),
  high: cssVar('--c-warning', '#e0901a'),
  medium: cssVar('--c-info', '#2f7de1'),
  low: cssVar('--c-cyan', '#0891b2'),
  info: cssVar('--text-3', '#566b7c'),
});

/** 上傳 / 下載、允許 / 阻擋等成對資料的固定色 */
export const pairColors = () => ({
  sent: cssVar('--chart-3', '#f5a524'),
  recv: cssVar('--chart-1', '#0369a1'),
  allow: cssVar('--c-success', '#12a150'),
  deny: cssVar('--c-danger', '#e0483e'),
});

/** 目前的明暗 / 風格(主題快取的鍵) */
export const themeKey = (): string => `${document.documentElement.dataset.theme ?? ''}/${document.documentElement.dataset.style ?? ''}`;

/** 依目前 CSS 變數組 ECharts 主題(GEChart 用 echarts.init(el, buildTheme())) */
export function buildTheme(): Record<string, unknown> {
  const text = cssVar('--text', '#0b2233');
  const text2 = cssVar('--text-2', '#475d6e');
  const line = cssVar('--line', 'rgba(11,34,51,0.08)');
  const axis = { axisLine: { lineStyle: { color: line } }, axisTick: { lineStyle: { color: line } }, axisLabel: { color: text2 }, splitLine: { lineStyle: { color: line } } };
  return {
    color: Array.from({ length: 8 }, (_, i) => cssVar(`--chart-${i + 1}`)).filter(Boolean),
    backgroundColor: 'transparent',
    textStyle: { color: text2, fontFamily: 'inherit' },
    title: { textStyle: { color: text } },
    legend: { textStyle: { color: text2 } },
    tooltip: {
      backgroundColor: cssVar('--glass-strong', '#ffffff'),
      borderColor: cssVar('--glass-border', line),
      textStyle: { color: text },
    },
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    geo: { itemStyle: { areaColor: cssVar('--heat-empty', line), borderColor: cssVar('--bg', '#fff') } },
    map: { itemStyle: { areaColor: cssVar('--heat-empty', line), borderColor: cssVar('--bg', '#fff') } },
  };
}
