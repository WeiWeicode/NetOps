/* 由 ui/index.ts 全域註冊的元件型別(vue-tsc 模板檢查用);新增 G* 元件時一併加入 */
export {};

declare module 'vue' {
  interface GlobalComponents {
    GAlert: (typeof import('./ui/components/GAlert.vue'))['default'];
    GAppSwitcher: (typeof import('./ui/components/GAppSwitcher.vue'))['default'];
    GAvatar: (typeof import('./ui/components/GAvatar.vue'))['default'];
    GBadge: (typeof import('./ui/components/GBadge.vue'))['default'];
    GButton: (typeof import('./ui/components/GButton.vue'))['default'];
    GCard: (typeof import('./ui/components/GCard.vue'))['default'];
    GCheckbox: (typeof import('./ui/components/GCheckbox.vue'))['default'];
    GEmpty: (typeof import('./ui/components/GEmpty.vue'))['default'];
    GFeedbackHost: (typeof import('./ui/components/GFeedbackHost.vue'))['default'];
    GIcon: (typeof import('./ui/components/GIcon.vue'))['default'];
    GLogo: (typeof import('./ui/components/GLogo.vue'))['default'];
    GInput: (typeof import('./ui/components/GInput.vue'))['default'];
    GModal: (typeof import('./ui/components/GModal.vue'))['default'];
    GPageHeader: (typeof import('./ui/components/GPageHeader.vue'))['default'];
    GProgress: (typeof import('./ui/components/GProgress.vue'))['default'];
    GSegmented: (typeof import('./ui/components/GSegmented.vue'))['default'];
    GSelect: (typeof import('./ui/components/GSelect.vue'))['default'];
    GSkeleton: (typeof import('./ui/components/GSkeleton.vue'))['default'];
    GStatCard: (typeof import('./ui/components/GStatCard.vue'))['default'];
    GStyleToggle: (typeof import('./ui/components/GStyleToggle.vue'))['default'];
    GSwitch: (typeof import('./ui/components/GSwitch.vue'))['default'];
    GTable: (typeof import('./ui/components/GTable.vue'))['default'];
    GTabs: (typeof import('./ui/components/GTabs.vue'))['default'];
    GTextarea: (typeof import('./ui/components/GTextarea.vue'))['default'];
    GAreaChart: (typeof import('./ui/charts/GAreaChart.vue'))['default'];
    GBarList: (typeof import('./ui/charts/GBarList.vue'))['default'];
    GDonut: (typeof import('./ui/charts/GDonut.vue'))['default'];
    GRing: (typeof import('./ui/charts/GRing.vue'))['default'];
    GSparkline: (typeof import('./ui/charts/GSparkline.vue'))['default'];
    GStackedBars: (typeof import('./ui/charts/GStackedBars.vue'))['default'];
  }
  interface ComponentCustomProperties {
    $can: (code: string) => boolean;
  }
}
