/**
 * 測試共用:假 JWKS 與內部 Token、以假 FTP 與暫存資料目錄建立 app
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Ftp } from '../src/infra/ftp/index.js';
import type { StreamTestOptions } from '../src/modules/pa-live/routes.js';

export interface TestApp {
  app: FastifyInstance;
  dataDir: string;
  /** 帶內部 Token 的請求 */
  call(opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown; emp?: string }): ReturnType<FastifyInstance['inject']>;
  /** 內部 Token(真實 HTTP 連線測試用) */
  token(emp?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createTestApp({ ftp, env = {}, streamTest }: { ftp?: Ftp; env?: Record<string, string>; streamTest?: StreamTestOptions } = {}): Promise<TestApp> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256', use: 'sig' };
  const jwks = http.createServer((_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netops-test-'));
  const config = loadConfig({ GW_ENV: 'dev', SERVICE_CODE: 'netops-api', GW_JWKS_URL: jwksUrl, LOG_LEVEL: 'silent', NETOPS_DATA_DIR: dataDir, FTP_HOST: 'fake-ftp', ...env });
  const app = await buildApp(config, { ftp, streamTest });
  const tokens = new Map<string, string>();
  const token = async (emp: string) => {
    if (!tokens.has(emp))
      tokens.set(emp, await new SignJWT({ sub: `u-${emp}`, emp, name: `測試${emp}` }).setProtectedHeader({ alg: 'ES256', kid: 'test' }).setIssuer('giganexus-bff').setAudience('netops-api').setExpirationTime('10m').sign(privateKey));
    return tokens.get(emp)!;
  };
  return {
    app,
    dataDir,
    token: (emp = 'S112009') => token(emp),
    async call({ method = 'GET', url, payload, emp = 'S112009' }) {
      return app.inject({ method, url, payload: payload as never, headers: { 'x-internal-token': await token(emp), 'x-request-id': 'req-test' } });
    },
    async close() {
      await app.close();
      jwks.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  } as TestApp;
}

/** 等到條件成立(背景匯入),最多 timeoutMs */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('等待逾時');
    await new Promise((r) => setTimeout(r, 20));
  }
}
