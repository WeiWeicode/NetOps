import vue from '@vitejs/plugin-vue';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';
import { mockGateway } from './mock/gateway.ts';

// 資訊網通管理系統:子路徑 /netops/(ARCHITECTURE D1;Nginx location 屬 IMPL-PLAN D1)
// 本機開發:/api 與入口網(/、/login 及其靜態檔)經 proxy 轉給測試區 Gateway(公司憑證;可用 GATEWAY_TARGET 改指其他 Gateway),
// Cookie 落在 localhost,登入後導回 http://localhost:5181/netops/...(同 GigaItApp)
// 設定 MOCK=admin|viewer|noapp|anon 時改用本機假 Gateway(mock/gateway.ts),不連測試區
const GATEWAY = process.env.GATEWAY_TARGET ?? 'https://giganexus-test.gigasolar.com.tw';
const MOCK = process.env.MOCK;
// @giganexus/web-kit 取自公司 GitLab npm Registry(.npmrc,Token 為環境變數 GITLAB_NPM_TOKEN)
const toGateway = { target: GATEWAY, changeOrigin: true };

/**
 * DEV_EXTRA_PERMS=代碼1,代碼2(逗號分隔;同 GigaItApp):測試區尚未登記的畫面代碼(netops.* 在 D1 才登記)先補進本機 /api/auth/me 看畫面。
 * 只影響本機前端顯示,BFF 照樣以真實權限檢查 API。
 */
const DEV_EXTRA_PERMS = (process.env.DEV_EXTRA_PERMS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
function extraPermsProxy(): Record<string, ProxyOptions> {
  if (!DEV_EXTRA_PERMS.length) return {};
  return {
    '^/api/auth/me(\\?.*)?$': {
      ...toGateway,
      selfHandleResponse: true,
      headers: { 'accept-encoding': 'identity' },
      configure: (proxy) =>
        proxy.on('proxyRes', (proxyRes: IncomingMessage, _req: IncomingMessage, res: ServerResponse) => {
          const chunks: Buffer[] = [];
          proxyRes.on('data', (c: Buffer) => chunks.push(c));
          proxyRes.on('end', () => {
            let body = Buffer.concat(chunks);
            if (proxyRes.statusCode === 200) {
              try {
                const me = JSON.parse(body.toString('utf8'));
                me.permissions = [...new Set([...(me.permissions ?? []), ...DEV_EXTRA_PERMS])];
                body = Buffer.from(JSON.stringify(me));
              } catch {
                // 非 JSON 照原樣
              }
            }
            const headers = { ...proxyRes.headers, 'content-length': String(body.length) };
            delete headers['content-encoding'];
            res.writeHead(proxyRes.statusCode ?? 200, headers);
            res.end(body);
          });
        }),
    },
  };
}

export default defineConfig({
  base: '/netops/', // 必須與登記的子路徑一致
  plugins: [vue(), mockGateway(MOCK)],
  resolve: {
    dedupe: ['vue', 'vue-router'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.PORT ?? 5181),
    strictPort: true,
    proxy: MOCK
      ? {}
      : {
          ...extraPermsProxy(),
          '/api': toGateway,
          // 入口網(giga-Portal,base /)的首頁、登入頁與其靜態檔;只在本機開發使用。
          // 「/」也要轉:沒有 netops.app.access 時守衛導回入口網 /,若由 Vite 回應會再導回 /netops/ 造成無限迴圈
          '^/(\\?.*)?$': toGateway,
          '^/(login|register|reset-password|no-access)(/|$|\\?)': toGateway,
          '/assets': toGateway,
        },
  },
  test: { include: ['test/**/*.test.ts'] },
});
