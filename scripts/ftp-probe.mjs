// 開發用：測試 FTP 連線、看伺服器支援的指令與目錄清單
// node scripts/ftp-probe.mjs [/路徑]
import { Client } from 'basic-ftp'
import { config } from '../server/config.js'

const dir = process.argv[2] || config.ftp.root
const c = new Client(20000)
try {
  await c.access({ host: config.ftp.host, port: config.ftp.port, user: config.ftp.user, password: config.ftp.password, secure: config.ftp.secure })
  console.log('FEAT:', [...(await c.features()).keys()].join(' '))
  console.log('SYST:', (await c.send('SYST')).message)
  await c.cd(dir)
  console.log('PWD :', await c.pwd())
  const list = await c.list()
  console.log(`共 ${list.length} 項`)
  console.log(list.slice(0, 15).map((f) => `${f.isDirectory ? 'D' : 'F'} ${String(f.size).padStart(12)} ${f.modifiedAt?.toISOString() ?? f.rawModifiedAt} ${f.name}`).join('\n'))
} catch (err) {
  console.error('錯誤：', err.message)
} finally {
  c.close()
}
