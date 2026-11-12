/**
 * 假 Gateway:安全事件(docs/API.md §4.2)。類型與 KPI / 排行的鍵值比照後端 server/lib/paevents.js,數字為假資料。
 */
import type { MockCtx } from './types.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lastDays = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i - 1);
    return ymd(d);
  });

const TYPES = [
  // C3 D43:威脅類在 ClickHouse(files 為有資料的小時數),GlobalProtect 仍是 FTP
  { type: 'threat', label: '威脅', dir: '/threat', source: 'clickhouse', files: 144, rows: 52_000, days: lastDays(6) },
  { type: 'url', label: 'URL 過濾', dir: '/url', source: 'clickhouse', files: 144, rows: 1_830_000, days: lastDays(6) },
  { type: 'globalprotect', label: 'GlobalProtect VPN', dir: '/globalprotect', source: 'ftp', files: 6, rows: 3_400, days: lastDays(6) },
  { type: 'wildfire', label: 'WildFire', dir: '/wildfire', source: 'clickhouse', files: 0, rows: 0, days: [] as string[] },
];

const items = (list: [string, number][], k = 1) => list.map(([key, n]) => ({ key, n: Math.round(n * k) }));

function detail(type: string, k: number) {
  if (type === 'threat')
    return {
      kpis: [
        {
          key: 'severity',
          title: '嚴重度',
          items: items(
            [
              ['critical', 12],
              ['high', 140],
              ['medium', 900],
              ['low', 3000],
              ['informational', 4600],
            ],
            k,
          ),
        },
        {
          key: 'action',
          title: '動作',
          items: items(
            [
              ['alert', 7000],
              ['reset-both', 1300],
              ['drop', 300],
            ],
            k,
          ),
        },
      ],
      tops: [
        {
          key: 'highName',
          title: '高風險威脅',
          items: items(
            [
              ['Microsoft Windows SMB Remote Code Execution', 40],
              ['Apache Log4j RCE Attempt', 22],
            ],
            k,
          ),
        },
        {
          key: 'extSrc',
          title: '外部來源 IP',
          items: items(
            [
              ['203.0.113.45', 820],
              ['198.51.100.7', 310],
              ['192.0.2.200', 95],
            ],
            k,
          ),
        },
        {
          key: 'name',
          title: '威脅名稱',
          items: items(
            [
              ['HTTP Directory Traversal', 300],
              ['SSH Brute Force', 210],
              ['DNS ANY Query', 120],
            ],
            k,
          ),
        },
        {
          key: 'dst',
          title: '目的 IP',
          items: items(
            [
              ['10.10.130.66', 500],
              ['10.10.1.20', 140],
            ],
            k,
          ),
        },
      ],
    };
  if (type === 'url')
    return {
      kpis: [
        {
          key: 'action',
          title: '動作',
          items: items(
            [
              ['alert', 1_700_000],
              ['block-url', 120_000],
              ['continue', 10_000],
            ],
            k,
          ),
        },
        {
          key: 'category',
          title: '類別',
          items: items(
            [
              ['business-and-economy', 600_000],
              ['computer-and-internet-info', 420_000],
              ['malware', 30],
              ['phishing', 12],
            ],
            k,
          ),
        },
      ],
      tops: [
        {
          key: 'blockHost',
          title: '被封鎖的網站',
          items: items(
            [
              ['ads.example.net', 42_000],
              ['tracker.example.org', 21_000],
            ],
            k,
          ),
        },
        {
          key: 'blockSrc',
          title: '被封鎖最多的來源 IP',
          items: items(
            [
              ['10.10.3.20', 8_000],
              ['10.10.5.11', 4_200],
            ],
            k,
          ),
        },
        {
          key: 'host',
          title: '網站',
          items: items(
            [
              ['www.example.com', 120_000],
              ['cdn.example.net', 98_000],
            ],
            k,
          ),
        },
      ],
    };
  return {
    kpis: [
      {
        key: 'status',
        title: '結果',
        items: items(
          [
            ['success', 3_200],
            ['failure', 200],
          ],
          k,
        ),
      },
    ],
    tops: [
      {
        key: 'failUser',
        title: '登入失敗的帳號',
        items: items(
          [
            ['S112009', 40],
            ['guest', 12],
          ],
          k,
        ),
      },
      {
        key: 'failIp',
        title: '登入失敗的來源 IP',
        items: items(
          [
            ['203.0.113.9', 55],
            ['198.51.100.33', 8],
          ],
          k,
        ),
      },
      {
        key: 'user',
        title: '連線帳號',
        items: items(
          [
            ['S113001', 220],
            ['S112009', 180],
          ],
          k,
        ),
      },
    ],
  };
}

export function handlePaEvents({ method, path, url, need, send, fail }: MockCtx): boolean {
  if (method === 'GET' && path === '/api/netops/pa-events/types') {
    if (!need('netops.pa.read')) return true;
    send(200, { types: TYPES.map((t) => ({ ...t, coverage: t.days.length ? { from: [...t.days].sort()[0], to: [...t.days].sort().at(-1) } : null })) });
    return true;
  }
  if (method === 'GET' && path === '/api/netops/pa-events/overview') {
    if (!need('netops.pa.read')) return true;
    const t = TYPES.find((x) => x.type === url.searchParams.get('type'));
    if (!t) return (fail(400, 'VALIDATION_FAILED', 'type 不正確'), true);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') || from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return (fail(400, 'VALIDATION_FAILED', 'from / to 格式錯誤'), true);
    const days = t.days.filter((d) => d >= from && d <= to).sort();
    const k = days.length;
    const hours = days.flatMap((d) =>
      Array.from({ length: 24 }, (_, h) => ({ hour: `${d}T${pad(h)}:00:00+08:00`, n: Math.round((t.rows / 6 / 24) * (0.4 + Math.sin(h / 3.8) ** 2)) })),
    );
    send(200, {
      type: t.type,
      label: t.label,
      from,
      to,
      files: t.source === 'clickhouse' ? k * 24 : k,
      source: t.source,
      ...(t.source === 'clickhouse' ? { coverage: { from: t.days.at(-1), to: t.days[0] }, partial: !!t.days.length && from < t.days.at(-1)!, topsState: 'ok', topsUntil: `${to}T23:00:00+08:00` } : {}),
      // 最舊的一天模擬「排行還沒建好」,看得到結果不完整的提示
      missing: days.includes(t.days.at(-1)!) ? 1 : 0,
      import: { busy: false, failed: 0 },
      rows: Math.round((t.rows / 6) * k),
      timeMin: k ? `${days[0]}T00:00:03+08:00` : null,
      timeMax: k ? `${days.at(-1)}T23:59:41+08:00` : null,
      hours,
      ...detail(t.type, k / 6),
    });
    return true;
  }
  return false;
}
