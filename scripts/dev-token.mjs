// 開發用：產生指定工號的 token（不經 AD），本機測試 API / 畫面用
// node scripts/dev-token.mjs S1234567  →  瀏覽器 console：localStorage.setItem('netops-token', '<token>')
import { signToken } from '../server/lib/auth.js'
console.log(signToken(String(process.argv[2] || '').toUpperCase()))
