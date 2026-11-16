// 在載入 CSS 前先套用明暗與風格,避免閃爍(UI-GUIDE §2;規則同 src/composables/theme.ts)。
// 獨立檔案而非內嵌:Gateway CSP 不允許 inline script。
(function () {
  var d = document.documentElement;
  var t = null;
  var s = null;
  try {
    t = localStorage.getItem('netops.theme');
    s = localStorage.getItem('netops.style');
  } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  var blur = window.CSS && (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'));
  var reduced = matchMedia('(prefers-reduced-transparency: reduce)').matches;
  d.dataset.theme = t;
  d.dataset.style = !blur || reduced || s === 'flat' ? 'flat' : 'glass';
})();
