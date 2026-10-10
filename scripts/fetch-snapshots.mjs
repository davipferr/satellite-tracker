// Downloads every satellite group into public/snapshots/ so the deployed site has a
// fallback when CelesTrak refuses a browser (it allows one download per group every
// 2 hours per IP). Run by GitHub Actions on each deploy and every 6 hours.
//
// Keep GROUPS in sync with the <select id="group"> options in index.html.
// File names must match snapshotKey() in src/data/celestrak.ts.
import { mkdir, writeFile } from 'node:fs/promises';

const GROUPS = ['stations', 'visual', 'starlink', 'oneweb', 'gps-ops', 'galileo', 'weather', 'geo', 'active'];
const CATNRS = [25544];

const dir = new URL('../public/snapshots/', import.meta.url);
await mkdir(dir, { recursive: true });

const jobs = [
  ...GROUPS.map((g) => ({ key: g, query: `GROUP=${g}` })),
  ...CATNRS.map((n) => ({ key: `catnr-${n}`, query: `CATNR=${n}` })),
];

const manifest = {};
for (const { key, query } of jobs) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=tle`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok || !/^1 /m.test(text)) throw new Error(`HTTP ${res.status}: ${text.slice(0, 80).trim()}`);
    await writeFile(new URL(`${key}.txt`, dir), text);
    manifest[key] = Date.now();
    console.log(`✓ ${key} (${(text.length / 1e3).toFixed(0)} kB)`);
  } catch (err) {
    // A missing snapshot only removes a fallback, so don't fail the deploy over it.
    console.warn(`✗ ${key}: ${err.message}`);
  }
}

await writeFile(new URL('index.json', dir), JSON.stringify(manifest, null, 2));
