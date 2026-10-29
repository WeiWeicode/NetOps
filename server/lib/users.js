import { query } from '../db.js'

/**
 * 員工資料（與 E-Learning 相同）
 * 先查 LOS.dbo.EmployeeInfo（在職），查不到再用 PortalSolar.dbo.NotesPhone
 */
export async function getUserInfo(userid) {
  if (!userid) return null
  const emp = await query(
    `SELECT E.UserID, E.UserName, E.EFDept AS DeptNo, E.EFDeptName AS DeptName, E.CompName,
            N.CName AS NotesName, N.CDeptName
       FROM LOS.dbo.EmployeeInfo E
       LEFT JOIN PortalSolar.dbo.NotesPhone N ON N.LgNo = E.UserID
      WHERE UPPER(E.UserID) = UPPER(@id) AND E.LeaveDate IS NULL`,
    { id: userid }
  )
  if (emp.length) {
    const e = emp[0]
    return {
      userid: e.UserID,
      name: e.UserName || e.NotesName || '',
      deptNo: e.DeptNo || '',
      deptName: e.DeptName || e.CDeptName || '',
      comp: e.CompName || '',
    }
  }
  const np = await query('SELECT LgNo, DeptNo, CName, CDeptName FROM PortalSolar.dbo.NotesPhone WHERE LgNo = @id', { id: userid })
  if (!np.length) return null
  const n = np[0]
  return { userid: n.LgNo, name: n.CName || '', deptNo: n.DeptNo || '', deptName: n.CDeptName || '', comp: '' }
}
