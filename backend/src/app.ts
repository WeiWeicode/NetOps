/**
 * Fastify 應用程式(由 Gateway samples/node-backend 複製,IMPL-PLAN B0):
 *   - 驗證 X-Internal-Token(BACKEND-GUIDE.md §4.2),身分放在 req.identity;dev 也不略過(AGENT.md §7.1)
 *   - 錯誤格式 { code, message, requestId, details? }(§5.3),不回傳堆疊或內部路徑
 *   - GET /healthz、GET /readyz、GET /openapi.json(§5.4、§6)
 *   - setupGateway:API 監控送 giga-observe、開始服務後自動註冊(§7.5、§11)
 *   - app.store:資料存取(infra/store,ARCHITECTURE D8);app.jobs:長時間工作(infra/jobs,D6)
 */
import swagger from '@fastify/swagger';
import { createTokenVerifier, errorBody, INTERNAL_TOKEN_HEADER, type GatewayIdentity } from '@giganexus/backend-sdk';
import { setupGateway } from '@giganexus/backend-sdk/fastify';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { JobRunner } from './infra/jobs/index.js';
import { DataFileError } from './infra/store/files.js';
import { createStore, type Store } from './infra/store/index.js';
import { createFtp, type Ftp } from './infra/ftp/index.js';
import { createAdImporter } from './modules/ad/importer.js';
import adRoutes from './modules/ad/routes.js';
import adFtpRoutes from './modules/ftp/ad-routes.js';
import ftpRoutes from './modules/ftp/routes.js';
import kbRoutes from './modules/kb/routes.js';
import { createKbService } from './modules/kb/service.js';
import { createEventImporter } from './modules/pa-events/importer.js';
import paEventRoutes from './modules/pa-events/routes.js';
import { createTrafficImporter } from './modules/pa/importer.js';
import logRoutes from './modules/pa/log-routes.js';
import paRoutes from './modules/pa/routes.js';
import pingRoutes from './modules/ping/routes.js';
import { swaggerOptions } from './openapi.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    store: Store;
    jobs: JobRunner;
  }
  interface FastifyRequest {
    identity: GatewayIdentity | null;
  }
  interface FastifyContextConfig {
    /** false:不驗證 Token(健康檢查、OpenAPI) */
    gatewayAuth?: boolean;
  }
}

/** deps:測試時注入假 FTP(AGENT.md §9);正式執行一律由設定建立 */
export async function buildApp(config: Config, deps: { ftp?: Ftp } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers["x-internal-token"]'] },
    // 沿用 Gateway 傳下來的 X-Request-Id,寫入每一筆日誌(§5.2)
    requestIdHeader: 'x-request-id',
  });
  app.decorate('config', config);
  app.decorate('store', createStore(config.dataDir));
  app.decorate('jobs', new JobRunner({}, (kind, err) => app.log.error({ err, kind }, '工作執行發生非預期錯誤')));
  app.addHook('onClose', async () => app.jobs.close());
  const verify = createTokenVerifier({ jwksUrl: config.gateway.jwksUrl!, audience: config.gateway.serviceCode });

  await app.register(swagger, swaggerOptions(config.gateway.serviceCode, config.gateway.project));
  // 監控 + 自動註冊;需在路由之前註冊。version 隨心跳回報
  await app.register(setupGateway, { env: config.gateway, monitor: config.monitor, version: process.env.npm_package_version });

  app.decorateRequest('identity', null);
  app.addHook('onRequest', async (req) => {
    // 找不到路由交給 404;健康檢查與 OpenAPI 不驗證
    if (!req.routeOptions.url || req.routeOptions.config.gatewayAuth === false) return;
    const token = req.headers[INTERNAL_TOKEN_HEADER];
    if (typeof token !== 'string' || !token) throw new AppError(401, 'NETOPS_INTERNAL_TOKEN_INVALID', '缺少內部 Token');
    try {
      req.identity = await verify(token);
    } catch {
      // 只有 Token 驗證失敗才回 401;Gateway 收到會視為設定錯誤並告警(§5.3)
      throw new AppError(401, 'NETOPS_INTERNAL_TOKEN_INVALID', '內部 Token 無效');
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.removeHeader('x-powered-by');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      // 外部系統錯誤(FTP 等)的原文只寫日誌,回應只有分類過的訊息
      if (err.status >= 500) req.log.error({ err, cause: (err as { cause?: unknown }).cause }, err.code);
      return reply.status(err.status).send(errorBody(err.code, err.message, req.id, err.details));
    }
    const e = err as { validation?: { instancePath: string; message?: string }[]; statusCode?: number };
    if (e.validation)
      return reply.status(400).send(
        errorBody(
          'VALIDATION_FAILED',
          '參數驗證失敗',
          req.id,
          e.validation.map((v) => ({ field: v.instancePath.replace(/^\//, '') || '(body)', message: v.message ?? '' })),
        ),
      );
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send(errorBody('VALIDATION_FAILED', '請求格式錯誤', req.id));
    // 資料檔損壞不當成沒有資料(AGENT.md §5);回應不帶檔名,細節只寫日誌
    if (err instanceof DataFileError) {
      req.log.error({ err }, '資料檔無法讀取');
      return reply.status(500).send(errorBody('NETOPS_DATA_CORRUPT', '資料檔損壞或無法讀取,請通知系統負責人', req.id));
    }
    req.log.error({ err }, '非預期錯誤');
    return reply.status(500).send(errorBody('INTERNAL_ERROR', '系統發生錯誤', req.id));
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send(errorBody('NETOPS_NOT_FOUND', '找不到此 API', req.id)));

  const noAuth = { config: { gatewayAuth: false }, schema: { hide: true } };
  app.get('/healthz', noAuth, async () => ({ status: 'ok' }));
  // 資料目錄可寫入才算就緒;FTP 是外部來源,連不到時由各功能回報,不影響就緒(§5.4)
  app.get('/readyz', noAuth, async (req, reply) =>
    (await app.store.ready()) ? { status: 'ok' } : reply.status(503).send(errorBody('NETOPS_NOT_READY', '資料目錄無法讀寫', req.id)),
  );
  app.get('/openapi.json', noAuth, async () => app.swagger());

  await app.register(pingRoutes);

  // PA 匯入(背景同步在程序內執行,單一容器,D9)
  const ftp = deps.ftp ?? createFtp(config.ftp);
  const paDeps = { ftp, store: app.store.pa, ftpConfig: config.ftp, log: app.log };
  const traffic = createTrafficImporter(paDeps);
  const events = createEventImporter(paDeps);
  const ad = createAdImporter({ ftp, store: app.store.ad, ftpConfig: config.ftp, log: app.log });
  app.addHook('onReady', async () => {
    traffic.start();
    events.start();
    ad.start();
  });
  app.addHook('onClose', async () => {
    ad.stop();
    await Promise.all([traffic.stop(), events.stop()]);
  });
  await app.register(paRoutes, { traffic });
  await app.register(logRoutes, { ftp, traffic, parallel: config.ftp?.maxConnections ?? 1, limit: config.search.limit, seconds: config.search.seconds });
  await app.register(paEventRoutes, { events });
  await app.register(adRoutes, { ad });
  await app.register(adFtpRoutes, { ad });
  await app.register(kbRoutes, { kb: createKbService(app.store.kb, app.log) });
  await app.register(ftpRoutes, {
    ftp,
    traffic,
    events,
    logDir: config.ftp?.logDir ?? '',
    root: config.ftp?.root ?? '',
    pattern: config.ftp?.pattern.source ?? '',
  });
  return app;
}
