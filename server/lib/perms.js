import { config } from '../config.js'
import { getUserInfo } from './users.js'

/**
 * 權限：在職員工，且工號在 VIEW_USERS 或部門在 VIEW_DEPTS（server/.env）
 * 兩個清單都空白 = 所有在職員工都能看
 * 快取 30 秒；改 .env 後 iisnode 會自動重啟
 */
const cache = new Map()
const TTL = 30000

/** 依工號取得 { active, allowed, info }，快取 30 秒 */
export async function getPerms(userid, force = false) {
  const key = String(userid ?? '').trim().toUpperCase()
  if (!key) return { active: false, allowed: false, info: null }
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < TTL) return hit.perms

  const info = await getUserInfo(key)
  const dept = String(info?.deptNo ?? '').trim().toUpperCase()
  const open = !config.viewUsers.length && !config.viewDepts.length
  const perms = {
    active: Boolean(info),
    allowed: Boolean(info) && (open || config.viewUsers.includes(key) || (dept !== '' && config.viewDepts.includes(dept))),
    info,
  }
  cache.set(key, { perms, at: Date.now() })
  return perms
}

/**
 * 知識庫管理者（server/.env 的 KB_ADMINS）：可以在 AI 問答請 AI 記錄、新增 / 修改 / 刪除筆記
 * 空白 = VIEW_USERS 的人都是管理者；VIEW_USERS 也空白 = 所有可登入的人
 */
export function isKbAdmin(userid) {
  const key = String(userid ?? '').trim().toUpperCase()
  const admins = config.kbAdmins.length ? config.kbAdmins : config.viewUsers
  return !admins.length || admins.includes(key)
}
