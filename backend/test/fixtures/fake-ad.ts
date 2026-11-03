/**
 * 假 AD 事件匯出檔(DC 排程 scripts/dc/ADLog-FtpBackup-3.ps1 的格式):
 *   TimeCreated, EventID, Level, Provider, Computer, RecordID, Message(Message 跨行,用雙引號包住)
 * 固定亂數種子;含登入失敗、帳號鎖定、建立帳號後加入特權群組、特權登入、系統錯誤等研判會用到的事件
 */
import { rng } from './fake-logs.js';

const pad = (n: number) => String(n).padStart(2, '0');
const q = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;

const msg4625 = (acct: string, ip: string, reason: string) =>
  `帳戶登入失敗。\r\n\r\n主體:\r\n\t安全性識別碼:\t\tNULL SID\r\n\t帳戶名稱:\t\t-\r\n\r\n登入失敗的帳戶:\r\n\t帳戶名稱:\t\t${acct}\r\n\t帳戶網域:\t\tGSMC\r\n\r\n失敗資訊:\r\n\t失敗原因:\t\t${reason}\r\n\t狀態:\t\t\t0xC000006D\r\n\t子狀態:\t\t0xC000006A\r\n\r\n網路資訊:\r\n\t工作站名稱:\tPC-${acct}\r\n\t來源網路位址:\t${ip}\r\n\t來源連接埠:\t\t0`;
const msg4720 = (actor: string, target: string) => `已建立使用者帳戶。\r\n\r\n主體:\r\n\t帳戶名稱:\t\t${actor}\r\n\t帳戶網域:\t\tGSMC\r\n\r\n新帳戶:\r\n\t帳戶名稱:\t\t${target}\r\n\t帳戶網域:\t\tGSMC`;
const msg4728 = (actor: string, target: string, group: string) =>
  `已將成員新增到已啟用安全性的全域群組。\r\n\r\n主體:\r\n\t帳戶名稱:\t\t${actor}\r\n\t帳戶網域:\t\tGSMC\r\n\r\n成員:\r\n\t帳戶名稱:\t\tCN=${target},OU=Users,DC=gsmc,DC=local\r\n\r\n群組:\r\n\t群組名稱:\t\t${group}\r\n\t群組網域:\t\tGSMC`;
const msg4672 = (actor: string) => `指派給新登入的特殊權限。\r\n\r\n主體:\r\n\t帳戶名稱:\t\t${actor}\r\n\t帳戶網域:\t\tGSMC\r\n\r\n權限:\t\tSeBackupPrivilege`;
const msg4771 = (acct: string, ip: string) => `Kerberos 預先驗證失敗。\r\n\r\n帳戶資訊:\r\n\t帳戶名稱:\t\t${acct}\r\n\r\n網路資訊:\r\n\t用戶端位址:\t\t::ffff:${ip}\r\n\r\n其他資訊:\r\n\t失敗碼:\t\t0x18`;

/** 一天的 Security 記錄(yyyyMMdd) */
export function securityCsv(day: string, rows: number, seed: number, computer = 'GSMC-DC1'): string {
  const r = rng(seed);
  const d = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  const out = ['TimeCreated,EventID,Level,Provider,Computer,RecordID,Message'];
  for (let i = 0; i < rows; i++) {
    const sec = Math.floor((i / rows) * 86399);
    const time = `${d}T${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
    const kind = r.int(10);
    const acct = r.pick(['S112009', 'S094009', 'admin', 'svc-backup', 'PC-01$']);
    const ip = r.pick(['10.10.1.5', '10.10.2.20', '192.168.10.3']);
    let id = 4624;
    let level = '資訊';
    let message = `帳戶已成功登入。\r\n\r\n新登入:\r\n\t帳戶名稱:\t\t${acct}\r\n\t來源網路位址:\t${ip}`;
    if (kind <= 2) [id, level, message] = [4625, '稽核失敗', msg4625(acct, ip, r.pick(['使用者名稱不明或密碼錯誤。', '帳戶目前已停用。']))];
    else if (kind === 3) [id, level, message] = [4771, '稽核失敗', msg4771(acct, ip)];
    else if (kind === 4) [id, level, message] = [4672, '稽核成功', msg4672(acct)];
    else if (kind === 5 && i % 7 === 0) [id, level, message] = [4740, '稽核成功', `已鎖定使用者帳戶。\r\n\r\n已鎖定的帳戶:\r\n\t帳戶名稱:\t\t${acct}`];
    out.push([q(time), id, q(level), q('Microsoft-Windows-Security-Auditing'), q(computer), 100000 + i, q(message)].join(','));
  }
  // 建立帳號後隨即加入特權群組(總覽要標出)
  out.push([q(`${d}T10:00:00`), 4720, q('稽核成功'), q('Microsoft-Windows-Security-Auditing'), q(computer), 900001, q(msg4720('admin', 'backdoor01'))].join(','));
  out.push([q(`${d}T10:00:05`), 4728, q('稽核成功'), q('Microsoft-Windows-Security-Auditing'), q(computer), 900002, q(msg4728('admin', 'backdoor01', 'Domain Admins'))].join(','));
  return out.join('\r\n') + '\r\n';
}

/** 一天的 System 記錄 */
export function systemCsv(day: string, rows: number, seed: number): string {
  const r = rng(seed);
  const d = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  const out = ['TimeCreated,EventID,Level,Provider,Computer,RecordID,Message'];
  for (let i = 0; i < rows; i++) {
    const time = `${d}T${pad(r.int(24))}:${pad(r.int(60))}:${pad(r.int(60))}`;
    const [id, level, prov] = r.pick([
      [7036, '資訊', 'Service Control Manager'],
      [5719, '錯誤', 'NETLOGON'],
      [1014, '警告', 'Microsoft-Windows-DNS-Client'],
    ] as const);
    out.push([q(time), id, q(level), q(prov), q('GSMC-DC1'), 500000 + i, q(`系統事件 ${id},"含逗號與引號"\r\n第二行 ${r.int(100)}`)].join(','));
  }
  return out.join('\r\n') + '\r\n';
}

/** 匯出程式的 UTF-16 LE(含 BOM)編碼 */
export const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
