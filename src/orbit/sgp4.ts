/**
 * Thin wrapper over satellite.js. We only borrow its SGP4/SDP4 implementation:
 * the satrec is built from *our* parsed TLE via the OMM (JSON) entry point, so
 * satellite.js never sees the raw TLE lines.
 */

import { json2satrec, sgp4, type OMMJsonObject, type SatRec } from 'satellite.js';
import type { Tle } from '../tle/parse';
import type { StateVector } from './kepler';

export type { SatRec };

export function tleToOmm(tle: Tle): OMMJsonObject {
  return {
    OBJECT_NAME: tle.name,
    OBJECT_ID: tle.intlDesignator,
    EPOCH: new Date(tle.epochMs).toISOString(),
    MEAN_MOTION: tle.meanMotion,
    ECCENTRICITY: tle.eccentricity,
    INCLINATION: tle.inclinationDeg,
    RA_OF_ASC_NODE: tle.raanDeg,
    ARG_OF_PERICENTER: tle.argPerigeeDeg,
    MEAN_ANOMALY: tle.meanAnomalyDeg,
    NORAD_CAT_ID: tle.catalogNumber,
    ELEMENT_SET_NO: tle.elementSetNumber,
    REV_AT_EPOCH: tle.revNumber,
    BSTAR: tle.bstar,
    MEAN_MOTION_DOT: tle.meanMotionDot,
    MEAN_MOTION_DDOT: tle.meanMotionDdot,
  };
}

export function makeSatrec(tle: Tle): SatRec {
  return json2satrec(tleToOmm(tle));
}

/**
 * SGP4 position/velocity in TEME (km, km/s) at an absolute time, or null if the
 * model fails (e.g. the satellite has decayed by that time).
 */
export function propagateSgp4(satrec: SatRec, epochMs: number, timeMs: number): StateVector | null {
  const minutesSinceEpoch = (timeMs - epochMs) / 60000;
  const result = sgp4(satrec, minutesSinceEpoch);
  if (!result) return null;
  return { r: result.position, v: result.velocity };
}
