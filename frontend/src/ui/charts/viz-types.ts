/**
 * 熱力圖與儀表板圖表元件的介面(V-b1;VIZ-RULES-DESIGN §6.4、HANDOFF-GEMINI-VIZ §4)。
 * **Claude 定型別,Gemini 照型別實作畫面(不改這個檔)**;要改介面寫在 MR「交給 Claude」。
 * 資料型別 = API 回應的對應欄位(api/heatmap.ts、api/insight.ts、api/slice.ts),這裡只轉出,不另定一份。
 *
 * 共同規則:
 *   - 點擊一律 emit('pick', ChartPick),元件內不呼叫 API;頁面用 useChartPick().toSliceQuery 轉成時段明細
 *   - 顏色只用 echarts.ts 的主題(CSS token),不自己指定
 *   - 數值 null = 沒有資料(和 0 不同:趨勢線斷開、長條不畫,tooltip 寫「沒有資料」)
 *   - 動畫看 prefers-reduced-motion(GEChart 已自動關 ECharts 動畫;CSS 動畫用 media query)
 */
import type { HeatCell, HeatGranularity, HeatMetric } from '@/api/heatmap';
import type { AllowDenyPoint, CountryCount, SankeyLink, SankeyNode, SeverityScore, ThreatPoint, TopApp, TopIp, TopIpTraffic, TopThreatName, TrendPoint } from '@/api/insight';
import type { SliceSource } from '@/api/slice';

export type { AllowDenyPoint, CountryCount, HeatCell, SankeyLink, SankeyNode, SeverityScore, ThreatPoint, TopApp, TopIp, TopIpTraffic, TopThreatName, TrendPoint };

/** 圖表代碼(ChartPick.chart):useChartPick 依這個決定時段明細條件 */
export type ChartId =
  | 'trend' // GTrendDualAxis:name = 時間 t(ISO)
  | 'allowDeny' // GAllowDeny:name = 時間 t
  | 'sankey' // GSankey:name = 節點 id(z:/a:/d:)或連線「source>target」
  | 'topIp' // GTopBars:name = IP
  | 'topApp' // GAppShare:name = App
  | 'severity' // GSeverityCards:name = critical | high | medium | low | info
  | 'timeline' // GThreatTimeline:name = 時間 t,series = 嚴重度
  | 'country' // GWorldMap / 國家排行:name = iso2,data = CountryCount
  | 'topInternalSrc' // GTopCompare 左:name = IP
  | 'topServerDst' // GTopCompare 右:name = IP
  | 'topNames'; // 威脅名稱排行:name = 威脅名稱

/** 圖表點擊(GEChart 正規化 ECharts 的 click 事件) */
export interface ChartPick {
  chart: ChartId | string;
  series?: string;
  name: string;
  value?: number;
  data?: unknown;
}

/* ───── 熱力圖(CSS Grid,不用 ECharts) ───── */

export interface GHeatmapProps {
  granularity: HeatGranularity;
  /** 決定色階 --heat-<metric>-1..4 */
  metric: HeatMetric;
  cells: HeatCell[];
  /** 排版用(年視圖第一欄、月的天數) */
  from: string;
  to: string;
  loading?: boolean;
  /** 目前選取格的 t */
  selected?: string | null;
  /** 預設 1(週一在第一列) */
  weekStart?: 0 | 1;
  /** 預設 true;reduced-motion 時元件自己忽略 */
  animate?: boolean;
}
export interface GHeatmapEmits {
  /** 點格子 / Enter → 開明細抽屜 */
  (e: 'select', cell: HeatCell): void;
  /** 雙擊 / Shift+Enter → 下鑽 */
  (e: 'drill', cell: HeatCell): void;
  (e: 'hover', cell: HeatCell | null): void;
}

/* ───── ECharts 圖表元件(Gemini 實作,內部都用 GEChart;emits 一律 pick) ───── */

export interface GEChartProps {
  /** ECharts option(不含顏色;主題由 echarts.ts 套用) */
  option: Record<string, unknown>;
  /** 預設 320px */
  height?: string;
  loading?: boolean;
  /** 圖表說明(螢幕閱讀器);必填。模板請寫 ariaLabel="…"(寫 aria-label 會被當成 HTML 屬性,不會傳進 prop) */
  ariaLabel: string;
  /** ChartPick.chart */
  chart?: ChartId | string;
}

export interface GTrendDualAxisProps {
  points: TrendPoint[];
  bucketSeconds: number;
}
export interface GSankeyProps {
  nodes: SankeyNode[];
  links: SankeyLink[];
}
export interface GTopBarsProps {
  items: TopIpTraffic[];
}
export interface GAppShareProps {
  items: TopApp[];
  mode: 'donut' | 'treemap';
}
export interface GAllowDenyProps {
  points: AllowDenyPoint[];
  bucketSeconds: number;
}
export interface GSeverityCardsProps {
  score: SeverityScore;
}
export interface GThreatTimelineProps {
  points: ThreatPoint[];
  bucketSeconds: number;
}
export interface GWorldMapProps {
  countries: CountryCount[];
  /** 排行顯示前幾名(預設 10;地圖顯示全部) */
  top?: number;
}
export interface GTopCompareProps {
  left: TopIp[];
  /** null = 沒有資料來源(例:伺服器網段未設定),顯示 notes */
  right: TopIp[] | null;
  leftTitle: string;
  rightTitle: string;
  notes?: string[];
}
export interface ChartPickEmits {
  (e: 'pick', p: ChartPick): void;
}

/* ───── 抽屜與徽章 ───── */

export interface GDrawerProps {
  modelValue: boolean;
  title: string;
  /** 預設 560px;≤ 960px 視窗時全寬 */
  width?: string;
  side?: 'right';
}
export interface GDrawerEmits {
  (e: 'update:modelValue', v: boolean): void;
}
export interface GSourceBadgeProps {
  source: SliceSource;
}
