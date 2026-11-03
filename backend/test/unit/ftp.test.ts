/**
 * infra/ftp(不連線的部分):路徑限制、連線名額的優先與逾時、取消
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { AppError } from '../../src/errors.js';
import { createFtp, Semaphore } from '../../src/infra/ftp/index.js';

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
