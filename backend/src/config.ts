/**
 * 設定:Gateway 相關(GW_ENV、SERVICE_CODE、GW_BASE_URL、API Key…)由 SDK loadGatewayEnv 讀取,
 * 本檔只補上服務自己的設定。部署區差異見 AGENT.md §6;缺少必要設定時啟動失敗,不加預設值繞過。
 */
import { isGatewayPort, loadGatewayEnv, loadMonitorEnv, type GatewayEnv, type MonitorEnv } from '@giganexus/backend-sdk';

/** 服務代碼與 port(ARCHITECTURE D1、Gateway BACKEND-GUIDE §3.3) */
export const SERVICE_CODE = 'netops-api';
export const DEFAULT_PORT = 51292;

export interface Config {
  gateway: GatewayEnv;
  /** giga-observe 監控(MONITOR_URL、MONITOR_API_KEY_FILE;dev 預設關閉) */
  monitor: MonitorEnv;
  port: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd?: string): Config {
  const gateway = loadGatewayEnv(env, cwd);
  // 服務代碼同時是內部 Token 的 aud;設錯會讓所有請求 401,啟動時就擋下
  if (gateway.serviceCode !== SERVICE_CODE) throw new Error(`SERVICE_CODE 必須是 ${SERVICE_CODE}:${gateway.serviceCode}`);
  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!isGatewayPort(port)) throw new Error(`PORT 必須在 51200–51300(BACKEND-GUIDE.md §3):${env.PORT}`);
  return { gateway, monitor: loadMonitorEnv(gateway.gwEnv, env), port, logLevel: env.LOG_LEVEL ?? (gateway.gwEnv === 'dev' ? 'debug' : 'info') };
}
