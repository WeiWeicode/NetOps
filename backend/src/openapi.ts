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
export const PERMISSIONS = [
  { code: 'netops.ping.read', name: 'NetOps 連線驗證:查詢' },
  { code: 'netops.pa-realtime.read', name: 'NetOps PA 即時監控:查詢' },
  // 測試區手動開關(暫停 / 繼續收集器;只給 netops-admin)
  { code: 'netops.pa-realtime.write', name: 'NetOps PA 即時監控:測試區暫停 / 繼續收集器' },
  { code: 'netops.pa.read', name: 'NetOps PA 防火牆:查詢' },
  { code: 'netops.pa-log.read', name: 'NetOps PA Log 明細:查詢' },
  // C5:PA 精準查詢(XML API log、Session Browser);只給 netops-admin(CQ7,按鈕 netops.pa-live.query)
  { code: 'netops.pa-query.read', name: 'NetOps PA 精準查詢:查詢' },
  { code: 'netops.ftp.read', name: 'NetOps FTP Log 檔案:查詢' },
  { code: 'netops.ftp.write', name: 'NetOps FTP Log 檔案:同步與管理' },
  { code: 'netops.ad.read', name: 'NetOps AD 事件:查詢' },
  { code: 'netops.ad-log.read', name: 'NetOps AD Log 明細:查詢' },
  { code: 'netops.kb.read', name: 'NetOps 知識庫:查詢' },
  { code: 'netops.kb.write', name: 'NetOps 知識庫:編輯' },
  // A1:AI 分析、問答(呼叫模型,不寫資料;2026-11-05 決定給 netops-admin、netops-viewer,D25 維持一個權限)
  { code: 'netops.ai.use', name: 'NetOps AI 分析與問答:使用' },
  // AC3:IP 對照表(姓名、部門屬個資;兩個都只給 netops-admin,例外同 D31)。PA 各 API 附帶的名稱沿用各 API 原本的權限
  { code: 'netops.ip-name.read', name: 'NetOps IP 對照表:查詢與匯出' },
  { code: 'netops.ip-name.write', name: 'NetOps IP 對照表:編輯與匯入' },
];

/** project:開發專案(package.json gateway.project,由 SDK loadGatewayEnv 讀取) */
export function swaggerOptions(serviceCode: string, project: string): SwaggerOptions {
  const extensions = { 'x-gateway': { upstream: serviceCode, system: SYSTEM_CODE, project }, 'x-permissions': PERMISSIONS };
  return { openapi: { openapi: '3.0.3', info: { title: 'NetOps 資訊網通管理系統 API', version: '0.1.0' }, ...extensions } };
}
