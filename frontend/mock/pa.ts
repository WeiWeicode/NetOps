/**
 * 假 Gateway:流量總覽(docs/API.md §4.1)。排行鍵值同後端 palog 摘要,數字為假資料。
 */
import type { MockCtx } from './types.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAYS = Array.from({ length: 7 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - i - 1);
  return { day: ymd(d), files: 4, rows: 1_830_000 - i * 12_345 };
});
const MB = 1024 * 1024;

type Row = [key: string, n: number, mb?: number];
const t = (list: Row[], k: number) => list.map(([key, n, mb]) => ({ key, n: Math.round(n * k), bytes: Math.round((mb ?? n / 1000) * MB * k) }));

function overview(from: string, to: string) {
  const days = DAYS.filter((d) => d.day >= from && d.day <= to).sort((a, b) => a.day.localeCompare(b.day));
  const k = days.length;
  const rows = days.reduce((a, d) => a + d.rows, 0);
  const block = Math.round(rows * 0.03);
  const hours = days.flatMap((d) =>
    Array.from({ length: 24 }, (_, h) => {
      const n = Math.round((d.rows / 24) * (0.3 + 1.4 * Math.sin(((h - 6) / 24) * Math.PI) ** 2));
      const b = Math.round(n * (h < 7 ? 0.08 : 0.025));
      return { hour: `${d.day}T${pad(h)}:00:00+08:00`, n, allow: n - b, block: b, bytes: n * 18_000 };
    }),
  );
  const top: Record<string, { key: string; n: number; bytes: number }[]> = {
    src: t(
      [
        ['10.10.1.5', 120_000, 3_400],
        ['10.10.3.20', 90_000, 820],
        ['10.10.112.74', 61_000, 12_000],
      ],
      k,
    ),
    dst: t(
      [
        ['8.8.8.8', 80_000, 40],
        ['10.10.130.66', 70_000, 9_800],
        ['20.190.1.10', 31_000, 2_200],
      ],
      k,
    ),
    app: t(
      [
        ['ssl', 900_000, 120_000],
        ['dns-base', 300_000, 200],
        ['web-browsing', 120_000, 8_000],
      ],
      k,
    ),
    dport: t(
      [
        ['tcp/443', 1_000_000],
        ['udp/53', 300_000],
        ['tcp/445', 12_000],
      ],
      k,
    ),
    zone: t(
      [
        ['trust → untrust', 1_500_000],
        ['untrust → dmz', 40_000],
        ['? → trust', 10],
      ],
      k,
    ),
    dstCountry: t(
      [
        ['United States', 600_000],
        ['Taiwan', 400_000],
        ['10.0.0.0-10.255.255.255', 300_000],
      ],
      k,
    ),
    upSrc: t(
      [
        ['10.10.1.5', 2_000, 9_200],
        ['10.10.8.8', 300, 2_100],
      ],
      k,
    ),
    upRiskSrc: t([['10.10.112.74', 400, 4_100]], k),
    upRiskPair: t(
      [
        ['10.10.112.74 → dropbox-base', 300, 3_000],
        ['10.10.112.74 → ssh', 100, 1_100],
      ],
      k,
    ),
    upRiskApp: t(
      [
        ['dropbox-base(檔案分享)', 300, 3_000],
        ['ssh(加密通道)', 100, 1_100],
      ],
      k,
    ),
    upDst: t([['162.125.1.1(Dropbox)', 300, 3_000]], k),
    aiSrc: t(
      [
        ['10.10.112.74', 800, 60],
        ['10.10.4.4', 200, 12],
      ],
      k,
    ),
    aiPair: t(
      [
        ['10.10.112.74 → openai-chatgpt', 600, 40],
        ['10.10.112.74 → google-gemini', 200, 20],
      ],
      k,
    ),
    aiApp: t(
      [
        ['openai-chatgpt', 900, 52],
        ['google-gemini', 220, 21],
      ],
      k,
    ),
    blockSrc: t(
      [
        ['10.10.3.20', 20_000],
        ['203.0.113.45', 8_000],
      ],
      k,
    ),
    blockDst: t([['10.10.130.66', 6_000]], k),
    blockDport: t(
      [
        ['tcp/445', 9_000],
        ['tcp/3389', 2_000],
      ],
      k,
    ),
    inboundBlockSrc: t(
      [
        ['203.0.113.45(CN)', 8_000],
        ['198.51.100.7(RU)', 3_000],
      ],
      k,
    ),
    inboundAllow: t([['198.51.100.20 → 10.10.20.5:tcp/443', 4_000]], k),
    riskApp: t(
      [
        ['ms-rdp(風險 4)', 300, 100],
        ['teamviewer(風險 4)', 80, 30],
      ],
      k,
    ),
    blockRule: t(
      [
        ['Deny-All', 30_000],
        ['Block-SMB-Out', 9_000],
      ],
      k,
    ),
    rule: t(
      [
        ['Allow-Web', 1_300_000],
        ['Allow-DNS', 300_000],
      ],
      k,
    ),
    endReason: t(
      [
        ['tcp-fin', 900_000],
        ['aged-out', 500_000],
        ['policy-deny', 40_000],
      ],
      k,
    ),
  };
  return {
    from,
    to,
    files: k * 4,
    missing: 0,
    // 期間超過 3 天時模擬 1 個檔案分析失敗,看得到結果不完整的提示
    import: { busy: false, failed: k > 3 ? 1 : 0 },
    rows,
    allow: rows - block,
    block,
    bytes: rows * 18_000,
    sent: rows * 3_000,
    recv: rows * 15_000,
    timeMin: k ? `${days[0]!.day}T00:00:01+08:00` : null,
    timeMax: k ? `${days.at(-1)!.day}T23:59:58+08:00` : null,
    hours,
    actions: { allow: rows - block, deny: Math.round(block * 0.8), drop: Math.round(block * 0.15), 'reset-both': Math.round(block * 0.05) },
    subtypes: { end: rows - block, deny: block },
    top,
    topBytes: Object.fromEntries(Object.entries(top).map(([key, v]) => [key, [...v].sort((a, b) => b.bytes - a.bytes)])),
    scan: k
      ? [
          { src: '203.0.113.45', n: 8_000, dsts: 1200, ports: 3, zone: 'untrust → trust' },
          { src: '10.10.3.20', n: 20_000, dsts: 40, ports: 180, zone: 'trust → untrust' },
          { src: '10.10.9.9', n: 900, dsts: 25, ports: 2, zone: 'trust → dmz' },
        ]
      : [],
  };
}

export function handlePa({ method, path, url, need, send, fail }: MockCtx): boolean {
  if (method === 'GET' && path === '/api/netops/pa/days') {
    if (!need('netops.pa.read')) return true;
    send(200, { days: DAYS, import: { busy: false, total: 0, done: 0, failed: 0, queued: 0 } });
    return true;
  }
  if (method === 'GET' && path === '/api/netops/pa/overview') {
    if (!need('netops.pa.read')) return true;
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') || from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return (fail(400, 'VALIDATION_FAILED', 'from / to 格式錯誤'), true);
    send(200, overview(from, to));
    return true;
  }
  return false;
}
