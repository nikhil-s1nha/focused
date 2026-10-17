import { validSignal } from "./public/director.mjs";
export function sanitizeSignal(m) {
  if (!validSignal(m)) return null;
  return {
    type: "signal",
    source: m.source,
    intensity: m.intensity,
    signal_quality: m.signal_quality,
    timestamp: m.timestamp,
  };
}
