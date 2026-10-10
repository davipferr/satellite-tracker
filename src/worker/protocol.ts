/** Messages between the main thread and the propagation worker. */

export interface TleLines {
  name: string;
  line1: string;
  line2: string;
}

export type ToWorker =
  | { type: 'init'; generation: number; tles: TleLines[] }
  /** `buffer` is transferred in (zero-copy) and comes back filled with xyz scene positions. */
  | { type: 'propagate'; generation: number; timeMs: number; buffer: Float32Array };

export type FromWorker =
  | { type: 'ready'; generation: number; count: number }
  | { type: 'positions'; generation: number; timeMs: number; buffer: Float32Array; elapsedMs: number };
