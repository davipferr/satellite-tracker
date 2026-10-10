/**
 * Coordinate chain:  TEME  →(rotate by GMST)→  ECEF  →(WGS-84)→  lat/lon/alt
 *                                               ECEF  →(axis swap + scale)→  Three.js scene
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Geodetic {
  /** Geodetic latitude, radians. */
  lat: number;
  /** Longitude, radians, in (-π, π]. */
  lon: number;
  /** Height above the WGS-84 ellipsoid, km. */
  alt: number;
}

export const WGS84_A = 6378.137; // equatorial radius, km
export const WGS84_F = 1 / 298.257223563; // flattening
export const WGS84_B = WGS84_A * (1 - WGS84_F); // polar radius, km
const E2 = WGS84_F * (2 - WGS84_F); // first eccentricity squared

/**
 * TEME (True Equator, Mean Equinox) → ECEF.
 *
 * TEME is the quasi-inertial frame SGP4 works in. Its z axis is the Earth's spin
 * axis, so going to Earth-fixed is a single rotation about z by the Earth's rotation
 * angle (GMST). We ignore polar motion (< 15 m).
 *
 * Rotating the *frame* by +θ means rotating the *vector* by −θ:
 *   x' =  cos θ·x + sin θ·y
 *   y' = −sin θ·x + cos θ·y
 */
export function temeToEcef(r: Vec3, gmstRad: number): Vec3 {
  const c = Math.cos(gmstRad);
  const s = Math.sin(gmstRad);
  return { x: c * r.x + s * r.y, y: -s * r.x + c * r.y, z: r.z };
}

/**
 * ECEF → geodetic latitude/longitude/altitude on the WGS-84 ellipsoid.
 *
 * Longitude is a plain atan2. Latitude is harder: geodetic latitude is the angle of
 * the ellipsoid *normal*, which doesn't pass through the Earth's centre, so there's no
 * closed form that's also simple. We iterate — it converges to sub-millimetre in 3-4 steps.
 */
export function ecefToGeodetic(p: Vec3): Geodetic {
  const lon = Math.atan2(p.y, p.x);
  const rxy = Math.hypot(p.x, p.y);

  // Start from the geocentric latitude corrected for flattening.
  let lat = Math.atan2(p.z, rxy * (1 - E2));
  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat); // prime-vertical radius of curvature
    lat = Math.atan2(p.z + E2 * n * sinLat, rxy);
  }

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  // Height formula that stays well-behaved at the poles (no division by cos lat).
  const alt = rxy * cosLat + p.z * sinLat - WGS84_A * Math.sqrt(1 - E2 * sinLat * sinLat);

  return { lat, lon, alt };
}

export function geodeticToEcef(g: Geodetic): Vec3 {
  const sinLat = Math.sin(g.lat);
  const cosLat = Math.cos(g.lat);
  const n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return {
    x: (n + g.alt) * cosLat * Math.cos(g.lon),
    y: (n + g.alt) * cosLat * Math.sin(g.lon),
    z: (n * (1 - E2) + g.alt) * sinLat,
  };
}

/**
 * ECEF (km, z = north pole) → Three.js scene units (y up, 1 unit = equatorial radius).
 *
 * Three's SphereGeometry puts u = 0.5 (longitude 0 on an equirectangular map) on +x,
 * and u = 0.75 (90°E) on −z. So:  scene = (x, z, −y) / R.
 */
export const SCENE_SCALE = 1 / WGS84_A;

export function ecefToScene(p: Vec3): Vec3 {
  return { x: p.x * SCENE_SCALE, y: p.z * SCENE_SCALE, z: -p.y * SCENE_SCALE };
}

/** Allocation-free variant for hot loops: writes scene coords into out[offset..offset+2]. */
export function ecefToSceneInto(x: number, y: number, z: number, out: Float32Array, offset: number): void {
  out[offset] = x * SCENE_SCALE;
  out[offset + 1] = z * SCENE_SCALE;
  out[offset + 2] = -y * SCENE_SCALE;
}

export function sceneToEcef(p: Vec3): Vec3 {
  return { x: p.x * WGS84_A, y: -p.z * WGS84_A, z: p.y * WGS84_A };
}
