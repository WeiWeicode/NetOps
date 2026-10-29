import { Router } from 'express'
import ActiveDirectory from 'activedirectory2'
import { config } from '../config.js'
import { query } from '../db.js'
import { signToken, requireAuth } from '../lib/auth.js'
import { getPerms, isKbAdmin } from '../lib/perms.js'
import { ah, fail, str } from '../lib/utils.js'

const router = Router()

/** 依工號前綴判斷 AD 公司別（與 GSMCNotejsApi 相同） */
const compOf = (username) => {
  const u = username.toUpperCase()
  if (u.includes('S')) return 'GIGASOLAR'
  if (u.includes('C')) return 'CERTONE'
  if (u.includes('V')) return 'WHOLESUN'
  if (u.includes('E')) return 'GEE'
  return 'GIGASOLAR'
}

const adAuth = (server, baseDN, username, password) =>
  new Promise((resolve) => {
    const ad = new ActiveDirectory({ url: `ldap://${server}`, baseDN })
    ad.authenticate(username + baseDN, password, (err, ok) => {
      // AD 錯誤碼：52e 密碼錯誤、775 帳號鎖定、532 密碼過期、773 須變更密碼、533 帳號停用（不記錄密碼）
      if (err) console.warn(`[AD] ${username}${baseDN} @ ${server}：${err.lde_message || err.message}`)
      resolve(!err && ok)
    })
  })

/** 驗證通過後：確認在職且有使用權限 → 發 token */
async function loginResult(userid) {
  const id = String(userid).trim().toUpperCase()
  const perms = await getPerms(id, true)
  if (!perms.active) fail('查無在職員工資料，無法使用本系統', 403)
  if (!perms.allowed) fail('無使用權限，請洽 MIS', 403)
  return { token: signToken(id), userid: id }
}

// 帳號密碼登入（AD 驗證）
router.post(
  '/login',
  ah(async (req, res) => {
    const username = str(req.body.username)
    const password = req.body.password ?? ''
    if (!username || !password) fail('請輸入帳號與密碼')

    const servers = await query(
      'SELECT ServerIP, baseDN FROM GscSystem.dbo.ADServerInfo WHERE Comp = @comp ORDER BY SEQ',
      { comp: compOf(username) }
    )
    for (const s of servers) {
      if (await adAuth(s.ServerIP, s.baseDN, username, password)) {
        return res.json({ status: 'success', ...(await loginResult(username)) })
      }
    }
    fail('認證失敗！請確認帳號密碼', 401)
  })
)

// 入口網站同步登入（PortalSolar.dbo.SyncLoginInfo，只接受本系統代碼的同步碼）
router.get(
  '/sync',
  ah(async (req, res) => {
    const code = str(req.query.SyncCode)
    if (!code) fail('缺少參數 SyncCode')
    const rows = await query(
      `SELECT TOP 1 UserID FROM PortalSolar.dbo.SyncLoginInfo
        WHERE SyncCode = @code AND SyncParagram = @sys ORDER BY CreatedTime DESC`,
      { code, sys: config.syncParagram }
    )
    if (!rows.length) fail('查無資料或認證逾時', 401)
    res.json({ status: 'success', ...(await loginResult(rows[0].UserID)) })
  })
)

// 目前登入者資料
router.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const info = req.user.perms.info
    res.json({
      status: 'success',
      data: { userid: req.user.userid, name: info?.name ?? '', deptName: info?.deptName ?? '', comp: info?.comp ?? '', kbAdmin: isKbAdmin(req.user.userid) },
    })
  })
)

export default router
