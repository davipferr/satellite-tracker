/**
 * Runs SGP4 for the whole catalog off the main thread.
 *
 * Each 'propagate' request carries a Float32Array that is *transferred* (not copied)
 * here, filled with scene-space xyz for every satellite, and transferred back.
 * Satellites SGP4 can't propagate (decayed, bad elements) get NaN.
 */

import { sgp4 } from 'satellite.js';
import { parseTle } from '../tle/parse';
import { makeSatrec, type SatRec } from '../orbit/sgp4';
import { gmst, julianDate } from '../coords/time';
import { ecefToSceneInto } from '../coords/transforms';
import type { FromWorker, ToWorker } from './protocol';

let satrecs: (SatRec | null)[] = [];
let epochs: Float64Array = new Float64Array(0);
let generation = 0;

function reply(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    generation = msg.generation;
    epochs = new Float64Array(msg.tles.length).fill(NaN);
    satrecs = msg.tles.map((t, i) => {
      try {
        const tle = parseTle(t.line1, t.line2, t.name);
        epochs[i] = tle.epochMs;
        return makeSatrec(tle);
      } catch {
        return null;
      }
    });
    reply({ type: 'ready', generation, count: satrecs.length });
    return;
  }

  if (msg.type === 'propagate') {
    const { buffer, timeMs } = msg;
    const started = performance.now();

    if (msg.generation === generation) {
      // One GMST for the whole batch — every satellite shares the same Earth rotation.
      const theta = gmst(julianDate(timeMs));
      const c = Math.cos(theta);
      const s = Math.sin(theta);

      for (let i = 0; i < satrecs.length; i++) {
        const rec = satrecs[i];
        const pv = rec ? sgp4(rec, (timeMs - epochs[i]) / 60000) : null;
        if (!pv) {
          buffer[i * 3] = buffer[i * 3 + 1] = buffer[i * 3 + 2] = NaN;
          continue;
        }
        const p = pv.position;
        // TEME → ECEF inline (same rotation as temeToEcef, without allocating).
        ecefToSceneInto(c * p.x + s * p.y, -s * p.x + c * p.y, p.z, buffer, i * 3);
      }
    }

    reply(
      { type: 'positions', generation: msg.generation, timeMs, buffer, elapsedMs: performance.now() - started },
      [buffer.buffer],
    );
  }
};
