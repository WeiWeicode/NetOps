/**
 * 假 Gateway:IP 對照表(docs/API.md §11;IMPL-PLAN AC3)。資料只在記憶體;姓名都是假的。
 *   - /api/netops/ip-names*、/ip-name-imports*、/ip-name-template
 *   - withNames:PA API 的回應附 names(只含回應出現的 IP;範圍小的優先),gateway.ts 的 send 呼叫
 * 匯入只解析 CSV(Excel 只回固定預覽,看畫面用)。
 */
import { randomUUID } from 'node:crypto';
import type { MockCtx } from './types.ts';

interface Entry {
  id: string;
  ip: string;
  name: string;
  department: string;
  device: string;
  deviceType: string;
  note: string;
  updatedAt: string;
  updatedBy: string;
}
const COLUMNS = ['IP或網段', '使用者姓名', '部門', '設備名稱', '設備類型', '備註'];
const at = '2026-11-13T09:30:00+08:00';
const mk = (ip: string, name: string, department: string, device: string, deviceType: string, note = ''): Entry => ({ id: randomUUID(), ip, name, department, device, deviceType, note, updatedAt: at, updatedBy: 'S112009 測試人員' });
let entries: Entry[] = [
  mk('10.10.1.5', '王小明', '資訊處', 'IT-NB-001', '筆電'),
  mk('10.10.3.20', '陳美玲', '財務部', 'FIN-PC-07', '桌機'),
  mk('10.10.112.74', '', '資訊處', '網管監控主機', '伺服器', '機房 A 櫃'),
  mk('10.10.130.66', '', '資訊處', 'FTP 伺服器', '伺服器', 'PA / AD log 匯出'),
  mk('10.0.0.0/24', '', '研發中心', '研發網段', '網路設備'),
  mk('10.0.0.97', '林志豪(很長的名字測試截斷效果)', '研發中心第二實驗室', 'RD-WS-97', '桌機', '借用至 12 月'),
];
const imports = new Map<string, Entry[]>();

const n = (ip: string) => ip.split('.').reduce((x, p) => x * 256 + Number(p), 0);
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
function lookup(ip: string): Entry | undefined {
  let best: { e: Entry; bits: number } | undefined;
  for (const e of entries) {
    const [base = '', b = '32'] = e.ip.split('/');
    const bits = Number(b);
    const size = 2 ** (32 - bits);
    if (Math.floor(n(ip) / size) === Math.floor(n(base) / size) && (!best || bits > best.bits)) best = { e, bits };
  }
  return best?.e;
}

/** PA API 回應附 names(同後端 attach:只含回應出現的 IP) */
export function withNames(path: string, body: unknown): unknown {
  if (!/^\/api\/netops\/(pa|pa-live|pa-events|pa-query)\//.test(path) || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const ips = new Set<string>();
  const walk = (v: unknown, d: number) => {
    if (d > 12) return;
    if (typeof v === 'string' && IPV4.test(v)) ips.add(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, d + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, d + 1));
  };
  walk(body, 0);
  const names: Record<string, unknown> = {};
  for (const ip of ips) {
    const e = lookup(ip);
    if (e) names[ip] = { name: e.name, department: e.department, device: e.device, deviceType: e.deviceType };
  }
  return { ...(body as object), names };
}

function parseCsv(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
}

export function handleIpNames({ method, path, url, body, need, send, fail, sendFile, user }: MockCtx): boolean {
  if (!/^\/api\/netops\/ip-name/.test(path)) return false;
  const read = () => need('netops.ip-name.read');
  const write = () => need('netops.ip-name.write');
  if (path === '/api/netops/ip-name-template') {
    if (read()) sendFile('text/csv; charset=utf-8', 'IP對照表_範本.csv', `﻿${COLUMNS.join(',')}\r\n192.0.2.10,王小明(範例),資訊處,IT-NB-001,筆電,範例列\r\n`);
    return true;
  }
  if ((path === '/api/netops/ip-names' && method === 'GET') || (path === '/api/netops/ip-name-searches' && method === 'POST')) {
    if (!read()) return true;
    if (method === 'POST') for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) url.searchParams.set(k, String(v));
    const format = url.searchParams.get('format');
    const all = [...entries].sort((a, b) => n(a.ip.split('/')[0]!) - n(b.ip.split('/')[0]!));
    if (format === 'csv' || format === 'xlsx') {
      sendFile('text/csv; charset=utf-8', 'IP對照表.csv', `﻿${[COLUMNS.join(','), ...all.map((e) => [e.ip, e.name, e.department, e.device, e.deviceType, e.note].join(','))].join('\r\n')}`);
      return true;
    }
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const hit = q ? all.filter((e) => [e.ip, e.name, e.department, e.device, e.deviceType, e.note].some((v) => v.toLowerCase().includes(q))) : all;
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Number(url.searchParams.get('pageSize')) || 50);
    send(200, { items: hit.slice((page - 1) * pageSize, page * pageSize), total: hit.length, page, pageSize, version: 1 });
    return true;
  }
  if (path === '/api/netops/ip-names' && method === 'POST') {
    if (!write()) return true;
    const b = body as Partial<Entry>;
    if (!b?.ip || !/^[\d.]+(\/\d{1,2})?$/.test(b.ip)) return (fail(400, 'VALIDATION_FAILED', '不是合法的 IPv4 或網段'), true);
    if (entries.some((e) => e.ip === b.ip)) return (fail(409, 'NETOPS_IP_NAME_DUPLICATE', '對照表已有這個 IP / 網段'), true);
    const e = { ...mk(b.ip, b.name ?? '', b.department ?? '', b.device ?? '', b.deviceType ?? '', b.note ?? ''), updatedBy: user, updatedAt: new Date().toISOString() };
    entries.push(e);
    send(201, e);
    return true;
  }
  const one = path.match(/^\/api\/netops\/ip-names\/([^/]+)$/);
  if (one && method === 'PUT') {
    if (!write()) return true;
    const i = entries.findIndex((e) => e.id === one[1]);
    if (i < 0) return (fail(404, 'NETOPS_IP_NAME_NOT_FOUND', '找不到這筆對照'), true);
    entries[i] = { ...entries[i]!, ...(body as Partial<Entry>), updatedBy: user, updatedAt: new Date().toISOString() };
    send(200, entries[i]);
    return true;
  }
  if (one && method === 'DELETE') {
    if (write()) {
      entries = entries.filter((e) => e.id !== one[1]);
      send(204, null);
    }
    return true;
  }
  if (path === '/api/netops/ip-name-imports' && method === 'POST') {
    if (!write()) return true;
    const b = body as { fileName: string; format: string; data: string };
    const rows = b.format === 'csv' ? parseCsv(Buffer.from(b.data, 'base64').toString('utf8')) : [COLUMNS, ['10.10.1.5', '王小明', '資訊處', 'IT-NB-002', '筆電', ''], ['10.10.9.9', '新同仁', '業務部', 'SA-NB-01', '筆電', ''], ['bad-ip', '', '', '', '', '']];
    if (rows[0]?.[0] !== COLUMNS[0]) return (fail(400, 'NETOPS_IP_NAME_IMPORT_INVALID', `第一列必須是欄名:${COLUMNS.join('、')}(請用頁面提供的範本)`), true);
    const errors: { row: number; ip: string; message: string }[] = [];
    const next: Entry[] = [];
    rows.slice(1).forEach((r, i) => {
      if (!/^[\d.]+(\/\d{1,2})?$/.test(r[0] ?? '')) return errors.push({ row: i + 2, ip: r[0] ?? '', message: '不是合法的 IPv4 或網段' });
      const old = entries.find((e) => e.ip === r[0]);
      next.push({ ...(old ?? mk(r[0]!, '', '', '', '')), name: r[1] ?? '', department: r[2] ?? '', device: r[3] ?? '', deviceType: r[4] ?? '', note: r[5] ?? '' });
    });
    const same = (a: Entry, b: Entry) => a.name === b.name && a.department === b.department && a.device === b.device && a.deviceType === b.deviceType && a.note === b.note;
    const added = next.filter((e) => !entries.some((o) => o.ip === e.ip));
    const changed = next.flatMap((e) => {
      const o = entries.find((x) => x.ip === e.ip);
      return o && !same(o, e) ? [{ before: o, after: e }] : [];
    });
    const removed = entries.filter((o) => !next.some((e) => e.ip === o.ip));
    const unchanged = next.length - added.length - changed.length;
    const id = randomUUID();
    imports.set(id, next);
    send(200, {
      id, fileName: b.fileName, total: next.length, skipped: 0, errors,
      counts: { added: added.length, changed: changed.length, removed: removed.length, unchanged },
      diff: { added, changed, removed, unchanged },
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    return true;
  }
  const imp = path.match(/^\/api\/netops\/ip-name-imports\/([^/]+)(\/confirm)?$/);
  if (imp && method === 'POST' && imp[2]) {
    if (!write()) return true;
    const next = imports.get(imp[1]!);
    if (!next) return (fail(404, 'NETOPS_IP_NAME_IMPORT_NOT_FOUND', '找不到這次匯入預覽(可能已逾期 15 分鐘),請重新上傳'), true);
    const before = entries;
    entries = next;
    imports.delete(imp[1]!);
    send(200, { added: next.filter((e) => !before.some((o) => o.ip === e.ip)).length, changed: 0, removed: before.filter((o) => !next.some((e) => e.ip === o.ip)).length, unchanged: 0, total: next.length });
    return true;
  }
  if (imp && method === 'DELETE') {
    imports.delete(imp[1]!);
    send(204, null);
    return true;
  }
  return false;
}
