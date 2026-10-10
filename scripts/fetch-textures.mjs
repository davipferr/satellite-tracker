// Downloads the NASA Earth textures into public/textures/.
//   Day:   Blue Marble Next Generation (Dec 2004, topography + bathymetry), 5400×2700
//   Night: Black Marble 2016 (city lights), 3600×1800
// Both are public domain, from NASA Earth Observatory / Visible Earth.
import { mkdir, writeFile, stat } from 'node:fs/promises';

const TEXTURES = {
  'earth_day.jpg':
    'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg',
  'earth_night.jpg': 'https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg',
};

const dir = new URL('../public/textures/', import.meta.url);
await mkdir(dir, { recursive: true });

for (const [file, url] of Object.entries(TEXTURES)) {
  const dest = new URL(file, dir);
  if (await stat(dest).then(() => true, () => false)) {
    console.log(`✓ ${file} (already present)`);
    continue;
  }
  process.stdout.write(`↓ ${file} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}
