import { describe, expect, it } from 'vitest';
import * as sat from 'satellite.js';
import { parseImpliedDecimal, parseCatalogNumber, parseTle, parseTleText, tleChecksum } from './tle/parse';
import { gmst, julianDate } from './coords/time';
import { ecefToGeodetic, geodeticToEcef, temeToEcef, ecefToScene } from './coords/transforms';
import { keplerFromState, keplerFromTle, propagateKepler, MU } from './orbit/kepler';
import { makeSatrec, propagateSgp4 } from './orbit/sgp4';

// The classic ISS example TLE (Wikipedia / CelesTrak docs).
const NAME = 'ISS (ZARYA)';
const L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

const dist = (a: sat.EciVec3<number>, b: sat.EciVec3<number>) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('TLE parser', () => {
  it('parses every field of the ISS example', () => {
    const t = parseTle(L1, L2, NAME);
    expect(t.name).toBe('ISS (ZARYA)');
    expect(t.catalogNumber).toBe(25544);
    expect(t.classification).toBe('U');
    expect(t.intlDesignator).toBe('98067A');
    expect(t.epochYear).toBe(2008);
    expect(t.epochDay).toBeCloseTo(264.51782528, 8);
    expect(t.meanMotionDot).toBeCloseTo(-0.00002182, 10);
    expect(t.meanMotionDdot).toBe(0);
    expect(t.bstar).toBeCloseTo(-0.11606e-4, 12);
    expect(t.elementSetNumber).toBe(292);
    expect(t.inclinationDeg).toBe(51.6416);
    expect(t.raanDeg).toBe(247.4627);
    expect(t.eccentricity).toBeCloseTo(0.0006703, 10);
    expect(t.argPerigeeDeg).toBe(130.536);
    expect(t.meanAnomalyDeg).toBe(325.0288);
    expect(t.meanMotion).toBe(15.72125391);
    expect(t.revNumber).toBe(56353);
    // Day 264.51782528 of 2008 (leap year) = Sep 20, 12:25:40 UTC
    expect(new Date(t.epochMs).toISOString()).toBe('2008-09-20T12:25:40.104Z');
  });

  it('agrees with satellite.js own TLE reader', () => {
    const t = parseTle(L1, L2);
    const ref = sat.twoline2satrec(L1, L2);
    expect(t.inclinationDeg * (Math.PI / 180)).toBeCloseTo(ref.inclo, 12);
    expect(t.eccentricity).toBeCloseTo(ref.ecco, 12);
    expect(t.bstar).toBeCloseTo(ref.bstar, 15);
    expect(t.epochJd).toBeCloseTo(ref.jdsatepoch, 7);
  });

  it('computes checksums and rejects corrupted lines', () => {
    expect(tleChecksum(L1)).toBe(7);
    expect(tleChecksum(L2)).toBe(7);
    const bad = L2.replace('51.6416', '51.6417');
    expect(() => parseTle(L1, bad)).toThrow(/Checksum/);
  });

  it('decodes implied decimals and Alpha-5 catalog numbers', () => {
    expect(parseImpliedDecimal(' 12345-3')).toBeCloseTo(0.12345e-3, 15);
    expect(parseImpliedDecimal('-11606-4')).toBeCloseTo(-0.11606e-4, 15);
    expect(parseImpliedDecimal(' 00000+0')).toBe(0);
    expect(parseCatalogNumber('A0001')).toBe(100001);
    expect(parseCatalogNumber('J2931')).toBe(182931);
    expect(parseCatalogNumber('Z9999')).toBe(339999);
  });

  it('parses 3-line and 2-line text blocks, skipping garbage', () => {
    const text = `${NAME}\n${L1}\n${L2}\n${L1}\r\n${L2}\nnot a tle\n`;
    const { tles, errors } = parseTleText(text);
    expect(tles).toHaveLength(2);
    expect(tles[1].name).toBe('NORAD 25544');
    expect(errors).toHaveLength(1);
  });
});

describe('time and frames', () => {
  it('Julian date of J2000', () => {
    expect(julianDate(Date.UTC(2000, 0, 1, 12))).toBe(2451545);
  });

  it('GMST matches satellite.js', () => {
    for (const ms of [Date.UTC(2008, 8, 20, 12, 25, 40), Date.UTC(2026, 9, 10, 3, 0, 0), Date.UTC(1999, 0, 1)]) {
      expect(gmst(julianDate(ms))).toBeCloseTo(sat.gstime(new Date(ms)), 10);
    }
  });

  it('TEME→ECEF→geodetic matches satellite.js', () => {
    const r = { x: 4000, y: -3000, z: 4500 };
    const g = gmst(julianDate(Date.UTC(2026, 3, 1, 6)));
    const ours = ecefToGeodetic(temeToEcef(r, g));
    const ref = sat.eciToGeodetic(r, g);
    expect(ours.lat).toBeCloseTo(ref.latitude, 9);
    expect(ours.lon).toBeCloseTo(ref.longitude, 9);
    expect(ours.alt).toBeCloseTo(ref.height, 5);
  });

  it('geodetic round trip, including near the pole', () => {
    for (const g of [
      { lat: 0.3, lon: -2, alt: 420 },
      { lat: 1.5707, lon: 1, alt: 800 },
      { lat: -0.9, lon: 3.1, alt: 35786 },
    ]) {
      const back = ecefToGeodetic(geodeticToEcef(g));
      expect(back.lat).toBeCloseTo(g.lat, 10);
      expect(back.lon).toBeCloseTo(g.lon, 10);
      expect(back.alt).toBeCloseTo(g.alt, 6);
    }
  });

  it('maps ECEF axes onto Three.js axes (y up, 90°E on −z)', () => {
    const pole = ecefToScene({ x: 0, y: 0, z: 6378.137 }); // north pole
    expect([pole.x, pole.y, pole.z + 0]).toEqual([0, 1, 0]);
    const east = ecefToScene({ x: 0, y: 6378.137, z: 0 }); // 90°E
    expect([east.x, east.y, east.z]).toEqual([0, 0, -1]);
  });
});

describe('propagators', () => {
  const tle = parseTle(L1, L2, NAME);
  const satrec = makeSatrec(tle);

  it('our parse → OMM → satrec gives the same SGP4 output as satellite.js parsing the lines', () => {
    const ref = sat.twoline2satrec(L1, L2);
    for (const minutes of [0, 90, 1440, 4320]) {
      const ours = propagateSgp4(satrec, tle.epochMs, tle.epochMs + minutes * 60000)!;
      const theirs = sat.sgp4(ref, minutes)!;
      expect(dist(ours.r, theirs.position)).toBeLessThan(0.01); // < 10 m (OMM epoch rounding)
    }
  });

  it('Kepler returns to the start after exactly one period and conserves energy', () => {
    const start = propagateSgp4(satrec, tle.epochMs, tle.epochMs)!;
    const orbit = keplerFromState(start, tle.epochMs);
    const period = (2 * Math.PI) / orbit.n;
    const after = propagateKepler(orbit, tle.epochMs + period * 1000 * 37);
    expect(dist(after.r, start.r)).toBeLessThan(1e-4);

    const energy = (s: typeof start) =>
      (s.v.x ** 2 + s.v.y ** 2 + s.v.z ** 2) / 2 - MU / Math.hypot(s.r.x, s.r.y, s.r.z);
    const mid = propagateKepler(orbit, tle.epochMs + period * 1000 * 0.37);
    expect(energy(mid)).toBeCloseTo(energy(start), 9);
  });

  it('Kepler vs SGP4: zero at epoch (state init), then the error grows', () => {
    const start = propagateSgp4(satrec, tle.epochMs, tle.epochMs)!;
    const orbit = keplerFromState(start, tle.epochMs);
    const err = (hours: number) => {
      const t = tle.epochMs + hours * 3600e3;
      return dist(propagateKepler(orbit, t).r, propagateSgp4(satrec, tle.epochMs, t)!.r);
    };
    expect(err(0)).toBeLessThan(1e-9);
    expect(err(1)).toBeGreaterThan(err(0.1));
    expect(err(24)).toBeGreaterThan(100); // J2 alone makes this hundreds of km in a day
  });

  it('Kepler from raw TLE mean elements is already off at epoch', () => {
    const orbit = keplerFromTle(tle);
    const sgp = propagateSgp4(satrec, tle.epochMs, tle.epochMs)!;
    const offset = dist(orbit.r0, sgp.r);
    expect(offset).toBeGreaterThan(1);
    expect(offset).toBeLessThan(50);
  });
});
