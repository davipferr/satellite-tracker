const MS_PER_DAY = 86_400_000;
/** Julian date of the Unix epoch, 1970-01-01T00:00:00Z. */
const JD_UNIX_EPOCH = 2440587.5;
/** Julian date of J2000.0, 2000-01-01T12:00:00 TT (we treat it as UTC — close enough here). */
export const JD_J2000 = 2451545.0;

export function julianDate(unixMs: number): number {
  return unixMs / MS_PER_DAY + JD_UNIX_EPOCH;
}

/**
 * Greenwich Mean Sidereal Time in radians, IAU-82 model (Vallado eq. 3-47).
 *
 * GMST is the angle between the vernal equinox and the Greenwich meridian — i.e. how
 * far the Earth has rotated in inertial space. It's exactly the rotation that takes
 * the TEME frame SGP4 outputs into the Earth-fixed frame.
 *
 * Strictly the input should be UT1; UTC differs from it by < 0.9 s, which moves a
 * point on the equator by < 0.4 km. We ignore it.
 */
export function gmst(jdUt1: number): number {
  const t = (jdUt1 - JD_J2000) / 36525; // Julian centuries since J2000
  let seconds =
    67310.54841 + (876600 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t * t * t;
  seconds %= 86400;
  // 86400 s of sidereal time = 360°, so 1 s = 1/240 degree.
  let rad = ((seconds / 240) * Math.PI) / 180;
  if (rad < 0) rad += 2 * Math.PI;
  return rad;
}
