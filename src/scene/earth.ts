/**
 * The Earth: a sphere, two NASA textures, and a hand-written shader that does the
 * lighting and the day/night terminator.
 *
 * The scene is Earth-fixed (ECEF): the globe never rotates — the Sun moves around it.
 * That keeps satellite positions, the ground track and picking all in one frame.
 */

import * as THREE from 'three';
import { WGS84_F } from '../coords/transforms';

const ATMOSPHERE_RADIUS = 1.025;

const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const earthFragment = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform vec3 sunDir;      // unit vector toward the Sun, scene space
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPosW);
    float cosSun = dot(n, sunDir);

    // Terminator: not a hard edge — blend across ~12° to fake twilight.
    float dayMix = smoothstep(-0.10, 0.10, cosSun);

    vec3 day = texture2D(dayMap, vUv).rgb;
    vec3 night = texture2D(nightMap, vUv).rgb;

    // Lambert diffuse with a little ambient so the night side isn't pitch black.
    vec3 lit = day * (0.04 + 1.1 * max(cosSun, 0.0));

    // Blinn-Phong highlight on water. No specular map, so call "water" anything
    // where blue clearly dominates.
    float water = smoothstep(0.02, 0.10, day.b - max(day.r, day.g));
    vec3 h = normalize(sunDir + v);
    lit += vec3(1.0, 0.95, 0.85) * pow(max(dot(n, h), 0.0), 60.0) * 0.6 * water * step(0.0, cosSun);

    // City lights, warm-tinted, only where it's dark.
    vec3 lights = night * vec3(1.0, 0.82, 0.55) * 1.6;
    vec3 color = mix(lights + day * 0.02, lit, dayMix);

    // Thin blue rim where we look through more atmosphere, on the lit side only.
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    color += vec3(0.30, 0.55, 1.0) * rim * 0.5 * smoothstep(-0.3, 0.4, cosSun);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const atmosphereVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const atmosphereFragment = /* glsl */ `
  uniform vec3 sunDir;
  uniform float limbDot;    // dot(n, v) of the shell at the Earth's visible edge
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPosW);
    // We render the shell's back faces: dot(n, v) runs from limbDot (just outside
    // the Earth's disc) to 0 (outer edge of the halo). Glow brightest at the Earth.
    float t = clamp(dot(n, v) / limbDot, 0.0, 1.0);
    float glow = pow(t, 2.5);
    float sunlit = smoothstep(-0.35, 0.35, dot(n, sunDir));
    gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * glow * (0.08 + 0.92 * sunlit), 1.0);
    #include <colorspace_fragment>
  }
`;

/** Fallback texture when the NASA images haven't been downloaded: a plain graticule. */
function makeFallbackDay(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1b3a5c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  for (let lon = 0; lon <= 360; lon += 15) {
    const x = (lon / 360) * canvas.width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let lat = 0; lat <= 180; lat += 15) {
    const y = (lat / 180) * canvas.height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function loadTexture(url: string, renderer: THREE.WebGLRenderer): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        resolve(tex);
      },
      undefined,
      () => resolve(null),
    );
  });
}

export interface Earth {
  group: THREE.Group;
  setSunDirection(dir: THREE.Vector3): void;
  texturesLoaded: Promise<boolean>;
}

export function createEarth(renderer: THREE.WebGLRenderer): Earth {
  const group = new THREE.Group();
  const sunDir = new THREE.Vector3(1, 0, 0);

  const earthMaterial = new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: makeFallbackDay() },
      nightMap: { value: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1) },
      sunDir: { value: sunDir },
    },
    vertexShader: earthVertex,
    fragmentShader: earthFragment,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), earthMaterial);
  // The real Earth is an oblate ellipsoid: polar radius is 21 km shorter. Scene y = polar axis.
  earth.scale.set(1, 1 - WGS84_F, 1);
  group.add(earth);

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(ATMOSPHERE_RADIUS, 96, 48),
    new THREE.ShaderMaterial({
      uniforms: {
        sunDir: { value: sunDir },
        limbDot: { value: -Math.sqrt(1 - 1 / (ATMOSPHERE_RADIUS * ATMOSPHERE_RADIUS)) },
      },
      vertexShader: atmosphereVertex,
      fragmentShader: atmosphereFragment,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  group.add(atmosphere);

  const texturesLoaded = Promise.all([
    loadTexture('textures/earth_day.jpg', renderer),
    loadTexture('textures/earth_night.jpg', renderer),
  ]).then(([day, night]) => {
    if (day) earthMaterial.uniforms.dayMap.value = day;
    if (night) earthMaterial.uniforms.nightMap.value = night;
    return Boolean(day);
  });

  return {
    group,
    texturesLoaded,
    setSunDirection(dir) {
      sunDir.copy(dir).normalize();
    },
  };
}
