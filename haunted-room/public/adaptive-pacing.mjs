// adaptive-pacing.mjs — maps the Director's tension onto a FNAF night's AI
// multiplier. Pure: no THREE, no DOM. Low input builds tension, so the night
// gets harder; relief eases it. Outside a running session the night is neutral.

export const MULTIPLIER_MIN = 0.5;
export const MULTIPLIER_MAX = 1.7;

export function adaptiveMultiplier(snap) {
  if (!snap || snap.phase !== "running") return 1;
  const tension = Number.isFinite(snap.tension) ? snap.tension : 0;
  const m = 0.8 + 0.9 * tension;
  return Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, m));
}
