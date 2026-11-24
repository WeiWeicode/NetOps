/**
 * netops-ad-receiver 測試用:假 Redis(水位去重語意同 src/infra/redis/ad-receiver.ts 的 Lua)、DC Token 對應表、事件訊息樣本。
 * 真 Redis 的 Lua 行為在 test/integration/ad.int.test.ts 驗證。
 */
import type { AcceptResult, AdReceiverRedis, AdStreamEvent } from '../../src/infra/redis/ad-receiver.js';
import { sha256Hex } from '../../src/ad-receiver/tokens.js';

/** 測試用 Token(64 字十六進位,同主機腳本產生的格式);不是任何環境的真 Token */
export const DC1_TOKEN = 'a'.repeat(32) + '1'.repeat(32);
export const DC2_TOKEN = 'b'.repeat(32) + '2'.repeat(32);
export const TOKEN_FILE = `# computer domain sha256(token)\nGSMC-DC1 gsmc.com.tw ${sha256Hex(DC1_TOKEN)}\n\nGSC-DC2 gsc.com.tw ${sha256Hex(DC2_TOKEN)}\n`;

export const msg4625 = (acct: string, ip: string) =>
  `帳戶登入失敗。\r\n\r\n主體:\r\n\t安全性識別碼:\t\tNULL SID\r\n\t帳戶名稱:\t\t-\r\n\r\n登入失敗的帳戶:\r\n\t帳戶名稱:\t\t${acct}\r\n\t帳戶網域:\t\tGSMC\r\n\r\n失敗資訊:\r\n\t失敗原因:\t\t不明的使用者名稱或錯誤密碼。\r\n\t狀態:\t\t\t0xC000006D\r\n\t子狀態:\t\t0xC000006A\r\n\r\n網路資訊:\r\n\t工作站名稱:\tPC-${acct}\r\n\t來源網路位址:\t${ip}\r\n\t來源連接埠:\t\t0`;
export const msg4728 = (actor: string, target: string, group: string) =>
  `已將成員新增到已啟用安全性的全域群組。\r\n\r\n主體:\r\n\t帳戶名稱:\t\t${actor}\r\n\t帳戶網域:\t\tGSMC\r\n\r\n成員:\r\n\t帳戶名稱:\t\tCN=${target},OU=Users,DC=gsmc,DC=local\r\n\r\n群組:\r\n\t群組名稱:\t\t${group}\r\n\t群組網域:\t\tGSMC`;

/** Agent 送的一筆事件(計畫 §4.1 Payload) */
export const agentEvent = (recordId: number, over: Record<string, unknown> = {}) => ({
  time: '2026-11-20T13:05:12.345+08:00',
  channel: 'Security',
  eventId: 4625,
  recordId,
  logEpoch: 0,
  level: 'Audit Failure',
  provider: 'Microsoft-Windows-Security-Auditing',
  message: msg4625('john', '10.10.112.13'),
  ...over,
});

export class FakeAdReceiverRedis implements AdReceiverRedis {
  /** Stream 條目(JSON 字串) */
  stream: string[] = [];
  hwm = new Map<string, Map<string, number>>();
  heartbeats = new Map<string, Record<string, string>>();
  computers = new Set<string>();
  agentEvents: string[] = [];
  /** 下一次操作拋錯(模擬 Redis 斷線) */
  fail = 0;

  private check() {
    if (this.fail > 0) {
      this.fail--;
      throw new Error('Connection is closed.');
    }
  }
  async acceptEvents(computer: string, events: readonly AdStreamEvent[]): Promise<AcceptResult> {
    this.check();
    let accepted = 0;
    let duplicates = 0;
    const h = this.hwm.get(computer) ?? new Map<string, number>();
    for (const e of events) {
      const f = `${e.channel}:${e.logEpoch}`;
      if (e.recordId > (h.get(f) ?? 0)) {
        this.stream.push(e.json);
        h.set(f, e.recordId);
        accepted++;
      } else duplicates++;
    }
    this.hwm.set(computer, h);
    if (accepted) {
      const hb = this.heartbeats.get(computer) ?? {};
      hb.received = String(Number(hb.received ?? 0) + accepted);
      this.heartbeats.set(computer, hb);
      this.computers.add(computer);
    }
    return { accepted, duplicates };
  }
  async writeHeartbeat(computer: string, fields: Record<string, string>, agentEvents: readonly string[]) {
    this.check();
    this.heartbeats.set(computer, { ...fields, received: this.heartbeats.get(computer)?.received ?? '0' });
    this.computers.add(computer);
    this.agentEvents.unshift(...agentEvents);
  }
  async watermarks(computer: string) {
    this.check();
    const out: Record<string, { logEpoch: number; lastRecordId: number }> = {};
    for (const [f, v] of this.hwm.get(computer) ?? []) {
      const [channel, epoch] = f.split(':') as [string, string];
      if (!out[channel] || Number(epoch) > out[channel].logEpoch) out[channel] = { logEpoch: Number(epoch), lastRecordId: v };
    }
    return out;
  }
  async ping() {}
  async quit() {}
}
