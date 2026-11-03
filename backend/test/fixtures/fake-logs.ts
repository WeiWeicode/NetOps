/**
 * 假 log(AGENT.md §9:測試不用正式資料):固定亂數種子產生,每次內容相同。
 *   - PA TRAFFIC / THREAT:PAN-OS WebUI 匯出的 CSV 格式(第一列欄位名稱;含雙引號、逗號、私有 / 公網 IP、
 *     阻擋、外部連入、掃描、上傳到高風險管道、AI 應用等研判會用到的情況)
 */
import zlib from 'node:zlib';

/** 固定種子的亂數(mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]! };
}

const pad = (n: number) => String(n).padStart(2, '0');
const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const TRAFFIC_HEADER = [
  'Receive Time', 'Type', 'Threat/Content Type', 'Source address', 'Destination address', 'NAT Source IP', 'NAT Destination IP', 'Rule',
  'Source User', 'Application', 'Source Zone', 'Destination Zone', 'Inbound Interface', 'Outbound Interface', 'Source Port', 'Destination Port',
  'NAT Destination Port', 'IP Protocol', 'Action', 'Bytes', 'Bytes Sent', 'Bytes Received', 'Packets', 'Start Time', 'Elapsed Time (sec)',
  'Category', 'Source Country', 'Destination Country', 'Session End Reason', 'Risk of app', 'Category of app', 'Subcategory of app',
  'Technology of app', 'Source Hostname', 'Destination Hostname',
];

const APPS: [string, string, string, number][] = [
  // [app, subcategory, technology, risk]
  ['ssl', 'encrypted-tunnel', 'browser-based', 4],
  ['web-browsing', 'internet-utility', 'browser-based', 4],
  ['dns-base', 'infrastructure', 'network-protocol', 3],
  ['dropbox-base', 'file-sharing', 'browser-based', 4],
  ['google-drive-web', 'storage-backup', 'browser-based', 4],
  ['openai-chatgpt', 'artificial-intelligence', 'browser-based', 3],
  ['claude-base', 'artificial-intelligence', 'browser-based', 3],
  ['bittorrent', 'file-sharing', 'peer-to-peer', 5],
  ['ms-rdp', 'remote-access', 'client-server', 4],
  ['smtp-base', 'email', 'client-server', 5],
  ['incomplete', '', '', 1],
  ['ms-update', 'software-update', 'client-server', 4],
];
const INTERNAL = ['10.10.1.5', '10.10.1.6', '10.10.2.20', '10.10.130.66', '192.168.10.3', '172.16.5.9'];
const EXTERNAL = ['8.8.8.8', '1.1.1.1', '142.250.66.78', '104.18.32.7', '203.0.113.9', '198.51.100.23'];
const COUNTRIES: Record<string, string> = { '8.8.8.8': 'United States', '1.1.1.1': 'Australia', '142.250.66.78': 'United States', '104.18.32.7': 'Canada', '203.0.113.9': 'Russian Federation', '198.51.100.23': 'China' };
const country = (ip: string) => COUNTRIES[ip] ?? '10.0.0.0-10.255.255.255';
const RULES = ['Allow-Web', 'Allow-DNS', 'Deny-All', 'Inbound-RDP', 'Allow, Internal "Core"'];

/** 一天的 TRAFFIC log(day 為 'yyyy/MM/dd',time 從 00:00 起每列遞增) */
export function trafficCsv(day: string, rows: number, seed: number): string {
  const r = rng(seed);
  const out: (string | number)[][] = [TRAFFIC_HEADER];
  for (let i = 0; i < rows; i++) {
    const sec = Math.floor((i / rows) * 86399);
    const time = `${day} ${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
    const kind = r.int(10);
    const [app, subcat, tech, risk] = r.pick(APPS);
    let src = r.pick(INTERNAL);
    let dst = r.pick(EXTERNAL);
    let fromZone = 'trust';
    let toZone = 'untrust';
    let action = r.next() < 0.85 ? 'allow' : r.pick(['deny', 'drop', 'reset-both']);
    let dport = r.pick([443, 80, 53, 3389, 25, 8443]);
    if (kind === 0) {
      // 外部連入(部分允許)
      src = r.pick(EXTERNAL);
      dst = r.pick(INTERNAL);
      fromZone = 'untrust';
      toZone = 'dmz';
    } else if (kind === 1) {
      // 掃描:同一個外部來源打很多目的與 Port,被擋
      src = '203.0.113.66';
      dst = `10.10.${r.int(4)}.${r.int(250) + 1}`;
      dport = r.int(1024) + 1;
      fromZone = 'untrust';
      toZone = 'trust';
      action = 'deny';
    } else if (kind === 2) {
      dst = r.pick(INTERNAL);
      toZone = 'trust';
    }
    const sent = r.int(500000);
    const recv = r.int(2000000);
    out.push([
      time, 'TRAFFIC', action === 'allow' ? 'end' : 'deny', src, dst, kind === 3 ? '61.220.1.2' : '', kind === 0 ? '10.10.9.9' : '', r.pick(RULES),
      r.next() < 0.3 ? `gsmc\\s11${pad(r.int(99))}009` : '', app, fromZone, toZone, 'ethernet1/1', 'ethernet1/2', 1024 + r.int(60000), dport,
      0, r.pick(['tcp', 'udp', 'icmp']), action, sent + recv, sent, recv, 1 + r.int(400), time, r.int(600),
      r.pick(['any', 'computer-and-internet-info', 'business-and-economy']), country(src), country(dst),
      r.pick(['tcp-fin', 'aged-out', 'policy-deny', 'tcp-rst-from-client']), risk, 'general-internet', subcat, tech,
      r.next() < 0.2 ? `PC-${r.int(50)}` : '', '',
    ]);
  }
  return csv(out);
}

const THREAT_HEADER = [
  'Receive Time', 'Type', 'Threat/Content Type', 'Source address', 'Destination address', 'NAT Source IP', 'NAT Destination IP', 'Rule',
  'Source User', 'Application', 'Source Zone', 'Destination Zone', 'Destination Port', 'IP Protocol', 'Action', 'URL/Filename',
  'Threat/Content Name', 'Category', 'Severity', 'Direction', 'Source Country', 'Destination Country', 'Repeat Count', 'thr_category',
  'filedigest', 'filetype',
];

/** 一天的 THREAT log(威脅、URL 過濾等其他類型共用格式) */
export function threatCsv(day: string, rows: number, seed: number, subtype = 'vulnerability'): string {
  const r = rng(seed);
  const out: (string | number)[][] = [THREAT_HEADER];
  for (let i = 0; i < rows; i++) {
    const sec = Math.floor((i / rows) * 86399);
    const time = `${day} ${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
    const src = r.next() < 0.5 ? r.pick(EXTERNAL) : r.pick(INTERNAL);
    const dst = r.pick(INTERNAL);
    out.push([
      time, 'THREAT', subtype, src, dst, '', '', r.pick(RULES), '', r.pick(['web-browsing', 'ssl', 'smb']), 'untrust', 'trust', r.pick([80, 443, 445]),
      'tcp', r.pick(['alert', 'reset-both', 'drop']), r.next() < 0.5 ? `www.example${r.int(5)}.com/path?q=${r.int(9)}` : '',
      r.pick(['SMB Brute Force(40004)', 'HTTP SQL Injection(30000)', 'Log4j RCE(91991)', 'Suspicious, "quoted" name(1)']),
      r.pick(['any', 'hacking', 'malware']), r.pick(['critical', 'high', 'medium', 'low', 'informational']),
      r.pick(['client-to-server', 'server-to-client']), country(src), country(dst), 1 + r.int(5), r.pick(['brute-force', 'code-execution', 'sql-injection']),
      '', '',
    ]);
  }
  return csv(out);
}

export const gz = (text: string) => zlib.gzipSync(text);
