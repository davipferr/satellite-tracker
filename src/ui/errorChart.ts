/** A small hand-drawn log-scale line chart for the Kepler-vs-SGP4 error. */

import type { ErrorSeries } from '../sim/compare';

export const SERIES_COLORS = { tle: '#ff7a3d', state: '#4fc3f7' };

const MIN_KM = 1e-3; // 1 m — log scale can't show zero
const MAX_KM = 1e5;

function niceDayStep(span: number): number {
  for (const s of [0.25, 0.5, 1, 2, 5, 10]) if (span / s <= 8) return s;
  return 20;
}

export function drawErrorChart(canvas: HTMLCanvasElement, series: ErrorSeries | null, cursorDay: number | null) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(canvas);
  const muted = css.getPropertyValue('--muted').trim() || '#8a94a6';
  const grid = css.getPropertyValue('--grid').trim() || 'rgba(255,255,255,0.08)';

  const pad = { l: 46, r: 10, t: 10, b: 24 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  if (!series || pw <= 0 || ph <= 0) return;

  const lo = Math.log10(MIN_KM);
  const hi = Math.log10(MAX_KM);
  const x = (d: number) => pad.l + (d / series.spanDays) * pw;
  const y = (km: number) => pad.t + ph - ((Math.log10(Math.max(km, MIN_KM)) - lo) / (hi - lo)) * ph;

  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.lineWidth = 1;

  // Horizontal grid: one line per decade.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const labels: Record<number, string> = { [-3]: '1 m', [-2]: '10 m', [-1]: '100 m', 0: '1 km', 1: '10 km', 2: '100 km', 3: '1000 km', 4: '10⁴ km', 5: '10⁵ km' };
  for (let e = lo; e <= hi; e++) {
    const yy = Math.round(y(10 ** e)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(w - pad.r, yy);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(labels[e] ?? '', pad.l - 5, yy);
  }

  // Vertical grid: days.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const step = niceDayStep(series.spanDays);
  for (let d = 0; d <= series.spanDays + 1e-9; d += step) {
    const xx = Math.round(x(d)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(xx, pad.t);
    ctx.lineTo(xx, pad.t + ph);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(`${d}d`, xx, pad.t + ph + 6);
  }

  // Earth's diameter: the largest error physically possible for a LEO satellite.
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = muted;
  const yd = Math.round(y(12756)) + 0.5;
  ctx.beginPath();
  ctx.moveTo(pad.l, yd);
  ctx.lineTo(w - pad.r, yd);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const [data, color] of [
    [series.fromTle, SERIES_COLORS.tle],
    [series.fromState, SERIES_COLORS.state],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < data.length; i++) {
      if (Number.isNaN(data[i])) {
        pen = false;
        continue;
      }
      const px = x(series.days[i]);
      const py = y(data[i]);
      if (pen) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
  }

  if (cursorDay !== null && cursorDay >= 0 && cursorDay <= series.spanDays) {
    const xx = Math.round(x(cursorDay)) + 0.5;
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xx, pad.t);
    ctx.lineTo(xx, pad.t + ph);
    ctx.stroke();
  }
}
