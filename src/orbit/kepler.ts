/**
 * A pure two-body (Keplerian) propagator.
 *
 * The only force is a point-mass Earth. No J2 oblateness, no drag, no Sun/Moon —
 * which is exactly why it drifts away from SGP4. For the ISS the biggest culprit is J2:
 * it swings the orbital plane west by ~5°/day (nodal regression), which alone is
 * ~600 km/day of cross-track error.
 *
 * Propagation uses Lagrange f and g coefficients with Kepler's equation written in
 * terms of ΔE (change in eccentric anomaly). That form never needs ω, Ω or ν, so it has
 * no singularities for circular or equatorial orbits — handy, since Starlink and GEO
 * satellites are nearly both.
 */

import type { Vec3 } from '../coords/transforms';
import type { Tle } from '../tle/parse';

/** Earth's gravitational parameter, km³/s². WGS-72, the value SGP4 is built on. */
export const MU = 398600.8;

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;

export interface StateVector {
  r: Vec3; // km
  v: Vec3; // km/s
}

export interface ClassicalElements {
  a: number; // semi-major axis, km
  e: number;
  i: number; // rad
  raan: number; // rad
  argPerigee: number; // rad
  meanAnomaly: number; // rad
}

export interface KeplerOrbit {
  epochMs: number;
  r0: Vec3;
  v0: Vec3;
  r0Mag: number;
  /** Semi-major axis, km. */
  a: number;
  /** Mean motion, rad/s. */
  n: number;
  /** r0·v0 / √μ — shows up in Kepler's equation in ΔE form. */
  sigma0: number;
}

/** Solve Kepler's equation  M = E − e·sin E  for E with Newton's method. */
export function solveKepler(meanAnomaly: number, e: number): number {
  const M = ((meanAnomaly % TWO_PI) + TWO_PI) % TWO_PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 50; k++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

/** Classical orbital elements → position/velocity in the same inertial frame. */
export function elementsToState(el: ClassicalElements, mu = MU): StateVector {
  const { a, e, i, raan, argPerigee } = el;
  const E = solveKepler(el.meanAnomaly, e);
  const trueAnomaly = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));

  // Position and velocity in the perifocal frame (x toward perigee, z along angular momentum).
  const p = a * (1 - e * e);
  const r = a * (1 - e * Math.cos(E));
  const xp = r * Math.cos(trueAnomaly);
  const yp = r * Math.sin(trueAnomaly);
  const k = Math.sqrt(mu / p);
  const vxp = -k * Math.sin(trueAnomaly);
  const vyp = k * (e + Math.cos(trueAnomaly));

  // Rotate perifocal → inertial: R3(−Ω) · R1(−i) · R3(−ω)
  const cO = Math.cos(raan), sO = Math.sin(raan);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(argPerigee), sw = Math.sin(argPerigee);
  const m11 = cO * cw - sO * sw * ci, m12 = -cO * sw - sO * cw * ci;
  const m21 = sO * cw + cO * sw * ci, m22 = -sO * sw + cO * cw * ci;
  const m31 = sw * si, m32 = cw * si;

  return {
    r: { x: m11 * xp + m12 * yp, y: m21 * xp + m22 * yp, z: m31 * xp + m32 * yp },
    v: { x: m11 * vxp + m12 * vyp, y: m21 * vxp + m22 * vyp, z: m31 * vxp + m32 * vyp },
  };
}

/** Build a two-body orbit from any position/velocity at a given instant. */
export function keplerFromState(state: StateVector, epochMs: number, mu = MU): KeplerOrbit {
  const { r, v } = state;
  const r0Mag = Math.hypot(r.x, r.y, r.z);
  const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
  // Vis-viva:  v² = μ(2/r − 1/a)
  const a = 1 / (2 / r0Mag - v2 / mu);
  if (!(a > 0)) throw new Error('Orbit is not elliptical');
  return {
    epochMs,
    r0: { ...r },
    v0: { ...v },
    r0Mag,
    a,
    n: Math.sqrt(mu / (a * a * a)),
    sigma0: (r.x * v.x + r.y * v.y + r.z * v.z) / Math.sqrt(mu),
  };
}

/**
 * Build a two-body orbit straight from the TLE's elements, treating them as if they
 * were osculating Keplerian elements.
 *
 * They aren't: TLE elements are SGP4 *mean* elements, with short-period J2 wobbles
 * averaged out (and mean motion in Kozai's convention). So even at the epoch this
 * orbit is off by several km — which is a lesson in itself.
 */
export function keplerFromTle(tle: Tle, mu = MU): KeplerOrbit {
  const n = (tle.meanMotion * TWO_PI) / 86400; // rev/day → rad/s
  const a = Math.cbrt(mu / (n * n)); // Kepler's third law
  const state = elementsToState(
    {
      a,
      e: tle.eccentricity,
      i: tle.inclinationDeg * DEG,
      raan: tle.raanDeg * DEG,
      argPerigee: tle.argPerigeeDeg * DEG,
      meanAnomaly: tle.meanAnomalyDeg * DEG,
    },
    mu,
  );
  return keplerFromState(state, tle.epochMs, mu);
}

/** Propagate to an absolute time (Unix ms). Returns position/velocity in the orbit's inertial frame. */
export function propagateKepler(orbit: KeplerOrbit, timeMs: number, mu = MU): StateVector {
  const { a, n, r0, v0, r0Mag, sigma0 } = orbit;
  const dt = (timeMs - orbit.epochMs) / 1000;

  // Whole revolutions don't change anything in two-body motion, so wrap ΔM into (−π, π]
  // to keep Newton's method well-conditioned for long propagations.
  let dM = (n * dt) % TWO_PI;
  if (dM > Math.PI) dM -= TWO_PI;
  else if (dM <= -Math.PI) dM += TWO_PI;

  // Kepler's equation in ΔE:  ΔM = ΔE + (σ0/√a)(1 − cos ΔE) − (1 − r0/a) sin ΔE
  const sqrtA = Math.sqrt(a);
  const c1 = sigma0 / sqrtA; //   e·sin E0
  const c2 = 1 - r0Mag / a; //    e·cos E0
  let dE = dM;
  for (let k = 0; k < 50; k++) {
    const sinE = Math.sin(dE);
    const cosE = Math.cos(dE);
    const f = dE + c1 * (1 - cosE) - c2 * sinE - dM;
    const fPrime = 1 + c1 * sinE - c2 * cosE; // equals r/a, always > 0
    const step = f / fPrime;
    dE -= step;
    if (Math.abs(step) < 1e-13) break;
  }

  const sinE = Math.sin(dE);
  const cosE = Math.cos(dE);
  const r = a + (r0Mag - a) * cosE + sigma0 * sqrtA * sinE;

  const f = 1 - (a / r0Mag) * (1 - cosE);
  const g = (dM - (dE - sinE)) / n; // = Δt − (ΔE − sin ΔE)/n, using the wrapped Δt
  const fDot = (-Math.sqrt(mu * a) / (r * r0Mag)) * sinE;
  const gDot = 1 - (a / r) * (1 - cosE);

  return {
    r: { x: f * r0.x + g * v0.x, y: f * r0.y + g * v0.y, z: f * r0.z + g * v0.z },
    v: { x: fDot * r0.x + gDot * v0.x, y: fDot * r0.y + gDot * v0.y, z: fDot * r0.z + gDot * v0.z },
  };
}
