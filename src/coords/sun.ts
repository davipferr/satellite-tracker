import type { Vec3 } from './transforms';
import { JD_J2000 } from './time';

const DEG = Math.PI / 180;

/**
 * Unit vector from Earth to Sun in an Earth-centred inertial frame (≈ TEME / mean-of-date),
 * using the low-precision formula from the Astronomical Almanac. Good to ~0.01°,
 * which is far better than a smoothstep terminator needs.
 */
export function sunDirectionEci(jd: number): Vec3 {
  const n = jd - JD_J2000;
  const meanLongitude = (280.46 + 0.9856474 * n) * DEG;
  const meanAnomaly = (357.528 + 0.9856003 * n) * DEG;
  const eclipticLongitude =
    meanLongitude + 1.915 * DEG * Math.sin(meanAnomaly) + 0.02 * DEG * Math.sin(2 * meanAnomaly);
  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  return {
    x: Math.cos(eclipticLongitude),
    y: Math.cos(obliquity) * Math.sin(eclipticLongitude),
    z: Math.sin(obliquity) * Math.sin(eclipticLongitude),
  };
}
