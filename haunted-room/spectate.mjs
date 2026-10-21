// spectate.mjs — validation for the spectator relay. The headset page publishes
// its head pose, scare events and session phase; TV pages replay them. Only the
// fields below are forwarded, with strict ranges. No sensor data passes through.

const SIDES = new Set(["left", "right", "front", "back"]);
const NAME = /^[a-z0-9_-]{1,24}$/;
const finite = Number.isFinite;
const inRange = (v, lo, hi) => finite(v) && v >= lo && v <= hi;
const vec = (a, n, lim) =>
  Array.isArray(a) && a.length === n && a.every((v) => inRange(v, -lim, lim));

export function sanitizeSpectate(m) {
  if (!m || typeof m !== "object") return null;
  if (m.type === "pose") {
    if (!vec(m.p, 3, 50) || !vec(m.q, 4, 1.5)) return null;
    const out = { type: "pose", p: m.p, q: m.q };
    if (inRange(m.l, 0, 1)) out.l = m.l;
    return out;
  }
  if (m.type === "phase") {
    if (!["begin", "reset", "end"].includes(m.phase)) return null;
    const out = { type: "phase", phase: m.phase };
    if (m.reason === "caught" || m.reason === "survived") out.reason = m.reason;
    return out;
  }
  if (m.type === "event") {
    const e = m.ev;
    if (!e || typeof e !== "object" || typeof e.type !== "string" || !NAME.test(e.type)) return null;
    const ev = { type: e.type };
    if (SIDES.has(e.side)) ev.side = e.side;
    if (typeof e.id === "string" && NAME.test(e.id)) ev.id = e.id;
    if (inRange(e.seconds, 0, 10)) ev.seconds = e.seconds;
    if (inRange(e.level, 0, 1)) ev.level = e.level;
    if (inRange(e.open, 0, 1)) ev.open = e.open;
    if (e.reason === "caught" || e.reason === "survived") ev.reason = e.reason;
    return { type: "event", ev };
  }
  return null;
}
