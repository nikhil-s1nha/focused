// FNAF-1 rules data (pure, no THREE/DOM). Original ids/names; mechanics replicate the classic ruleset.
// Constants marked (approx) are community-documented values, reproduced from memory; tune freely.

export const ROOMS = ['showstage','dining','backstage','cove','hall-west','hall-west-corner','supply','kitchen','restrooms','hall-east','hall-east-corner','office'];
// Camera index 1..11 -> room (office excluded). Kitchen is audio-only.
export const CAMERAS = ['showstage','dining','backstage','cove','hall-west','hall-west-corner','supply','kitchen','restrooms','hall-east','hall-east-corner'];
export const AUDIO_ONLY_CAMERAS = ['kitchen'];
export const cameraRoom = (index) => CAMERAS[index - 1] ?? null;
export const cameraIndex = (room) => { const i = CAMERAS.indexOf(room); return i < 0 ? 0 : i + 1; };

export const CHARACTERS = ['bellwether','lark','ratchet','maestro'];

/** Classic: 89.1 s per in-game hour (~8.9 min night). Short: ~3 min night. */
export const SECONDS_PER_HOUR = { classic: 89.1, short: 30 };
export const CLASSIC_SPH = 89.1;
export const NIGHT_HOURS = 6;
export const HOUR_LABELS = ['12 AM','1 AM','2 AM','3 AM','4 AM','5 AM','6 AM'];

// Movement-opportunity intervals in classic seconds (FNAF1: Bonnie 4.97, Chica 4.98, Foxy 5.01, Freddy 3.02).
export const MOVE_INTERVAL = { bellwether: 4.97, lark: 4.98, ratchet: 5.01, maestro: 3.02 };

// Movement graphs (room -> candidate next rooms, chosen by rng, occupied rooms skipped except showstage).
export const ROUTES = {
  bellwether: {
    showstage: ['dining','backstage'], dining: ['backstage','hall-west'], backstage: ['dining','hall-west'],
    'hall-west': ['supply','hall-west-corner'], supply: ['hall-west','hall-west-corner'],
    'hall-west-corner': ['hall-west','supply'], // door attempt handled separately; this is "wander off"
  },
  lark: {
    showstage: ['dining'], dining: ['kitchen','restrooms','hall-east'], kitchen: ['restrooms','dining'],
    restrooms: ['kitchen','dining','hall-east'], 'hall-east': ['hall-east-corner','restrooms'],
    'hall-east-corner': ['hall-east'],
  },
  maestro: { // single deterministic path, like the original
    showstage: ['dining'], dining: ['restrooms'], restrooms: ['kitchen'], kitchen: ['hall-east'],
    'hall-east': ['hall-east-corner'], 'hall-east-corner': ['hall-east'],
  },
};
export const DOOR_ROOM = { bellwether: 'hall-west-corner', lark: 'hall-east-corner', maestro: 'hall-east-corner' };
export const DOOR_SIDE = { bellwether: 'left', lark: 'right', maestro: 'right' };
export const RETREAT_ROOM = { bellwether: 'dining', lark: 'restrooms', maestro: 'hall-east' };

export const RATCHET = {
  stages: 3,                 // cove stages 0..3, stage 4 = running
  freezeMin: 0.83, freezeMax: 16.67, // seconds frozen after the cove camera is looked at (approx)
  runSeconds: 5.0,           // run down hall-west before the door check (approx)
  bangBase: 1, bangStep: 5,  // power lost on bang: 1%, then 6%, 11%, ... (classic)
};

// Monitor-up attackers who got in wait for the monitor to drop, but never longer than this (comfort cap).
export const OFFICE_WAIT_CAP = 10;

// Power. Seconds per 1% at usage 1..5 (classic ~9.6, 4.8, 2.8, 1.9, 1.0).
export const DRAIN_INTERVAL = [9.6, 4.8, 2.8, 1.9, 1.0];
// Extra passive drain: seconds per extra 1% (Night 2:6, 3:5, 4:4, 5:3; Night 6:3). Night 1/custom: none (0 = off).
export const PASSIVE_DRAIN = { 1: 0, 2: 6, 3: 5, 4: 4, 5: 3, 6: 3, custom: 0 };
export const POWER_WARN_LEVELS = [20, 10];

// Power-out sequence phase bounds (classic seconds).
export const POWER_OUT = { approachMin: 3, approachMax: 6, eyes: 3, darkMin: 5, darkMax: 20, eyeBlink: 0.5 };

// Original music-box tune as note data only (midi note, beats). 3/4 feel, 84 bpm. Not any existing melody.
export const JINGLE_BPM = 84;
export const JINGLE = [
  { midi: 67, beats: 1 }, { midi: 71, beats: 0.5 }, { midi: 74, beats: 0.5 }, { midi: 72, beats: 1 },
  { midi: 69, beats: 1 }, { midi: 67, beats: 1 }, { midi: 64, beats: 1.5 }, { midi: 66, beats: 0.5 },
  { midi: 67, beats: 1 }, { midi: 74, beats: 1 }, { midi: 71, beats: 1 }, { midi: 69, beats: 2 },
  { midi: 62, beats: 1 }, { midi: 66, beats: 1 }, { midi: 69, beats: 1 }, { midi: 67, beats: 3 },
];
export const jingleSeconds = () => JINGLE.reduce((s, n) => s + n.beats, 0) * 60 / JINGLE_BPM;

// AI levels per night [maestro, bellwether, lark, ratchet] approximating FNAF1; wake = hour -> new level.
// Night 4 maestro is 1-2 in the original; fixed at 2 here for determinism.
export const NIGHT_AI = {
  1: { base: { maestro: 0, bellwether: 0, lark: 0, ratchet: 0 }, wake: { bellwether: { 2: 1 }, lark: { 4: 1 } } },
  2: { base: { maestro: 0, bellwether: 3, lark: 1, ratchet: 1 }, wake: {} },
  3: { base: { maestro: 1, bellwether: 0, lark: 5, ratchet: 2 }, wake: { bellwether: { 1: 1, 3: 2 } } },
  4: { base: { maestro: 2, bellwether: 2, lark: 4, ratchet: 6 }, wake: {} },
  5: { base: { maestro: 3, bellwether: 5, lark: 7, ratchet: 5 }, wake: {} },
  6: { base: { maestro: 4, bellwether: 10, lark: 12, ratchet: 6 }, wake: {} },
};
// Phone-call lengths in classic seconds (approx). Nights 1-5 only.
export const PHONE_SECONDS = { 1: 110, 2: 75, 3: 45, 4: 50, 5: 35 };

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clampAi = (n) => clamp(Number.isFinite(n) ? n : 0, 0, 20);

// ---- Serializable progress (no storage here; caller persists) ----
export function createProgress() {
  return { version: 1, nightsWon: [], bestCustom: null, unlocked: { night6: false, custom: false } };
}
export function recordWin(progress, night) {
  const p = JSON.parse(JSON.stringify(progress));
  const key = night === 'custom' ? 'custom' : Number(night);
  if (key !== 'custom' && !p.nightsWon.includes(key)) p.nightsWon.push(key);
  p.nightsWon.sort((a, b) => a - b);
  if ([1, 2, 3, 4, 5].every((n) => p.nightsWon.includes(n))) p.unlocked.night6 = true;
  if (p.nightsWon.includes(6)) p.unlocked.custom = true;
  return p;
}
export function availableNights(progress) {
  const out = [1];
  for (let n = 2; n <= 5; n++) if (progress.nightsWon.includes(n - 1)) out.push(n);
  if (progress.unlocked.night6) out.push(6);
  if (progress.unlocked.custom) out.push('custom');
  return out;
}
export function validProgress(p) {
  return !!p && p.version === 1 && Array.isArray(p.nightsWon) && p.nightsWon.every((n) => Number.isInteger(n) && n >= 1 && n <= 6)
    && !!p.unlocked && typeof p.unlocked.night6 === 'boolean' && typeof p.unlocked.custom === 'boolean';
}
