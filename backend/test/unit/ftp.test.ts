/**
 * infra/ftp(不連線的部分):路徑限制、連線名額的優先與逾時、取消
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { AppError } from '../../src/errors.js';
import { createFtp, ftpReason, Semaphore, unavailable } from '../../src/infra/ftp/index.js';
import { errorText } from '../../src/modules/pa/importer.js';
import { createTestApp, waitFor } from '../helpers.js';

const code = (c: string) => (err: unknown) => err instanceof AppError && err.code === c;

describe('safePath', () => {
  const ftp = createFtp(loadConfig({ SERVICE_CODE: 'netops-api', GW_ENV: 'dev', GW_BASE_URL: 'https://gw.example', FTP_HOST: 'h', FTP_ROOT: '/my-data', FTP_AD_DIR: '/my-data/AD', FTP_THREAT_DIR: '-', FTP_URL_DIR: '-', FTP_DATA_FILTER_DIR: '-', FTP_WILDFIRE_DIR: '-', FTP_DECRYPTION_DIR: '-', FTP_GLOBALPROTECT_DIR: '-', FTP_USERID_DIR: '-' }).ftp);
  it('正規化並限制在 FTP_ROOT 之下', () => {
    assert.equal(ftp.safePath('my-data\\a\\..\\b/'), '/my-data/b');
    assert.throws(() => ftp.safePath('/my-data/../etc'), code('NETOPS_FTP_PATH_FORBIDDEN'));
    assert.throws(() => ftp.safePath('/my-data-2'), code('NETOPS_FTP_PATH_FORBIDDEN'));
  });
  it('含控制字元回 400', () => {
    assert.throws(() => ftp.safePath('/my-data/a\r\nDELE x'), code('VALIDATION_FAILED'));
  });
  it('沒有設定 FTP 時回 503', () => {
    assert.throws(() => createFtp(null).safePath('/'), code('NETOPS_FTP_NOT_CONFIGURED'));
  });
});

describe('Semaphore', () => {
  it('優先的等候者先拿到名額', async () => {
    const s = new Semaphore(1);
    const order: string[] = [];
    const first = await s.acquire();
    const low = s.acquire().then((r) => (order.push('low'), r));
    const high = s.acquire({ priority: true }).then((r) => (order.push('high'), r));
    first();
    (await high)();
    (await low)();
    assert.deepEqual(order, ['high', 'low']);
  });

  it('等候逾時回 503 NETOPS_FTP_BUSY,不佔名額', async () => {
    const s = new Semaphore(1);
    const r = await s.acquire();
    await assert.rejects(s.acquire({ timeoutMs: 20 }), code('NETOPS_FTP_BUSY'));
    r();
    (await s.acquire({ timeoutMs: 20 }))();
  });

  it('等候中取消就放棄;重複 release 不會多給名額', async () => {
    const s = new Semaphore(1);
    const r = await s.acquire();
    const ctl = new AbortController();
    const waiting = s.acquire({ signal: ctl.signal });
    ctl.abort();
    await assert.rejects(waiting, code('NETOPS_JOB_CANCELLED'));
    r();
    r();
    const a = await s.acquire();
    await assert.rejects(s.acquire({ timeoutMs: 20 }), code('NETOPS_FTP_BUSY'));
    a();
  });
});

describe('FTP 錯誤訊息(不外露主機、port 與原始錯誤)', () => {
  const sys = (code: string, message: string) => Object.assign(new Error(message), { code });
  const ftpErr = (code: number, message: string) => Object.assign(new Error(message), { code });

  it('原始錯誤分類成固定的原因', () => {
    const cases: [unknown, string][] = [
      [sys('ECONNREFUSED', 'connect ECONNREFUSED 10.10.130.66:21'), '拒絕連線'],
      [sys('ENOTFOUND', 'getaddrinfo ENOTFOUND ftp.internal'), '找不到主機'],
      [sys('ECONNRESET', 'read ECONNRESET'), '連線中斷'],
      [new Error('Timeout (control socket) 10.10.130.66:21'), '連線逾時'],
      [sys('DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'), 'TLS 憑證驗證失敗'],
      [ftpErr(530, '530 Login incorrect. user netops'), '帳號或密碼錯誤(FTP 530)'],
      [ftpErr(550, '550 /secret: No such file'), '檔案或目錄不存在,或沒有權限(FTP 550)'],
      [ftpErr(599, '599 something 10.10.130.66'), 'FTP 伺服器回應錯誤(FTP 599)'],
      [new Error('weird failure at 10.10.130.66:21'), '連線或傳輸失敗'],
    ];
    for (const [err, reason] of cases) assert.equal(ftpReason(err), reason);
  });

  it('分析狀態的錯誤訊息用白名單:已分類的照實,其他回固定訊息', () => {
    assert.equal(errorText(unavailable('FTP 連線失敗', sys('ECONNRESET', 'read ECONNRESET 10.10.130.66:21'))), 'FTP 連線失敗:連線中斷');
    assert.equal(errorText(Object.assign(new Error('不是 PA 防火牆匯出的 CSV'), { status: 400 })), '不是 PA 防火牆匯出的 CSV');
    assert.equal(errorText(new Error('FTP 傳輸不完整(10 / 20 bytes)')), 'FTP 傳輸不完整(10 / 20 bytes)');
    for (const raw of [new Error('socket hang up 10.10.130.66:21'), Object.assign(new Error('EACCES /srv/giga-netops/test/palogs'), { path: '/srv' })]) assert.equal(errorText(raw), '分析失敗(詳見服務日誌)');
  });

  it('502 的訊息只有分類過的原因,原始錯誤放在 cause', () => {
    const raw = sys('ECONNREFUSED', 'connect ECONNREFUSED 10.10.130.66:21');
    const e = unavailable('FTP 連線失敗', raw);
    assert.equal(e.status, 502);
    assert.equal(e.code, 'NETOPS_FTP_UNAVAILABLE');
    assert.equal(e.message, 'FTP 連線失敗:拒絕連線');
    assert.equal((e as { cause?: unknown }).cause, raw);
  });

  it('實際連線失敗時訊息不含主機與 port', async () => {
    // 先開再關一個本機 port,保證拒絕連線
    const port = await new Promise<number>((r) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => r(p));
      });
    });
    const ftp = createFtp(loadConfig({ SERVICE_CODE: 'netops-api', GW_ENV: 'dev', GW_BASE_URL: 'https://gw.example', FTP_HOST: '127.0.0.1', FTP_PORT: String(port), FTP_USER: 'u', FTP_PASSWORD: 'secret-pw' }).ftp);
    await assert.rejects(ftp.listDir('/'), (err: Error) => {
      assert.ok(err instanceof AppError && err.code === 'NETOPS_FTP_UNAVAILABLE');
      assert.ok(!err.message.includes('127.0.0.1') && !err.message.includes(String(port)) && !err.message.includes('secret-pw'), err.message);
      assert.ok((err as { cause?: unknown }).cause);
      return true;
    });
  });

  it('經 API 回 502 時不帶出 FTP 原始錯誤', async () => {
    const raw = sys('ECONNREFUSED', 'connect ECONNREFUSED 10.10.130.66:21');
    const failing = {
      safePath: (p = '/') => p || '/',
      listDir: async () => {
        throw unavailable('FTP 連線失敗', raw);
      },
      openStream: async () => {
        throw unavailable('FTP 連線失敗', raw);
      },
      withSession: async () => {
        throw unavailable('FTP 連線失敗', raw);
      },
    };
    const t = await createTestApp({ ftp: failing });
    try {
      const res = await t.call({ url: '/v1/ftp/pa/files' });
      assert.equal(res.statusCode, 502);
      assert.equal(res.json().message, 'FTP 連線失敗:拒絕連線');
      assert.ok(!res.body.includes('10.10.130.66'));
      // 同步失敗的 lastSyncError 也只有分類過的訊息
      await t.call({ method: 'POST', url: '/v1/ftp/pa/syncs' });
      await waitFor(async () => {
        const s = (await t.call({ url: '/v1/ftp/pa/status' })).json();
        return !s.traffic.syncing && Boolean(s.traffic.lastSyncAt);
      });
      const st = (await t.call({ url: '/v1/ftp/pa/status' })).json();
      assert.equal(st.traffic.lastSyncError, 'FTP 連線失敗:拒絕連線');
      assert.ok(!JSON.stringify(st).includes('10.10.130.66'));
    } finally {
      await t.close();
    }
  });
});
