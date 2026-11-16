// 產生世界地圖 GeoJSON(V-b1;docs/VIZ-RULES-DESIGN.md §6.5、決策 V9:打包進前端,不連外部 CDN)。只在要更新地圖時手動執行一次,輸出進版控。
//   來源:world-atlas@2.0.2 countries-110m.json(Natural Earth 1:110m,公有領域;套件 ISC)、i18n-iso-countries@7.14.0(ISO 3166 數字 → alpha-2、英文名稱)
//   在暫存目錄執行(不加進專案相依):
//     mkdir /tmp/geo && cd /tmp/geo && npm i world-atlas@2.0.2 topojson-client@3.1.0 i18n-iso-countries@7.14.0
//     node <repo>/frontend/scripts/build-world-geo.mjs <repo>/frontend/src/ui/charts/world
//   輸出:world.geo.json(feature.properties.name = ISO2,座標取到小數 2 位)、countries.ts(ISO2 → 英文名稱)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'x.js'));
const topo = require('world-atlas/countries-110m.json');
const { feature } = require('topojson-client');
const countries = require('i18n-iso-countries');
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
const out = process.argv[2];
if (!out) throw new Error('用法:node build-world-geo.mjs <輸出目錄>');

// 沒有 ISO 數字代碼的區域:Kosovo 用 XK(使用者指定代碼);北賽普勒斯、索馬利蘭不對應國家(地圖上不著色)
const EXTRA = { Kosovo: 'XK' };
const round = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100] : c.map(round));
const fc = feature(topo, topo.objects.countries);
const names = {};
const feats = [];
for (const f of fc.features) {
  const iso2 = f.id ? countries.numericToAlpha2(f.id) : EXTRA[f.properties.name];
  if (!iso2) continue;
  names[iso2] = iso2 === 'XK' ? 'Kosovo' : countries.getName(iso2, 'en', { select: 'official' }) ?? f.properties.name;
  feats.push({ type: 'Feature', properties: { name: iso2 }, geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } });
}
fs.writeFileSync(path.join(out, 'world.geo.json'), JSON.stringify({ type: 'FeatureCollection', features: feats }));
const lines = Object.entries(names).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`);
fs.writeFileSync(
  path.join(out, 'countries.ts'),
  `/** 地圖上的國家(ISO 3166-1 alpha-2 → 英文名稱);由 frontend/scripts/build-world-geo.mjs 產生,不要手改 */\nexport const WORLD_COUNTRIES: Record<string, string> = {\n${lines.join('\n')}\n};\n`,
);
console.log(`features ${feats.length}`);
