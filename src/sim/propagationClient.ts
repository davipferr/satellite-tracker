import type { FromWorker, TleLines, ToWorker } from '../worker/protocol';

/**
 * Main-thread side of the propagation worker.
 *
 * Keeps exactly one request in flight and ping-pongs two buffers: while the worker
 * fills one, the renderer reads the other. If the worker is slower than the frame
 * rate, frames simply reuse the latest positions instead of queueing work.
 */
export class PropagationClient {
  private worker = new Worker(new URL('../worker/propagation.worker.ts', import.meta.url), { type: 'module' });
  private generation = 0;
  private count = 0;
  private spare: Float32Array | null = null;
  private busy = false;
  private ready = false;

  /** Latest positions (scene xyz per satellite) and the sim time they were computed for. */
  positions: Float32Array = new Float32Array(0);
  positionsTimeMs = NaN;
  lastWorkerMs = 0;
  onPositions: (() => void) | null = null;
  private waiters: (() => void)[] = [];

  constructor() {
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
  }

  setCatalog(tles: TleLines[]) {
    this.generation++;
    this.count = tles.length;
    this.ready = false;
    this.busy = false;
    this.positions = new Float32Array(this.count * 3).fill(NaN);
    this.positionsTimeMs = NaN;
    this.spare = new Float32Array(this.count * 3);
    this.post({ type: 'init', generation: this.generation, tles });
  }

  /** Ask for positions at `timeMs`. Ignored if a request is already running. */
  request(timeMs: number) {
    if (!this.ready || this.busy || !this.spare) return;
    this.busy = true;
    const buffer = this.spare;
    this.spare = null;
    this.post({ type: 'propagate', generation: this.generation, timeMs, buffer }, [buffer.buffer]);
  }

  private handle(msg: FromWorker) {
    if (msg.generation !== this.generation) return; // reply for an old catalog
    if (msg.type === 'ready') {
      this.ready = true;
      return;
    }
    // Swap: the fresh buffer becomes current, the old current becomes the spare.
    this.spare = this.positions;
    this.positions = msg.buffer;
    this.positionsTimeMs = msg.timeMs;
    this.lastWorkerMs = msg.elapsedMs;
    this.busy = false;
    this.onPositions?.();
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  /** Resolves the next time fresh positions arrive (e.g. the first batch after setCatalog). */
  whenPositions(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private post(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }
}
