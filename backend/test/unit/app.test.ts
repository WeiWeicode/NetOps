/**
 * netops-api 骨架自我檢查(IMPL-PLAN B0):npm test
 *   - OpenAPI 符合 BACKEND-GUIDE.md §6.1,且每個 operation 都有 description 與 x-gherkin
 *   - X-Internal-Token 驗證與錯誤格式(§4.2、§5.3);健康檢查不需 Token
 *   - 部署區設定(dev / test / prod)與服務代碼;設定細節見 config.test.ts
 *   - /readyz 檢查資料目錄(infra/store)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

const CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/;

let app: FastifyInstance;
let jwks: http.Server;
let dataDir: string;
let sign: (claims: Record<string, unknown>, opts?: { aud?: string; iss?: string; exp?: string }) => Promise<string>;

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256', use: 'sig' };
  jwks = http.createServer((_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`;
  sign = (claims, { aud = 'netops-api', iss = 'giganexus-bff', exp = '60s' } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'test' }).setIssuer(iss).setAudience(aud).setExpirationTime(exp).sign(privateKey);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-app-'));
  app = await buildApp(loadConfig({ GW_ENV: 'dev', SERVICE_CODE: 'netops-api', GW_JWKS_URL: jwksUrl, LOG_LEVEL: 'silent', NETOPS_DATA_DIR: dataDir }));
});

after(async () => {
  await app.close();
  jwks.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('OpenAPI(BACKEND-GUIDE.md §6.1)', () => {
  it('根層 x-gateway 為 netops-api / netops / NetOps;每個 operation 都有必填欄位、description 與 x-gherkin', async () => {
    const doc = (await app.inject('/openapi.json')).json();
    assert.deepEqual(doc['x-gateway'], { upstream: 'netops-api', system: 'netops', project: 'NetOps' });
    const declared = new Set(doc['x-permissions'].map((p: { code: string }) => p.code));
    const ops = Object.values(doc.paths as Record<string, Record<string, Record<string, unknown>>>).flatMap((p) => Object.values(p));
    assert.ok(ops.length > 0);
    for (const op of ops) {
      const id = String(op.operationId);
      assert.match(id, CODE, `operationId 格式:${id}`);
      assert.ok(id.startsWith('netops.'), `operationId 要以系統代碼開頭:${id}`);
      assert.ok(op.summary, `${id} 缺少 summary`);
      assert.ok(typeof op.description === 'string' && op.description.length <= 1000, `${id} 缺少 description`);
      assert.ok(typeof op['x-gherkin'] === 'string' && /^場景[::]/m.test(op['x-gherkin']), `${id} 缺少 x-gherkin 場景`);
      const perm = op['x-permission'] as string;
      assert.ok(perm === 'public' || perm === 'authenticated' || declared.has(perm), `${id} 的 x-permission 未列在 x-permissions:${perm}`);
    }
    // {system}.{resource}.{action}(BACKEND-GUIDE §6.1);use 只有 netops.ai.use(A1,2026-11-05 決定;不是 .read,只能由按鈕節點綁定)
    for (const p of doc['x-permissions'] as { code: string }[]) assert.match(p.code, /^netops\.[a-z0-9-]+\.(read|write)$|^netops\.ai\.use$/, `權限代碼格式:${p.code}`);
    assert.equal(doc.paths['/healthz'], undefined, '健康檢查不應出現在 OpenAPI');
    assert.equal(doc.paths['/v1/ping'].get['x-permission'], 'netops.ping.read');
    // 冪等 DELETE 回 204(docs/API.md §1.1、§7):OpenAPI 要宣告,Gateway 匯入後才看得到正確的回應
    for (const p of ['/v1/pa/log-searches/{id}', '/v1/ftp/ad/listings/{id}', '/v1/kb/notes/{id}']) assert.ok(doc.paths[p].delete.responses['204'], `${p} DELETE 缺少 204`);
  });
});

describe('X-Internal-Token 與錯誤格式', () => {
  const get = async (url: string, token?: string) =>
    app.inject({ url, headers: { 'x-request-id': 'req-1', ...(token ? { 'x-internal-token': token } : {}) } });

  it('/healthz、/readyz、/openapi.json 不需 Token', async () => {
    for (const url of ['/healthz', '/readyz', '/openapi.json']) assert.equal((await get(url)).statusCode, 200, url);
  });

  it('資料目錄無法寫入時 /readyz 回 503 NETOPS_NOT_READY,不帶出路徑', async () => {
    const orig = app.store.ready;
    app.store.ready = async () => false;
    try {
      const res = await get('/readyz');
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.json(), { code: 'NETOPS_NOT_READY', message: '資料目錄無法讀寫', requestId: 'req-1' });
      assert.ok(!res.body.includes(dataDir));
    } finally {
      app.store.ready = orig;
    }
  });

  it('缺少 Token 回 401 NETOPS_INTERNAL_TOKEN_INVALID,格式 { code, message, requestId }', async () => {
    const res = await get('/v1/ping');
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { code: 'NETOPS_INTERNAL_TOKEN_INVALID', message: '缺少內部 Token', requestId: 'req-1' });
  });

  it('aud、iss 不符或過期的 Token 回 401', async () => {
    for (const token of [
      await sign({ sub: '1' }, { aud: 'portal-api' }),
      await sign({ sub: '1' }, { iss: 'someone-else' }),
      await sign({ sub: '1' }, { exp: '-120s' }),
      'not-a-jwt',
    ]) {
      const res = await get('/v1/ping', token);
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().code, 'NETOPS_INTERNAL_TOKEN_INVALID');
    }
  });

  it('有效 Token 回傳登入者身分', async () => {
    const res = await get('/v1/ping', await sign({ sub: '1', emp: 'S112009', name: '佳緯', dept: 'S1800', roles: ['netops-admin'] }));
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.service, 'netops-api');
    assert.equal(body.emp, 'S112009');
    assert.equal(body.name, '佳緯');
    assert.equal(body.dept, 'S1800');
    assert.deepEqual(body.roles, ['netops-admin']);
    assert.equal(body.requestId, 'req-1');
    assert.ok(!Number.isNaN(Date.parse(body.time)));
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  it('不存在的路徑回 404 NETOPS_NOT_FOUND', async () => {
    const res = await get('/v1/nope');
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'NETOPS_NOT_FOUND');
  });
});

describe('部署區設定', () => {
  const base = { SERVICE_CODE: 'netops-api', GW_BASE_URL: 'https://gw.example' };

  it('dev 不自動註冊,預設 port 51292,開發專案 NetOps', () => {
    const c = loadConfig({ ...base, GW_ENV: 'dev' });
    assert.equal(c.gateway.autoRegister, false);
    assert.equal(c.port, 51292);
    assert.equal(c.gateway.project, 'NetOps');
  });

  it('test 自動註冊,缺少必要設定時啟動失敗', () => {
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'test' }), /GW_API_KEY_FILE、SERVICE_ADVERTISE_URL/);
    const full = { GW_API_KEY: 'k', SERVICE_ADVERTISE_URL: 'http://netops-api:51292', NETOPS_DATA_DIR: '/data', FTP_HOST: 'ftp', FTP_USER: 'u', FTP_PASSWORD: 'p', REDIS_URL: 'redis://netops-redis:6379/0' };
    const c = loadConfig({ ...base, GW_ENV: 'test', ...full });
    assert.equal(c.gateway.autoRegister, true);
  });

  it('正式區不接受明文 GW_API_KEY', () => {
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'prod', GW_API_KEY: 'k', SERVICE_ADVERTISE_URL: 'http://netops-api:51292' }), /GW_API_KEY_FILE/);
  });

  it('服務代碼必須是 netops-api,port 必須在 51200–51300', () => {
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'dev', SERVICE_CODE: 'node-sample' }), /SERVICE_CODE 必須是 netops-api/);
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'dev', PORT: '8080' }), /51200–51300/);
  });

  it('GW_ENV 只接受 dev / test / prod', () => {
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'product' }), /dev \/ test \/ prod/);
  });
});
