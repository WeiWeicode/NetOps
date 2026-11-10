// C1 POC:在 netops-api 容器內執行,沿用容器的 FTP 設定與機密(FTP_PASSWORD_FILE),不另外處理帳密。
//   docker exec -i <netops-api> node - list <dir>   < ftp-cat.mjs   列出目錄(JSON 一行一筆:name、size、modified)
//   docker exec -i <netops-api> node - cat <file>   < ftp-cat.mjs   把檔案內容串流到 stdout(.gz 自動解壓)
// FTP 唯讀(AGENT.md §7.4):只用 infra/ftp 的 listDir / openStream,不刪除、不改名、不上傳;一次一條連線。
// 原始 log 不落地(§7.2):內容只經 stdout 管線直接送進 ClickHouse,不寫檔。
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from '/app/dist/src/config.js';
import { createFtp } from '/app/dist/src/infra/ftp/index.js';

const [cmd, target] = process.argv.slice(2);
if (!['list', 'cat'].includes(cmd) || !target) {
  console.error('用法:list <dir> | cat <file>');
  process.exit(2);
}
const ftp = createFtp(loadConfig().ftp);

if (cmd === 'list') {
  for (const e of await ftp.listDir(target)) {
    process.stdout.write(JSON.stringify({ name: e.name, dir: e.dir, size: e.size, modified: e.modified }) + '\n');
  }
} else {
  const { stream, done } = await ftp.openStream(target);
  const out = /\.gz$/i.test(target) ? [stream, zlib.createGunzip(), process.stdout] : [stream, process.stdout];
  await Promise.all([pipeline(...out), done]);
}
