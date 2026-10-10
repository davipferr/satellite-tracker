/**
 * Thousands of satellites in a single draw call with InstancedMesh.
 *
 * Every frame we rewrite each instance's 4×4 matrix directly in the underlying
 * Float32Array — only the translation and a uniform scale change, so we skip
 * Matrix4.compose() and touch just 4 of the 16 floats.
 */

import * as THREE from 'three';

const PIXEL_RADIUS = 2.2;
const SELECTED_PIXEL_RADIUS = 6;
const HOVER_PIXEL_RADIUS = 4;

export class SatelliteLayer {
  readonly mesh: THREE.InstancedMesh;
  private capacity: number;
  private count = 0;
  private baseColors: Float32Array = new Float32Array(0);
  selected = -1;
  hovered = -1;

  constructor(capacity = 1024) {
    this.capacity = capacity;
    this.mesh = this.build(capacity);
  }

  private build(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      capacity,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Positions change every frame, so a cached bounding sphere would be wrong.
    mesh.frustumCulled = false;
    mesh.count = 0;
    const m = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < capacity; i++) m[i * 16 + 15] = 1;
    mesh.setColorAt(0, new THREE.Color()); // allocates instanceColor
    return mesh;
  }

  /** Resize for a new catalog. `colors` is rgb per satellite. */
  setCatalog(colors: Float32Array, parent: THREE.Object3D) {
    const n = colors.length / 3;
    if (n > this.capacity) {
      parent.remove(this.mesh);
      this.mesh.dispose();
      this.capacity = Math.ceil(n * 1.25);
      (this as { mesh: THREE.InstancedMesh }).mesh = this.build(this.capacity);
      parent.add(this.mesh);
    }
    this.count = n;
    this.mesh.count = n;
    this.baseColors = colors;
    this.selected = this.hovered = -1;
    this.refreshColors();
  }

  refreshColors() {
    const c = this.mesh.instanceColor!.array as Float32Array;
    c.set(this.baseColors);
    for (const [i, rgb] of [
      [this.hovered, [1, 1, 1]],
      [this.selected, [1, 0.85, 0.2]],
    ] as const) {
      if (i >= 0) c.set(rgb, i * 3);
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /**
   * @param positions scene xyz per satellite (NaN = hide)
   * @param camera used to keep markers a constant size on screen
   */
  update(positions: Float32Array, camera: THREE.PerspectiveCamera, viewportHeight: number) {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const cam = camera.position;
    // World size of one pixel at distance 1.
    const pxPerUnit = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewportHeight;

    for (let i = 0; i < this.count; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const o = i * 16;
      if (Number.isNaN(x)) {
        m[o] = m[o + 5] = m[o + 10] = 0;
        continue;
      }
      const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
      const px = i === this.selected ? SELECTED_PIXEL_RADIUS : i === this.hovered ? HOVER_PIXEL_RADIUS : PIXEL_RADIUS;
      const s = d * pxPerUnit * px;
      m[o] = m[o + 5] = m[o + 10] = s;
      m[o + 12] = x;
      m[o + 13] = y;
      m[o + 14] = z;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Screen-space picking: find the satellite closest to the cursor (within a few pixels)
 * that isn't hidden behind the Earth. Far more forgiving than raycasting 3-px spheres.
 */
export function pickSatellite(
  positions: Float32Array,
  count: number,
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  viewport: { width: number; height: number },
  maxPixels = 10,
): number {
  const v = new THREE.Vector3();
  const cam = camera.position;
  let best = -1;
  let bestD2 = maxPixels * maxPixels;

  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    if (Number.isNaN(x)) continue;
    v.set(x, positions[i * 3 + 1], positions[i * 3 + 2]).project(camera);
    if (v.z > 1) continue; // behind camera
    const dx = ((v.x - ndcX) * viewport.width) / 2;
    const dy = ((v.y - ndcY) * viewport.height) / 2;
    const d2 = dx * dx + dy * dy;
    if (d2 >= bestD2) continue;
    if (occludedByEarth(cam, x, positions[i * 3 + 1], positions[i * 3 + 2])) continue;
    best = i;
    bestD2 = d2;
  }
  return best;
}

/** Does the segment camera→point pass through the unit sphere? */
function occludedByEarth(c: THREE.Vector3, px: number, py: number, pz: number): boolean {
  const dx = px - c.x, dy = py - c.y, dz = pz - c.z;
  const len = Math.hypot(dx, dy, dz);
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // Closest approach of the ray to the origin.
  const t = -(c.x * ux + c.y * uy + c.z * uz);
  if (t < 0 || t > len) return false;
  const cx = c.x + ux * t, cy = c.y + uy * t, cz = c.z + uz * t;
  return cx * cx + cy * cy + cz * cz < 0.995;
}
