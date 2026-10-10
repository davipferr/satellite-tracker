/**
 * CelesTrak GP API client with a persistent cache and a bundled fallback.
 *
 * CelesTrak updates GP data every 2 hours and answers HTTP 403 to an IP that asks for
 * the same set again before that ("GP data has not updated since your last successful
 * download…"). The limit is per IP, not per browser — a second device on the same
 * network, or a fresh browser profile, gets refused with nothing cached. So:
 *
 *   1. Cache Storage, 2 h TTL — the normal path.
 *   2. Network. A 403 with a cached copy just means "your copy is current".
 *   3. Any cached copy, however old.
 *   4. A snapshot of every group bundled with the site at deploy time
 *      (scripts/fetch-snapshots.mjs, refreshed by GitHub Actions every 6 h).
 */

import { parseTleText } from '../tle/parse';

const BASE = import.meta.env.DEV ? '/celestrak' : 'https://celestrak.org';
const CACHE_NAME = 'celestrak-gp-v1';
const FETCHED_AT_HEADER = 'x-fetched-at';
/** When we last confirmed with CelesTrak that the copy is current (may be later than fetched-at). */
const CHECKED_AT_HEADER = 'x-checked-at';
const ORIGIN_HEADER = 'x-origin';
export const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

export type GpQuery = { group: string } | { catnr: number };

export interface GpResult {
  text: string;
  fetchedAt: number;
  /** Earliest time CelesTrak will hand out newer data for this query. */
  nextUpdateAt: number;
  source: 'network' | 'cache' | 'stale-cache' | 'snapshot';
  /** Why we fell back, if we did. */
  warning?: string;
}

export function gpUrl(query: GpQuery): string {
  const params = new URLSearchParams({ FORMAT: 'tle' });
  if ('group' in query) params.set('GROUP', query.group);
  else params.set('CATNR', String(query.catnr));
  return `${BASE}/NORAD/elements/gp.php?${params}`;
}

/** File name used for the bundled snapshot. Must match scripts/fetch-snapshots.mjs. */
export function snapshotKey(query: GpQuery): string {
  return 'group' in query ? query.group : `catnr-${query.catnr}`;
}

class RateLimitError extends Error {
  constructor(
    message: string,
    /** Time of the last successful download CelesTrak reports for this IP, if given. */
    readonly lastDownloadAt: number | null,
  ) {
    super(message);
  }
}

async function openCache(): Promise<Cache | null> {
  try {
    return 'caches' in globalThis ? await caches.open(CACHE_NAME) : null;
  } catch {
    return null; // e.g. insecure context
  }
}

interface Cached {
  text: string;
  fetchedAt: number;
  checkedAt: number;
  /** 'snapshot' when the cached copy came from the site's bundled snapshot rather than CelesTrak. */
  origin: 'celestrak' | 'snapshot';
}

async function readCache(cache: Cache | null, url: string): Promise<Cached | null> {
  const res = await cache?.match(url);
  if (!res) return null;
  const fetchedAt = Number(res.headers.get(FETCHED_AT_HEADER) ?? 0);
  return {
    text: await res.text(),
    fetchedAt,
    checkedAt: Number(res.headers.get(CHECKED_AT_HEADER) ?? fetchedAt),
    origin: res.headers.get(ORIGIN_HEADER) === 'snapshot' ? 'snapshot' : 'celestrak',
  };
}

async function writeCache(cache: Cache | null, url: string, entry: Cached) {
  await cache?.put(
    url,
    new Response(entry.text, {
      headers: {
        'content-type': 'text/plain',
        [FETCHED_AT_HEADER]: String(entry.fetchedAt),
        [CHECKED_AT_HEADER]: String(entry.checkedAt),
        [ORIGIN_HEADER]: entry.origin,
      },
    }),
  );
}

const inFlight = new Map<string, Promise<GpResult>>();

export function fetchGp(query: GpQuery, { force = false } = {}): Promise<GpResult> {
  const key = `${gpUrl(query)}|${force}`;
  let p = inFlight.get(key);
  if (!p) {
    p = doFetch(query, force).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

async function download(url: string): Promise<string> {
  const res = await fetch(url);
  const text = await res.text();
  if (res.status === 403 && /has not updated/i.test(text)) {
    const m = /at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC/.exec(text);
    throw new RateLimitError(text.trim(), m ? Date.parse(`${m[1]}T${m[2]}Z`) : null);
  }
  if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status}: ${text.slice(0, 120).trim()}`);
  // CelesTrak answers some errors ("No GP data found") with 200 + plain text.
  if (parseTleText(text).tles.length === 0) throw new Error(`CelesTrak returned no TLEs: ${text.slice(0, 120).trim()}`);
  return text;
}

async function loadSnapshot(query: GpQuery): Promise<{ text: string; fetchedAt: number } | null> {
  try {
    const key = snapshotKey(query);
    const [manifest, res] = await Promise.all([
      fetch('snapshots/index.json').then((r) => (r.ok ? (r.json() as Promise<Record<string, number>>) : {})),
      fetch(`snapshots/${key}.txt`),
    ]);
    if (!res.ok) return null;
    const text = await res.text();
    if (parseTleText(text).tles.length === 0) return null;
    return { text, fetchedAt: (manifest as Record<string, number>)[key] ?? 0 };
  } catch {
    return null;
  }
}

async function doFetch(query: GpQuery, force: boolean): Promise<GpResult> {
  const url = gpUrl(query);
  const cache = await openCache();
  const cached = await readCache(cache, url);

  if (cached && !force && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return {
      text: cached.text,
      fetchedAt: cached.fetchedAt,
      nextUpdateAt: cached.checkedAt + CACHE_TTL_MS,
      source: cached.origin === 'snapshot' ? 'snapshot' : 'cache',
    };
  }

  try {
    const text = await download(url);
    const now = Date.now();
    await writeCache(cache, url, { text, fetchedAt: now, checkedAt: now, origin: 'celestrak' });
    return { text, fetchedAt: now, nextUpdateAt: now + CACHE_TTL_MS, source: 'network' };
  } catch (err) {
    const rateLimited = err instanceof RateLimitError;
    // When CelesTrak says "not updated since your last download", it will refuse until
    // two hours after that download.
    const nextUpdateAt =
      rateLimited && err.lastDownloadAt ? err.lastDownloadAt + CACHE_TTL_MS : Date.now() + CACHE_TTL_MS;

    // Treat the copy we end up with as checked until CelesTrak will talk to us again, so
    // reloads don't keep collecting 403s (CelesTrak blocks IPs that ignore them).
    const checkedAt = nextUpdateAt - CACHE_TTL_MS;

    // A cached *snapshot* isn't a real download — fall through and reload the bundled
    // one, which may be newer.
    if (cached && cached.origin === 'celestrak') {
      if (rateLimited) {
        // Nothing newer exists: our copy is current.
        await writeCache(cache, url, { ...cached, checkedAt });
        return { text: cached.text, fetchedAt: cached.fetchedAt, nextUpdateAt, source: 'cache' };
      }
      return {
        text: cached.text,
        fetchedAt: cached.fetchedAt,
        nextUpdateAt,
        source: 'stale-cache',
        warning: `CelesTrak unreachable (${(err as Error).message}). Showing your last download.`,
      };
    }

    const snapshot = await loadSnapshot(query);
    if (snapshot) {
      if (rateLimited) await writeCache(cache, url, { ...snapshot, checkedAt, origin: 'snapshot' });
      return {
        ...snapshot,
        nextUpdateAt,
        source: 'snapshot',
        warning: rateLimited
          ? 'CelesTrak allows one download per group every 2 hours per network, and this network already downloaded it. Showing the copy bundled with the site.'
          : `CelesTrak unreachable (${(err as Error).message}). Showing the copy bundled with the site.`,
      };
    }

    if (rateLimited) {
      const at = new Date(nextUpdateAt).toISOString().slice(11, 16);
      throw new Error(
        `CelesTrak allows one download per group every 2 hours per network, and this network already downloaded it. Try again after ${at} UTC.`,
      );
    }
    throw err;
  }
}
