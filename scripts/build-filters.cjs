'use strict';
const { FiltersEngine } = require('@ghostery/adblocker');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const engine = await FiltersEngine.fromPrebuiltAdsAndTracking((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(60000) }));
  const target = path.join(__dirname, '../assets/blocker.bin');
  fs.writeFileSync(target, engine.serialize());
  const filters = engine.getFilters();
  const metadata = { generatedAt: new Date().toISOString(), network: filters.networkFilters.length, cosmetic: filters.cosmeticFilters.length, engine: 'Ghostery @ghostery/adblocker 2.20.1', preset: 'ads-and-tracking', source: 'https://github.com/ghostery/adblocker' };
  fs.writeFileSync(path.join(__dirname, '../assets/blocker.json'), JSON.stringify(metadata, null, 2));
  console.log(metadata);
})().catch(error => { console.error(error.message); process.exit(1); });
