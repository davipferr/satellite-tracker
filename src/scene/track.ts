/**
 * Visuals for the selected satellite: its path through space (in the Earth-fixed
 * frame, so it's a spiral rather than an ellipse), its ground track, and the
 * Keplerian "ghost" with a line showing how far off it is.
 */

import * as THREE from 'three';

export class SelectionTrack {
  readonly group = new THREE.Group();
  private orbitLine: THREE.Line;
  private groundLine: THREE.Line;
  private ghost: THREE.Mesh;
  private errorLine: THREE.Line;

  constructor(private samples = 400) {
    this.orbitLine = this.makeLine(samples, 0.9);
    this.groundLine = this.makeLine(samples, 0.55);
    this.ghost = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xff7a3d }),
    );
    const errGeom = new THREE.BufferGeometry();
    errGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.errorLine = new THREE.Line(
      errGeom,
      new THREE.LineDashedMaterial({ color: 0xff7a3d, dashSize: 0.01, gapSize: 0.008 }),
    );
    this.group.add(this.orbitLine, this.groundLine, this.ghost, this.errorLine);
    this.group.visible = false;
    this.setGhostVisible(false);
  }

  private makeLine(n: number, opacity: number): THREE.Line {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const line = new THREE.Line(
      geom,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false }),
    );
    line.frustumCulled = false;
    return line;
  }

  /**
   * @param path scene positions, oldest first
   * @param nowIndex index of the sample at the current time (past is drawn dimmer)
   */
  setPath(path: Float32Array, ground: Float32Array, nowIndex: number) {
    for (const [line, data, color] of [
      [this.orbitLine, path, new THREE.Color(0x7fd3ff)],
      [this.groundLine, ground, new THREE.Color(0xffd34d)],
    ] as const) {
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const col = line.geometry.getAttribute('color') as THREE.BufferAttribute;
      (pos.array as Float32Array).set(data);
      const n = data.length / 3;
      for (let i = 0; i < n; i++) {
        const k = i < nowIndex ? 0.3 : 1;
        col.setXYZ(i, color.r * k, color.g * k, color.b * k);
      }
      line.geometry.setDrawRange(0, n);
      pos.needsUpdate = col.needsUpdate = true;
    }
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  setGhostVisible(v: boolean) {
    this.ghost.visible = this.errorLine.visible = v;
  }

  setGhost(ghost: THREE.Vector3, actual: THREE.Vector3, camera: THREE.Camera, pxPerUnit: number) {
    this.ghost.position.copy(ghost);
    this.ghost.scale.setScalar(ghost.distanceTo(camera.position) * pxPerUnit * 5);
    const pos = this.errorLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, ghost.x, ghost.y, ghost.z);
    pos.setXYZ(1, actual.x, actual.y, actual.z);
    pos.needsUpdate = true;
    this.errorLine.computeLineDistances();
  }

  get sampleCount() {
    return this.samples;
  }
}
