/**
 * 全域 UI 套件:app.use(ui) 後所有 G* 元件、v-can 指令與 $can 在任何頁面可直接使用,不需各自 import。
 * 頁面不自行刻按鈕 / 卡片 / 表格樣式;需要新樣式時擴充這裡的元件或 styles/tokens.css。
 */
import type { App, Component, Directive } from 'vue';
import { watchEffect } from 'vue';
import { useAuth } from '@/api/gateway';
import './styles/tokens.css';
import './styles/base.css';

const components = import.meta.glob<{ default: Component }>(['./components/G*.vue', './charts/G*.vue'], { eager: true });

const { can } = useAuth();

/**
 * v-can="'netops.pa-files.manage'":沒有權限時隱藏元素(PRD FR-3.2;只是使用體驗,BFF 一定再檢查)。
 * v-can.disable="'...'":例外情況改為停用並加上提示。按鈕權限代碼 = 其呼叫的寫入 API 權限代碼(PRD D4)。
 */
const vCan: Directive<HTMLElement, string> = {
  mounted(el, binding) {
    const stop = watchEffect(() => {
      const ok = can(binding.value);
      if (binding.modifiers.disable || binding.arg === 'disable') {
        el.toggleAttribute('disabled', !ok);
        el.title = ok ? '' : `需要權限 ${binding.value}`;
      } else el.style.display = ok ? '' : 'none';
    });
    (el as HTMLElement & { __canStop?: () => void }).__canStop = stop;
  },
  unmounted(el) {
    (el as HTMLElement & { __canStop?: () => void }).__canStop?.();
  },
};

export default {
  install(app: App) {
    for (const [path, mod] of Object.entries(components)) {
      const name = path
        .split('/')
        .pop()!
        .replace(/\.vue$/, '');
      app.component(name, mod.default);
    }
    app.directive('can', vCan);
    app.config.globalProperties.$can = can;
  },
};

export { confirm, toast } from './feedback';

// Export all components for direct import in script setup
export { default as GAlert } from './components/GAlert.vue';
export { default as GAppSwitcher } from './components/GAppSwitcher.vue';
export { default as GAvatar } from './components/GAvatar.vue';
export { default as GBadge } from './components/GBadge.vue';
export { default as GButton } from './components/GButton.vue';
export { default as GCard } from './components/GCard.vue';
export { default as GCheckbox } from './components/GCheckbox.vue';
export { default as GEmpty } from './components/GEmpty.vue';
export { default as GFeedbackHost } from './components/GFeedbackHost.vue';
export { default as GIcon } from './components/GIcon.vue';
export { default as GInput } from './components/GInput.vue';
export { default as GLazy } from './components/GLazy.vue';
export { default as GLogo } from './components/GLogo.vue';
export { default as GModal } from './components/GModal.vue';
export { default as GPageHeader } from './components/GPageHeader.vue';
export { default as GProgress } from './components/GProgress.vue';
export { default as GSegmented } from './components/GSegmented.vue';
export { default as GSelect } from './components/GSelect.vue';
export { default as GSkeleton } from './components/GSkeleton.vue';
export { default as GStatCard } from './components/GStatCard.vue';
export { default as GStyleToggle } from './components/GStyleToggle.vue';
export { default as GSwitch } from './components/GSwitch.vue';
export { default as GTable } from './components/GTable.vue';
export { default as GTabs } from './components/GTabs.vue';
export { default as GTextarea } from './components/GTextarea.vue';

export { default as GAreaChart } from './charts/GAreaChart.vue';
export { default as GBarList } from './charts/GBarList.vue';
export { default as GDonut } from './charts/GDonut.vue';
export { default as GRing } from './charts/GRing.vue';
export { default as GSparkline } from './charts/GSparkline.vue';

