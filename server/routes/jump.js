import { Router } from 'express'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { exec } from '../db.js'
import { ah, fail } from '../lib/utils.js'

/**
 * 跳轉到其他系統（與 E-Learning 跳轉職能評鑑相同）：
 * 寫一筆同步碼到入口網站共用的 PortalSolar.dbo.SyncLoginInfo（SyncParagram = 對方系統代碼），
 * 回傳 {url}/SyncLogin?SyncCode=...，對方系統依同步碼找到工號後直接登入
 *   POST /jump/:system   system = config.jumps 的 key（veeam）
 */
const router = Router()

router.post(
  '/:system',
  ah(async (req, res) => {
    const target = config.jumps[String(req.params.system).toLowerCase()]
    if (!target) fail('沒有這個系統', 404)
    const code = crypto.randomBytes(32).toString('hex')
    await exec(
      `INSERT INTO PortalSolar.dbo.SyncLoginInfo (SyncCode, SyncParagram, UserID, CreatedTime)
       VALUES (@code, @sys, @userid, GETDATE())`,
      { code, sys: target.paragram, userid: req.user.userid }
    )
    res.json({ status: 'success', data: { url: `${target.url}/SyncLogin?SyncCode=${code}` } })
  })
)

export default router
