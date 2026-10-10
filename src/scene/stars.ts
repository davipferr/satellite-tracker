import * as THREE from 'three';

/** A cheap starfield: random points on a far sphere with varied brightness. */
export function createStars(count = 6000, radius = 400): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Uniform on a sphere: z uniform in [-1, 1], angle uniform in [0, 2π).
    const z = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    positions.set([r * Math.cos(a) * radius, z * radius, r * Math.sin(a) * radius], i * 3);
    const b = 0.25 + Math.pow(Math.random(), 4) * 0.75;
    const tint = Math.random();
    colors.set([b * (0.85 + 0.15 * tint), b * 0.9, b * (1 - 0.15 * tint)], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true, depthWrite: false }),
  );
}
