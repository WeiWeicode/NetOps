/**
 * PA Log 明細的核心 scan.js 與舊版相同(AI 問答仍用它掃 FTP)。
 * C3(ARCHITECTURE D43)起明細 API 只查 ClickHouse,API 行為的測試在 ch-detail.test.ts。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const LEGACY = path.resolve(here, '../../../server/lib');
const text = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('核心邏輯與舊版相同', () => {
  it('scan.js 只把 openStream 改成由呼叫端注入,其餘與舊版逐字相同', () => {
    const legacy = text(path.join(LEGACY, 'scan.js'));
    const mine = text(path.resolve(here, '../../src/modules/pa/core/scan.js'));
    const expected = legacy
      .replace("import { openStream } from './ftp.js'\n", '')
      .replace(' *   onProgress({ filesScanned, files, rows })：每掃完一個檔案呼叫一次\n', ' *   onProgress({ filesScanned, files, rows })：每掃完一個檔案呼叫一次\n *   openStream(path)：開啟 FTP 串流（新版由呼叫端注入 infra/ftp，舊版直接 import lib/ftp.js；其餘不變）\n')
      .replace('onProgress = null }) {', 'onProgress = null, openStream }) {');
    assert.equal(mine, expected);
  });
});
