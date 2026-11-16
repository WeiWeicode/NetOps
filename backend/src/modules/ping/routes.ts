/**
 * 連線驗證(IMPL-PLAN B0):確認 瀏覽器 → Traefik → Nginx → BFF → netops-api 整條路徑與權限檢查。
 * 後端 GET /v1/ping 對外為 GET /api/netops/ping;API 層權限由 BFF 依 x-permission 檢查,這裡不重複實作(AGENT.md §7.1)。
 */
import type { FastifyPluginAsync } from 'fastify';

const pingRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/ping',
    {
      schema: {
        operationId: 'netops.ping.get',
        summary: 'NetOps 連線驗證',
        description: '回傳 Gateway 傳下來的登入者身分(工號、姓名、部門、角色)與服務時間,用來確認經 Gateway 呼叫 netops-api 的路徑與權限設定;沒有 netops.ping.read 時由 BFF 回 403。',
        tags: ['連線驗證'],
        'x-permission': 'netops.ping.read',
        'x-gherkin': [
          '場景: 有權限的使用者取得自己的身分',
          '  假如 使用者 S112009 已登入且擁有 netops.ping.read',
          '  當 呼叫 GET /api/netops/ping',
          '  那麼 回應 200',
          '  而且 emp 為 "S112009"',
          '',
          '場景: 沒有權限時拒絕',
          '  假如 使用者已登入但沒有 netops.ping.read',
          '  當 呼叫 GET /api/netops/ping',
          '  那麼 回應 403',
          '',
          '場景: 直連服務沒有內部 Token',
          '  假如 呼叫端不經 Gateway',
          '  當 呼叫 GET /v1/ping 且沒有 X-Internal-Token',
          '  那麼 回應 401',
          '  而且 回應的 code 為 "NETOPS_INTERNAL_TOKEN_INVALID"',
        ].join('\n'),
        response: {
          200: {
            type: 'object',
            properties: {
              service: { type: 'string' },
              emp: { type: 'string' },
              name: { type: 'string' },
              dept: { type: 'string' },
              roles: { type: 'array', items: { type: 'string' } },
              requestId: { type: 'string' },
              time: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    async (req) => ({
      service: 'netops-api',
      emp: req.identity?.emp,
      name: req.identity?.name,
      dept: req.identity?.dept,
      roles: req.identity?.roles ?? [],
      requestId: req.id,
      time: new Date().toISOString(),
    }),
  );
};

export default pingRoutes;
