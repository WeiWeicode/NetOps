/**
 * OpenAPI 根層設定(Gateway BACKEND-GUIDE.md §6.1):x-gateway 與 x-permissions 必填。
 * 每個 operation 的 operationId、summary、description、x-permission、x-gherkin 寫在各路由的 schema。
 */
import type { SwaggerOptions } from '@fastify/swagger';

/** 路由 schema 可用的 Gateway 擴充欄位(BACKEND-GUIDE.md §6.1),由 @fastify/swagger 原樣輸出到 operation */
declare module 'fastify' {
  interface FastifySchema {
    /** 權限代碼(例 netops.pa.read)、authenticated(登入即可)或 public(免登入,需 IT 核准) */
    'x-permission'?: string;
    /** 行為規格:Gherkin 場景文字(zh-TW 關鍵字),存入 gw.api_route.gherkin */
    'x-gherkin'?: string;
    'x-audit-level'?: 'none' | 'meta' | 'body';
    'x-cache-ttl'?: number;
    'x-cache-scope'?: 'shared' | 'user';
    'x-timeout-ms'?: number;
    'x-gateway-path'?: string;
    'x-rate-limit'?: string;
  }
}

/** 系統代碼:對外前綴 /api/netops(ARCHITECTURE D1) */
export const SYSTEM_CODE = 'netops';

/**
 * 本服務的 API 權限代碼與中文名稱;Gateway 匯入時不存在者一併建立(kind 省略 = api)。
 * 讀 / 寫分開,讀取以 .read 結尾(ARCHITECTURE §5)。畫面節點由 deploy/gateway-rbac.yaml 登記(D1),以 includes 綁定這些權限。
 * 新權限預設沒有人擁有,由系統負責人在 GigaItApp 指派(D15)。
 */
export const PERMISSIONS = [{ code: 'netops.ping.read', name: 'NetOps 連線驗證:查詢' }];

/** project:開發專案(package.json gateway.project,由 SDK loadGatewayEnv 讀取) */
export function swaggerOptions(serviceCode: string, project: string): SwaggerOptions {
  const extensions = { 'x-gateway': { upstream: serviceCode, system: SYSTEM_CODE, project }, 'x-permissions': PERMISSIONS };
  return { openapi: { openapi: '3.0.3', info: { title: 'NetOps 資訊網通管理系統 API', version: '0.1.0' }, ...extensions } };
}
