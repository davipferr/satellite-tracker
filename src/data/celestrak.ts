/**
 * CelesTrak GP API client with a persistent cache.
 *
 * CelesTrak only updates GP data a few times a day and will rate-limit (HTTP 403)
 * clients that re-download the same set too often, so we keep responses in the
 * browser's Cache Storage for two hours. If the network fails we fall back to
 * whatever we have, however old.
 */

import { parseTleText } from '../tle/parse';

const BASE = import.meta.env.DEV ? '/celestrak' : 'https://celestrak.org';
const CACHE_NAME = 'celestrak-gp-v1';
const FETCHED_AT_HEADER = 'x-fetched-at';
export const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

export type GpQuery = { group: string } | { catnr: number };

export interface GpResult {
  text: string;
  fetchedAt: number;
  source: 'network' | 'cache' | 'stale-cache';
}

export function gpUrl(query: GpQuery): string {
  const params = new URLSearchParams({ FORMAT: 'tle' });
  if ('group' in query) params.set('GROUP', query.group);
  else params.set('CATNR', String(query.catnr));
  return `${BASE}/NORAD/elements/gp.php?${params}`;
}

async function openCache(): Promise<Cache | null> {
  try {
    return 'caches' in globalThis ? await caches.open(CACHE_NAME) : null;
  } catch {
    return null; // e.g. insecure context
  }
}

async function readCache(cache: Cache | null, url: string): Promise<{ text: string; fetchedAt: number } | null> {
  const res = await cache?.match(url);
  if (!res) return null;
  return { text: await res.text(), fetchedAt: Number(res.headers.get(FETCHED_AT_HEADER) ?? 0) };
}

const inFlight = new Map<string, Promise<GpResult>>();

export function fetchGp(query: GpQuery, { force = false } = {}): Promise<GpResult> {
  const url = gpUrl(query);
  const key = `${url}|${force}`;
  let p = inFlight.get(key);
  if (!p) {
    p = doFetch(url, force).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

async function doFetch(url: string, force: boolean): Promise<GpResult> {
  const cache = await openCache();
  const cached = await readCache(cache, url);

  if (cached && !force && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached, source: 'cache' };
  }

  try {
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status}: ${text.slice(0, 120).trim()}`);
    // CelesTrak answers some errors ("No GP data found") with 200 + plain text.
    if (parseTleText(text).tles.length === 0) throw new Error(`CelesTrak returned no TLEs: ${text.slice(0, 120).trim()}`);

    const fetchedAt = Date.now();
    await cache?.put(
      url,
      new Response(text, { headers: { 'content-type': 'text/plain', [FETCHED_AT_HEADER]: String(fetchedAt) } }),
    );
    return { text, fetchedAt, source: 'network' };
  } catch (err) {
    if (cached) {
      console.warn('CelesTrak fetch failed, using stale cache:', err);
      return { ...cached, source: 'stale-cache' };
    }
    throw err;
  }
}
