/**
 * Keplerian vs SGP4: how far apart are they as time goes on?
 *
 * Two flavours of two-body orbit, both started at the TLE epoch:
 *  - "TLE elements": the TLE's mean elements plugged straight into Kepler. Already off
 *    at t = 0 because mean ≠ osculating elements.
 *  - "SGP4 state": seeded with SGP4's exact position/velocity at the epoch, so the error
 *    starts at zero and shows purely what two-body physics is missing (J2, drag, …).
 */

import { keplerFromState, keplerFromTle, propagateKepler, type KeplerOrbit } from '../orbit/kepler';
import { propagateSgp4, type SatRec } from '../orbit/sgp4';
import type { Tle } from '../tle/parse';

export type KeplerSeed = 'tle' | 'state';

export interface ErrorSeries {
  spanDays: number;
  days: Float64Array;
  /** Position difference to SGP4 in km, NaN where SGP4 failed. */
  fromTle: Float64Array;
  fromState: Float64Array;
}

export function makeKeplerOrbits(tle: Tle, satrec: SatRec): Record<KeplerSeed, KeplerOrbit> | null {
  const atEpoch = propagateSgp4(satrec, tle.epochMs, tle.epochMs);
  if (!atEpoch) return null;
  try {
    return { tle: keplerFromTle(tle), state: keplerFromState(atEpoch, tle.epochMs) };
  } catch {
    return null;
  }
}

export function computeErrorSeries(tle: Tle, satrec: SatRec, spanDays: number, samples = 1200): ErrorSeries | null {
  const orbits = makeKeplerOrbits(tle, satrec);
  if (!orbits) return null;

  const days = new Float64Array(samples);
  const fromTle = new Float64Array(samples);
  const fromState = new Float64Array(samples);

  for (let i = 0; i < samples; i++) {
    const d = (spanDays * i) / (samples - 1);
    const t = tle.epochMs + d * 86_400_000;
    days[i] = d;
    const ref = propagateSgp4(satrec, tle.epochMs, t);
    if (!ref) {
      fromTle[i] = fromState[i] = NaN;
      continue;
    }
    const a = propagateKepler(orbits.tle, t).r;
    const b = propagateKepler(orbits.state, t).r;
    fromTle[i] = Math.hypot(a.x - ref.r.x, a.y - ref.r.y, a.z - ref.r.z);
    fromState[i] = Math.hypot(b.x - ref.r.x, b.y - ref.r.y, b.z - ref.r.z);
  }
  return { spanDays, days, fromTle, fromState };
}
