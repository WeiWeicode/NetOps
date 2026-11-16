/** 匯出 CSV(AD、PA 明細共用) */

/** CSV(Excel 開啟中文不亂碼:加 BOM;文字欄位以 = + - @(含全形、前面有空白)或 Tab、CR 開頭時加 ' 避免被當成公式) */
export function toCsv(header: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^(?:[\t\r]|[ \u3000]*[=+\-@＝＋－＠])/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
