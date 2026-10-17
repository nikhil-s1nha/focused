import { test } from "node:test";
import assert from "node:assert/strict";
import { SignalClient } from "../public/signal-client.mjs";

// Deterministic monotonic clock plus timer queue; no real waiting.
function fakeClock() {
  let now = 0,
    nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(nextId, { fn, at: now + Math.max(0, ms), interval: null });
      return nextId++;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => {
      timers.set(nextId, { fn, at: now + ms, interval: ms });
      return nextId++;
    },
    clearInterval: (id) => timers.delete(id),
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let dueId = null,
          due = null;
        for (const [id, t] of timers)
          if (t.at <= end && (!due || t.at < due.at)) {
            due = t;
            dueId = id;
          }
        if (!due) break;
        now = due.at;
        if (due.interval === null) timers.delete(dueId);
        else due.at += due.interval;
        due.fn();
      }
      now = end;
    },
  };
}

function harness(overrides = {}) {
  const clock = fakeClock();
  const signals = [],
    statuses = [],
    sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sockets.push(this);
    }
    open() {
      this.onopen?.();
    }
    message(data) {
      this.onmessage?.({ data });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    }
  }
  const client = new SignalClient({
    onSignal: (message, receiptNow) => signals.push({ message, receiptNow }),
    onStatus: (status) => statuses.push(status),
    now: clock.now,
    WebSocketImpl: FakeWebSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    setIntervalImpl: clock.setInterval,
    clearIntervalImpl: clock.clearInterval,
    location: { protocol: "http:", host: "127.0.0.1:8080" },
    rng: () => 0.5,
    ...overrides,
  });
  return { client, clock, signals, statuses, sockets };
}

const frame = (intensity = 0.42, extra = {}) =>
  JSON.stringify({
    type: "signal",
    source: "hardware",
    intensity,
    signal_quality: 0.9,
    timestamp: 1792256400,
    ...extra,
  });

test("manual mode emits ~10 Hz with manual values and label", () => {
  const { client, clock, signals } = harness();
  client.setMode("manual");
  clock.advance(2000);
  assert.equal(signals.length, 20);
  for (const { message } of signals) {
    assert.equal(message.type, "signal");
    assert.equal(message.source, "manual");
    assert.equal(message.intensity, 0.5);
    assert.equal(message.signal_quality, 1);
    assert.ok(Number.isFinite(message.timestamp));
  }
  client.setManualValue(0.2);
  client.setManualQuality(0.7);
  client.setManualValue(NaN); // ignored, keeps 0.2
  clock.advance(100);
  const last = signals.at(-1).message;
  assert.equal(last.intensity, 0.2);
  assert.equal(last.signal_quality, 0.7);
  assert.equal(signals.at(-1).receiptNow, clock.now());
});

test("synthetic low scenario stays low and is labeled synthetic", () => {
  const { client, clock, signals } = harness();
  client.setMode("synthetic");
  client.setScenario("low");
  clock.advance(5000);
  assert.equal(signals.length, 50);
  for (const { message } of signals) {
    assert.equal(message.source, "synthetic");
    assert.ok(message.intensity < 0.3);
    assert.ok(message.signal_quality >= 0.5);
  }
});

test("synthetic high scenario stays high", () => {
  const { client, clock, signals } = harness();
  client.setMode("synthetic");
  client.setScenario("high");
  clock.advance(5000);
  for (const { message } of signals) assert.ok(message.intensity > 0.75);
});

test("dropout scenario produces a multi-second emission gap", () => {
  const { client, clock, signals } = harness();
  client.setMode("synthetic");
  client.setScenario("dropout");
  clock.advance(24000); // two 12 s dropout cycles
  assert.ok(signals.length > 100);
  let maxGap = 0;
  for (let i = 1; i < signals.length; i++)
    maxGap = Math.max(maxGap, signals[i].receiptNow - signals[i - 1].receiptNow);
  assert.ok(maxGap >= 4000, `gap ${maxGap}ms should exceed freshness window`);
});

test("artifacts scenario crashes quality below 0.5 on rng dips", () => {
  const seq = [0.1, 0.1, 0.9, 0.9];
  let i = 0;
  const { client, clock, signals } = harness({
    rng: () => seq[i++ % seq.length],
  });
  client.setMode("synthetic");
  client.setScenario("artifacts");
  clock.advance(2000);
  const qualities = signals.map((s) => s.message.signal_quality);
  assert.ok(qualities.some((q) => q < 0.5));
  assert.ok(qualities.some((q) => q >= 0.5));
});

test("live mode connects, accepts valid frames, drops bad ones safely", () => {
  const { client, clock, signals, statuses, sockets } = harness();
  client.setMode("live");
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "ws://127.0.0.1:8080/signals");
  assert.equal(statuses.at(-1).connection, "connecting");
  sockets[0].open();
  assert.equal(statuses.at(-1).connection, "connected");
  clock.advance(50);
  sockets[0].message(frame(0.42, { extra_field: "stripme" }));
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].message, {
    type: "signal",
    source: "hardware",
    intensity: 0.42,
    signal_quality: 0.9,
    timestamp: 1792256400,
  });
  assert.equal(signals[0].receiptNow, 50);
  sockets[0].message("{not json");
  sockets[0].message(frame(2)); // out of range
  sockets[0].message(JSON.stringify({ type: "signal", source: "EEG" }));
  assert.equal(signals.length, 1);
  assert.equal(client.stats().dropped, 3);
  assert.equal(statuses.at(-1).error, "Invalid signal packet");
});

test("live mode reconnects with exponential backoff", () => {
  const { client, clock, sockets, statuses } = harness();
  client.setMode("live");
  sockets[0].open();
  sockets[0].close();
  assert.equal(client.stats().reconnects, 1);
  assert.equal(statuses.at(-1).connection, "reconnecting");
  clock.advance(499);
  assert.equal(sockets.length, 1);
  clock.advance(1); // rng 0.5 → jitter factor 1.0 → exactly 500 ms
  assert.equal(sockets.length, 2);
  sockets[1].close(); // never opened; backoff doubles to 1000 ms
  assert.equal(client.stats().reconnects, 2);
  clock.advance(999);
  assert.equal(sockets.length, 2);
  clock.advance(1);
  assert.equal(sockets.length, 3);
  sockets[2].open(); // success resets backoff
  sockets[2].close();
  clock.advance(500);
  assert.equal(sockets.length, 4);
});

test("generation guard ignores events from a stale socket", () => {
  const { client, clock, signals, sockets } = harness();
  client.setMode("live");
  const stale = sockets[0];
  stale.open();
  client.setMode("manual");
  assert.ok(stale.closed);
  stale.closed = false; // force events through anyway
  stale.message(frame());
  stale.close();
  assert.equal(signals.length, 0);
  assert.equal(client.stats().dropped, 0);
  assert.equal(client.stats().reconnects, 0);
  clock.advance(100);
  assert.equal(signals.at(-1).message.source, "manual");
  assert.equal(sockets.length, 1); // stale close scheduled no reconnect
});

test("stats reports rate over sliding window and monotonic signal age", () => {
  const { client, clock, sockets } = harness();
  client.setMode("live");
  sockets[0].open();
  for (let i = 0; i < 5; i++) {
    sockets[0].message(frame());
    clock.advance(100);
  }
  let s = client.stats();
  assert.equal(s.mode, "live");
  assert.equal(s.connected, true);
  assert.equal(s.received, 5);
  assert.equal(s.receiveRate, 2.5); // 5 frames in the 2 s window
  assert.equal(s.lastSignalAgeMs, 100);
  clock.advance(250);
  s = client.stats();
  assert.equal(s.lastSignalAgeMs, 350);
  clock.advance(3000); // all receipts fall out of the window
  assert.equal(client.stats().receiveRate, 0);
  const idle = harness();
  idle.client.setMode("live");
  assert.equal(idle.client.stats().lastSignalAgeMs, null);
});

test("dispose closes the socket, clears timers and suppresses callbacks", () => {
  const live = harness();
  live.client.setMode("live");
  live.sockets[0].open();
  live.client.dispose();
  assert.ok(live.sockets[0].closed);
  live.sockets[0].closed = false;
  live.sockets[0].message(frame());
  assert.equal(live.signals.length, 0);
  assert.equal(live.clock.pending(), 0);

  const manual = harness();
  manual.client.setMode("manual");
  manual.clock.advance(500);
  assert.equal(manual.signals.length, 5);
  const statusCount = manual.statuses.length;
  manual.client.dispose();
  manual.clock.advance(2000);
  assert.equal(manual.signals.length, 5);
  assert.equal(manual.statuses.length, statusCount);
  assert.equal(manual.clock.pending(), 0);
  manual.client.setMode("synthetic"); // no effect after dispose
  manual.clock.advance(500);
  assert.equal(manual.signals.length, 5);
});

test("invalid mode or scenario surfaces through onStatus without breaking", () => {
  const { client, clock, signals, statuses } = harness();
  client.setMode("bogus");
  assert.equal(statuses.at(-1).error, 'Unknown mode "bogus"');
  client.setMode("synthetic");
  client.setScenario("chaos");
  assert.equal(statuses.at(-1).error, 'Unknown scenario "chaos"');
  assert.equal(statuses.at(-1).scenario, "cycle"); // unchanged
  clock.advance(300);
  assert.equal(signals.length, 3); // still ticking
});
