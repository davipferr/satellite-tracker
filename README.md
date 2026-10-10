# Satellite Tracker

Real-time 3D satellite tracker built from first principles with **TypeScript + Vite + Three.js**, using
**satellite.js only for SGP4** and live orbital data from **CelesTrak**.

```bash
npm install
npm run textures   # downloads NASA Blue Marble + Black Marble into public/textures/
npm run dev
```

`npm test` runs the unit tests, which check the hand-written parts against satellite.js's reference
implementations. `npm run build` type-checks and builds to `dist/`.

## What's hand-written and where

| Piece | File | Notes |
|---|---|---|
| TLE parser | [src/tle/parse.ts](src/tle/parse.ts) | Fixed-column parsing, checksums, implied-decimal fields (`-11606-4`), Alpha-5 catalog numbers, 2- and 3-line formats. |
| Keplerian propagator | [src/orbit/kepler.ts](src/orbit/kepler.ts) | Elements → state vector, then Lagrange f/g with Kepler's equation in ΔE (no singularities for circular/equatorial orbits). |
| SGP4 bridge | [src/orbit/sgp4.ts](src/orbit/sgp4.ts) | The parsed TLE is converted to OMM and fed to `json2satrec`, so satellite.js never parses the TLE itself. |
| GMST | [src/coords/time.ts](src/coords/time.ts) | IAU-82 sidereal time. |
| TEME → ECEF → geodetic → scene | [src/coords/transforms.ts](src/coords/transforms.ts) | Rotation by GMST, iterative WGS-84 latitude, and the axis swap `scene = (x, z, −y) / R⊕`. |
| Sun position | [src/coords/sun.ts](src/coords/sun.ts) | Astronomical Almanac low-precision formula. |
| Earth, lighting, terminator | [src/scene/earth.ts](src/scene/earth.ts) | Custom GLSL: Lambert + ocean specular, smoothstep day/night blend with city lights, atmosphere shell. Ellipsoid flattening applied. |
| Kepler vs SGP4 | [src/sim/compare.ts](src/sim/compare.ts), [src/ui/errorChart.ts](src/ui/errorChart.ts) | Error over 1–14 days, hand-drawn log chart, live “ghost” on the globe. |
| CelesTrak cache | [src/data/celestrak.ts](src/data/celestrak.ts) | Cache Storage, 2 h TTL, falls back to stale data when rate-limited or offline. |
| Worker + InstancedMesh | [src/worker/propagation.worker.ts](src/worker/propagation.worker.ts), [src/sim/propagationClient.ts](src/sim/propagationClient.ts), [src/scene/satellites.ts](src/scene/satellites.ts) | Transferable ping-pong buffers, one request in flight, constant-pixel-size instances, screen-space picking. |

## Design notes

- **The scene is Earth-fixed.** The globe never rotates; the Sun direction moves instead. Satellite
  positions, ground tracks and picking then all share one frame (ECEF), and the orbit path shows the
  real spiral a satellite traces over a rotating Earth.
- **Displayed time follows the worker.** Worker results arrive one frame late, so the Sun, the
  selection panel and the tracks use the worker's timestamp. Otherwise, at 1 day/s, the selected
  marker would visibly trail its own orbit line.
- **Two Kepler seeds.** Seeding from the TLE's *mean* elements is off by a few km at epoch.
  Seeding from SGP4's *osculating* state is exact at epoch, but it drifts faster because short-period
  J2 terms bias the semi-major axis, which gives the wrong period. Pick either seed in the UI.
- **Ignored on purpose:** UT1−UTC (< 0.4 km), polar motion (< 15 m), and the equation of the
  equinoxes. They're all below what you can see.

## Data

CelesTrak GP API, e.g. `https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle`.
In dev, requests go through Vite's proxy (`/celestrak`). Production builds call CelesTrak directly
(it sends `Access-Control-Allow-Origin: *`).

CelesTrak allows **one download per group every 2 hours per IP** and answers HTTP 403 otherwise.
The limit applies to the whole network, so a second device on the same Wi-Fi gets refused even
with an empty cache. The app falls back in this order:

1. Browser cache (2 h). A 403 when a cached copy exists just means the copy is current.
2. Any older cached copy.
3. A snapshot of every group, bundled with the site. GitHub Actions downloads it on each deploy
   and every 6 hours ([scripts/fetch-snapshots.mjs](scripts/fetch-snapshots.mjs)).

The "Check CelesTrak for new data" button stays disabled until CelesTrak will actually serve new
data.

Textures: NASA Visible Earth (public domain). Blue Marble Next Generation, Dec 2004, 5400×2700, and
Black Marble 2016 night lights, 3600×1800. Without them the app falls back to a grid texture.

## Next step (optional)

React Three Fiber: once the raw Three.js version makes sense, port `scene/` to R3F components. The
math, worker and data layers don't depend on Three.js, so they carry over unchanged.
