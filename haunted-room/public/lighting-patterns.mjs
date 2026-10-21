// Shared original FNaF atmosphere waveform; at most 2.5 on/off pairs per second.
export function fluorescentMultiplier(clock, duration, intensity, pattern = "stutter") {
  if (!(duration > 0) || clock >= duration) return 1;
  const p = Math.max(0, Math.min(1, clock / duration));
  const depth = Math.max(0, Math.min(1, intensity));
  if (pattern === "sag") return 1 - depth * Math.sin(Math.PI * p);
  let h = (Math.floor(clock * 5) | 0) ^ 0x5bf03635;
  h = Math.imul(h ^ (h >>> 13), 0x9e3779b1);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296 < .55 ? 1 - Math.min(.8, depth) * (1 - p * .6) : 1;
}
