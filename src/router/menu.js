import { ShieldCheck, ShieldAlert, Search, FolderDown, Bot, BookOpen, DatabaseBackup, Network } from 'lucide-vue-next'

/**
 * 側邊選單與路由（選單 = 路由，一處定義）
 * 所有登入者（server/.env 的 VIEW_USERS / VIEW_DEPTS）可用全部頁面
 * href：連到其他系統（另開分頁，不建立路由）
 * jump：同步登入的系統代碼（server config.jumps），點選時先取得 SyncLogin 網址，失敗才開 href
 */
export const menuGroups = [
  {
    title: '防火牆 PA-560',
    items: [
      { name: 'Dashboard', path: 'Dashboard', title: '流量總覽', icon: ShieldCheck, component: () => import('../views/PaDashboard.vue') },
      // TRAFFIC 以外的 log：威脅、URL 過濾、資料過濾、WildFire、解密、GlobalProtect、User-ID
      { name: 'PaEvents', path: 'PaEvents', title: '安全事件', icon: ShieldAlert, component: () => import('../views/PaEvents.vue') },
      { name: 'PaAsk', path: 'PaAsk', title: 'AI 問答', icon: Bot, component: () => import('../views/PaAsk.vue') },
      { name: 'PaSearch', path: 'PaSearch', title: 'Log 明細查詢', icon: Search, component: () => import('../views/PaSearch.vue') },
      { name: 'FtpFiles', path: 'FtpFiles', title: 'FTP Log 檔案', icon: FolderDown, component: () => import('../views/FtpFiles.vue') },
    ],
  },
  {
    title: 'AD 網域',
    items: [
      { name: 'AdEvents', path: 'AdEvents', title: 'AD 事件總覽', icon: Network, component: () => import('../views/AdEvents.vue') },
      // 與防火牆的 AI 問答共用頁面，只看 AD 事件記錄
      { name: 'AdAsk', path: 'AdAsk', title: 'AI 問答', docTitle: 'AD AI 問答', icon: Bot, component: () => import('../views/PaAsk.vue'), props: { source: 'ad' } },
      { name: 'AdSearch', path: 'AdSearch', title: 'Log 明細查詢', docTitle: 'AD Log 明細查詢', icon: Search, component: () => import('../views/AdSearch.vue') },
      { name: 'AdFiles', path: 'AdFiles', title: 'FTP Log 檔案', docTitle: 'AD FTP Log 檔案', icon: FolderDown, component: () => import('../views/AdFiles.vue') },
    ],
  },
  {
    title: '網通知識',
    items: [
      { name: 'Knowledge', path: 'Knowledge', title: '知識庫', icon: BookOpen, component: () => import('../views/Knowledge.vue') },
    ],
  },
  {
    title: '其他系統',
    items: [{ name: 'Veeam', title: 'Veeam 備份監控', icon: DatabaseBackup, jump: 'veeam', href: 'https://gsmc-web.gigasolar.com.tw/Veeam' }],
  },
]

/** 系統內的頁面（建立路由用，不含外部連結） */
export const menuItems = menuGroups.flatMap((g) => g.items).filter((m) => !m.href)
