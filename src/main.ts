import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createEarth } from './scene/earth';
import { createStars } from './scene/stars';
import { SatelliteLayer, pickSatellite } from './scene/satellites';
import { SelectionTrack } from './scene/track';
import { PropagationClient } from './sim/propagationClient';
import { Catalog } from './sim/catalog';
import { computeErrorSeries, makeKeplerOrbits, type ErrorSeries, type KeplerSeed } from './sim/compare';
import { fetchGp, type GpQuery, type GpResult } from './data/celestrak';
import { gmst, julianDate } from './coords/time';
import { ecefToGeodetic, ecefToScene, geodeticToEcef, temeToEcef, type Vec3 } from './coords/transforms';
import { sunDirectionEci } from './coords/sun';
import { propagateKepler, type KeplerOrbit } from './orbit/kepler';
import { propagateSgp4 } from './orbit/sgp4';
import { drawErrorChart } from './ui/errorChart';
import { createToast } from './ui/toast';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 2000);
camera.position.set(2.2, 1.6, 2.6);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 1.15;
controls.maxDistance = 40;
controls.rotateSpeed = 0.5;

const earth = createEarth(renderer);
scene.add(earth.group, createStars());

const sats = new SatelliteLayer();
scene.add(sats.mesh);

const track = new SelectionTrack();
scene.add(track.group);

earth.texturesLoaded.then((ok) => {
  $('texture-note').hidden = ok;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const client = new PropagationClient();
const clock = { simMs: Date.now(), speed: 1, lastReal: performance.now() };

let catalog: Catalog | null = null;
let dataInfo: GpResult | null = null;
let loadToken = 0;

let selected = -1;
let follow = false;
let showGhost = true;
let ghostSeed: KeplerSeed = 'tle';
let ghostOrbits: Record<KeplerSeed, KeplerOrbit> | null = null;
let spanDays = 3;
let series: ErrorSeries | null = null;

const selectedScene = new THREE.Vector3(NaN, NaN, NaN);

/**
 * The time everything on screen corresponds to. The worker's positions lag one
 * request behind the clock, so the Sun, track and info panel follow *its* time —
 * otherwise at 1d/s the selected marker would visibly trail its own orbit line.
 */
function displayTime(): number {
  return Number.isFinite(client.positionsTimeMs) ? client.positionsTimeMs : clock.simMs;
}

function pxPerUnit(): number {
  return (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / window.innerHeight;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const groupSelect = $<HTMLSelectElement>('group');

function savedGroup(): string {
  try {
    return localStorage.getItem('group') ?? 'stations';
  } catch {
    return 'stations';
  }
}

const refreshBtn = $<HTMLButtonElement>('refresh');
let loading = false;

/** Lock the data controls while a load runs, so impatient clicks can't fire extra CelesTrak requests. */
function setLoading(on: boolean) {
  loading = on;
  groupSelect.disabled = on;
  updateRefreshButton();
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function loadGroup(value: string, force = false) {
  if (loading) return;
  const token = ++loadToken;
  const label = groupSelect.selectedOptions[0]?.text ?? value;
  const query: GpQuery = value.startsWith('catnr:') ? { catnr: Number(value.slice(6)) } : { group: value };
  setLoading(true);
  toast.show('loading', `Loading ${label}…`);
  try {
    const result = await fetchGp(query, { force });
    if (token !== loadToken) return;

    toast.show('loading', `Parsing ${label} TLEs…`);
    await nextFrame(); // let the toast paint before the synchronous parse
    const cat = new Catalog(result.text);
    catalog = cat;
    dataInfo = result;

    toast.show('loading', `Propagating ${cat.size.toLocaleString()} satellites…`);
    const firstPositions = client.whenPositions();
    client.setCatalog(cat.entries.map(({ tle }) => ({ name: tle.name, line1: tle.line1, line2: tle.line2 })));
    sats.setCatalog(cat.colors(), scene);
    select(cat.indexOf(25544)); // pick the ISS when it's in the set, otherwise clears selection
    try {
      localStorage.setItem('group', value);
    } catch {
      /* storage unavailable — fine */
    }
    await firstPositions;
    if (token !== loadToken) return;

    if (result.warning) toast.show('warning', result.warning, 12000);
    else toast.hide();
  } catch (err) {
    if (token !== loadToken) return;
    setStatus(`Couldn't load ${label}.`);
    toast.show('error', (err as Error).message);
  } finally {
    if (token === loadToken) {
      setLoading(false);
      updateStatus();
    }
  }
}

groupSelect.value = savedGroup();
if (!groupSelect.value) groupSelect.value = 'stations';
groupSelect.addEventListener('change', () => loadGroup(groupSelect.value));
refreshBtn.addEventListener('click', () => loadGroup(groupSelect.value, true));

/**
 * CelesTrak publishes new data every 2 hours and refuses earlier re-downloads, so the
 * refresh button only enables once there can actually be something new.
 */
function updateRefreshButton() {
  const next = dataInfo?.nextUpdateAt ?? 0;
  const waiting = Date.now() < next;
  refreshBtn.disabled = loading || waiting;
  const text = waiting
    ? `New CelesTrak data after ${new Date(next).toISOString().slice(11, 16)} UTC`
    : 'Check CelesTrak for new data';
  if (refreshBtn.textContent !== text) refreshBtn.textContent = text;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const infoPanel = $('info');
const fieldsEl = $('sat-fields');
const FIELDS = [
  ['norad', 'NORAD ID'],
  ['cospar', 'COSPAR ID'],
  ['epoch', 'TLE epoch'],
  ['age', 'TLE age'],
  ['lat', 'Latitude'],
  ['lon', 'Longitude'],
  ['alt', 'Altitude'],
  ['speed', 'Speed (inertial)'],
  ['period', 'Period'],
  ['incl', 'Inclination'],
  ['ecc', 'Eccentricity'],
  ['peri', 'Perigee / apogee'],
  ['kerr', 'Kepler ghost error'],
] as const;
type FieldKey = (typeof FIELDS)[number][0];

fieldsEl.innerHTML = FIELDS.map(([k, label]) => `<dt>${label}</dt><dd data-k="${k}">—</dd>`).join('');
const fieldEls = Object.fromEntries(
  FIELDS.map(([k]) => [k, fieldsEl.querySelector<HTMLElement>(`[data-k="${k}"]`)!]),
) as Record<FieldKey, HTMLElement>;

function setField(k: FieldKey, text: string, warn = false) {
  const el = fieldEls[k];
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('warn', warn);
}

function select(index: number) {
  selected = index;
  sats.selected = index;
  sats.refreshColors();
  lastTrackUpdate = -Infinity;

  if (!catalog || index < 0) {
    infoPanel.hidden = true;
    track.hide();
    ghostOrbits = null;
    series = null;
    $<HTMLButtonElement>('to-epoch').disabled = true;
    return;
  }

  const entry = catalog.entries[index];
  const { tle } = entry;
  ghostOrbits = makeKeplerOrbits(tle, catalog.satrec(index));
  recomputeSeries();

  infoPanel.hidden = false;
  $('sat-name').textContent = tle.name;
  setField('norad', String(tle.catalogNumber));
  setField('cospar', tle.intlDesignator || '—');
  setField('epoch', new Date(tle.epochMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
  setField('period', `${entry.periodMin.toFixed(1)} min`);
  setField('incl', `${tle.inclinationDeg.toFixed(3)}°`);
  setField('ecc', tle.eccentricity.toFixed(7));
  setField('peri', `${entry.perigeeKm.toFixed(0)} / ${entry.apogeeKm.toFixed(0)} km`);
  $<HTMLButtonElement>('to-epoch').disabled = false;
}

function recomputeSeries() {
  if (!catalog || selected < 0) return;
  series = computeErrorSeries(catalog.entries[selected].tle, catalog.satrec(selected), spanDays);
  lastChartDraw = -Infinity;
}

$('close-info').addEventListener('click', () => select(-1));
$<HTMLInputElement>('follow').addEventListener('change', (e) => {
  follow = (e.target as HTMLInputElement).checked;
});
$<HTMLInputElement>('ghost').addEventListener('change', (e) => {
  showGhost = (e.target as HTMLInputElement).checked;
});
$<HTMLSelectElement>('ghost-seed').addEventListener('change', (e) => {
  ghostSeed = (e.target as HTMLSelectElement).value as KeplerSeed;
});
segmented($('span'), 'days', (v) => {
  spanDays = v;
  recomputeSeries();
});

// ---------------------------------------------------------------------------
// Per-frame selection work (main thread — it's one satellite)
// ---------------------------------------------------------------------------

let lastTrackUpdate = -Infinity;
let lastInfoUpdate = -Infinity;
let lastChartDraw = -Infinity;

function toVec(p: Vec3, out: THREE.Vector3) {
  return out.set(p.x, p.y, p.z);
}

/** Path through space (Earth-fixed, so a spiral) and its ground track, for the selected satellite. */
function buildTrack(t: number) {
  if (!catalog) return;
  const entry = catalog.entries[selected];
  const rec = catalog.satrec(selected);
  const n = track.sampleCount;
  const periodMs = entry.periodMin * 60_000;
  const before = 0.3;
  const span = before + 1;
  const path = new Float32Array(n * 3);
  const ground = new Float32Array(n * 3);

  let last: Vec3 | null = null;
  let lastGround: Vec3 | null = null;
  for (let i = 0; i < n; i++) {
    const ti = t + (i / (n - 1) - before / span) * span * periodMs;
    const pv = propagateSgp4(rec, entry.tle.epochMs, ti);
    if (pv) {
      // Each sample gets its own GMST: the Earth turns while the satellite goes around.
      const ecef = temeToEcef(pv.r, gmst(julianDate(ti)));
      const geo = ecefToGeodetic(ecef);
      last = ecefToScene(ecef);
      const g = ecefToScene(geodeticToEcef({ lat: geo.lat, lon: geo.lon, alt: 0 }));
      lastGround = { x: g.x * 1.002, y: g.y * 1.002, z: g.z * 1.002 };
    }
    if (last && lastGround) {
      path.set([last.x, last.y, last.z], i * 3);
      ground.set([lastGround.x, lastGround.y, lastGround.z], i * 3);
    }
  }
  track.setPath(path, ground, Math.round((before / span) * (n - 1)));
}

const ghostVec = new THREE.Vector3();

function updateSelection(t: number, theta: number, now: number) {
  if (!catalog || selected < 0) return;
  const entry = catalog.entries[selected];
  const pv = propagateSgp4(catalog.satrec(selected), entry.tle.epochMs, t);

  if (!pv) {
    selectedScene.set(NaN, NaN, NaN);
    track.hide();
    setField('alt', 'SGP4 failed (decayed?)', true);
    return;
  }

  const ecef = temeToEcef(pv.r, theta);
  toVec(ecefToScene(ecef), selectedScene);

  if (now - lastTrackUpdate > 100) {
    buildTrack(t);
    lastTrackUpdate = now;
  }

  let errKm = NaN;
  const ghostOn = showGhost && ghostOrbits !== null;
  track.setGhostVisible(ghostOn);
  if (ghostOn) {
    const k = propagateKepler(ghostOrbits![ghostSeed], t);
    errKm = Math.hypot(k.r.x - pv.r.x, k.r.y - pv.r.y, k.r.z - pv.r.z);
    track.setGhost(toVec(ecefToScene(temeToEcef(k.r, theta)), ghostVec), selectedScene, camera, pxPerUnit());
  }

  if (now - lastInfoUpdate > 100) {
    lastInfoUpdate = now;
    const geo = ecefToGeodetic(ecef);
    const latDeg = THREE.MathUtils.radToDeg(geo.lat);
    const lonDeg = THREE.MathUtils.radToDeg(geo.lon);
    const ageDays = (t - entry.tle.epochMs) / DAY_MS;
    setField('lat', `${Math.abs(latDeg).toFixed(3)}° ${latDeg >= 0 ? 'N' : 'S'}`);
    setField('lon', `${Math.abs(lonDeg).toFixed(3)}° ${lonDeg >= 0 ? 'E' : 'W'}`);
    setField('alt', `${geo.alt.toFixed(1)} km`);
    setField('speed', `${Math.hypot(pv.v.x, pv.v.y, pv.v.z).toFixed(3)} km/s`);
    setField('age', `${ageDays >= 0 ? '+' : ''}${ageDays.toFixed(2)} days`, Math.abs(ageDays) > 7);
    setField('kerr', ghostOn ? formatKm(errKm) : '—');
  }

  if (now - lastChartDraw > 200) {
    lastChartDraw = now;
    drawErrorChart($<HTMLCanvasElement>('chart'), series, (t - entry.tle.epochMs) / DAY_MS);
  }
}

function formatKm(km: number): string {
  if (!Number.isFinite(km)) return '—';
  if (km < 1) return `${(km * 1000).toFixed(0)} m`;
  return `${km.toFixed(km < 100 ? 1 : 0)} km`;
}

// ---------------------------------------------------------------------------
// Picking & hover
// ---------------------------------------------------------------------------

const tooltip = $('tooltip');
let downAt: { x: number; y: number } | null = null;

function pickAt(clientX: number, clientY: number): number {
  if (!catalog) return -1;
  const ndcX = (clientX / window.innerWidth) * 2 - 1;
  const ndcY = -(clientY / window.innerHeight) * 2 + 1;
  return pickSatellite(client.positions, catalog.size, camera, ndcX, ndcY, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) {
    const i = pickAt(e.clientX, e.clientY);
    if (i >= 0) select(i);
  }
  downAt = null;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const i = pickAt(e.clientX, e.clientY);
  if (i !== sats.hovered) {
    sats.hovered = i;
    sats.refreshColors();
  }
  canvas.classList.toggle('pointer', i >= 0);
  if (i >= 0 && catalog) {
    tooltip.hidden = false;
    tooltip.textContent = catalog.entries[i].tle.name;
    tooltip.style.left = `${e.clientX}px`;
    tooltip.style.top = `${e.clientY}px`;
  } else {
    tooltip.hidden = true;
  }
});
canvas.addEventListener('pointerleave', () => {
  tooltip.hidden = true;
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const searchInput = $<HTMLInputElement>('search');
const resultsEl = $<HTMLUListElement>('results');
let results: number[] = [];

function renderResults() {
  if (!catalog || results.length === 0) {
    resultsEl.hidden = true;
    return;
  }
  resultsEl.innerHTML = '';
  for (const i of results) {
    const { tle } = catalog.entries[i];
    const li = document.createElement('li');
    li.innerHTML = `<span></span><small>${tle.catalogNumber}</small>`;
    li.firstElementChild!.textContent = tle.name;
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      choose(i);
    });
    resultsEl.append(li);
  }
  resultsEl.hidden = false;
}

function choose(i: number) {
  select(i);
  searchInput.value = '';
  results = [];
  renderResults();
  searchInput.blur();
}

searchInput.addEventListener('input', () => {
  results = catalog?.search(searchInput.value) ?? [];
  renderResults();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && results.length) choose(results[0]);
  if (e.key === 'Escape') searchInput.blur();
});
searchInput.addEventListener('blur', () => {
  resultsEl.hidden = true;
});
searchInput.addEventListener('focus', renderResults);

// ---------------------------------------------------------------------------
// Time controls & status
// ---------------------------------------------------------------------------

function segmented(container: HTMLElement, attr: string, onPick: (value: number) => void) {
  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    container.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    onPick(Number(btn.dataset[attr]));
  });
}

function setSpeed(speed: number) {
  clock.speed = speed;
  $('speeds')
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === speed));
}

segmented($('speeds'), 'speed', (v) => (clock.speed = v));
$('now').addEventListener('click', () => {
  clock.simMs = Date.now();
  setSpeed(1);
});
$('to-epoch').addEventListener('click', () => {
  if (!catalog || selected < 0) return;
  clock.simMs = catalog.entries[selected].tle.epochMs;
  setSpeed(0);
});

const toast = createToast($('toast'));
const statusEl = $('status');
function setStatus(text: string) {
  statusEl.textContent = text;
}

function updateStatus() {
  updateRefreshButton();
  if (!catalog || !dataInfo || loading) return;
  const ageMin = Math.round((Date.now() - dataInfo.fetchedAt) / 60000);
  const source = {
    network: 'fresh from CelesTrak',
    cache: 'from cache',
    'stale-cache': 'old cache (CelesTrak unreachable)',
    snapshot: 'bundled snapshot',
  }[dataInfo.source];
  const age = ageMin < 1 ? 'just now' : ageMin < 120 ? `${ageMin} min ago` : `${(ageMin / 60).toFixed(1)} h ago`;
  setStatus(
    `${catalog.size.toLocaleString()} objects · ${source}, fetched ${age} · SGP4 worker ${client.lastWorkerMs.toFixed(1)} ms`,
  );
}

const clockEl = $('clock');
let lastUiUpdate = -Infinity;

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const sunVec = new THREE.Vector3();

function frame(now: number) {
  const dt = now - clock.lastReal;
  clock.lastReal = now;
  clock.simMs += dt * clock.speed;
  client.request(clock.simMs);

  const t = displayTime();
  const jd = julianDate(t);
  const theta = gmst(jd);

  earth.setSunDirection(toVec(ecefToScene(temeToEcef(sunDirectionEci(jd), theta)), sunVec));

  if (catalog) sats.update(client.positions, camera, window.innerHeight);
  updateSelection(t, theta, now);

  if (follow && selected >= 0 && Number.isFinite(selectedScene.x)) {
    const dist = Math.max(camera.position.length(), selectedScene.length() + 0.6);
    camera.position.copy(selectedScene).normalize().multiplyScalar(dist);
  }

  controls.update();
  renderer.render(scene, camera);

  if (now - lastUiUpdate > 250) {
    lastUiUpdate = now;
    clockEl.textContent = new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    updateStatus();
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
loadGroup(groupSelect.value);
