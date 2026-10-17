// SignalClient: the single seam between the scene and all three input modes.
// manual   — ~10 Hz ticker built from slider values, source "manual".
// synthetic — ~10 Hz labeled mathematical generator (never per rendered frame).
// live     — WebSocket to /signals; the EEG partner's hardware feed lands here.
// Freshness is always judged by LOCAL monotonic receipt time, never the
// publisher clock. Problems surface through onStatus, never the console.
import { validSignal } from "./director.mjs";

export const MODES = Object.freeze(["manual", "synthetic", "live"]);
export const SCENARIOS = Object.freeze([
  "cycle",
  "low",
  "high",
  "dropout",
  "artifacts",
]);
const TICK_MS = 100; // ~10 Hz for manual and synthetic emitters.
const RATE_WINDOW_MS = 2000; // sliding window for stats().receiveRate.
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 10000;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export class SignalClient {
  #onSignal;
  #onStatus;
  #now;
  #WebSocketImpl;
  #setTimeout;
  #clearTimeout;
  #setInterval;
  #clearInterval;
  #location;
  #rng;
  #mode = null;
  #scenario = "cycle";
  #connection = "idle";
  #disposed = false;
  #manualIntensity = 0.5;
  #manualQuality = 1;
  #phase; // synthetic generator time in seconds, advanced per tick.
  #ticker = null;
  #socket = null;
  #retryTimer = null;
  #retryMs = RETRY_BASE_MS;
  #generation = 0;
  #reconnects = 0;
  #dropped = 0;
  #received = 0;
  #lastError = null;
  #lastReceipt = null; // monotonic ms of the latest accepted signal.
  #receipts = []; // monotonic ms receipt times inside the rate window.

  constructor({
    onSignal = () => {},
    onStatus = () => {},
    now = () => globalThis.performance?.now() ?? Date.now(),
    WebSocketImpl = globalThis.WebSocket,
    setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeoutImpl = (id) => globalThis.clearTimeout(id),
    setIntervalImpl = (fn, ms) => globalThis.setInterval(fn, ms),
    clearIntervalImpl = (id) => globalThis.clearInterval(id),
    location = globalThis.location,
    rng = Math.random,
    phase = 0,
  } = {}) {
    this.#onSignal = onSignal;
    this.#onStatus = onStatus;
    this.#now = now;
    this.#WebSocketImpl = WebSocketImpl;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#setInterval = setIntervalImpl;
    this.#clearInterval = clearIntervalImpl;
    this.#location = location;
    this.#rng = rng;
    this.#phase = phase;
  }

  setMode(mode) {
    if (this.#disposed) return;
    if (!MODES.includes(mode)) {
      this.#problem(`Unknown mode "${mode}"`);
      return;
    }
    this.#teardown();
    this.#mode = mode;
    this.#lastReceipt = null;
    this.#receipts.length = 0;
    this.#retryMs = RETRY_BASE_MS;
    if (mode === "live") {
      this.#connect();
    } else {
      this.#connection = "idle";
      this.#ticker = this.#setInterval(() => this.#tick(), TICK_MS);
      this.#emitStatus();
    }
  }

  setScenario(scenario) {
    if (this.#disposed) return;
    if (!SCENARIOS.includes(scenario)) {
      this.#problem(`Unknown scenario "${scenario}"`);
      return;
    }
    if (scenario === this.#scenario) return;
    this.#scenario = scenario;
    this.#emitStatus();
  }

  setManualValue(intensity) {
    if (Number.isFinite(intensity))
      this.#manualIntensity = clamp01(intensity);
  }

  setManualQuality(quality) {
    if (Number.isFinite(quality)) this.#manualQuality = clamp01(quality);
  }

  stats() {
    const now = this.#now();
    this.#prune(now);
    return {
      mode: this.#mode,
      connected: this.#connection === "connected",
      receiveRate: this.#receipts.length / (RATE_WINDOW_MS / 1000),
      lastSignalAgeMs:
        this.#lastReceipt === null ? null : now - this.#lastReceipt,
      reconnects: this.#reconnects,
      dropped: this.#dropped,
      received: this.#received,
    };
  }

  dispose() {
    if (this.#disposed) return;
    this.#teardown();
    this.#disposed = true;
    this.#mode = null;
    this.#connection = "disposed";
  }

  // ---- internal ----

  #teardown() {
    this.#generation++; // Any still-alive socket's events are now stale.
    if (this.#ticker !== null) {
      this.#clearInterval(this.#ticker);
      this.#ticker = null;
    }
    if (this.#retryTimer !== null) {
      this.#clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#socket) {
      const socket = this.#socket;
      this.#socket = null;
      try {
        socket.close();
      } catch {
        // A socket mid-handshake may refuse to close; nothing to surface.
      }
    }
    this.#connection = "idle";
  }

  #tick() {
    if (this.#disposed) return;
    const message =
      this.#mode === "manual" ? this.#manualFrame() : this.#syntheticFrame();
    if (message) this.#accept(message);
  }

  #manualFrame() {
    return {
      type: "signal",
      source: "manual",
      intensity: this.#manualIntensity,
      signal_quality: this.#manualQuality,
      timestamp: Date.now() / 1000,
    };
  }

  // Deterministic-friendly generator: phase advances a fixed 0.1 s per tick,
  // so behavior depends only on tick count, injected phase and injected rng.
  #syntheticFrame() {
    this.#phase += TICK_MS / 1000;
    const p = this.#phase;
    const sweep = 0.5 + 0.48 * Math.sin(p * 0.18); // slow full-range drift.
    let intensity = sweep;
    let quality = 0.9 + 0.08 * Math.sin(p * 0.7); // mostly high.
    switch (this.#scenario) {
      case "low":
        intensity = 0.1 + 0.06 * (0.5 + 0.5 * Math.sin(p * 0.35));
        break;
      case "high":
        intensity = 0.88 + 0.06 * (0.5 + 0.5 * Math.sin(p * 0.35));
        break;
      case "dropout":
        // Emit for 7 s, then stay silent for 5 s (longer than the 3 s
        // freshness gate), every 12 s — exercises WAIT recovery.
        if (p % 12 >= 7) return null;
        break;
      case "artifacts":
        // Random-ish quality crashes below the 0.5 minQuality floor.
        if (this.#rng() < 0.25) quality = 0.1 + 0.3 * this.#rng();
        break;
      default:
        // "cycle": the sweep plus an occasional mild quality dip.
        if (this.#rng() < 0.03) quality = 0.55 + 0.2 * this.#rng();
    }
    return {
      type: "signal",
      source: "synthetic",
      intensity: clamp01(intensity),
      signal_quality: clamp01(quality),
      timestamp: Date.now() / 1000,
    };
  }

  #url() {
    const secure = this.#location?.protocol === "https:";
    return `${secure ? "wss" : "ws"}://${this.#location?.host}/signals`;
  }

  #connect() {
    const generation = ++this.#generation;
    this.#connection = "connecting";
    this.#emitStatus();
    let ws;
    try {
      ws = new this.#WebSocketImpl(this.#url());
    } catch (e) {
      this.#scheduleReconnect(e?.message || "WebSocket unavailable");
      return;
    }
    this.#socket = ws;
    ws.onopen = () => {
      if (generation !== this.#generation || this.#disposed) return;
      this.#retryMs = RETRY_BASE_MS;
      this.#connection = "connected";
      this.#lastError = null;
      this.#emitStatus();
    };
    ws.onmessage = (event) => {
      if (
        generation !== this.#generation ||
        this.#disposed ||
        this.#mode !== "live"
      )
        return;
      this.#handleFrame(event.data);
    };
    ws.onerror = () => {
      if (generation !== this.#generation) return;
      try {
        ws.close();
      } catch {
        // Close failures collapse into onclose/reconnect handling.
      }
    };
    ws.onclose = () => {
      if (generation !== this.#generation || this.#disposed) return;
      this.#socket = null;
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(reason = null) {
    if (this.#disposed || this.#mode !== "live") return;
    this.#reconnects++;
    this.#connection = "reconnecting";
    if (reason) this.#lastError = reason;
    this.#emitStatus();
    // Exponential backoff with jitter (0.75x–1.25x), capped at 10 s.
    const delay = this.#retryMs * (0.75 + 0.5 * this.#rng());
    this.#retryMs = Math.min(RETRY_CAP_MS, this.#retryMs * 2);
    this.#retryTimer = this.#setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
  }

  #handleFrame(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.#drop("Malformed JSON frame");
      return;
    }
    if (!validSignal(message)) {
      this.#drop("Invalid signal packet");
      return;
    }
    // Forward exactly the five contract fields, nothing extra.
    this.#accept({
      type: "signal",
      source: message.source,
      intensity: message.intensity,
      signal_quality: message.signal_quality,
      timestamp: message.timestamp,
    });
  }

  #accept(message) {
    if (this.#disposed) return;
    const now = this.#now();
    this.#lastReceipt = now;
    this.#received++;
    this.#receipts.push(now);
    this.#prune(now);
    this.#onSignal(message, now);
  }

  #prune(now) {
    while (this.#receipts.length && now - this.#receipts[0] > RATE_WINDOW_MS)
      this.#receipts.shift();
  }

  #drop(reason) {
    this.#dropped++;
    this.#problem(reason);
  }

  #problem(reason) {
    this.#lastError = reason;
    this.#emitStatus();
  }

  #emitStatus() {
    if (this.#disposed) return;
    this.#onStatus({
      mode: this.#mode,
      connection: this.#connection,
      scenario: this.#scenario,
      reconnects: this.#reconnects,
      dropped: this.#dropped,
      error: this.#lastError,
    });
  }
}
