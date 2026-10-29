import { createApp } from 'vue'
import { createPinia } from 'pinia'
// Element Plus 暗色主題變數（只在 <html class="dark"> 時生效），要放在 style.css 之前，讓配色檔可以覆寫
import 'element-plus/theme-chalk/dark/css-vars.css'
import './style.css'
import App from './App.vue'
import router from './router/index.js'
// ElMessage / ElMessageBox 以函式呼叫時，樣式不會被自動引入
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/es/components/loading/style/css'
import { initThemeMode } from './composables/useThemeMode.js'
import { initFontScale } from './composables/useFontScale.js'

initThemeMode() // 掛載前套用明亮 / 暗色
initFontScale() // 掛載前套用個人字體大小

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
