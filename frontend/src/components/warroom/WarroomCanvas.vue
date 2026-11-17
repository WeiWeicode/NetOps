<script setup lang="ts">
/**
 * 戰情室中央 Canvas(WR-5;WARROOM-GEMINI-HANDOFF §2、§3、§4,對照樣稿 warroom-v5.html):
 *   - 左側節點:外部來源(國家 / Top 攻擊 IP / 其他 / 內部互連)，線條圖示、旋轉光弧、阻擋比例 > 60% 的紅色脈衝
 *   - 右側節點:內部網段(VLAN / 核心服務六角形 / 未分類)，線條圖示、旋轉光弧
 *   - 連線與粒子:貝茲曲線、粒子數由匯出的 particleRate(link, rates.conn) 決定(畫面上限 ≤ 1500)、拖尾、阻擋火花(bursts)與盾牌閃紅
 *   - 中央核心:六角盾、分段負載環(DP CPU)、刻度環、雷達掃描、log 類型衛星、擴散波(頻率隨新連線/秒)、二進位環繞資料流、能量電弧
 *   - 儀表弧:吞吐量 / 連線數滿格值使用傳入的 gauge({ throughputMaxBps, sessionMax })，絕不寫死
 *   - 互動:滑過節點顯示明細 tooltip、點擊節點切換聚焦(toggleFocus)、點空白處取消聚焦(toggleFocus(null))
 *   - 效能與生命週期:分頁隱藏時暫停動畫、卸載時取消 requestAnimationFrame 並移除事件監聽
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fmtNum, fmtShort, fmtSize } from '@/api/format';
import type { PaLiveSnapshot } from '@/api/paLive';
import { fmtBps } from '@/composables/paLive';
import {
  particleRate,
  type Focus,
  type LinkView,
  type Rates,
  type SegmentNode,
  type SourceNode,
  type Tone,
} from '@/composables/useWarroom';

const props = defineProps<{
  sources: readonly SourceNode[];
  segments: readonly SegmentNode[];
  links: readonly LinkView[];
  rates: Rates;
  kpis: { denyPerMin: number | null; threat5m: number | null } | null;
  snapshot: PaLiveSnapshot | null;
  gauge: { throughputMaxBps: number; sessionMax: number };
  focus: Focus | null;
  legendOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggleFocus', f: Focus | null): void;
  (e: 'centerChange', cx: number): void;
}>();

const wrapEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);

// ---- SVG 線條圖示(對照樣稿 warroom-v5.html ICONS) ----
const ICONS: Record<string, string> = {
  globe: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20M2 12h20M12 2c3 3 4 6.5 4 10s-1 7-4 10M12 2c-3 3-4 6.5-4 10s1 7 4 10',
  skull:
    'M12 2c-5 0-8 3.5-8 8c0 3 1.5 5 3 6v3h10v-3c1.5-1 3-3 3-6c0-4.5-3-8-8-8M9 10.5a1.5 1.5 0 1 0 0 .1M15 10.5a1.5 1.5 0 1 0 0 .1M10 19v3M14 19v3',
  cloud: 'M7 18h11a4 4 0 0 0 0-8a6 6 0 0 0-11.5-1A4.5 4.5 0 0 0 7 18',
  pc: 'M3 4h18v12H3zM8 20h8M12 16v4',
  office: 'M3 4h18v12H3zM8 20h8M12 16v4',
  factory: 'M2 21h20M3 21V10l6 4V10l6 4V6h4v15M17 10v2',
  gear: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 1v4M12 19v4M1 12h4M19 12h4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M4.2 19.8l2.8-2.8M17 7l2.8-2.8',
  server: 'M3 3h18v6H3zM3 15h18v6H3zM7 6h.1M7 18h.1M3 9v6M21 9v6',
  mail: 'M2 5h20v14H2zM2 5l10 8l10-8',
  key: 'M7 14a4 4 0 1 0 0 .1M10 12l11-11M17 5l3 3M14 8l3 3',
  lock: 'M5 11h14v11H5zM8 11V7a4 4 0 0 1 8 0v4M12 15v3',
  wifi: 'M2 9c6-5 14-5 20 0M5 13c4-3.5 10-3.5 14 0M8.5 16.5c2-1.5 5-1.5 7 0M12 20h.1',
  network: 'M12 3v6M12 15v6M3 12h6M15 12h6M9 9h6v6H9z',
  shield: 'M12 2l8 3v6c0 5-3.5 9-8 11c-4.5-2-8-6-8-11V5zM8.5 12l2.5 2.5l5-5',
};

const pathCache = new Map<string, Path2D>();
function getPath2D(name: string): Path2D | null {
  if (typeof Path2D === 'undefined') return null;
  const key = name in ICONS ? name : 'globe';
  let p = pathCache.get(key);
  if (!p) {
    p = new Path2D(ICONS[key]!);
    pathCache.set(key, p);
  }
  return p;
}

function sourceIcon(s: SourceNode): string {
  if (s.kind === 'ip') return 'skull';
  if (s.kind === 'country') return 'globe';
  if (s.id === 'lan') return 'network';
  return 'cloud';
}

function segmentIcon(g: SegmentNode): string {
  if (g.icon && g.icon in ICONS) return g.icon;
  if (g.kind === 'service') return 'server';
  if (g.kind === 'vlan') return 'pc';
  return 'network';
}

function toneRgb(tone: Tone): [number, number, number] {
  if (tone === 'deny') return [255, 77, 94];
  if (tone === 'warn') return [245, 176, 58];
  return [34, 211, 166];
}

function ratioRgb(d: number): [number, number, number] {
  return d > 0.6 ? [255, 77, 94] : d > 0.25 ? [245, 176, 58] : [34, 211, 166];
}

interface PlacedSource {
  node: SourceNode;
  x: number;
  y: number;
  r: number;
}
interface PlacedSegment {
  node: SegmentNode;
  x: number;
  y: number;
  r: number;
}
interface Particle {
  si: number;
  di: number;
  t: number;
  sp: number;
  deny: boolean;
  threat: boolean;
  seg: 0 | 1 | 2;
  px?: number;
  py?: number;
}
interface Burst {
  x: number;
  y: number;
  r: number;
  a: number;
}
interface Ripple {
  r: number;
  a: number;
}

const MAX_PARTICLES = 1500;
const MAX_BURSTS = 80;
const MAX_RIPPLES = 24;

let W = 1280;
let H = 620;
let cx = 640;
let cy = 310;
let R = 90;
let rafId = 0;
let lastFrameTs = 0;
let lastRip = 0;
let shieldHit = 0;
let dMbps = 0;
let dSess = 0;
let dLoad = 0.45;
let resizeObs: ResizeObserver | null = null;

const placedLeft = ref<PlacedSource[]>([]);
const placedRight = ref<PlacedSegment[]>([]);
const hoverTarget = ref<{ side: 'source' | 'segment'; index: number; clientX: number; clientY: number } | null>(null);

let parts: Particle[] = [];
let bursts: Burst[] = [];
let ripples: Ripple[] = [];

function computeRadius(size: number): number {
  return 11 + Math.sqrt(Math.max(0.04, size)) * 12;
}

function updateLayout() {
  const wrap = wrapEl.value;
  const cv = canvasEl.value;
  if (!wrap || !cv) return;
  const rect = wrap.getBoundingClientRect();
  W = Math.max(640, Math.floor(rect.width || innerWidth));
  H = Math.max(360, Math.floor(rect.height || innerHeight - 300));
  cv.width = W;
  cv.height = H;

  const lx = props.legendOpen ? Math.max(290, W * 0.23) : Math.max(150, W * 0.14);
  const rx = Math.min(W - 290, W * 0.76);
  cx = (lx + rx) / 2;
  cy = H / 2;
  R = Math.min(Math.max(160, rx - lx), H) * (props.legendOpen ? 0.135 : 0.155);

  emit('centerChange', cx);
  placeNodes(lx, rx);
}

function placeNodes(lx: number, rx: number) {
  const top = 56;
  const bot = Math.max(top + 80, H - 56);
  const sLen = Math.max(1, props.sources.length);
  const gLen = Math.max(1, props.segments.length);

  placedLeft.value = props.sources.map((node, i) => ({
    node,
    x: lx,
    y: top + ((bot - top) * (i + 0.5)) / sLen,
    r: computeRadius(node.size),
  }));

  placedRight.value = props.segments.map((node, j) => ({
    node,
    x: rx,
    y: top + ((bot - top) * (j + 0.5)) / gLen,
    r: computeRadius(node.size),
  }));
}

watch(
  () => [props.sources, props.segments, props.legendOpen] as const,
  () => {
    for (const p of parts) {
      p.px = undefined;
      p.py = undefined;
    }
    updateLayout();
  },
);

function bez(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  const mx = (a.x + b.x) / 2;
  const p0 = a;
  const p3 = b;
  const p1 = { x: mx, y: a.y };
  const p2 = { x: mx, y: b.y };
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function ent(i: number) {
  const s = placedLeft.value[i];
  const sy = s ? s.y : cy;
  return { x: cx - R, y: cy + (sy - cy) * 0.25 };
}

function ext(j: number) {
  const d = placedRight.value[j];
  const dy = d ? d.y : cy;
  return { x: cx + R, y: cy + (dy - dy * 0 + (dy - cy) * 0.25) };
}

function burst(p: { x: number; y: number }) {
  if (bursts.length < MAX_BURSTS) {
    bursts.push({ x: p.x, y: p.y, r: 2, a: 1 });
  }
  shieldHit = 1;
}

function spawnParticles(dtSec: number) {
  if (parts.length >= MAX_PARTICLES) return;
  const left = placedLeft.value;
  const right = placedRight.value;
  if (!left.length || !right.length) return;

  const sMap = new Map<string, number>();
  left.forEach((s, idx) => sMap.set(s.node.id, idx));
  const gMap = new Map<string, number>();
  right.forEach((g, idx) => gMap.set(g.node.id, idx));

  const totalConn = props.rates.conn;
  for (const l of props.links) {
    if (parts.length >= MAX_PARTICLES) break;
    const si = sMap.get(l.source);
    const di = gMap.get(l.segment);
    if (si === undefined || di === undefined) continue;
    const rate = particleRate(l, totalConn);
    const prob = rate * dtSec;
    if (Math.random() < prob) {
      const denyProb = l.conn > 0 ? l.deny / l.conn : 0;
      const threatProb = l.conn > 0 ? l.threat / l.conn : 0;
      const r = Math.random();
      const deny = r < denyProb;
      const threat = !deny && r < denyProb + threatProb;
      parts.push({
        si,
        di,
        t: 0,
        sp: 0.006 + Math.random() * 0.006,
        deny,
        threat,
        seg: 0,
      });
    }
  }
}

function drawIcon(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, s: number, stroke: string, lw: number) {
  const p = getPath2D(name);
  if (!p) return;
  ctx.save();
  ctx.translate(x - s / 2, y - s / 2);
  ctx.scale(s / 24, s / 24);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = (lw * 24) / s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(p);
  ctx.restore();
}

function hex(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rot + (i * Math.PI) / 3;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawLink(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  rgb: string,
  w: number,
  alpha: number,
) {
  ctx.strokeStyle = `rgba(${rgb},${alpha})`;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  const mx = (a.x + b.x) / 2;
  ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y);
  ctx.stroke();
}

function drawGauge(
  ctx: CanvasRenderingContext2D,
  a0: number,
  a1: number,
  frac: number,
  rad: number,
  c: string,
  label: string,
  val: string,
  lx: number,
  ly: number,
  ccw: boolean,
) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  ctx.lineCap = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(30,50,80,.7)';
  ctx.beginPath();
  ctx.arc(cx, cy, rad, a0, a1, ccw);
  ctx.stroke();

  const ae = a0 + (a1 - a0) * clamped;
  const gr = ctx.createLinearGradient(cx - rad, cy, cx + rad, cy);
  gr.addColorStop(0, `rgba(${c},.3)`);
  gr.addColorStop(1, `rgb(${c})`);
  ctx.strokeStyle = gr;
  ctx.shadowColor = `rgb(${c})`;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(cx, cy, rad, a0, ae, ccw);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx + Math.cos(ae) * rad, cy + Math.sin(ae) * rad, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = 'butt';

  ctx.textAlign = 'center';
  ctx.fillStyle = `rgb(${c})`;
  ctx.font = 'bold 21px "Segoe UI", sans-serif';
  ctx.fillText(val, lx, ly);
  ctx.fillStyle = '#6f86a8';
  ctx.font = '10px "Segoe UI", "Microsoft JhengHei", sans-serif';
  ctx.fillText(label, lx, ly + 14);
}

function fmtThroughputMax(maxBps: number): string {
  if (maxBps >= 1e9) {
    const g = maxBps / 1e9;
    return `${Number.isInteger(g) ? g : g.toFixed(1)} Gbps`;
  }
  const m = maxBps / 1e6;
  return `${Math.round(m)} Mbps`;
}

function fmtSessionMax(maxSess: number): string {
  if (maxSess >= 1000) {
    const k = maxSess / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(maxSess);
}

function drawCore(ctx: CanvasRenderingContext2D, ts: number) {
  const t = ts / 1000;
  const dpCpu = props.snapshot?.metrics?.cpu?.dataplane;
  const targetLoad = dpCpu != null ? Math.max(0.05, Math.min(1, dpCpu / 100)) : 0.45;
  dLoad += (targetLoad - dLoad) * 0.08;

  const lc = ratioRgb(dLoad * 0.7).join(',');
  shieldHit *= 0.9;

  // 背景核心光暈
  const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.2);
  g.addColorStop(0, `rgba(${(62 + shieldHit * 190) | 0},${(168 - shieldHit * 100) | 0},255,.28)`);
  g.addColorStop(1, 'rgba(62,168,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 2.2, 0, Math.PI * 2);
  ctx.fill();

  // 雷達錐形掃描
  if (typeof ctx.createConicGradient === 'function') {
    const sg = ctx.createConicGradient((t * 1.2) % (Math.PI * 2), cx, cy);
    sg.addColorStop(0, 'rgba(62,168,255,.35)');
    sg.addColorStop(0.12, 'rgba(62,168,255,0)');
    sg.addColorStop(1, 'rgba(62,168,255,0)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.45, 0, Math.PI * 2);
    ctx.fill();
  }

  // 外圈刻度環
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.15);
  for (let i = 0; i < 72; i++) {
    const a = (i * Math.PI) / 36;
    const l = i % 6 ? 4 : 10;
    ctx.strokeStyle = i % 6 ? 'rgba(62,168,255,.35)' : 'rgba(120,200,255,.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * R * 1.45, Math.sin(a) * R * 1.45);
    ctx.lineTo(Math.cos(a) * (R * 1.45 - l), Math.sin(a) * (R * 1.45 - l));
    ctx.stroke();
  }
  ctx.restore();

  // 分段負載環
  const seg = 40;
  for (let i = 0; i < seg; i++) {
    const a0 = -Math.PI / 2 + (i * Math.PI * 2) / seg + 0.02;
    const a1 = a0 + (Math.PI * 2) / seg - 0.04;
    const on = i / seg < dLoad;
    ctx.strokeStyle = on ? `rgba(${lc},${0.6 + 0.4 * Math.sin(t * 4 + i * 0.3) ** 2})` : 'rgba(30,50,80,.6)';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.18, a0, a1);
    ctx.stroke();
  }

  // 虛線軌道與 log 類型衛星
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(62,168,255,.5)';
  ctx.setLineDash([3, 7]);
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.95, -t * 0.6, -t * 0.6 + Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  const sats: [string, string][] = [
    ['TRAFFIC', '34,211,166'],
    ['THREAT', '245,176,58'],
    ['URL', '62,168,255'],
    ['WILDFIRE', '255,77,94'],
    ['GP', '160,120,255'],
  ];
  sats.forEach((s, i) => {
    const a = t * 0.5 + (i * Math.PI * 2) / sats.length;
    const x = cx + Math.cos(a) * R * 0.95;
    const y = cy + Math.sin(a) * R * 0.95;
    ctx.fillStyle = `rgb(${s[1]})`;
    ctx.shadowColor = `rgb(${s[1]})`;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(${s[1]},.8)`;
    ctx.font = '9px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(s[0], x, y - 7);
  });

  // 六角盾牌核心
  const hr = R * 0.62;
  ctx.shadowColor = `rgb(${lc})`;
  ctx.shadowBlur = 25 + shieldHit * 30;
  const hg = ctx.createLinearGradient(cx, cy - hr, cx, cy + hr);
  hg.addColorStop(0, 'rgba(20,45,80,.95)');
  hg.addColorStop(1, 'rgba(8,18,34,.95)');
  hex(ctx, cx, cy, hr, Math.PI / 6);
  ctx.fillStyle = hg;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = shieldHit > 0.1 ? 'rgba(255,77,94,.9)' : 'rgba(120,200,255,.9)';
  ctx.stroke();
  ctx.shadowBlur = 0;

  hex(ctx, cx, cy, hr * 0.86, Math.PI / 6);
  ctx.strokeStyle = 'rgba(62,168,255,.25)';
  ctx.lineWidth = 1;
  ctx.stroke();

  drawIcon(ctx, 'shield', cx, cy - hr * 0.32, hr * 0.5, `rgb(${lc})`, 2.2);
  ctx.fillStyle = '#e6f2ff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 15px "Segoe UI", sans-serif';
  ctx.fillText('PA-560', cx, cy + hr * 0.22);
  ctx.font = 'bold 20px "Segoe UI", sans-serif';
  ctx.fillStyle = `rgb(${lc})`;
  ctx.fillText(dpCpu != null ? `${Math.round(dpCpu)}%` : '—', cx, cy + hr * 0.55);
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.fillStyle = '#6f86a8';
  ctx.fillText('DATAPLANE', cx, cy + hr * 0.72);

  // 核心額外特效與儀表弧(使用 props.gauge，不寫死)
  const rawBps = props.snapshot?.metrics?.throughput?.bps ?? 0;
  const rawMbps = rawBps / 1e6;
  const rawSess = props.snapshot?.metrics?.session?.active ?? 0;
  const rawCps = props.snapshot?.metrics?.throughput?.cps ?? Math.round(props.rates.conn);

  dMbps += (rawMbps - dMbps) * 0.08;
  dSess += (rawSess - dSess) * 0.08;

  const ripInterval = Math.max(0.35, 1.6 - Math.min(1400, rawCps) / 1400);
  if (t - lastRip > ripInterval && ripples.length < MAX_RIPPLES) {
    ripples.push({ r: R * 0.65, a: 0.6 });
    lastRip = t;
  }
  ripples = ripples.filter((p) => {
    p.r += 1.6;
    p.a -= 0.006;
    ctx.strokeStyle = `rgba(62,168,255,${p.a})`;
    ctx.lineWidth = 1;
    hex(ctx, cx, cy, p.r, Math.PI / 6);
    ctx.stroke();
    return p.a > 0 && p.r < R * 2.4;
  });

  const gR = R * 1.7;
  const maxBps = Math.max(1e6, props.gauge.throughputMaxBps);
  const maxSess = Math.max(1, props.gauge.sessionMax);

  drawGauge(
    ctx,
    Math.PI * 1.2,
    Math.PI * 1.8,
    (dMbps * 1e6) / maxBps,
    gR,
    '34,211,166',
    `吞吐量 Mbps / ${fmtThroughputMax(maxBps)}`,
    props.snapshot?.metrics?.throughput?.bps != null ? dMbps.toFixed(0) : '—',
    cx,
    cy - gR - 18,
    false,
  );
  drawGauge(
    ctx,
    Math.PI * 0.8,
    Math.PI * 0.2,
    dSess / maxSess,
    gR,
    '160,120,255',
    `連線數 / ${fmtSessionMax(maxSess)}`,
    props.snapshot?.metrics?.session?.active != null ? Math.round(dSess).toLocaleString('zh-TW') : '—',
    cx,
    cy + gR + 30,
    true,
  );

  // 左右小指標:阻擋/分、新連線/秒
  const denyStr = props.kpis?.denyPerMin != null ? `${fmtNum(props.kpis.denyPerMin)}/分` : '—';
  const cpsStr = props.snapshot?.metrics?.throughput?.cps != null ? `${fmtNum(rawCps)}/s` : `${Math.round(props.rates.conn)}/s`;
  ctx.textAlign = 'center';
  ctx.font = 'bold 15px "Segoe UI", sans-serif';
  ctx.fillStyle = '#ff4d5e';
  ctx.fillText(denyStr, cx - gR - 6, cy - R * 1.9);
  ctx.fillStyle = '#6f86a8';
  ctx.font = '10px "Segoe UI", "Microsoft JhengHei", sans-serif';
  ctx.fillText('阻擋', cx - gR - 6, cy - R * 1.9 + 13);

  ctx.font = 'bold 15px "Segoe UI", sans-serif';
  ctx.fillStyle = '#3ea8ff';
  ctx.fillText(cpsStr, cx + gR + 6, cy - R * 1.9);
  ctx.fillStyle = '#6f86a8';
  ctx.font = '10px "Segoe UI", "Microsoft JhengHei", sans-serif';
  ctx.fillText('新連線', cx + gR + 6, cy - R * 1.9 + 13);

  // 環繞二進位字元流
  ctx.font = '9px Consolas, monospace';
  ctx.fillStyle = 'rgba(62,168,255,.35)';
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2 - t * 0.25;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * R * 1.58, cy + Math.sin(a) * R * 1.58);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText((i * 7 + Math.floor(t * 3)) % 5 > 2 ? '1' : '0', 0, 0);
    ctx.restore();
  }

  // 隨機電弧
  if (Math.random() < 0.25) {
    const a = Math.random() * Math.PI * 2;
    ctx.strokeStyle = 'rgba(180,220,255,.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let x = cx + Math.cos(a) * R * 0.62;
    let y = cy + Math.sin(a) * R * 0.62;
    ctx.moveTo(x, y);
    for (let k = 1; k <= 5; k++) {
      const rr = R * (0.62 + k * 0.11);
      x = cx + Math.cos(a + (Math.random() - 0.5) * 0.15) * rr;
      y = cy + Math.sin(a + (Math.random() - 0.5) * 0.15) * rr;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  rgb: [number, number, number],
  align: 'left' | 'right',
  isFocused: boolean,
  isHovered: boolean,
  isHex: boolean,
  isDangerPulse: boolean,
  isAtk: boolean,
  iconName: string,
  label: string,
  sizeFrac: number,
  conn5m: number,
  now: number,
) {
  const c = rgb.join(',');
  const a = props.focus === null || isFocused ? 1 : 0.22;

  // 阻擋比例高的紅色危險脈衝
  if (isDangerPulse) {
    for (let k = 0; k < 2; k++) {
      const ph = (now / 900 + k * 0.5) % 1;
      ctx.strokeStyle = `rgba(255,77,94,${(1 - ph) * 0.7 * a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + ph * 22, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 外圍旋轉光弧
  ctx.strokeStyle = `rgba(${c},${0.8 * a})`;
  ctx.lineWidth = 2;
  const ro = (now / 1500) * (align === 'right' ? 1 : -1);
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.arc(x, y, r + 5, ro + k * 2.09, ro + k * 2.09 + 1.2);
    ctx.stroke();
  }

  // 節點本體(服務六角形 / 其他圓形)
  ctx.shadowColor = `rgb(${c})`;
  ctx.shadowBlur = isHovered ? 25 : 12;
  const ng = ctx.createRadialGradient(x, y - r * 0.4, 1, x, y, r);
  ng.addColorStop(0, `rgba(${c},${0.45 * a})`);
  ng.addColorStop(1, `rgba(8,16,30,${0.95 * a})`);
  if (isHex) hex(ctx, x, y, r, 0);
  else {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = ng;
  ctx.fill();
  ctx.lineWidth = isHovered ? 2.5 : 1.5;
  ctx.strokeStyle = `rgba(${c},${a})`;
  ctx.stroke();
  ctx.shadowBlur = 0;

  drawIcon(ctx, iconName, x, y, r * 1.05, `rgba(${isAtk ? '255,200,200' : '230,242,255'},${a})`, 1.6);

  // 文字與長條
  const tx = x + (align === 'right' ? -r - 14 : r + 14);
  ctx.textAlign = align;
  ctx.fillStyle = `rgba(230,242,255,${a})`;
  ctx.font = 'bold 13px "Segoe UI", "Microsoft JhengHei", sans-serif';
  ctx.fillText((isAtk ? '⚠ ' : '') + label, tx, y - 2);

  const bw = Math.max(8, Math.min(90, sizeFrac * 85));
  const bx = align === 'right' ? tx - bw : tx;
  ctx.fillStyle = `rgba(${c},${0.7 * a})`;
  ctx.fillRect(bx, y + 5, bw, 3);

  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.fillStyle = `rgba(111,134,168,${a})`;
  ctx.fillText(`${fmtShort(conn5m)} conn/5m`, align === 'right' ? tx - bw - 6 : tx + bw + 6, y + 9);
}

function drawBursts(ctx: CanvasRenderingContext2D) {
  ctx.globalCompositeOperation = 'lighter';
  bursts = bursts.filter((b) => {
    b.r += 1;
    b.a -= 0.045;
    ctx.strokeStyle = `rgba(255,77,94,${b.a})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, Math.PI * 0.6, Math.PI * 1.4);
    ctx.stroke();
    for (let k = 0; k < 5; k++) {
      const an = Math.PI * 0.7 + k * Math.PI * 0.15;
      ctx.fillStyle = `rgba(255,140,120,${b.a})`;
      ctx.fillRect(b.x + Math.cos(an) * b.r * 1.4, b.y + Math.sin(an) * b.r * 1.4, 2, 2);
    }
    return b.a > 0;
  });
  ctx.globalCompositeOperation = 'source-over';
}

function renderFrame(ts: number) {
  if (typeof document !== 'undefined' && document.hidden) {
    rafId = 0;
    return;
  }
  const cv = canvasEl.value;
  const ctx = cv?.getContext?.('2d');
  if (!cv || !ctx) {
    // 還拿不到 context:下一幀重試,迴圈不會卡死
    rafId = requestAnimationFrame(renderFrame);
    return;
  }

  const dtSec = lastFrameTs ? Math.min(0.1, (ts - lastFrameTs) / 1000) : 0.016;
  lastFrameTs = ts;

  ctx.fillStyle = 'rgba(6,11,20,.38)';
  ctx.fillRect(0, 0, W, H);

  // 背景網格線
  ctx.strokeStyle = 'rgba(30,50,80,.15)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  const left = placedLeft.value;
  const right = placedRight.value;
  const f = props.focus;

  // 左側連線(來源 → 核心入口)
  left.forEach((s, i) => {
    const isFocused = !f || (f.side === 'source' && f.id === s.node.id);
    const w = 1 + s.node.size * 3.5;
    drawLink(ctx, s, ent(i), toneRgb(s.node.tone).join(','), w, 0.25 * (isFocused ? 1 : 0.12));
  });

  // 右側連線(核心出口 → 網段)
  right.forEach((d, j) => {
    const isFocused = !f || (f.side === 'segment' && f.id === d.node.id);
    const w = 1 + d.node.size * 3.5;
    drawLink(ctx, ext(j), d, '62,168,255', w, 0.25 * (isFocused ? 1 : 0.12));
  });

  // 粒子產生與移動
  spawnParticles(dtSec);
  parts = parts.filter((p) => {
    const srcP = left[p.si];
    const dstP = right[p.di];
    if (!srcP || !dstP) return false;
    p.t += p.sp;
    let pos: { x: number; y: number };
    let segAlpha = 1;

    const fo =
      !f ||
      (f.side === 'source' && f.id === srcP.node.id) ||
      (f.side === 'segment' && f.id === dstP.node.id && !p.deny);

    if (p.seg === 0) {
      pos = bez(srcP, ent(p.si), p.t);
      if (p.t >= 1) {
        if (p.deny) {
          burst(ent(p.si));
          return false;
        }
        p.seg = 1;
        p.t = 0;
      }
    } else if (p.seg === 1) {
      const a1 = ent(p.si);
      const b1 = ext(p.di);
      pos = { x: a1.x + (b1.x - a1.x) * p.t, y: a1.y + (b1.y - a1.y) * p.t };
      segAlpha = 0.5;
      if (p.t >= 1) {
        p.seg = 2;
        p.t = 0;
      }
    } else {
      pos = bez(ext(p.di), dstP, p.t);
      if (p.t >= 1) return false;
    }

    const c = p.deny ? '255,77,94' : p.threat ? '245,176,58' : p.seg === 2 ? '62,168,255' : '34,211,166';
    const al = segAlpha * (fo ? 1 : 0.08);
    ctx.globalCompositeOperation = 'lighter';
    if (p.px !== undefined && p.py !== undefined) {
      ctx.strokeStyle = `rgba(${c},${al * 0.45})`;
      ctx.lineWidth = p.threat ? 3 : 1.6;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    }
    p.px = pos.x;
    p.py = pos.y;
    const sz = p.threat ? 4 : 2;
    const gg = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, sz * 3);
    gg.addColorStop(0, `rgba(255,255,255,${al})`);
    gg.addColorStop(0.3, `rgba(${c},${al})`);
    gg.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, sz * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    return true;
  });

  drawBursts(ctx);
  drawCore(ctx, ts);

  // 繪製左右節點
  left.forEach((s, i) => {
    const isFocused = !!f && f.side === 'source' && f.id === s.node.id;
    const isHovered = hoverTarget.value?.side === 'source' && hoverTarget.value.index === i;
    drawNode(
      ctx,
      s.x,
      s.y,
      s.r,
      toneRgb(s.node.tone),
      'right',
      isFocused,
      isHovered,
      false,
      s.node.denyRatio > 0.6,
      s.node.kind === 'ip',
      sourceIcon(s.node),
      s.node.label,
      s.node.size,
      s.node.conn,
      ts,
    );
  });

  right.forEach((d, j) => {
    const isFocused = !!f && f.side === 'segment' && f.id === d.node.id;
    const isHovered = hoverTarget.value?.side === 'segment' && hoverTarget.value.index === j;
    const rgb: [number, number, number] = d.node.kind === 'service' ? [160, 120, 255] : [62, 168, 255];
    drawNode(
      ctx,
      d.x,
      d.y,
      d.r,
      rgb,
      'left',
      isFocused,
      isHovered,
      d.node.kind === 'service',
      false,
      false,
      segmentIcon(d.node),
      d.node.label,
      d.node.size,
      d.node.conn,
      ts,
    );
  });

  rafId = requestAnimationFrame(renderFrame);
}

function startLoop() {
  if (!rafId && typeof requestAnimationFrame === 'function') {
    lastFrameTs = 0;
    rafId = requestAnimationFrame(renderFrame);
  }
}

function stopLoop() {
  if (rafId && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function onVisibilityChange() {
  if (document.hidden) stopLoop();
  else startLoop();
}

function hitTest(offsetX: number, offsetY: number): { side: 'source' | 'segment'; index: number; id: string } | null {
  for (const [i, s] of placedLeft.value.entries()) {
    if (Math.hypot(s.x - offsetX, s.y - offsetY) < s.r + 8) {
      return { side: 'source', index: i, id: s.node.id };
    }
  }
  for (const [j, d] of placedRight.value.entries()) {
    if (Math.hypot(d.x - offsetX, d.y - offsetY) < d.r + 8) {
      return { side: 'segment', index: j, id: d.node.id };
    }
  }
  return null;
}

function coordsOf(e: MouseEvent): { x: number; y: number } {
  const cv = canvasEl.value;
  if (!cv) return { x: e.offsetX, y: e.offsetY };
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onMouseMove(e: MouseEvent) {
  const { x, y } = coordsOf(e);
  const h = hitTest(x, y);
  if (!h) {
    hoverTarget.value = null;
    return;
  }
  hoverTarget.value = { side: h.side, index: h.index, clientX: x, clientY: y };
}

function onMouseLeave() {
  hoverTarget.value = null;
}

function onCanvasClick(e: MouseEvent) {
  const { x, y } = coordsOf(e);
  const h = hitTest(x, y);
  if (!h) {
    emit('toggleFocus', null);
  } else {
    emit('toggleFocus', { side: h.side, id: h.id });
  }
}

function clickNodeButton(side: 'source' | 'segment', id: string) {
  emit('toggleFocus', { side, id });
}

const hoveredSource = computed(() =>
  hoverTarget.value?.side === 'source' ? (placedLeft.value[hoverTarget.value.index]?.node ?? null) : null,
);
const hoveredSegment = computed(() =>
  hoverTarget.value?.side === 'segment' ? (placedRight.value[hoverTarget.value.index]?.node ?? null) : null,
);
const tipStyle = computed(() => {
  if (!hoverTarget.value) return { display: 'none' };
  const left = Math.min(W - 220, Math.max(12, hoverTarget.value.clientX + 14));
  const top = Math.min(H - 130, Math.max(12, hoverTarget.value.clientY + 14));
  return { display: 'block', left: `${left}px`, top: `${top}px` };
});

onMounted(() => {
  updateLayout();
  window.addEventListener('resize', updateLayout);
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (typeof ResizeObserver !== 'undefined' && wrapEl.value) {
    resizeObs = new ResizeObserver(() => updateLayout());
    resizeObs.observe(wrapEl.value);
  }
  // 背景分頁開啟時不啟動,等 visibilitychange 再開始
  if (!document.hidden) startLoop();
});

onBeforeUnmount(() => {
  stopLoop();
  window.removeEventListener('resize', updateLayout);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  resizeObs?.disconnect();
  resizeObs = null;
  parts = [];
  bursts = [];
  ripples = [];
});
</script>

<template>
  <div ref="wrapEl" class="wr-canvas-wrap">
    <canvas
      id="c"
      ref="canvasEl"
      class="wr-canvas"
      @mousemove="onMouseMove"
      @mouseleave="onMouseLeave"
      @click="onCanvasClick"
    />

    <!-- 無障礙與測試用節點互動熱區(與 Canvas 節點同步，支援鍵盤與測試點擊) -->
    <div class="wr-canvas__a11y" aria-label="戰情室節點清單">
      <button
        v-for="(s, idx) in placedLeft"
        :key="s.node.id"
        type="button"
        class="wr-node-hit"
        :data-node-side="'source'"
        :data-node-id="s.node.id"
        :aria-pressed="focus?.side === 'source' && focus?.id === s.node.id"
        :aria-label="`來源節點 ${s.node.label}，5 分鐘連線 ${s.node.conn}`"
        :style="{ left: `${s.x - s.r}px`, top: `${s.y - s.r}px`, width: `${s.r * 2}px`, height: `${s.r * 2}px` }"
        @mouseenter="hoverTarget = { side: 'source', index: idx, clientX: s.x, clientY: s.y }"
        @mouseleave="hoverTarget = null"
        @click.stop="clickNodeButton('source', s.node.id)"
      />
      <button
        v-for="(d, idx) in placedRight"
        :key="d.node.id"
        type="button"
        class="wr-node-hit"
        :data-node-side="'segment'"
        :data-node-id="d.node.id"
        :aria-pressed="focus?.side === 'segment' && focus?.id === d.node.id"
        :aria-label="`網段節點 ${d.node.label}，5 分鐘連線 ${d.node.conn}`"
        :style="{ left: `${d.x - d.r}px`, top: `${d.y - d.r}px`, width: `${d.r * 2}px`, height: `${d.r * 2}px` }"
        @mouseenter="hoverTarget = { side: 'segment', index: idx, clientX: d.x, clientY: d.y }"
        @mouseleave="hoverTarget = null"
        @click.stop="clickNodeButton('segment', d.node.id)"
      />
    </div>

    <!-- 滑過節點明細 Tooltip(對照樣稿 #tip) -->
    <div id="tip" class="wr-tip" :style="tipStyle" role="tooltip">
      <template v-if="hoveredSource">
        <b>{{ hoveredSource.label }}</b>
        <span v-if="hoveredSource.country && hoveredSource.kind === 'ip'" class="wr-tip__cc">
          ({{ hoveredSource.country }})
        </span>
        <br />
        5 分鐘連線：{{ fmtNum(hoveredSource.conn) }}<br />
        阻擋比例：
        <span :class="hoveredSource.tone === 'deny' ? 'deny' : hoveredSource.tone === 'warn' ? 'threat' : 'allow'">
          {{ Math.round(hoveredSource.denyRatio * 100) }}%
        </span>
        <br />
        Top 目的：{{ hoveredSource.topDst.map((x) => x.key).join(', ') || '—' }}<br />
        Top App：{{ hoveredSource.topApp.map((x) => x.key).join(', ') || '—' }}
      </template>
      <template v-else-if="hoveredSegment">
        <b>{{ hoveredSegment.label }}</b><br />
        5 分鐘流量：{{ fmtSize(hoveredSegment.bytes) }}（{{ fmtBps((hoveredSegment.bytes * 8) / 300) }}）<br />
        連線數：{{ fmtNum(hoveredSegment.conn) }}<br />
        威脅命中：{{ fmtNum(hoveredSegment.threat) }}
      </template>
    </div>
  </div>
</template>

<style scoped>
.wr-canvas-wrap {
  position: absolute;
  top: 52px;
  left: 0;
  right: 0;
  bottom: 242px;
  overflow: hidden;
}
.wr-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
}
.wr-canvas__a11y {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.wr-node-hit {
  position: absolute;
  pointer-events: auto;
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
}
.wr-node-hit:focus-visible {
  outline: 2px solid #3ea8ff;
  outline-offset: 3px;
}
.wr-tip {
  position: absolute;
  pointer-events: none;
  background: rgba(11, 20, 36, 0.94);
  border: 1px solid #3ea8ff;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  color: #cfe3ff;
  line-height: 1.5;
  min-width: 190px;
  z-index: 15;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
}
.wr-tip__cc {
  color: #6f86a8;
  font-size: 11px;
}
.deny {
  color: #ff4d5e;
}
.allow {
  color: #22d3a6;
}
.threat {
  color: #f5b03a;
}
</style>
