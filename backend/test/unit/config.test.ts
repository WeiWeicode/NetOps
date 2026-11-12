/**
 * 服務設定(IMPL-PLAN B1、AGENT.md §6):資料目錄、FTP 與機密 *_FILE;缺少必要設定時啟動失敗
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-config-'));
const secret = path.join(tmp, 'ftp_password');
fs.writeFileSync(secret, 'from-file\n');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const base = { SERVICE_CODE: 'netops-api', GW_BASE_URL: 'https://gw.example' };
const gwTest = { ...base, GW_ENV: 'test', GW_API_KEY: 'k', SERVICE_ADVERTISE_URL: 'http://netops-api:51292', REDIS_URL: 'redis://netops-redis:6379/0', CLICKHOUSE_URL: 'http://netops-clickhouse:8123', CLICKHOUSE_PASSWORD: 'x' };
const ftp = { FTP_HOST: '10.10.130.66', FTP_USER: 'netops', FTP_PASSWORD_FILE: secret };

describe('資料目錄', () => {
  it('dev 未設定時用本機暫存目錄', () => {
    const c = loadConfig({ ...base, GW_ENV: 'dev' });
    assert.equal(c.dataDir, path.join(os.tmpdir(), 'giga-netops-dev'));
  });

  it('test / prod 缺少 NETOPS_DATA_DIR 時啟動失敗', () => {
    assert.throws(() => loadConfig({ ...gwTest, ...ftp }), /test 缺少必要設定:NETOPS_DATA_DIR/);
  });

  it('必須是絕對路徑', () => {
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'dev', NETOPS_DATA_DIR: 'data' }), /NETOPS_DATA_DIR 必須是絕對路徑/);
  });
});

describe('FTP', () => {
  it('dev 未設定 FTP_HOST 時 ftp 為 null(功能回 503)', () => {
    assert.equal(loadConfig({ ...base, GW_ENV: 'dev' }).ftp, null);
  });

  it('test 缺少 FTP_HOST / FTP_USER / FTP_PASSWORD_FILE 時列出缺少的項目', () => {
    assert.throws(() => loadConfig({ ...gwTest, NETOPS_DATA_DIR: tmp }), /test 缺少必要設定:FTP_HOST、FTP_USER、FTP_PASSWORD_FILE/);
  });

  it('密碼由 FTP_PASSWORD_FILE 讀取並去掉換行;預設值與舊版相同', () => {
    const c = loadConfig({ ...gwTest, NETOPS_DATA_DIR: tmp, ...ftp });
    assert.ok(c.ftp);
    assert.equal(c.ftp.password, 'from-file');
    assert.equal(c.ftp.port, 21);
    assert.equal(c.ftp.root, '/');
    assert.equal(c.ftp.logDir, '/');
    assert.equal(c.ftp.adDir, '/AD_Log_Backup');
    assert.equal(c.ftp.eventDirs.threat, '/threat');
    assert.equal(c.ftp.maxConnections, 1);
    assert.equal(c.ftp.syncMinutes, 0);
    assert.equal(c.ftp.tlsInsecure, false);
    assert.ok(c.ftp.pattern.test('PA-560_traffic_2026_10_16_last_calendar_day_0.csv'));
  });

  it('正式區不接受明文 FTP_PASSWORD(同時設定 _FILE 也拒絕)與 FTP_TLS_INSECURE', () => {
    const prod = { ...base, GW_ENV: 'prod', GW_API_KEY_FILE: secret, SERVICE_ADVERTISE_URL: 'http://netops-api:51292', NETOPS_DATA_DIR: tmp, REDIS_URL: 'redis://netops-redis:6379/0', CLICKHOUSE_URL: 'http://netops-clickhouse:8123', CLICKHOUSE_PASSWORD_FILE: secret };
    assert.throws(() => loadConfig({ ...prod, FTP_HOST: 'h', FTP_USER: 'u', FTP_PASSWORD: 'p' }), /正式區不可用 FTP_PASSWORD 明文設定/);
    assert.throws(() => loadConfig({ ...prod, ...ftp, FTP_PASSWORD: 'p' }), /正式區不可用 FTP_PASSWORD 明文設定/);
    assert.throws(() => loadConfig({ ...prod, ...ftp, FTP_TLS_INSECURE: '1' }), /正式區不可設定 FTP_TLS_INSECURE/);
    assert.equal(loadConfig({ ...prod, ...ftp }).ftp?.password, 'from-file');
  });

  it('讀不到機密檔時啟動失敗,訊息不含路徑', () => {
    const missing = path.join(tmp, 'nope');
    assert.throws(
      () => loadConfig({ ...gwTest, NETOPS_DATA_DIR: tmp, ...ftp, FTP_PASSWORD_FILE: missing }),
      (err: Error) => /無法讀取 FTP_PASSWORD_FILE/.test(err.message) && !err.message.includes(missing),
    );
  });

  it('目錄正規化;設成 - 表示不匯入該類型', () => {
    const c = loadConfig({ ...base, GW_ENV: 'dev', FTP_HOST: 'h', FTP_LOG_DIR: 'my-data\\', FTP_URL_DIR: '-', FTP_AD_DIR: '//AD//' });
    assert.equal(c.ftp?.root, '/');
    assert.equal(c.ftp?.logDir, '/my-data');
    assert.equal(c.ftp?.eventDirs.url, '');
    assert.equal(c.ftp?.adDir, '/AD');
  });

  it('開關只接受 1 / 0 / true / false', () => {
    const dev = { ...base, GW_ENV: 'dev', FTP_HOST: 'h' };
    assert.equal(loadConfig({ ...dev, FTP_SECURE: 'true' }).ftp?.secure, true);
    assert.equal(loadConfig({ ...dev, FTP_SECURE: '0' }).ftp?.secure, false);
    assert.throws(() => loadConfig({ ...dev, FTP_SECURE: 'yes' }), /FTP_SECURE 只能是/);
  });

  it('匯入目錄必須在 FTP_ROOT 之下;.. 會先正規化', () => {
    const dev = { ...base, GW_ENV: 'dev', FTP_HOST: 'h', FTP_ROOT: '/my-data' };
    assert.throws(() => loadConfig({ ...dev, FTP_LOG_DIR: '/other' }), /FTP_LOG_DIR、FTP_AD_DIR、FTP_THREAT_DIR.* 必須在 FTP_ROOT/);
    const off = { FTP_THREAT_DIR: '-', FTP_URL_DIR: '-', FTP_DATA_FILTER_DIR: '-', FTP_WILDFIRE_DIR: '-', FTP_DECRYPTION_DIR: '-', FTP_GLOBALPROTECT_DIR: '-', FTP_USERID_DIR: '/my-data/user-id' };
    const c = loadConfig({ ...dev, ...off, FTP_LOG_DIR: '/my-data/pa/../traffic', FTP_AD_DIR: '/my-data/AD' });
    assert.equal(c.ftp?.logDir, '/my-data/traffic');
    assert.throws(() => loadConfig({ ...dev, ...off, FTP_AD_DIR: '/my-data/../etc' }), /FTP_AD_DIR 必須在 FTP_ROOT/);
  });

  it('數字超出範圍或規則寫錯時啟動失敗', () => {
    const dev = { ...base, GW_ENV: 'dev', FTP_HOST: 'h' };
    assert.throws(() => loadConfig({ ...dev, FTP_MAX_CONNECTIONS: '0' }), /FTP_MAX_CONNECTIONS 必須是 1–6 的整數/);
    assert.throws(() => loadConfig({ ...dev, FTP_SYNC_MINUTES: 'abc' }), /FTP_SYNC_MINUTES/);
    assert.throws(() => loadConfig({ ...dev, FTP_PATTERN: '(' }), /FTP_PATTERN 不是正確的正規表示式/);
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'dev', PA_SEARCH_SECONDS: '9999' }), /PA_SEARCH_SECONDS 必須是 10–600/);
  });
});

describe('AI(IMPL-PLAN A1)', () => {
  const dev = { ...base, GW_ENV: 'dev' };
  it('沒有設定時 AI 關閉;預設不同步向量庫、不自動學習外部 IP', () => {
    const c = loadConfig(dev).ai;
    assert.equal(c.llm.url, '');
    assert.equal(c.vector.url, '');
    assert.equal(c.vector.collection, 'NetOpsKb');
    assert.equal(c.vectorSync, false);
    assert.equal(c.ipLearn.hour, -1);
    assert.equal(c.kbMaxChars, 20000);
  });

  it('主機位址只從設定讀,結尾的 / 拿掉;API Key 讀 *_FILE', () => {
    const key = path.join(tmp, 'qdrant_api_key');
    fs.writeFileSync(key, 'qk\n');
    const c = loadConfig({ ...dev, LLM_URL: 'http://10.10.130.46:8080/v1/', LLM_MODEL: 'Qwen3.6-35B-A3B-FP8', EMBED_URL: 'http://10.10.130.46:8081/v1', QDRANT_URL: 'http://10.10.130.46:6333', QDRANT_API_KEY_FILE: key, VECTOR_SYNC: '1', IPLEARN_HOUR: '3' }).ai;
    assert.deepEqual(c.llm, { url: 'http://10.10.130.46:8080/v1', model: 'Qwen3.6-35B-A3B-FP8', apiKey: '', timeoutMs: 300000 });
    assert.deepEqual(c.vector, { url: 'http://10.10.130.46:6333', apiKey: 'qk', collection: 'NetOpsKb', embedUrl: 'http://10.10.130.46:8081/v1' });
    assert.equal(c.vectorSync, true);
    assert.equal(c.ipLearn.hour, 3);
  });

  it('設定錯誤時啟動失敗(網址、帳密寫在網址、缺 embedding、collection、正式區明文 Key)', () => {
    assert.throws(() => loadConfig({ ...dev, LLM_URL: '10.10.130.46:8080' }), /LLM_URL/);
    assert.throws(() => loadConfig({ ...dev, LLM_URL: 'ftp://10.10.130.46' }), /只接受 http/);
    assert.throws(() => loadConfig({ ...dev, QDRANT_URL: 'http://u:p@10.10.130.46:6333', EMBED_URL: 'http://e' }), /不可帶帳密/);
    assert.throws(() => loadConfig({ ...dev, QDRANT_URL: 'http://10.10.130.46:6333' }), /必須設定 EMBED_URL/);
    assert.throws(() => loadConfig({ ...dev, QDRANT_COLLECTION: '../x' }), /QDRANT_COLLECTION/);
    assert.throws(() => loadConfig({ ...dev, IPLEARN_HOUR: '24' }), /IPLEARN_HOUR/);
    assert.throws(() => loadConfig({ ...dev, VECTOR_SYNC: 'yes' }), /VECTOR_SYNC/);
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'prod', GW_API_KEY_FILE: secret, SERVICE_ADVERTISE_URL: 'http://netops-api:51292', NETOPS_DATA_DIR: tmp, ...ftp, QDRANT_API_KEY: 'plain' }), /正式區不可用 QDRANT_API_KEY 明文/);
  });
});

describe('netops-redis(R1)', () => {
  it('test / prod 缺少 REDIS_URL 時啟動失敗;dev 為 null', () => {
    const { REDIS_URL: _omit, ...noRedis } = gwTest;
    assert.throws(() => loadConfig({ ...noRedis, NETOPS_DATA_DIR: tmp, ...ftp }), /test 缺少必要設定:REDIS_URL/);
    assert.equal(loadConfig({ ...base, GW_ENV: 'dev' }).redisUrl, null);
  });

  it('只接受 redis:// 或 rediss://', () => {
    assert.throws(() => loadConfig({ ...gwTest, NETOPS_DATA_DIR: tmp, ...ftp, REDIS_URL: 'http://x' }), /REDIS_URL 必須以/);
    assert.equal(loadConfig({ ...gwTest, NETOPS_DATA_DIR: tmp, ...ftp }).redisUrl, 'redis://netops-redis:6379/0');
  });
});
