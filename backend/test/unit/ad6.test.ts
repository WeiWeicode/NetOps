/**
 * AD-6 單元測試(docs/AD-AGENT-PLAN.md §9):
 *   - §9.1 System / Directory_Service / DNS_Server、§9.2 與 §9.3 Security 事件中文名稱與說明完整
 *   - 新增事件的關鍵欄位解析(TicketEncryptionType、ServiceName、TaskName、ServiceFileName、ObjectDN、
 *     AttributeLDAPDisplayName、SidHistory、信任網域名稱、DCSync GUID、4616、4624 登入類型)並對齊 ad_events 既有欄位
 *   - ACCOUNT_CHANGE_IDS 與 adlog.js ACCOUNT_CHANGES 同步
 *   - FTP 對帳只算 v3 的 23 種 Security 事件,所有 AD-6 新 ID 不進對帳 count()
 *   - GET /v1/ad/days 回傳擴充後的 securityEvents 與 channelEvents
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACCOUNT_CHANGE_IDS, createAdChReader, FTP_SECURITY_EVENT_IDS } from '../../src/infra/clickhouse/ad-reader.js';
import { toAdRow } from '../../src/ingest/ad-rows.js';
import {
  ACCOUNT_CHANGES,
  CHANNEL_EVENTS,
  DIRECTORY_SERVICE_EVENTS,
  DNS_SERVER_EVENTS,
  EVENT_DESCRIPTIONS,
  eventName,
  isIssue,
  SECURITY_EVENTS,
  summarizeAd,
  SYSTEM_EVENTS,
  toEvent,
  enrichEvent,
} from '../../src/modules/ad/core/adlog.js';
import { compareAd, ftpCounts } from '../../src/modules/ad/reconcile.js';
import { createTestApp } from '../helpers.js';

const AD6_SECURITY_IDS = [
  // §9.2 新增 27 種無條件 + 4616 + 4624
  4723, 4697, 4698, 4699, 4700, 4701, 4702, 4719, 1100, 1104, 4741, 4742, 4743, 4765, 4766, 4780, 4735, 4737, 4755, 4730, 4734, 4758, 4739, 4713, 4706, 4707, 4716, 4616, 4624,
  // §9.3 開關 + 4768
  4768, 4769, 4662, 5136,
];

const parseOne = (channel: string, eventId: number, level: string, message: string) => {
  const map = { time: 0, eventId: 1, level: 2, provider: 3, computer: 4, recordId: 5, message: 6 };
  return enrichEvent(toEvent(['2026-11-24T10:00:00', String(eventId), level, 'Microsoft-Windows-Security-Auditing', 'GSMC-DC1', '100', message], map, channel)) as Record<string, unknown>;
};

describe('AD-6 事件名稱與說明對照表(§9.1–§9.3)', () => {
  it('§9.2 與 §9.3 所有 Security Event ID 都有中文名稱與說明', () => {
    for (const id of [...FTP_SECURITY_EVENT_IDS, ...AD6_SECURITY_IDS]) {
      assert.ok(SECURITY_EVENTS[id as keyof typeof SECURITY_EVENTS], `SECURITY_EVENTS 缺少 ${id}`);
      assert.equal(eventName('Security', id), SECURITY_EVENTS[id as keyof typeof SECURITY_EVENTS]);
    }
    for (const id of AD6_SECURITY_IDS.filter((x) => x !== 4624)) {
      assert.ok(EVENT_DESCRIPTIONS[id as keyof typeof EVENT_DESCRIPTIONS], `EVENT_DESCRIPTIONS 缺少 ${id}`);
    }
  });

  it('§9.1 System / Directory_Service / DNS_Server 事件皆有名稱,且 summarizeAd 填入各通道 name', () => {
    for (const id of [104, 7045, 41, 1074, 6006, 6008]) assert.ok(SYSTEM_EVENTS[id as keyof typeof SYSTEM_EVENTS], `System ${id}`);
    for (const id of [1864, 2042, 1645, 2887, 2889, 1388, 1988, 2092]) assert.ok(DIRECTORY_SERVICE_EVENTS[id as keyof typeof DIRECTORY_SERVICE_EVENTS], `Directory_Service ${id}`);
    for (const id of [4000, 4004, 4015]) assert.ok(DNS_SERVER_EVENTS[id as keyof typeof DNS_SERVER_EVENTS], `DNS_Server ${id}`);
    assert.equal(CHANNEL_EVENTS.System[7045], eventName('System', 7045));
    const events = [
      parseOne('System', 7045, 'Information', '服務已安裝在系統中。\n服務名稱:\tEvilSvc\n服務檔案名稱:\tC:\\Temp\\evil.exe'),
      parseOne('Directory_Service', 2889, 'Warning', '用戶端執行未簽署的 LDAP 繫結'),
      parseOne('DNS_Server', 4015, 'Error', 'DNS 伺服器發生嚴重的 Active Directory 錯誤'),
      parseOne('Security', 4719, 'Audit Success', '系統稽核原則已變更。'),
    ];
    const sum = summarizeAd(events as never);
    const byKey = new Map(sum.events.map((g: { channel: string; eventId: number; name: string }) => [`${g.channel}:${g.eventId}`, g.name]));
    assert.equal(byKey.get('System:7045'), SYSTEM_EVENTS[7045]);
    assert.equal(byKey.get('Directory_Service:2889'), DIRECTORY_SERVICE_EVENTS[2889]);
    assert.equal(byKey.get('DNS_Server:4015'), DNS_SERVER_EVENTS[4015]);
    assert.equal(byKey.get('Security:4719'), SECURITY_EVENTS[4719]);
  });

  it('ad-reader ACCOUNT_CHANGE_IDS 與 adlog.js ACCOUNT_CHANGES 保持同步', () => {
    const a = [...ACCOUNT_CHANGE_IDS].sort((x, y) => x - y);
    const b = Object.keys(ACCOUNT_CHANGES)
      .map(Number)
      .sort((x, y) => x - y);
    assert.deepEqual(a, b);
  });
});

describe('AD-6 關鍵欄位解析(沿用 ad_events 既有欄位)', () => {
  it('4768 成功但 RC4(0x17)標示弱加密並計入 isIssue;失敗且 AES 只記失敗原因', () => {
    const weak = parseOne(
      'Security',
      4768,
      'Audit Success',
      '已要求 Kerberos 驗證票證 (TGT)。\n帳戶名稱:\t\talice\n服務名稱:\t\tkrbtgt\n用戶端位址:\t\t::ffff:10.10.5.9\n結果碼:\t\t0x0\n票證加密類型:\t\t0x17',
    );
    assert.equal(weak.account, 'alice');
    assert.equal(weak.target, 'krbtgt');
    assert.equal(weak.ip, '10.10.5.9');
    assert.match(String(weak.reason), /弱加密 RC4-HMAC（0x17）/);
    assert.equal(isIssue(weak as never), true);

    const failAes = parseOne(
      'Security',
      4768,
      'Audit Failure',
      'A Kerberos authentication ticket (TGT) was requested.\nAccount Name:\t\tbob\nResult Code:\t\t0x18\nTicket Encryption Type:\t0x12',
    );
    assert.equal(failAes.reason, '密碼錯誤（0x18）');
    assert.equal(isIssue(failAes as never), true);
  });

  it('4769 弱加密 TGS 解析 ServiceName 與 TicketEncryptionType(0x17 / 0x18)', () => {
    const e = parseOne(
      'Security',
      4769,
      'Audit Success',
      'A Kerberos service ticket was requested.\nAccount Name:\t\talice@GSMC.COM.TW\nService Name:\t\tMSSQLSvc/sql01.gsmc.com.tw:1433\nClient Address:\t\t::ffff:10.10.8.2\nTicket Encryption Type:\t0x17',
    );
    assert.equal(e.account, 'alice@GSMC.COM.TW');
    assert.equal(e.target, 'MSSQLSvc/sql01.gsmc.com.tw:1433');
    assert.equal(e.ip, '10.10.8.2');
    assert.match(String(e.reason), /RC4-HMAC（0x17）/);
    assert.equal(isIssue(e as never), true);
  });

  it('4697 安裝服務與 4698 排程工作解析 ServiceName / ServiceFileName / TaskName', () => {
    const svc = parseOne(
      'Security',
      4697,
      'Audit Success',
      '已在系統中安裝服務。\n主體:\n\t帳戶名稱:\t\tadmin\n服務資訊:\n\t服務名稱:\t\tBackdoorSvc\n\t服務檔案名稱:\t\tC:\\Windows\\Temp\\bd.exe',
    );
    assert.deepEqual([svc.actor, svc.target, svc.reason, isIssue(svc as never)], ['admin', 'BackdoorSvc', 'C:\\Windows\\Temp\\bd.exe', true]);

    const task = parseOne(
      'Security',
      4698,
      'Audit Success',
      '已建立排程工作。\n主體:\n\t帳戶名稱:\t\tadmin\n工作資訊:\n\t工作名稱:\t\t\\UpdaterTask',
    );
    assert.deepEqual([task.actor, task.target, isIssue(task as never)], ['admin', '\\UpdaterTask', true]);
  });

  it('4719 稽核原則、4765 SID History、4706 信任網域、4616 時間變更、4624 RDP 登入', () => {
    const pol = parseOne('Security', 4719, 'Audit Success', '系統稽核原則已變更。\n帳戶名稱:\t\tadmin\n子類別:\t\tLogon\n變更:\t\t已移除成功');
    assert.deepEqual([pol.actor, pol.target, pol.reason], ['admin', 'Logon', '已移除成功']);

    const sid = parseOne(
      'Security',
      4765,
      'Audit Success',
      'SID History was added to an account.\nSubject:\n\tAccount Name:\t\tadmin\nTarget Account:\n\tTarget Account Name:\t\trogue\nSID History:\t\tS-1-5-21-1-2-3-512',
    );
    assert.deepEqual([sid.actor, sid.target, sid.reason], ['admin', 'rogue', 'S-1-5-21-1-2-3-512']);

    const trust = parseOne(
      'Security',
      4706,
      'Audit Success',
      '已建立網域的新信任。\n主體:\n\t帳戶名稱:\t\tadmin\n受信任的網域名稱:\t\tgsc.com.tw\n信任類型:\t\t2\n信任方向:\t\t雙向',
    );
    assert.deepEqual([trust.actor, trust.target, trust.reason], ['admin', 'gsc.com.tw', '2 / 雙向']);

    const tm = parseOne(
      'Security',
      4616,
      'Audit Success',
      '系統時間已變更。\n主體:\n\t帳戶名稱:\t\tadmin\n先前的時間:\t\t2026-11-24T01:00:00Z\n新的時間:\t\t2026-11-20T01:00:00Z\n處理程序名稱:\t\tC:\\Windows\\System32\\cmd.exe',
    );
    assert.deepEqual([tm.actor, tm.target, tm.reason], ['admin', 'C:\\Windows\\System32\\cmd.exe', '2026-11-24T01:00:00Z → 2026-11-20T01:00:00Z']);

    const rdp = parseOne(
      'Security',
      4624,
      'Audit Success',
      '帳戶已成功登入。\n登入類型:\t\t10\n新登入:\n\t帳戶名稱:\t\talice\n來源網路位址:\t\t10.10.2.8',
    );
    assert.deepEqual([rdp.account, rdp.ip, rdp.reason], ['alice', '10.10.2.8', '登入類型 10（RDP 遠端互動）']);
  });

  it('4662 DCSync 與 5136 GPO 變更解析 ObjectDN / AttributeLDAPDisplayName / 複寫 GUID,寫入 ad_events 既有欄位', () => {
    const dcRow = toAdRow(
      JSON.stringify({
        computer: 'GSMC-DC1',
        domain: 'gsmc.com.tw',
        channel: 'Security',
        eventId: 4662,
        recordId: '5001',
        logEpoch: 0,
        time: '2026-11-24T09:00:00.000+08:00',
        level: 'Audit Success',
        provider: 'Microsoft-Windows-Security-Auditing',
        message: '已對物件執行作業。\n帳戶名稱:\t\tevil_user\n物件名稱:\t\tDC=gsmc,DC=com,DC=tw\n屬性:\t\t{1131f6ad-9c07-11d1-f79f-00c04fc2dcd2}',
      }),
      Date.parse('2026-11-24T09:00:01+08:00'),
      { badTime: false },
    )!;
    assert.deepEqual([dcRow.actor, dcRow.target, dcRow.reason, dcRow.is_issue], ['evil_user', 'DC=gsmc,DC=com,DC=tw', 'DS-Replication-Get-Changes-All', 1]);

    const gpoRow = toAdRow(
      JSON.stringify({
        computer: 'GSMC-DC1',
        domain: 'gsmc.com.tw',
        channel: 'Security',
        eventId: 5136,
        recordId: '5002',
        logEpoch: 0,
        time: '2026-11-24T09:05:00.000+08:00',
        level: 'Audit Success',
        provider: 'Microsoft-Windows-Security-Auditing',
        message:
          'A directory service object was modified.\nSubject:\n\tAccount Name:\t\tadmin\nObject:\n\tDN:\t\tCN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,CN=System,DC=gsmc,DC=com,DC=tw\n\tClass:\t\tgroupPolicyContainer\nAttribute:\n\tLDAP Display Name:\tgPCFileSysPath\n\tValue:\t\t\\\\gsmc.com.tw\\SysVol\\evil',
      }),
      Date.parse('2026-11-24T09:05:01+08:00'),
      { badTime: false },
    )!;
    assert.equal(gpoRow.actor, 'admin');
    assert.match(String(gpoRow.target), /^CN=\{31B2F340/);
    assert.match(String(gpoRow.reason), /gPCFileSysPath/);
    assert.equal(gpoRow.is_issue, 1);
  });

  it('4735 / 4730 群組變更與刪除設 group / target / privileged;isIssue 只保留高風險 ID(審查 M3)', () => {
    const privGrp = parseOne(
      'Security',
      4737,
      'Audit Success',
      '已變更已啟用安全性的全域群組。\n主體:\n\t帳戶名稱:\t\tadmin\n群組:\n\t群組名稱:\t\tDomain Admins',
    );
    assert.deepEqual([privGrp.actor, privGrp.group, privGrp.target, privGrp.privileged, isIssue(privGrp as never)], ['admin', 'Domain Admins', 'Domain Admins', true, true]);

    // 4723、4742、一般群組變更 / 刪除(4730 / 4734 / 4758 / 4735 / 4737 / 4755):只記錄、不算需要注意
    for (const id of [4723, 4742, 4730, 4734, 4758, 4735, 4737, 4755]) {
      const ev = parseOne('Security', id, 'Audit Success', '已變更。\n主體:\n\t帳戶名稱:\t\talice\n群組:\n\t群組名稱:\t\tSales');
      assert.equal(isIssue(ev as never), false, `${id} 不應標為 isIssue`);
    }

    // 需求方決定的 20 個高風險 ID 皆須為 isIssue
    for (const id of [4697, 4698, 4699, 4700, 4701, 4702, 4719, 4765, 4766, 4780, 4616, 1100, 1104, 4662, 5136, 4706, 4707, 4716, 4713, 4739]) {
      const ev = parseOne('Security', id, 'Audit Success', '事件內容');
      assert.equal(isIssue(ev as never), true, `高風險 ${id} 應標為 isIssue`);
    }
  });

  it('非 Security 通道即使 EventID 撞號也不走 Security 欄位解析與 Security isIssue(審查 Low 2)', () => {
    const sys = parseOne('System', 4697, 'Information', '帳戶名稱:\t\tnot-sec\n服務名稱:\t\tFooSvc');
    assert.equal(sys.actor, undefined);
    assert.equal(sys.target, undefined);
    assert.equal(isIssue(sys as never), false);
    const dns = parseOne('DNS_Server', 1100, 'Information', '帳戶名稱:\t\tnot-sec');
    assert.equal(dns.account, undefined);
    assert.equal(isIssue(dns as never), false);
  });

  it('5136 真實英文與繁體中文全文解析不被短標籤誤配(審查 Low 3)', () => {
    const enFull = [
      'A directory service object was modified.',
      '',
      'Subject:',
      '\tSecurity ID:\t\tGSMC\\admin.lin',
      '\tAccount Name:\t\tadmin.lin',
      '\tAccount Domain:\t\tGSMC',
      '\tLogon ID:\t\t0x1A2B3C',
      '',
      'Directory Service:',
      '\tName:\tgsmc.com.tw',
      '\tType:\tActive Directory Domain Services',
      '',
      'Object:',
      '\tDN:\tCN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,CN=System,DC=gsmc,DC=com,DC=tw',
      '\tGUID:\t{12345678-1234-1234-1234-1234567890AB}',
      '\tClass:\tgroupPolicyContainer',
      '',
      'Attribute:',
      '\tLDAP Display Name:\tgPCFileSysPath',
      '\tSyntax (OID):\t2.5.5.12',
      '\tValue:\t\\\\gsmc.com.tw\\SysVol\\gsmc.com.tw\\Policies\\{31B2F340-016D-11D2-945F-00C04FB984F9}',
      '',
      'Operation:',
      '\tType:\tValue Added',
      '\tCorrelation ID:\t{ABCDEF01-2345-6789-ABCD-EF0123456789}',
      '\tApplication Correlation ID:\t-',
    ].join('\n');
    const en = parseOne('Security', 5136, 'Audit Success', enFull);
    assert.equal(en.actor, 'admin.lin');
    assert.equal(en.target, 'CN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,CN=System,DC=gsmc,DC=com,DC=tw');
    assert.equal(
      en.reason,
      'gPCFileSysPath (groupPolicyContainer) = \\\\gsmc.com.tw\\SysVol\\gsmc.com.tw\\Policies\\{31B2F340-016D-11D2-945F-00C04FB984F9}',
    );

    const zhFull = [
      '已修改目錄服務物件。',
      '',
      '主體:',
      '\t安全性識別碼:\t\tGSMC\\admin.chen',
      '\t帳戶名稱:\t\tadmin.chen',
      '\t帳戶網域:\t\tGSMC',
      '\t登入識別碼:\t\t0x9F12',
      '',
      '目錄服務:',
      '\t名稱:\tgsmc.com.tw',
      '\t類型:\tActive Directory 網域服務',
      '',
      '物件:',
      '\tDN:\tCN=AdminSDHolder,CN=System,DC=gsmc,DC=com,DC=tw',
      '\tGUID:\t{87654321-4321-4321-4321-BA0987654321}',
      '\t類別:\tcontainer',
      '',
      '屬性:',
      '\tLDAP 顯示名稱:\tnTSecurityDescriptor',
      '\t語法 (OID):\t2.5.5.15',
      '\t值:\tO:DAG:DAD:PAI(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;DA)',
      '',
      '作業:',
      '\t類型:\t已新增值',
      '\t關聯識別碼:\t{11111111-2222-3333-4444-555555555555}',
      '\t應用程式關聯識別碼:\t-',
    ].join('\n');
    const zh = parseOne('Security', 5136, 'Audit Success', zhFull);
    assert.equal(zh.actor, 'admin.chen');
    assert.equal(zh.target, 'CN=AdminSDHolder,CN=System,DC=gsmc,DC=com,DC=tw');
    assert.equal(zh.reason, 'nTSecurityDescriptor (container) = O:DAG:DAD:PAI(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;DA)');
  });

  it('已知行為變更(需求方 2026-11-24 接受,審查 M4):4768 成功、4624 登入類型與帳號異動目標帳戶的新舊比對', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const oldAdlog = await import(pathToFileURL(path.resolve(here, '../../../server/lib/adlog.js')).href);
    const map = { time: 0, eventId: 1, level: 2, provider: 3, computer: 4, recordId: 5, message: 6 };
    const parseOld = (eventId: number, level: string, message: string) =>
      oldAdlog.enrichEvent(oldAdlog.toEvent(['2026-11-24T10:00:00', String(eventId), level, 'Microsoft-Windows-Security-Auditing', 'GSMC-DC1', '100', message], map, 'Security'));

    // 1. 4768 成功(Result Code = 0x0, AES):舊版 reason='0x0',新版改為空白 ''
    const msg4768Ok = 'A Kerberos authentication ticket (TGT) was requested.\nAccount Name:\t\talice\nResult Code:\t\t0x0\nTicket Encryption Type:\t0x12';
    const old4768 = parseOld(4768, 'Audit Success', msg4768Ok);
    const new4768 = parseOne('Security', 4768, 'Audit Success', msg4768Ok);
    assert.equal(old4768.reason, '0x0');
    assert.equal(new4768.reason, '');

    // 2. 4624 含登入類型:舊版 reason='',新版補「登入類型 N（說明）」
    const msg4624Rdp = '帳戶已成功登入。\n登入類型:\t\t10\n新登入:\n\t帳戶名稱:\t\talice\n來源網路位址:\t\t10.10.2.8';
    const old4624 = parseOld(4624, 'Audit Success', msg4624Rdp);
    const new4624 = parseOne('Security', 4624, 'Audit Success', msg4624Rdp);
    assert.equal(old4624.reason, '');
    assert.equal(new4624.reason, '登入類型 10（RDP 遠端互動）');

    // 3. 帳號異動含「目標帳戶名稱」:新版與舊版皆正確抽出目標帳戶名稱 bob(無非預期回歸)
    const msgTarget = '帳戶變更。\n主體:\n\t帳戶名稱:\t\tadmin\n目標:\n\t目標帳戶名稱:\t\tbob';
    const oldChg = parseOld(4738, 'Audit Success', msgTarget);
    const newChg = parseOne('Security', 4738, 'Audit Success', msgTarget);
    assert.equal(oldChg.target, 'bob');
    assert.equal(newChg.target, 'bob');
  });
});

describe('AD-6 FTP 對帳不受影響(只算 v3 的 23 種)', () => {
  it('FTP_SECURITY_EVENT_IDS 維持 23 種,不含任何 AD-6 新增 ID;ftpCounts 與 reconCounts SQL 不納入新 ID', async () => {
    assert.equal(FTP_SECURITY_EVENT_IDS.length, 23);
    const v3 = new Set<number>(FTP_SECURITY_EVENT_IDS);
    for (const id of AD6_SECURITY_IDS) {
      assert.equal(v3.has(id), false, `對帳不應納入 AD-6 新增事件 ${id}`);
    }
    const events = [
      { computer: 'GSMC-DC1', channel: 'Security', eventId: 4625 },
      { computer: 'GSMC-DC1', channel: 'Security', eventId: 1102 },
      // 全部 AD-6 新增 ID 都必須被排除在對帳之外
      ...AD6_SECURITY_IDS.map((eventId) => ({ computer: 'GSMC-DC1', channel: 'Security', eventId })),
    ];
    const counts = ftpCounts(events);
    assert.equal(counts.get('GSMC-DC1|Security'), 2);
    const cmp = compareAd(counts, [{ computer: 'GSMC-DC1', channel: 'Security', n: 2, agent: 2, ftp: 0 }]);
    assert.equal(cmp[0]!.status, 'ok');

    // ClickHouse reconCounts SQL 的 event_id IN [...] 只含 23 種
    let seenSql = '';
    const reader = createAdChReader(
      { url: 'http://127.0.0.1:8123', user: 'u', password: 'p' },
      async (_u, init) => {
        seenSql = String(init?.body ?? '');
        return new Response('', { status: 200 });
      },
      { securityEvents: SECURITY_EVENTS, channelEvents: CHANNEL_EVENTS, accountChanges: ACCOUNT_CHANGES },
    );
    await reader.reconCounts(0, 86_400_000);
    const m = /event_id IN \[([0-9,]+)\]/.exec(seenSql);
    assert.ok(m, seenSql);
    const inIds = m[1]!.split(',').map(Number);
    assert.deepEqual(inIds, [...FTP_SECURITY_EVENT_IDS]);
  });

  it('GET /v1/ad/days 回傳擴充後的 securityEvents 與 channelEvents', async () => {
    const t = await createTestApp();
    try {
      const res = await t.call({ url: '/v1/ad/days' });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.securityEvents['4697'], '安裝服務');
      assert.equal(body.securityEvents['5136'], '目錄服務物件變更（GPO / AdminSDHolder）');
      assert.equal(body.channelEvents.System['7045'], '系統安裝新服務');
      assert.equal(body.channelEvents.Directory_Service['2889'], '用戶端執行未簽署的 LDAP 繫結');
      assert.equal(body.channelEvents.DNS_Server['4015'], 'DNS 伺服器發生嚴重的 Active Directory 錯誤');
      // OpenAPI 描述與 x-gherkin 包含 channelEvents(審查 M2)
      const spec = t.app.swagger() as unknown as { paths: Record<string, { get: Record<string, unknown> }> };
      const op = spec.paths['/v1/ad/days']!.get;
      assert.match(String(op.description), /channelEvents/);
      assert.match(String(op['x-gherkin']), /而且 回應含 channelEvents/);
    } finally {
      await t.close();
    }
  });
});
