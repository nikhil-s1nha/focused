// Display-only helpers. All trace vertices originate in captured samples.
// The presentation buffer moves the viewport, never filters or invents values.
export const TRACE_WINDOW_SECONDS = 10;
export const PRESENTATION_BUFFER_SECONDS = 0.75;
export const MAX_TRACE_SAMPLES = 4096;

export class TraceBuffer {
  constructor(capacity = MAX_TRACE_SAMPLES) {
    this.capacity = capacity;
    this.storage = new Array(capacity);
    this.key = null;
    this.start = 0;
    this.size = 0;
    this.version = 0;
  }
  at(index) { return index >= 0 && index < this.size ? this.storage[(this.start + index) % this.capacity] : undefined; }
  get latest() { return this.at(this.size - 1); }
  ingest(key, samples, gapSeconds = 0.024) {
    let reset = key !== this.key;
    const incoming = samples.at(-1);
    if (!reset && incoming && this.latest && incoming.elapsed_seconds < this.latest.elapsed_seconds) reset = true;
    if (reset) { this.key = key; this.start = 0; this.size = 0; this.version++; }
    if (!incoming || (this.latest && incoming.sequence === this.latest.sequence && incoming.read_micros === this.latest.read_micros)) return {reset, added: 0};
    const prior = this.latest;
    let from = 0;
    // Snapshot overlap is normal: the API retains its own bounded history.
    if (prior) {
      from = samples.findIndex(point => point.sequence === prior.sequence && point.read_micros === prior.read_micros);
      from = from < 0 ? 0 : from + 1;
    }
    let added = 0;
    for (let i = from; i < samples.length; i++) {
      const point = samples[i];
      if (!Number.isFinite(point.elapsed_seconds) || !Array.isArray(point.counts) || point.counts.length !== 2 || !point.counts.every(Number.isFinite)) continue;
      const previous = this.latest;
      if (previous && point.elapsed_seconds < previous.elapsed_seconds) continue;
      const gap = !previous || point.break_before || point.sequence !== ((previous.sequence + 1) >>> 0) || point.elapsed_seconds <= previous.elapsed_seconds || point.elapsed_seconds - previous.elapsed_seconds > gapSeconds;
      const retained = {...point, break_before: Boolean(gap)};
      if (this.size < this.capacity) { this.storage[(this.start + this.size) % this.capacity] = retained; this.size++; }
      else { this.storage[this.start] = retained; this.start = (this.start + 1) % this.capacity; }
      added++;
    }
    if (added) this.version++;
    return {reset, added};
  }
  window(start, end) {
    const points = [];
    for (let i = 0; i < this.size; i++) {
      const point = this.at(i);
      if (point.elapsed_seconds > end) break;
      // Retain one real predecessor for a clipped line crossing the left edge.
      if (point.elapsed_seconds < start) { points[0] = point; continue; }
      points.push(point);
    }
    if (points.length === 1 && points[0].elapsed_seconds < start) return [];
    return points;
  }
}

export class PresentationClock {
  constructor(delay = PRESENTATION_BUFFER_SECONDS) {
    this.delay = delay;
    this.cursor = null;
    this.latest = null;
    this.lastNow = null;
    this.live = false;
  }
  observe(latest, now, {reset = false, live = false} = {}) {
    if (!Number.isFinite(latest)) { this.cursor = this.latest = null; this.lastNow = now; this.live = live; return; }
    this.tick(now);
    this.latest = latest;
    if (reset || this.cursor === null) this.cursor = live ? Math.max(0, latest - this.delay) : latest;
    // A resumed tab/large delivery gap must not replay many seconds of old data.
    // Jump the viewport only: actual sample times and gap flags are untouched.
    if (live && latest - this.cursor > Math.max(2, this.delay * 2)) this.cursor = Math.max(0, latest - this.delay);
    if (!live) this.cursor = latest;
    this.live = live;
    this.lastNow = now;
  }
  tick(now) {
    if (this.cursor !== null && this.live && this.lastNow !== null) {
      this.cursor = Math.min(this.latest, this.cursor + Math.max(0, now - this.lastNow) / 1000);
    }
    this.lastNow = now;
    return this.cursor;
  }
  get lag() { return this.cursor === null ? 0 : Math.max(0, this.latest - this.cursor); }
}

// Within each pixel bucket preserve the original first, min, max, and last
// vertices in time order. Segment boundaries are never joined or averaged.
export function peakPreservingPoints(points, channel, start, duration, pixels) {
  if (points.length <= Math.max(1, pixels) * 2) return points;
  const result = [];
  let bucket = [], bucketId = null;
  function flush() {
    if (!bucket.length) return;
    let min = 0, max = 0;
    for (let i = 1; i < bucket.length; i++) {
      if (bucket[i].counts[channel] < bucket[min].counts[channel]) min = i;
      if (bucket[i].counts[channel] > bucket[max].counts[channel]) max = i;
    }
    for (const i of [...new Set([0, min, max, bucket.length - 1])].sort((a,b) => a-b)) result.push(bucket[i]);
    bucket = [];
  }
  for (const point of points) {
    const id = Math.floor((point.elapsed_seconds - start) / duration * Math.max(1, pixels));
    if (point.break_before || id !== bucketId) flush();
    bucketId = id;
    bucket.push(point);
  }
  flush();
  return result;
}

const axisRanges = new WeakMap();
function stableRange(canvas, points, channel, now, key) {
  let low = Infinity, high = -Infinity;
  for (const point of points) { low = Math.min(low, point.counts[channel]); high = Math.max(high, point.counts[channel]); }
  if (!Number.isFinite(low)) return {low: -1, high: 1};
  const span = Math.max(2, high - low), padding = span * 0.12;
  const target = {low: low-padding, high: high+padding};
  let range = axisRanges.get(canvas);
  if (!range || range.key !== key || low < range.low || high > range.high) {
    range = {...target, key, changedAt: now};
  } else if (now-range.changedAt > 2000 && high-low < (range.high-range.low)*0.5) {
    range = {...target, key, changedAt: now};
  }
  axisRanges.set(canvas, range);
  return range;
}

export function paintBenchTrace(canvas, frame, channel) {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const left = width < 500 ? 64 : 80, top = 20, right = width - 20, bottom = height - 30;
  ctx.font = '10px ui-monospace, monospace'; ctx.lineWidth = 1;
  if (!frame.points.length) { ctx.fillStyle = '#95a7b8'; ctx.textAlign = 'left'; ctx.fillText('No raw frames in this phase', left, 60); return; }
  const {low, high} = stableRange(canvas, frame.points, channel, frame.now, frame.key);
  const x = time => left + (time - frame.start) / frame.duration * (right-left);
  const y = value => bottom - (value-low) / (high-low) * (bottom-top);
  for (let i = 0; i <= 4; i++) {
    const yy = top + (bottom-top)*i/4, xx = left + (right-left)*i/4;
    ctx.strokeStyle = '#20302e'; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
    ctx.fillStyle = '#95a7b8'; ctx.textAlign = 'right'; ctx.fillText(Math.round(high-(high-low)*i/4).toLocaleString(), left-8, yy+3);
    ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, bottom); ctx.stroke();
    ctx.textAlign = i===0 ? 'left' : i===4 ? 'right' : 'center';
    ctx.fillText((frame.start+frame.duration*i/4).toFixed(2)+' s', xx, bottom+20);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(left,top,right-left,bottom-top); ctx.clip();
  const points = peakPreservingPoints(frame.points, channel, frame.start, frame.duration, Math.ceil(right-left));
  ctx.strokeStyle = channel ? '#88b8e8' : '#59e0aa'; ctx.lineWidth = 1.2; ctx.beginPath();
  points.forEach((point,i) => {
    if (i === 0 || point.break_before) ctx.moveTo(x(point.elapsed_seconds), y(point.counts[channel]));
    else ctx.lineTo(x(point.elapsed_seconds), y(point.counts[channel]));
  });
  ctx.stroke();
  // Isolated real samples remain dots instead of vanishing as zero-length paths.
  ctx.fillStyle = ctx.strokeStyle;
  points.forEach((point,i) => {
    if ((i === 0 || point.break_before) && (i === points.length-1 || points[i+1].break_before)) {
      ctx.beginPath(); ctx.arc(x(point.elapsed_seconds), y(point.counts[channel]), 2, 0, Math.PI*2); ctx.fill();
    }
  });
  frame.markers.forEach(({marker, point}, index) => {
    if (point.elapsed_seconds < frame.start || point.elapsed_seconds > frame.playhead) return;
    const xx = x(point.elapsed_seconds);
    ctx.strokeStyle = '#f7cb7c'; ctx.lineWidth = 1; ctx.setLineDash([3,4]);
    ctx.beginPath(); ctx.moveTo(xx,top); ctx.lineTo(xx,bottom); ctx.stroke(); ctx.setLineDash([]);
    if (channel === 0) { ctx.fillStyle = '#f7cb7c'; ctx.textAlign = 'left'; ctx.fillText(String(marker.label || 'Event').slice(0,28), Math.max(left+3,Math.min(xx+4,right-170)), top+12+(index%3)*13); }
  });
  ctx.restore();
}
