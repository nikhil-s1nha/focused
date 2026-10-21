// Pixel/trace heuristics, not a trained model or an emotion classifier.
export const DETECTOR_VERSION = 'local-graph/1';
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};

export function extractTrace({ data, width, height }, { roi, color, tolerance = 55 }) {
  const x0 = Math.max(0, Math.floor(roi.x)), y0 = Math.max(0, Math.floor(roi.y));
  const x1 = Math.min(width, Math.ceil(roi.x + roi.width)), y1 = Math.min(height, Math.ceil(roi.y + roi.height));
  const points = [];
  for (let x = x0; x < x1; x++) {
    const runs = []; let run = null;
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      const match = data[i + 3] > 128 && Math.hypot(data[i] - color[0], data[i + 1] - color[1], data[i + 2] - color[2]) <= tolerance;
      if (match) { if (!run) run = [y, y]; else run[1] = y; }
      else if (run) { runs.push(run); run = null; }
    }
    if (run) runs.push(run);
    // Multiple traces, same-colored grid lines, and vertical borders are ambiguous.
    const valid = runs.length === 1 && runs[0][1] - runs[0][0] < (y1 - y0) * .65;
    points.push(valid ? (runs[0][0] + runs[0][1]) / 2 : null);
  }
  return { points, roi: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, image: { width, height } };
}

export function validTrace(trace) {
  const r = trace?.roi, size = trace?.image;
  return !!r && !!size && ['width', 'height'].every(k => Number.isInteger(size[k]) && size[k] >= 1 && size[k] <= 1600) &&
    ['x', 'y', 'width', 'height'].every(k => Number.isInteger(r[k])) && r.x >= 0 && r.y >= 0 && r.width >= 20 && r.height >= 20 &&
    r.x + r.width <= size.width && r.y + r.height <= size.height && Array.isArray(trace.points) && trace.points.length === r.width &&
    trace.points.every(y => y === null || (Number.isFinite(y) && y >= r.y && y < r.y + r.height));
}

export function analyzeTrace(trace, { sensitivity = 4.5, minAmplitude = 10 } = {}) {
  if (!validTrace(trace)) throw Error('Select a graph region at least 20 × 20 pixels');
  if (!Number.isFinite(sensitivity) || sensitivity < 2 || sensitivity > 12 || !Number.isFinite(minAmplitude) || minAmplitude < 3 || minAmplitude > 400) throw Error('Invalid sensitivity or minimum amplitude');
  const { points, roi, image } = trace, values = points.filter(y => y !== null), coverage = values.length / points.length;
  const base = { predictions: [], image, coverage, baseline: null, thresholdPx: null, noisePx: null, source: 'local_graph_detector', simulated: false };
  if (coverage < .65) return { ...base, status: 'insufficient_trace' };
  const baseline = median(values), noise = Math.max(1, 1.4826 * median(values.map(y => Math.abs(y - baseline))));
  const threshold = Math.max(minAmplitude, sensitivity * noise);
  const hits = points.map((y, x) => y !== null && Math.abs(y - baseline) >= threshold ? x : -1).filter(x => x >= 0);
  const groups = [];
  for (const x of hits) {
    const group = groups[groups.length - 1];
    if (!group || x - group[group.length - 1] > 4) groups.push([x]); else group.push(x);
  }
  const predictions = groups.filter(g => g.length >= 2).slice(0, 100).map(g => {
    const start = Math.max(0, g[0] - 3), end = Math.min(points.length - 1, g[g.length - 1] + 3);
    const ys = points.slice(start, end + 1).filter(y => y !== null);
    const top = Math.max(roi.y, Math.min(...ys) - 3), bottom = Math.min(roi.y + roi.height, Math.max(...ys) + 4);
    const amplitudePx = Math.max(...g.map(x => Math.abs(points[x] - baseline)));
    return { class: 'graph_change', x: roi.x + (start + end + 1) / 2, y: (top + bottom) / 2, width: end - start + 1, height: bottom - top,
      amplitudePx, score: amplitudePx / noise };
  });
  return { ...base, predictions, baseline, noisePx: noise, thresholdPx: threshold, status: predictions.length ? 'change_detected' : 'trace_stable' };
}

// A visible peak cannot be counted again simply because the next encounter starts.
// Require two clear frames to arm, then two changed frames within one encounter.
export class LocalChangeGate {
  reset() { this.key = ''; this.encounter = ''; this.clear = 0; this.hits = 0; this.armed = false; this.lastEmit = -Infinity; }
  constructor() { this.reset(); }
  observe(result, context, now, key) {
    if (this.key !== key) { this.reset(); this.key = key; }
    if (result.status === 'insufficient_trace') { this.armed = false; this.clear = 0; this.hits = 0; return null; }
    if (this.encounter !== context.encounter_id) { this.encounter = context.encounter_id; this.hits = 0; }
    if (!result.predictions.length) { this.hits = 0; if (++this.clear >= 2) this.armed = true; return null; }
    this.clear = 0;
    if (!this.armed || ++this.hits < 2 || now - this.lastEmit < 5000) return null;
    this.armed = false; this.hits = 0; this.lastEmit = now;
    return [...result.predictions].sort((a, b) => b.score - a.score)[0];
  }
}
