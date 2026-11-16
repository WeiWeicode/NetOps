/**
 * 假 Gateway:AD 事件總覽(docs/API.md §6.1)。已匯入的日期取自 mock/ftp.ts 的 AD 資料夾(同步 / 刪除結果會反映在這裡)。
 */
import { adDays, adStatus } from './ftp.ts';
import type { MockCtx } from './types.ts';

const CHANNELS = { Security: '安全性', System: '系統', Directory_Service: '目錄服務', DNS_Server: 'DNS 伺服器' };
const SECURITY_EVENTS = {
  '4625': '登入失敗',
  '4740': '帳號鎖定',
  '4720': '建立帳號',
  '4728': '加入全域群組',
  '4771': 'Kerberos 預先驗證失敗',
  '4672': '特權登入',
};

const imported = () => adDays.filter((d) => d.state === 'done' || d.state === 'changed' || d.state === 'orphan');

function overview(from: string, to: string) {
  const days = imported().filter((d) => d.day >= from && d.day <= to);
  const n = days.length;
  const sec = days.reduce((a, d) => a + (d.files.find((f) => f.channel === 'Security')?.rows ?? 0), 0);
  const group = (channel: string, eventId: number, level: string, count: number, sample: string) => ({
    channel,
    eventId,
    level,
    provider: channel === 'Security' ? 'Microsoft-Windows-Security-Auditing' : 'Service Control Manager',
    n: count,
    first: `${from}T08:00:00+08:00`,
    last: `${to}T17:30:00+08:00`,
    sample,
    computers: ['GSMC-DC1'],
  });
  const fail = Math.round(sec * 0.006);
  const events = n
    ? [
        group('Security', 4624, 'audit_success', Math.round(sec * 0.7), '帳戶已成功登入'),
        group('Security', 4672, 'audit_success', Math.round(sec * 0.2), '特殊權限已指派給新登入'),
        group('Security', 4625, 'audit_failure', fail, '帳戶無法登入。失敗原因:使用者名稱或密碼錯誤'),
        group('Security', 4740, 'audit_success', n, '使用者帳戶已鎖定'),
        group('System', 7036, 'info', 380 * n, '服務進入執行狀態'),
        group('System', 1014, 'warning', 12 * n, '名稱解析逾時'),
        group('Directory_Service', 2887, 'warning', 2 * n, '有用戶端以未簽署的 LDAP 繫結'),
        group('DNS_Server', 4013, 'error', 1, 'DNS 伺服器正在等候 AD 初始同步'),
      ]
    : [];
  const issues = events.filter((e) => ['audit_failure', 'warning', 'error', 'critical'].includes(e.level) || e.eventId === 4740);
  const total = events.reduce((a, e) => a + e.n, 0);
  const byLevel: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  for (const e of events) {
    byLevel[e.level] = (byLevel[e.level] ?? 0) + e.n;
    byChannel[e.channel] = (byChannel[e.channel] ?? 0) + e.n;
  }
  return {
    from,
    to,
    days: n,
    total,
    byChannel,
    byLevel,
    timeMin: n ? `${days.at(-1)!.day}T00:00:01+08:00` : null,
    timeMax: n ? `${days[0]!.day}T23:59:59+08:00` : null,
    hours: [],
    events,
    issues,
    failAccounts: n
      ? [
          { key: 'S112009', n: Math.ceil(fail * 0.4) },
          { key: 'guest', n: Math.ceil(fail * 0.2) },
        ]
      : [],
    failIps: n
      ? [
          { key: '10.10.1.5', n: Math.ceil(fail * 0.5) },
          { key: '10.10.3.20', n: Math.ceil(fail * 0.1) },
        ]
      : [],
    failReasons: n
      ? [
          {
            key: '使用者名稱或密碼錯誤(0xC000006A)',
            n: fail,
            ips: [{ key: '10.10.1.5', n: Math.ceil(fail * 0.5) }],
            accounts: [{ key: 'S112009', n: Math.ceil(fail * 0.4) }],
          },
        ]
      : [],
    accountChanges: n
      ? [
          {
            time: `${to}T10:00:00+08:00`,
            eventId: 4720,
            action: '建立帳號',
            actor: 'GSMC\\admin',
            target: 'svc-backup2',
            group: '',
            privileged: false,
            computer: 'GSMC-DC1',
            recordId: '1001',
          },
          {
            time: `${to}T10:02:00+08:00`,
            eventId: 4728,
            action: '加入全域群組',
            actor: 'GSMC\\admin',
            target: 'svc-backup2',
            group: 'Domain Admins',
            privileged: true,
            computer: 'GSMC-DC1',
            recordId: '1002',
          },
          {
            time: `${from}T09:15:00+08:00`,
            eventId: 4724,
            action: '重設密碼',
            actor: 'GSMC\\helpdesk',
            target: 'S113001',
            group: '',
            privileged: false,
            computer: 'GSMC-DC1',
            recordId: '0987',
          },
        ]
      : [],
    privilegedChanges: n ? 1 : 0,
    accountsCreated: n ? 1 : 0,
    privLogons: n
      ? [
          { key: 'admin', n: 42 * n },
          { key: 'helpdesk', n: 8 * n },
        ]
      : [],
  };
}

/** 假的 AD 事件明細(依期間平均分布) */
function events(from: string, to: string) {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  const n = Math.min(240, Math.max(0, Math.round((b - a) / 600_000)));
  const KINDS = [
    {
      channel: 'Security',
      eventId: 4625,
      level: 'audit_failure',
      levelText: '稽核失敗',
      reason: '使用者名稱或密碼錯誤(0xC000006A)',
      message: '帳戶無法登入。\n失敗原因:使用者名稱或密碼錯誤',
    },
    { channel: 'Security', eventId: 4624, level: 'audit_success', levelText: '稽核成功', reason: '', message: '帳戶已成功登入。' },
    { channel: 'Security', eventId: 4728, level: 'audit_success', levelText: '稽核成功', reason: '', message: '成員已新增到啟用安全性的全域群組。' },
    { channel: 'System', eventId: 7036, level: 'info', levelText: '資訊', reason: '', message: '服務進入執行狀態。' },
    { channel: 'DNS_Server', eventId: 4013, level: 'error', levelText: '錯誤', reason: '', message: 'DNS 伺服器正在等候 AD 初始同步。' },
  ];
  return Array.from({ length: n }, (_, i) => {
    const k = KINDS[i % KINDS.length]!;
    const t = new Date(a + ((b - a) * i) / Math.max(1, n));
    const pad = (x: number) => String(x).padStart(2, '0');
    return {
      time: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}+08:00`,
      ...k,
      provider: k.channel === 'Security' ? 'Microsoft-Windows-Security-Auditing' : 'Service Control Manager',
      computer: 'GSMC-DC1',
      recordId: String(100000 + i),
      account: k.channel === 'Security' ? ['S112009', 'guest', 'S113001'][i % 3]! : '',
      domain: k.channel === 'Security' ? 'GSMC' : '',
      ip: k.eventId === 4625 ? '10.10.1.5' : '',
      workstation: k.eventId === 4625 ? 'PC01' : '',
      actor: k.eventId === 4728 ? 'GSMC\\admin' : '',
      target: k.eventId === 4728 ? 'svc-backup2' : '',
      group: k.eventId === 4728 ? 'Domain Admins' : '',
      privileged: k.eventId === 4728,
    };
  }).reverse();
}

export function handleAd({ method, path, url, need, send, fail, sendFile }: MockCtx): boolean {
  if (method === 'GET' && (path === '/api/netops/ad/events' || path === '/api/netops/ad/events/export')) {
    if (!need('netops.ad-log.read')) return true;
    const p = url.searchParams;
    const from = p.get('from') ?? '';
    const to = p.get('to') ?? '';
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
      return (fail(400, 'VALIDATION_FAILED', 'from / to 必須是 ISO 8601 含時區'), true);
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 31) return (fail(400, 'VALIDATION_FAILED', '期間最長 31 天'), true);
    const all = events(from, to);
    const ids = (p.get('eventId') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const q = (p.get('q') ?? '').toLowerCase();
    const rows = all.filter(
      (e) =>
        (!p.get('channel') || e.channel === p.get('channel')) &&
        (!p.get('level') || e.level === p.get('level')) &&
        (!ids.length || ids.includes(String(e.eventId))) &&
        (!p.get('account') || e.account.includes(p.get('account')!)) &&
        (!p.get('ip') || e.ip === p.get('ip')) &&
        (!q || `${e.message} ${e.reason}`.toLowerCase().includes(q)) &&
        (p.get('issueOnly') !== 'true' || ['audit_failure', 'warning', 'error', 'critical'].includes(e.level)),
    );
    if (path.endsWith('/export')) {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['時間', '記錄', '事件 ID', '等級', '來源', '主機', '帳號', '執行者', '對象', '群組', '來源 IP', '工作站', '原因', '訊息'];
      const lines = rows.map((e) =>
        [
          e.time,
          CHANNELS[e.channel as keyof typeof CHANNELS] ?? e.channel,
          e.eventId,
          e.levelText,
          e.provider,
          e.computer,
          e.account,
          e.actor,
          e.target,
          e.group,
          e.ip,
          e.workstation,
          e.reason,
          e.message,
        ]
          .map(esc)
          .join(','),
      );
      sendFile('text/csv; charset=utf-8', 'AD_log.csv', `\uFEFF${[head.map(esc).join(','), ...lines].join('\r\n')}`);
      return true;
    }
    const page = Math.max(1, Number(p.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(p.get('pageSize')) || 50));
    send(200, { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, scanned: all.length });
    return true;
  }
  if (method === 'GET' && path === '/api/netops/ad/days') {
    if (!need('netops.ad.read')) return true;
    send(200, {
      days: imported().map((d) => ({
        day: d.day,
        events: d.events ?? 0,
        importedAt: d.importedAt,
        files: d.files.map((f) => ({ name: f.name, channel: f.channel, rows: f.rows })),
      })),
      import: { running: adStatus.running, lastSyncAt: adStatus.lastSyncAt, lastSyncError: adStatus.lastSyncError ? '同步失敗,詳見 FTP Log 檔案頁' : '' },
      channels: CHANNELS,
      securityEvents: SECURITY_EVENTS,
    });
    return true;
  }
  if (method === 'GET' && path === '/api/netops/ad/overview') {
    if (!need('netops.ad.read')) return true;
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') || from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return (fail(400, 'VALIDATION_FAILED', 'from / to 格式錯誤'), true);
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > 92) return (fail(400, 'VALIDATION_FAILED', '期間最長 92 天'), true);
    send(200, overview(from, to));
    return true;
  }
  return false;
}
