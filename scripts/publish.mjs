// 產生可直接放到 IIS 的發佈資料夾：publish/
//   app.cjs + web.config（iisnode 入口）、server/（API）、dist/（Vue 打包結果）、themes/（配色）、package.json（只列後端套件）
// 使用方式：npm run publish          （預設不執行 npm install；要一起產生 node_modules：npm run publish -- --install）
import { cpSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { execSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'publish')
const doInstall = process.argv.includes('--install')

if (!existsSync(resolve(root, 'dist'))) {
  console.error('找不到 dist，請先執行 npm run build')
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })

// 前端
cpSync(resolve(root, 'dist'), resolve(out, 'dist'), { recursive: true })

// 後端（含 server/.env）
cpSync(resolve(root, 'server'), resolve(out, 'server'), {
  recursive: true,
  filter: (src) => !['.env.example', '.env.development'].includes(basename(src)),
})
// 配色核心與色票（server/routes/theme.js 用來產生 /api/theme.css）；預設值 theme.json 一起帶
for (const f of ['theme-core.mjs', 'palettes.mjs', 'theme.json']) cpSync(resolve(root, 'themes', f), resolve(out, 'themes', f))

if (!existsSync(resolve(root, 'server', '.env'))) {
  console.warn('⚠ 找不到 server/.env，請在 IIS 實體路徑的 server 資料夾自行建立（範本 server/.env.example）')
}

// 只列出後端需要的套件，避免把 Vue、Element Plus 等前端套件裝到伺服器
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const serverDeps = ['express', 'mssql', 'activedirectory2', 'jsonwebtoken', 'dotenv', 'basic-ftp']
writeFileSync(
  resolve(out, 'package.json'),
  JSON.stringify(
    {
      name: 'netops-server',
      private: true,
      type: 'module',
      scripts: { start: 'node server/index.js' },
      dependencies: Object.fromEntries(serverDeps.map((d) => [d, pkg.dependencies[d]])),
    },
    null,
    2
  ) + '\n'
)

// iisnode 以 require() 載入入口檔，server 是 ES module，所以用 .cjs 轉接
writeFileSync(resolve(out, 'app.cjs'), `// iisnode 入口：載入 ES module 版的 server\nimport('./server/index.js')\n`)

// 所有請求都交給 Node（Express 會提供 /NetOps/ 頁面與 /NetOps/api）
writeFileSync(
  resolve(out, 'web.config'),
  `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <handlers>
      <add name="iisnode" path="app.cjs" verb="*" modules="iisnode" />
    </handlers>

    <rewrite>
      <rules>
        <rule name="NetOps" stopProcessing="true">
          <match url=".*" />
          <action type="Rewrite" url="app.cjs" />
        </rule>
      </rules>
    </rewrite>

    <!-- API 的 401 / 403 / 404 / 500 會回 JSON 錯誤訊息，不要被 IIS 換成它自己的錯誤頁 -->
    <httpErrors existingResponse="PassThrough" />

    <!-- 原始碼、設定檔、套件不可直接下載 -->
    <security>
      <requestFiltering>
        <hiddenSegments>
          <add segment="node_modules" />
          <add segment="server" />
          <add segment="themes" />
          <add segment="iisnode" />
          <add segment="uploads" />
        </hiddenSegments>
      </requestFiltering>
    </security>

    <!-- 修改 server 程式或 .env 後自動重啟 Node；flushResponse：AI 分析的串流回應要即時送出，不等整段完成 -->
    <iisnode node_env="production" flushResponse="true" watchedFiles="web.config;app.cjs;server\\*.js;server\\lib\\*.js;server\\routes\\*.js;server\\.env" />

    <!-- AI 分析的串流（text/event-stream）不壓縮，否則 IIS 會等整段完成才送出 -->
    <urlCompression doDynamicCompression="false" />
  </system.webServer>
</configuration>
`
)

if (doInstall) {
  console.log('安裝後端套件（npm install --omit=dev）...')
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: out, stdio: 'inherit' })
} else {
  console.log('未執行 npm install（沒有 node_modules）：第一次部署或後端套件有增減時，在 IIS 實體路徑執行 npm install --omit=dev，或改用 npm run publish -- --install')
}

console.log('\n發佈檔案已輸出到', out)
console.log('請將 publish 資料夾「全部內容」複製到 IIS 應用程式 /NetOps 的實體路徑。')
console.log('IIS 需安裝 iisnode 與 URL Rewrite（與 E-Learning 相同），並確認 server/.env 為正式環境設定。')
