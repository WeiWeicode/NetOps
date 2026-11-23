/**
 * netops-ad-receiver 的 HTTP 介面(AD-1;docs/AD-AGENT-PLAN.md §4.1、§7)。DC Agent 直連(明文 HTTP,需求方 2026-11-23 決定),
 * 不是 Gateway 上游(D24):不接 setupGateway、不註冊路由、不讀 X-Internal-Token。
 *
 *   POST /ad/v1/logs       批次事件(≤ 1,000 筆、≤ 4 MB)→ 依水位去重後寫 Stream netops:ad:log:events
 *   POST /ad/v1/heartbeat  每 15 秒心跳(≤ 64 KB)→ netops:ad:heartbeat:{computer}、netops:ad:computers、Watchdog 事件清單
 *   GET  /healthz          容器健康檢查(不需 Token、不碰 Redis)
 *
 * 認證(H3):標頭 X-NetOps-Ad-Token,每台 DC 一把;在讀 body 之前檢查(onRequest),沒有有效 Token 不解析內容。
 * 內容的 computer / domain 和 Token 對應的 DC 不一致回 403。錯誤格式 { code, message, requestId }(AGENT.md §8),不回堆疊。
 * 日誌一行 JSON,不含 Token、事件內容與訊息。
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AdReceiverRedis } from '../infra/redis/ad-receiver.js';
import { checkIdentity, HEARTBEAT_BODY_LIMIT, LOGS_BODY_LIMIT, parseHeartbeat, parseLogs, PayloadError } from './payload.js';
import type { DcIdentity, TokenTable } from './tokens.js';

export type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

export interface AdReceiverDeps {
  tokens: TokenTable;
  redis: AdReceiverRedis;
  log: Log;
  now?: () => number;
  /** 每台 DC 每分鐘最多幾個請求(測試用;預設 MAX_REQUESTS_PER_MINUTE) */
  maxRequestsPerMinute?: number;
}

export const TOKEN_HEADER = 'x-netops-ad-token';
/**
 * 每台 DC 每分鐘的請求上限:正常每 3–5 秒一批 + 每 15 秒心跳 ≈ 每分鐘 24 個;離線後補送時一批收到 200 才送下一批,
 * 120 留 5 倍餘裕。超過回 429,Agent 退避後重送同一批(不移水位,不掉資料)
 */
export const MAX_REQUESTS_PER_MINUTE = 120;
/** 同一種警告每分鐘最多記一次(Token 錯誤被灌時不洗日誌) */
const LOG_THROTTLE_MS = 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    dc?: DcIdentity;
  }
}

class RedisUnavailable extends Error {
  constructor(cause: unknown) {
    super(String((cause as Error)?.message ?? cause).slice(0, 200));
  }
}

function send(reply: FastifyReply, req: FastifyRequest, status: number, code: string, message: string) {
  return reply.code(status).send({ code, message, requestId: req.id });
}

export function buildAdReceiverApp(deps: AdReceiverDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const lastWarn = new Map<string, { at: number; skipped: number }>();
  const warn = (kind: string, msg: string, extra: Record<string, unknown> = {}) => {
    const t = now();
    const s = lastWarn.get(kind);
    if (s && t - s.at < LOG_THROTTLE_MS) {
      s.skipped++;
      return;
    }
    lastWarn.set(kind, { at: t, skipped: 0 });
    deps.log('warn', msg, { ...extra, ...(s?.skipped ? { skippedSimilar: s.skipped } : {}) });
  };

  // 固定一分鐘的視窗計數(單一容器,程序內即可)
  const perMinute = deps.maxRequestsPerMinute ?? MAX_REQUESTS_PER_MINUTE;
  const windows = new Map<string, { start: number; n: number }>();
  const limiter = (computer: string): boolean => {
    const t = now();
    const w = windows.get(computer);
    if (!w || t - w.start >= 60_000) {
      windows.set(computer, { start: t, n: 1 });
      return true;
    }
    return ++w.n <= perMinute;
  };

  const app = Fastify({
    logger: false,
    bodyLimit: LOGS_BODY_LIMIT,
    // 慢速傳送佔住連線:整個請求 30 秒內要完成
    requestTimeout: 30_000,
    genReqId: () => randomUUID(),
    // 來源由主機防火牆限制,容器看到的是 Docker 閘道:不信任任何轉送標頭
    trustProxy: false,
    return503OnClosing: true,
  });

  // 先驗 Token 再讀 body(未授權的請求不解析 4 MB 內容)
  // 預設拒絕:只有 /healthz 不驗 Token(依路由比對的結果判斷,不看原始 URL:/%61d/… 這類編碼路徑會被路由器解碼,資安審查 H1)
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' && req.routeOptions.url === '/healthz') return;
    const raw = req.headers[TOKEN_HEADER];
    const dc = deps.tokens.lookup(Array.isArray(raw) ? undefined : raw);
    if (!dc) {
      warn('token', 'DC Token 無效或缺少,拒收', { requestId: req.id, path: req.routeOptions.url ?? '' });
      return send(reply, req, 401, 'NETOPS_AD_TOKEN_INVALID', 'X-NetOps-Ad-Token 無效或缺少');
    }
    // 每台 DC 每分鐘的請求數上限(Token 外洩時限制灌入量,保護和 netops-pa 共用的 netops-redis;資安審查 M1)
    if (!limiter(dc.computer)) {
      warn(`rate:${dc.computer}`, 'DC 請求過於頻繁,暫時拒收', { requestId: req.id, computer: dc.computer });
      return send(reply.header('retry-after', '60'), req, 429, 'NETOPS_AD_RATE_LIMITED', '請求過於頻繁,請稍後重送');
    }
    req.dc = dc;
  });

  /** Redis 呼叫:失敗標成 RedisUnavailable(回 503 讓 Agent 重送);其他例外是程式錯誤,回 500(code review M3) */
  const redisCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new RedisUnavailable(e);
    }
  };

  const handle = async <T>(req: FastifyRequest, reply: FastifyReply, run: (dc: DcIdentity, body: Record<string, unknown>) => Promise<T>) => {
    const dc = req.dc;
    // onRequest 一定會設;沒有就拒絕(防禦:之後改路由或 hook 時不會變成身分繞過)
    if (!dc) return send(reply, req, 401, 'NETOPS_AD_TOKEN_INVALID', 'X-NetOps-Ad-Token 無效或缺少');
    try {
      return await run(dc, checkIdentity(req.body, dc));
    } catch (e) {
      if (e instanceof PayloadError) {
        warn(`payload:${dc.computer}:${e.code}`, 'AD 上傳內容被拒', { requestId: req.id, computer: dc.computer, code: e.code, reason: e.message });
        return send(reply, req, e.status, e.code, e.message);
      }
      if (e instanceof RedisUnavailable) {
        // Redis 斷線等:回 503,Agent 不移動水位、退避後重送同一批
        warn('redis', 'Redis 寫入失敗', { requestId: req.id, computer: dc.computer, error: e.message });
        return send(reply, req, 503, 'NETOPS_AD_UNAVAILABLE', '暫時無法接收,請稍後重送');
      }
      warn('internal', '非預期錯誤', { requestId: req.id, computer: dc.computer, error: String((e as Error)?.message ?? e).slice(0, 200) });
      return send(reply, req, 500, 'NETOPS_AD_INTERNAL', '伺服器錯誤');
    }
  };

  app.post('/ad/v1/logs', async (req, reply) =>
    handle(req, reply, async (dc, body) => {
      const parsed = parseLogs(body, dc);
      const r = await redisCall(() => deps.redis.acceptEvents(dc.computer, parsed.events, now()));
      if (parsed.rejectedCount) warn(`rejected:${dc.computer}`, 'AD 事件有格式錯誤的筆數(已略過)', { requestId: req.id, computer: dc.computer, rejected: parsed.rejectedCount, first: parsed.rejected[0] });
      return { accepted: r.accepted, duplicates: r.duplicates, rejected: parsed.rejectedCount, rejectedItems: parsed.rejected, requestId: req.id };
    }),
  );

  app.post('/ad/v1/heartbeat', { bodyLimit: HEARTBEAT_BODY_LIMIT }, async (req, reply) =>
    handle(req, reply, async (dc, body) => {
      const hb = parseHeartbeat(body, dc, now());
      await redisCall(() => deps.redis.writeHeartbeat(dc.computer, hb.fields, hb.agentEvents));
      // 水位只是參考資訊:讀不到時心跳仍算成功(不讓 Agent 重送;code review L8)
      const channels = await deps.redis.watermarks(dc.computer).catch(() => ({}));
      return { ok: true, serverTime: hb.fields.updatedAt, channels, requestId: req.id };
    }),
  );

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.setNotFoundHandler((req, reply) => send(reply, req, 404, 'NETOPS_AD_NOT_FOUND', '路徑不存在'));
  app.setErrorHandler((err: { statusCode?: number; code?: string }, req, reply) => {
    // Fastify 的內建錯誤(超過大小、不是 JSON、JSON 壞掉);訊息不回原文(可能帶內容)
    const status = err.statusCode ?? 500;
    if (status === 413) return send(reply, req, 413, 'NETOPS_AD_PAYLOAD_TOO_LARGE', '內容超過大小上限');
    if (status === 415) return send(reply, req, 415, 'NETOPS_AD_UNSUPPORTED_MEDIA_TYPE', 'Content-Type 必須是 application/json');
    if (status >= 400 && status < 500) return send(reply, req, 400, 'NETOPS_AD_BAD_REQUEST', '內容不是合法的 JSON');
    deps.log('error', '非預期錯誤', { requestId: req.id, code: err.code ?? '' });
    return send(reply, req, 500, 'NETOPS_AD_INTERNAL', '伺服器錯誤');
  });

  return app;
}
