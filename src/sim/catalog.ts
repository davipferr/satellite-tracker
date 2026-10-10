import { parseTleText, type Tle } from '../tle/parse';
import { makeSatrec, type SatRec } from '../orbit/sgp4';
import { WGS84_A } from '../coords/transforms';
import { MU } from '../orbit/kepler';

export type Regime = 'LEO' | 'MEO' | 'GEO' | 'HEO';

export const REGIME_COLORS: Record<Regime, [number, number, number]> = {
  LEO: [0.35, 0.82, 1.0],
  MEO: [0.55, 1.0, 0.48],
  GEO: [1.0, 0.42, 0.55],
  HEO: [0.76, 0.55, 1.0],
};

export interface CatalogEntry {
  tle: Tle;
  regime: Regime;
  periodMin: number;
  perigeeKm: number;
  apogeeKm: number;
}

function classify(tle: Tle): Omit<CatalogEntry, 'tle'> {
  const periodMin = 1440 / tle.meanMotion;
  const n = (tle.meanMotion * 2 * Math.PI) / 86400;
  const a = Math.cbrt(MU / (n * n));
  const perigeeKm = a * (1 - tle.eccentricity) - WGS84_A;
  const apogeeKm = a * (1 + tle.eccentricity) - WGS84_A;
  let regime: Regime;
  if (tle.eccentricity > 0.25) regime = 'HEO';
  else if (periodMin < 128) regime = 'LEO';
  else if (periodMin > 1380 && periodMin < 1500) regime = 'GEO';
  else regime = 'MEO';
  return { regime, periodMin, perigeeKm, apogeeKm };
}

export class Catalog {
  readonly entries: CatalogEntry[];
  readonly parseErrors: number;
  private satrecs = new Map<number, SatRec>();

  constructor(text: string) {
    const { tles, errors } = parseTleText(text);
    // De-duplicate by catalog number (some groups overlap), keeping the newest epoch.
    const byId = new Map<number, Tle>();
    for (const t of tles) {
      const prev = byId.get(t.catalogNumber);
      if (!prev || t.epochMs > prev.epochMs) byId.set(t.catalogNumber, t);
    }
    this.entries = [...byId.values()].map((tle) => ({ tle, ...classify(tle) }));
    this.parseErrors = errors.length;
  }

  get size() {
    return this.entries.length;
  }

  /** Satrecs for the main thread are built lazily — only the selected satellite needs one. */
  satrec(index: number): SatRec {
    let rec = this.satrecs.get(index);
    if (!rec) {
      rec = makeSatrec(this.entries[index].tle);
      this.satrecs.set(index, rec);
    }
    return rec;
  }

  indexOf(catalogNumber: number): number {
    return this.entries.findIndex((e) => e.tle.catalogNumber === catalogNumber);
  }

  search(query: string, limit = 12): number[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: number[] = [];
    for (let i = 0; i < this.entries.length && out.length < limit; i++) {
      const t = this.entries[i].tle;
      if (t.name.toLowerCase().includes(q) || String(t.catalogNumber) === q) out.push(i);
    }
    return out;
  }

  colors(): Float32Array {
    const c = new Float32Array(this.entries.length * 3);
    this.entries.forEach((e, i) => c.set(REGIME_COLORS[e.regime], i * 3));
    return c;
  }
}
