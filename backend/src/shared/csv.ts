/** 匯出 CSV(AD、PA 明細共用) */

/** CSV(Excel 開啟中文不亂碼:加 BOM;欄位以 = + - @ 開頭時加 ' 避免被當成公式) */
export function toCsv(header: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
