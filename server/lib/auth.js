import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { getPerms } from './perms.js'

export const signToken = (userid) => jwt.sign({ userid }, config.jwtSecret, { expiresIn: config.jwtExpires })

/** 驗證 Bearer token，成功後 req.user = { userid, perms } */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return res.status(401).json({ status: 'error', message: '請先登入' })
  try {
    const payload = jwt.verify(token, config.jwtSecret)
    const perms = await getPerms(payload.userid)
    if (!perms.active) return res.status(403).json({ status: 'error', message: '查無在職員工資料，無法使用本系統' })
    if (!perms.allowed) return res.status(403).json({ status: 'error', message: '無使用權限，請洽 MIS' })
    req.user = { userid: String(payload.userid).toUpperCase(), perms }
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ status: 'error', message: '登入已逾時，請重新登入' })
    }
    next(err)
  }
}
