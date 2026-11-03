/**
 * netops-api(對外 /api/netops/*,後端 /v1/*;docs/API.md)。頁面只呼叫這裡的函式,不直接組路徑。
 */
import { http } from './gateway';

/** GET /api/netops/ping(B0 驗證路由,netops.ping.read):回傳 Gateway 傳下來的登入者身分 */
export interface Ping {
  service: string;
  emp?: string;
  name?: string;
  dept?: string;
  roles: string[];
  requestId: string;
  time: string;
}
export const ping = () => http.get<Ping>('/api/netops/ping');
