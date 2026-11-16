import { installMonitor } from '@giganexus/web-kit';
import { createApp } from 'vue';
import App from './App.vue';
import { initTheme } from './composables/theme';
import { router } from './router';
import ui from './ui';
import { ipLabel } from './composables/ipNames';
import { IP_LABEL_KEY } from './ui/ipLabel';

// 登入、CSRF、401 自動 Refresh 由 Gateway web-kit 處理(api/gateway.ts);路由守衛見 router.ts
initTheme();

const app = createApp(App);
// 前端健康度回報(Gateway MONITORING-PLAN W9-9):JS 錯誤、API 失敗、效能、換頁 → BFF /api/telemetry/web → giga-observe(服務 netops-web)
// 只在建置後的版本開啟,本機開發不送(同入口網、GigaItApp)
installMonitor({ app: 'netops-web', router, vueApp: app, release: import.meta.env.VITE_RELEASE, enabled: import.meta.env.PROD });
// IP 旁邊顯示名稱(AC3):GIpLabel / GTable 的 ip 欄向這裡查
app.provide(IP_LABEL_KEY, ipLabel);
app.use(router).use(ui).mount('#app');
