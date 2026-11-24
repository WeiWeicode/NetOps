/**
 * 假 Gateway:AD 事件總覽(docs/API.md §6.1)。已匯入的日期取自 mock/ftp.ts 的 AD 資料夾(同步 / 刪除結果會反映在這裡)。
 */
import { adDays, adStatus } from './ftp.ts';
import type { MockCtx } from './types.ts';

const MOCK_NAMES: Record<string, { name: string; department: string; device: string; deviceType: string }> = {
  '10.10.1.5': { name: '王小明', department: '資訊處', device: 'NB-IT05', deviceType: '筆電' },
  '10.10.3.20': { name: '陳美玲', department: '財務部', device: 'PC-FIN20', deviceType: '桌機' },
};

const MOCK_AGENTS = () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    items: [
      {
        computer: 'GSMC-DC1',
        dcDomain: 'gsmc.com.tw',
        state: 'ok',
        updatedAt: iso(now - 12_000),
        ageSec: 12,
        reportedAt: iso(now - 13_000),
        agentVersion: '0.1.0',
        watchdogVersion: '0.1.0',
        received: 48_320,
        agent: {
          pid: 4120,
          serviceState: 'running',
          startType: 'auto',
          statusOk: true,
          lastCollectTickAt: iso(now - 2_000),
          lastSendOkAt: iso(now - 5_000),
          lastError: '',
          restarts24h: 0,
          cpuPct: 0.4,
          rssMb: 9.6,
          pendingEvents: 0,
          skippedEvents: 0,
          sendRejectStreak: 0,
        },
        channels: {
          Security: { lastRecordId: 985_412, logEpoch: 0, fileSizeMb: 122.4, maxSizeMb: 128, oldestEventAt: iso(now - 18.5 * 3600_000), coverageHours: 18.5, wrapRisk: true },
          System: { lastRecordId: 45_210, logEpoch: 0, fileSizeMb: 14.2, maxSizeMb: 64, oldestEventAt: null, coverageHours: null, wrapRisk: null },
          Directory_Service: { lastRecordId: 12_880, logEpoch: 0, fileSizeMb: 8.1, maxSizeMb: 64, oldestEventAt: null, coverageHours: null, wrapRisk: null },
          DNS_Server: { lastRecordId: 8_310, logEpoch: 0, fileSizeMb: 5.5, maxSizeMb: 64, oldestEventAt: null, coverageHours: null, wrapRisk: null },
        },
        events: [
          { type: 'agent_restarted', cause: 'hung', detail: '採集迴圈停滯 95 秒,已重新啟動', at: iso(now - 3 * 3600_000), receivedAt: iso(now - 3 * 3600_000 + 3_000) },
        ],
      },
      {
        computer: 'GSMC-DC2',
        dcDomain: 'gsmc.com.tw',
        state: 'stale',
        updatedAt: iso(now - 125_000),
        ageSec: 125,
        reportedAt: iso(now - 126_000),
        agentVersion: '0.1.0',
        watchdogVersion: '0.1.0',
        received: 31_045,
        agent: {
          pid: 3880,
          serviceState: 'running',
          startType: 'auto',
          statusOk: true,
          lastCollectTickAt: iso(now - 125_000),
          lastSendOkAt: iso(now - 130_000),
          lastError: '後端回應 HTTP 503 NETOPS_AD_UNAVAILABLE',
          restarts24h: 1,
          cpuPct: 0.6,
          rssMb: 10.4,
          pendingEvents: 12,
          skippedEvents: 0,
          sendRejectStreak: 0,
        },
        channels: {
          Security: { lastRecordId: 612_004, logEpoch: 0, fileSizeMb: 64.0, maxSizeMb: 128, oldestEventAt: iso(now - 42 * 3600_000), coverageHours: 42.0, wrapRisk: false },
        },
        events: [
          { type: 'agent_service_stopped', cause: 'stopped', detail: 'NetOpsAdAgent 服務停止,Watchdog 已恢復為自動啟動並拉起', at: iso(now - 5 * 3600_000), receivedAt: iso(now - 5 * 3600_000 + 2_000) },
        ],
      },
      {
        computer: 'GSC-DC1',
        dcDomain: 'gsc.com.tw',
        state: 'offline',
        updatedAt: iso(now - 720_000),
        ageSec: 720,
        reportedAt: iso(now - 721_000),
        agentVersion: '0.1.0',
        watchdogVersion: '0.1.0',
        received: 12_900,
        agent: {
          pid: null,
          serviceState: 'stopped',
          startType: 'manual',
          statusOk: false,
          lastCollectTickAt: iso(now - 720_000),
          lastSendOkAt: iso(now - 730_000),
          lastError: '',
          restarts24h: 0,
          cpuPct: null,
          rssMb: null,
          pendingEvents: null,
          skippedEvents: 0,
          sendRejectStreak: 0,
        },
        channels: {
          Security: { lastRecordId: 210_110, logEpoch: 1, fileSizeMb: 50.0, maxSizeMb: 128, oldestEventAt: iso(now - 36 * 3600_000), coverageHours: 36.0, wrapRisk: false },
        },
        events: [],
      },
    ],
    summary: { total: 3, ok: 1, stale: 1, offline: 1, unknown: 0, wrapRisk: 1 },
    staleSec: 90,
    offlineSec: 180,
    source: 'clickhouse',
  };
};

const MOCK_RECON_JOBS = new Map<string, Record<string, unknown>>();

const CHANNELS = { Security: '安全性', System: '系統', Directory_Service: '目錄服務', DNS_Server: 'DNS 伺服器' };
const SECURITY_EVENTS: Record<string, string> = {
  '1100': '事件記錄服務被關閉',
  '1102': '稽核記錄被清除',
  '1104': 'Security Log 已滿',
  '4616': '系統時間被變更',
  '4624': '登入成功',
  '4625': '登入失敗',
  '4662': '目錄物件作業（DCSync 複寫權限）',
  '4672': '特殊權限登入',
  '4697': '安裝服務',
  '4698': '建立排程工作',
  '4719': '系統稽核原則被變更',
  '4720': '建立使用者帳戶',
  '4723': '使用者自行變更密碼',
  '4728': '加入全域安全群組',
  '4740': '帳戶被鎖定',
  '4765': '新增 SID History 成功',
  '4768': 'Kerberos TGT 要求',
  '4769': 'Kerberos 服務票證要求',
  '4771': 'Kerberos 預先驗證失敗',
  '4776': 'NTLM 認證',
  '5136': '目錄服務物件變更（GPO / AdminSDHolder）',
};
const CHANNEL_EVENTS: Record<string, Record<string, string>> = {
  Security: SECURITY_EVENTS,
  System: {
    '41': '系統未正常關機即重新啟動（Kernel-Power）',
    '104': '系統事件記錄被清除',
    '1074': '系統正常關機或重新啟動',
    '6006': '事件記錄服務已停止',
    '6008': '系統發生非預期關機',
    '7045': '系統安裝新服務',
  },
  Directory_Service: {
    '1388': '偵測到 AD 複寫中的殘留物件（Lingering Object）',
    '1645': 'AD 無法執行目錄複寫（SPN / 驗證問題）',
    '1864': 'AD 複寫長期未同步',
    '1988': 'AD 複寫因殘留物件而被封鎖',
    '2042': 'AD 複寫超過邏輯刪除存留期（Tombstone）',
    '2092': 'DC 無法成為 FSMO 操作主機（連線失敗）',
    '2887': '未簽署或明文 LDAP 繫結彙總',
    '2889': '用戶端執行未簽署的 LDAP 繫結',
  },
  DNS_Server: {
    '4000': 'DNS 伺服器無法開啟 Active Directory',
    '4004': 'DNS 伺服器無法完成 AD 區域列舉',
    '4015': 'DNS 伺服器發生嚴重的 Active Directory 錯誤',
  },
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
    source: 'clickhouse',
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
    names: MOCK_NAMES,
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
      computer: i % 3 === 0 ? 'GSMC-DC2' : 'GSMC-DC1',
      dcDomain: 'gsmc.com.tw',
      source: i % 5 === 0 ? 'ftp' : 'agent',
      logEpoch: 0,
      recordId: String(100000 + i),
      account: k.channel === 'Security' ? ['S112009', 'guest', 'S113001'][i % 3]! : '',
      domain: k.channel === 'Security' ? 'GSMC' : '',
      ip: k.eventId === 4625 ? (i % 2 === 0 ? '10.10.1.5' : '10.10.3.20') : '',
      workstation: k.eventId === 4625 ? 'PC01' : '',
      actor: k.eventId === 4728 ? 'GSMC\\admin' : '',
      target: k.eventId === 4728 ? 'svc-backup2' : '',
      group: k.eventId === 4728 ? 'Domain Admins' : '',
      privileged: k.eventId === 4728,
    };
  }).reverse();
}

export function handleAd({ method, path, url, body, need, send, fail, sendFile }: MockCtx): boolean {
  if (method === 'GET' && path === '/api/netops/ad/agents') {
    if (!need('netops.ad.read')) return true;
    send(200, MOCK_AGENTS());
    return true;
  }
  if (method === 'GET' && path === '/api/netops/ad/reconciliations') {
    if (!need('netops.ftp.read')) return true;
    const days = imported().slice(0, 2);
    const items = days.map((d, idx) => ({
      day: d.day,
      checkedAt: new Date().toISOString(),
      status: idx === 0 ? 'gap' : 'ok',
      ftpFiles: d.files.length,
      gaps: idx === 0 ? 1 : 0,
      excess: 0,
      items: [
        { computer: 'GSMC-DC1', channel: 'Security', ftp: 1240, ch: idx === 0 ? 1232 : 1240, chAgent: 1220, chFtp: idx === 0 ? 12 : 20, diff: idx === 0 ? 8 : 0, status: idx === 0 ? 'gap' : 'ok' },
        { computer: 'GSMC-DC1', channel: 'System', ftp: 380, ch: 380, chAgent: 380, chFtp: 0, diff: 0, status: 'ok' },
        { computer: 'GSMC-DC2', channel: 'Security', ftp: 890, ch: 890, chAgent: 870, chFtp: 20, diff: 0, status: 'ok' },
      ],
      backfills: [...MOCK_RECON_JOBS.values()].filter((j) => j.day === d.day).map((j) => String(j.id)),
    }));
    send(200, { items, window: days.length ? { from: days.at(-1)!.day, to: days[0]!.day } : null });
    return true;
  }
  if (method === 'POST' && path === '/api/netops/ad/reconciliations') {
    if (!need('netops.ftp.write')) return true;
    const day = String((body as { day?: string } | undefined)?.day ?? '');
    send(200, {
      day,
      checkedAt: new Date().toISOString(),
      status: 'ok',
      ftpFiles: 4,
      gaps: 0,
      excess: 0,
      items: [{ computer: 'GSMC-DC1', channel: 'Security', ftp: 1240, ch: 1240, chAgent: 1220, chFtp: 20, diff: 0, status: 'ok' }],
      backfills: [],
    });
    return true;
  }
  if (method === 'POST' && path === '/api/netops/ad/backfills') {
    if (!need('netops.ftp.write')) return true;
    const b = (body as { day?: string; scope?: { computer: string; channel: string }[] } | undefined) ?? {};
    const id = `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
    const job = {
      id,
      day: b.day ?? '',
      files: ['Security_GSMC-DC1.csv'],
      scope: b.scope?.length ? b.scope : [{ computer: 'GSMC-DC1', channel: 'Security' }],
      state: 'done',
      createdBy: 'T000001',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      read: 1240,
      skipped: 1232,
      inserted: 5,
      waitingAgent: 2,
      ambiguous: 1,
      invalid: 0,
      error: null,
    };
    MOCK_RECON_JOBS.set(id, job);
    send(202, job);
    return true;
  }
  if (method === 'GET' && path.startsWith('/api/netops/ad/backfills/')) {
    if (!need('netops.ftp.read')) return true;
    const id = path.slice('/api/netops/ad/backfills/'.length);
    const job = MOCK_RECON_JOBS.get(id);
    if (!job) return (fail(404, 'NETOPS_BACKFILL_NOT_FOUND', '找不到補漏工作'), true);
    send(200, job);
    return true;
  }
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
    const computer = (p.get('computer') ?? '').trim().split('.')[0]!.toUpperCase();
    const dcDomain = (p.get('dcDomain') ?? '').trim().toLowerCase();
    const rows = all.filter(
      (e) =>
        (!p.get('channel') || e.channel === p.get('channel')) &&
        (!p.get('level') || e.level === p.get('level')) &&
        (!ids.length || ids.includes(String(e.eventId))) &&
        (!p.get('account') || e.account.includes(p.get('account')!)) &&
        (!p.get('ip') || e.ip === p.get('ip')) &&
        (!computer || e.computer.toUpperCase() === computer) &&
        (!dcDomain || e.dcDomain.toLowerCase() === dcDomain) &&
        (!q || `${e.message} ${e.reason}`.toLowerCase().includes(q)) &&
        (p.get('issueOnly') !== 'true' || ['audit_failure', 'warning', 'error', 'critical'].includes(e.level)),
    );
    if (path.endsWith('/export')) {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['時間', '記錄', '事件 ID', '等級', '來源', '主機', '帳號', '執行者', '對象', '群組', '來源 IP', '工作站', '原因', '訊息', 'DC 網域', '來源 IP 名稱 / 部門', '資料來源'];
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
          e.dcDomain,
          MOCK_NAMES[e.ip] ? `${MOCK_NAMES[e.ip]!.name} / ${MOCK_NAMES[e.ip]!.department}` : '',
          e.source === 'agent' ? 'Agent' : 'FTP',
        ]
          .map(esc)
          .join(','),
      );
      sendFile('text/csv; charset=utf-8', 'AD_log.csv', `\uFEFF${[head.map(esc).join(','), ...lines].join('\r\n')}`);
      return true;
    }
    const page = Math.max(1, Number(p.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(p.get('pageSize')) || 50));
    send(200, { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, scanned: all.length, source: 'clickhouse', names: MOCK_NAMES });
    return true;
  }
  if (method === 'GET' && path === '/api/netops/ad/days') {
    if (!need('netops.ad.read')) return true;
    send(200, {
      source: 'clickhouse',
      agents: MOCK_AGENTS().summary,
      days: imported().map((d) => ({
        day: d.day,
        events: d.events ?? 0,
        agent: Math.round((d.events ?? 0) * 0.9),
        ftp: Math.round((d.events ?? 0) * 0.1),
        computers: ['GSMC-DC1', 'GSMC-DC2'],
      })),
      import: { running: adStatus.running, lastSyncAt: adStatus.lastSyncAt, lastSyncError: adStatus.lastSyncError ? '同步失敗,詳見 FTP Log 檔案頁' : '' },
      channels: CHANNELS,
      securityEvents: SECURITY_EVENTS,
      channelEvents: CHANNEL_EVENTS,
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
