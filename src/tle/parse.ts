/**
 * Hand-written parser for the NORAD Two-Line Element (TLE) format.
 *
 * Every field lives at a fixed column. Column numbers below are 1-based, the way
 * the format is documented (https://celestrak.org/NORAD/documentation/tle-fmt.php):
 *
 * Line 1
 *   01      line number ("1")
 *   03-07   satellite catalog number (may be Alpha-5, e.g. "A0001")
 *   08      classification (U, C, S)
 *   10-17   international designator (YY NNN PPP)
 *   19-20   epoch year (two digits)
 *   21-32   epoch day of year, with fractional day
 *   34-43   first derivative of mean motion / 2   [rev/day^2]
 *   45-52   second derivative of mean motion / 6  [rev/day^3], implied decimal point
 *   54-61   BSTAR drag term [1/earth radii], implied decimal point
 *   63      ephemeris type (always 0 in distributed data)
 *   65-68   element set number
 *   69      checksum (mod 10)
 *
 * Line 2
 *   01      line number ("2")
 *   03-07   satellite catalog number
 *   09-16   inclination [deg]
 *   18-25   right ascension of the ascending node [deg]
 *   27-33   eccentricity, implied leading "0."
 *   35-42   argument of perigee [deg]
 *   44-51   mean anomaly [deg]
 *   53-63   mean motion [rev/day]
 *   64-68   revolution number at epoch
 *   69      checksum (mod 10)
 */

import { julianDate } from '../coords/time';

export interface Tle {
  name: string;
  line1: string;
  line2: string;

  catalogNumber: number;
  classification: string;
  intlDesignator: string;

  /** Full four-digit year of the epoch. */
  epochYear: number;
  /** Day of year, 1-based, with fraction (1.5 = Jan 1st, 12:00 UTC). */
  epochDay: number;
  /** Epoch as Unix milliseconds. */
  epochMs: number;
  /** Epoch as a Julian date (UTC). */
  epochJd: number;

  /** dn/dt divided by 2, rev/day^2 — stored exactly as written in the TLE. */
  meanMotionDot: number;
  /** d²n/dt² divided by 6, rev/day^3 — stored exactly as written in the TLE. */
  meanMotionDdot: number;
  /** SGP4 drag coefficient, 1/earth radii. */
  bstar: number;
  ephemerisType: number;
  elementSetNumber: number;

  inclinationDeg: number;
  raanDeg: number;
  eccentricity: number;
  argPerigeeDeg: number;
  meanAnomalyDeg: number;
  /** Revolutions per day. Note: this is the SGP4 (Kozai) *mean* mean motion, not osculating. */
  meanMotion: number;
  revNumber: number;
}

export class TleParseError extends Error {}

/** Slice using the 1-based inclusive column numbers from the spec. */
function col(line: string, from: number, to: number): string {
  return line.substring(from - 1, to);
}

function num(line: string, from: number, to: number, field: string): number {
  const raw = col(line, from, to).trim();
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value)) {
    throw new TleParseError(`Invalid ${field}: "${raw}"`);
  }
  return value;
}

/**
 * Fields like BSTAR are written as " 12345-3", meaning +0.12345e-3.
 * Leading sign (or space), five mantissa digits with an implied "0." in front,
 * then a signed single-digit power of ten.
 */
export function parseImpliedDecimal(raw: string): number {
  const s = raw.trim();
  if (s === '') return 0;
  const match = /^([+-]?)(\d+)([+-]\d)$/.exec(s);
  if (!match) throw new TleParseError(`Invalid implied-decimal field: "${raw}"`);
  const [, sign, mantissa, exponent] = match;
  const value = Number(`0.${mantissa}`) * 10 ** Number(exponent);
  return sign === '-' ? -value : value;
}

/** Mod-10 checksum: sum of all digits, with each '-' counting as 1. Everything else is 0. */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (let i = 0; i < 68 && i < line.length; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
    else if (c === '-') sum += 1;
  }
  return sum % 10;
}

/**
 * Catalog numbers above 99999 use "Alpha-5": the first digit is replaced by a letter
 * A=10 … Z=33, skipping I and O (they look like 1 and 0).
 */
export function parseCatalogNumber(raw: string): number {
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const match = /^([A-HJ-NP-Z])(\d{4})$/.exec(s);
  if (!match) throw new TleParseError(`Invalid catalog number: "${raw}"`);
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return (letters.indexOf(match[1]) + 10) * 10000 + Number(match[2]);
}

/** Two-digit years: 57-99 → 1957-1999, 00-56 → 2000-2056 (Sputnik launched in 1957). */
function fullYear(twoDigit: number): number {
  return twoDigit < 57 ? 2000 + twoDigit : 1900 + twoDigit;
}

export function parseTle(line1: string, line2: string, name = '', verifyChecksum = true): Tle {
  line1 = line1.trimEnd();
  line2 = line2.trimEnd();

  if (line1.length < 69 || line2.length < 69) {
    throw new TleParseError('TLE lines must be 69 characters long');
  }
  if (line1[0] !== '1' || line2[0] !== '2') {
    throw new TleParseError('Expected line numbers "1" and "2"');
  }
  if (verifyChecksum) {
    for (const line of [line1, line2]) {
      const expected = Number(line[68]);
      const actual = tleChecksum(line);
      if (expected !== actual) {
        throw new TleParseError(`Checksum mismatch on line ${line[0]}: expected ${expected}, got ${actual}`);
      }
    }
  }

  const catalogNumber = parseCatalogNumber(col(line1, 3, 7));
  if (parseCatalogNumber(col(line2, 3, 7)) !== catalogNumber) {
    throw new TleParseError('Catalog numbers on line 1 and line 2 differ');
  }

  const epochYear = fullYear(num(line1, 19, 20, 'epoch year'));
  const epochDay = num(line1, 21, 32, 'epoch day');
  // Day 1.0 is January 1st 00:00 UTC, so subtract one day.
  const epochMs = Date.UTC(epochYear, 0, 1) + (epochDay - 1) * 86_400_000;

  return {
    name: name.trim() || `NORAD ${catalogNumber}`,
    line1,
    line2,
    catalogNumber,
    classification: col(line1, 8, 8),
    intlDesignator: col(line1, 10, 17).trim(),
    epochYear,
    epochDay,
    epochMs,
    epochJd: julianDate(epochMs),
    meanMotionDot: num(line1, 34, 43, 'mean motion derivative'),
    meanMotionDdot: parseImpliedDecimal(col(line1, 45, 52)),
    bstar: parseImpliedDecimal(col(line1, 54, 61)),
    ephemerisType: Number(col(line1, 63, 63).trim() || 0),
    elementSetNumber: Number(col(line1, 65, 68).trim() || 0),

    inclinationDeg: num(line2, 9, 16, 'inclination'),
    raanDeg: num(line2, 18, 25, 'RAAN'),
    eccentricity: Number(`0.${col(line2, 27, 33).trim()}`),
    argPerigeeDeg: num(line2, 35, 42, 'argument of perigee'),
    meanAnomalyDeg: num(line2, 44, 51, 'mean anomaly'),
    meanMotion: num(line2, 53, 63, 'mean motion'),
    revNumber: Number(col(line2, 64, 68).trim() || 0),
  };
}

export interface ParseResult {
  tles: Tle[];
  errors: { lineNumber: number; message: string }[];
}

/**
 * Parse a block of text containing TLEs. Accepts both the 3-line format (name line,
 * optionally prefixed with "0 ") and bare 2-line sets.
 */
export function parseTleText(text: string): ParseResult {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  const tles: Tle[] = [];
  const errors: ParseResult['errors'] = [];

  let i = 0;
  while (i < lines.length) {
    let name = '';
    if (!lines[i].startsWith('1 ')) {
      name = lines[i].replace(/^0 /, '');
      i++;
    }
    const l1 = lines[i];
    const l2 = lines[i + 1];
    if (l1 === undefined || l2 === undefined || !l1.startsWith('1 ') || !l2.startsWith('2 ')) {
      errors.push({ lineNumber: i + 1, message: `Malformed TLE near "${name || l1}"` });
      // Resynchronise on the next line that could start a record.
      i++;
      continue;
    }
    try {
      tles.push(parseTle(l1, l2, name));
    } catch (e) {
      errors.push({ lineNumber: i + 1, message: (e as Error).message });
    }
    i += 2;
  }

  return { tles, errors };
}
