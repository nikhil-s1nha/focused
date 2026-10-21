// Serializable save/restore model. Pure: no storage access (the app persists the string via localStorage).

export const PROGRESS_VERSION = 1;
export const MODES = Object.freeze(['fnaf1', 'fnaf2', 'fnaf3', 'fnaf4']);
export const DIFFICULTY_PRESETS = Object.freeze({
  easy: { id: 'easy', label: 'Easy', multiplier: 0.6 },
  normal: { id: 'normal', label: 'Normal', multiplier: 1 },
  nightmare: { id: 'nightmare', label: 'Nightmare', multiplier: 1.5 },
});
export const ADAPTIVE_RANGE = Object.freeze({ min: 0.25, max: 2 });
// Known rosters for custom night validation; fnaf3 roster is owned elsewhere, so ids are only pattern-checked.
export const CUSTOM_ROSTERS = Object.freeze({
  fnaf1: ['bellwether', 'lark', 'ratchet', 'maestro'],
  fnaf2: ['bramble', 'pip', 'cinder', 'quill', 'nimbus', 'tallow', 'sprocket', 'wick', 'jackalope'],
  fnaf3: null,
  fnaf4: ['hollowjaw', 'gristle', 'marrow', 'sable', 'small'],
});
const ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const STAR_NIGHT = { 5: 1, 6: 2 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isInt = (n) => Number.isInteger(n);

export function createModeProgress() {
  return { nightsWon: [], stars: 0, attempts: 0, losses: 0, bestCustom: null, lastLoss: null, customWon: 0 };
}
export function createProgress() {
  return {
    version: PROGRESS_VERSION,
    modes: Object.fromEntries(MODES.map((m) => [m, createModeProgress()])),
    settings: { difficulty: 'normal', adaptive: { enabled: false, multiplier: 1 } }, // adaptive reserved for the Director layer
  };
}

/** Returns a clean progress object from untrusted input, or null if unusable. Never throws. */
export function sanitizeProgress(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== PROGRESS_VERSION || !raw.modes || typeof raw.modes !== 'object') return null;
  const p = createProgress();
  for (const m of MODES) {
    const r = raw.modes[m];
    if (!r || typeof r !== 'object') continue;
    const mp = p.modes[m];
    if (Array.isArray(r.nightsWon)) mp.nightsWon = [...new Set(r.nightsWon.filter((n) => isInt(n) && n >= 1 && n <= 6))].sort((a, b) => a - b);
    for (const k of ['attempts', 'losses', 'customWon']) if (isInt(r[k]) && r[k] >= 0) mp[k] = r[k];
    mp.stars = isInt(r.stars) ? clamp(r.stars, 0, 3) : 0;
    if (typeof r.lastLoss === 'string' && r.lastLoss.length < 64) mp.lastLoss = r.lastLoss;
    if (r.bestCustom && typeof r.bestCustom === 'object' && isInt(r.bestCustom.total) && r.bestCustom.total >= 0 && r.bestCustom.total <= 400) mp.bestCustom = { total: r.bestCustom.total };
  }
  const s = raw.settings;
  if (s && typeof s === 'object') {
    if (typeof s.difficulty === 'string' && DIFFICULTY_PRESETS[s.difficulty]) p.settings.difficulty = s.difficulty;
    const a = s.adaptive;
    if (a && typeof a === 'object') {
      p.settings.adaptive.enabled = a.enabled === true;
      if (Number.isFinite(a.multiplier)) p.settings.adaptive.multiplier = clamp(a.multiplier, ADAPTIVE_RANGE.min, ADAPTIVE_RANGE.max);
    }
  }
  return p;
}
export const validProgress = (raw) => sanitizeProgress(raw) !== null;
export const serializeProgress = (p) => JSON.stringify(p);
/** Parse a stored string; any failure yields a fresh progress object. */
export function deserializeProgress(str) {
  try { return sanitizeProgress(JSON.parse(str)) ?? createProgress(); } catch { return createProgress(); }
}

const clone = (p) => JSON.parse(JSON.stringify(p));
function mp(p, mode) { if (!MODES.includes(mode)) throw new RangeError(`unknown mode ${mode}`); return p.modes[mode]; }

export function isNightUnlocked(p, mode, night) {
  const m = mp(p, mode), won = m.nightsWon;
  if (night === 'custom') return won.includes(6);
  if (!isInt(night) || night < 1 || night > 6) return false;
  if (night === 1) return true;
  return won.includes(night - 1);
}
export function availableNights(p, mode) {
  const out = [];
  for (let n = 1; n <= 6; n++) if (isNightUnlocked(p, mode, n)) out.push(n);
  if (isNightUnlocked(p, mode, 'custom')) out.push('custom');
  return out;
}

/** night: 1..6 or 'custom'. custom: normalized levels (from validateCustomConfig). Returns new progress. */
export function recordWin(p, mode, night, { custom = null } = {}) {
  const out = clone(p), m = mp(out, mode);
  m.attempts++;
  if (night === 'custom') {
    m.customWon++;
    const total = custom ? Object.values(custom).reduce((a, b) => a + b, 0) : 0;
    if (!m.bestCustom || total > m.bestCustom.total) m.bestCustom = { total };
    const keys = custom ? Object.keys(custom) : [];
    if (keys.length && keys.every((k) => custom[k] === 20)) m.stars = Math.max(m.stars, 3);
  } else if (isInt(night) && night >= 1 && night <= 6) {
    if (!m.nightsWon.includes(night)) m.nightsWon.push(night);
    m.nightsWon.sort((a, b) => a - b);
    if (STAR_NIGHT[night]) m.stars = Math.max(m.stars, STAR_NIGHT[night]);
  } else throw new RangeError(`bad night ${night}`);
  return out;
}
export function recordLoss(p, mode, reason = 'unknown') {
  const out = clone(p), m = mp(out, mode);
  m.attempts++; m.losses++; m.lastLoss = String(reason).slice(0, 63);
  return out;
}
export const starsFor = (p, mode) => mp(p, mode).stars;
export const totalStars = (p) => MODES.reduce((s, m) => s + p.modes[m].stars, 0);

// ---- custom night ----
/** Validate a custom-night config {charId: 0..20}. Returns {ok, errors[], config} (config only when ok). */
export function validateCustomConfig(mode, cfg, { roster = undefined } = {}) {
  const errors = [];
  if (!MODES.includes(mode)) return { ok: false, errors: [`unknown mode ${mode}`], config: null };
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, errors: ['config must be an object'], config: null };
  const allowed = roster === undefined ? CUSTOM_ROSTERS[mode] : roster;
  const config = {};
  for (const [id, v] of Object.entries(cfg)) {
    if (allowed ? !allowed.includes(id) : !ID_RE.test(id)) { errors.push(`unknown character ${id}`); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || !isInt(v)) { errors.push(`${id}: level must be an integer`); continue; }
    if (v < 0 || v > 20) { errors.push(`${id}: level must be 0-20`); continue; }
    config[id] = v;
  }
  if (allowed) for (const id of allowed) if (!(id in cfg)) config[id] = 0; // missing characters default to 0
  if (!Object.keys(config).length && !errors.length) errors.push('config is empty');
  return errors.length ? { ok: false, errors, config: null } : { ok: true, errors: [], config };
}

// ---- difficulty ----
export function setDifficulty(p, id) {
  if (!DIFFICULTY_PRESETS[id]) throw new RangeError(`unknown difficulty ${id}`);
  const out = clone(p); out.settings.difficulty = id; return out;
}
export function setAdaptive(p, { enabled, multiplier }) {
  const out = clone(p), a = out.settings.adaptive;
  if (typeof enabled === 'boolean') a.enabled = enabled;
  if (Number.isFinite(multiplier)) a.multiplier = clamp(multiplier, ADAPTIVE_RANGE.min, ADAPTIVE_RANGE.max);
  return out;
}
/** Difficulty preset multiplier times the adaptive multiplier (only applied when enabled). Pass to mode.setAiLevelMultiplier. */
export function aiMultiplier(settings) {
  const base = (DIFFICULTY_PRESETS[settings?.difficulty] ?? DIFFICULTY_PRESETS.normal).multiplier;
  const a = settings?.adaptive;
  return base * (a && a.enabled && Number.isFinite(a.multiplier) ? a.multiplier : 1);
}

// ---- endings ----
export const GAME_OVER_REASONS = Object.freeze({
  'released-early': 'You let go of the door too soon.',
  'door-open': 'Something was at the door and you never closed it.',
  flashlit: 'You kept the light on something that wanted to be seen.',
  swarm: 'The small ones gathered, and nobody sent them away.',
  'mask-off': 'The intruder found you with the mask down.',
  musicbox: 'The music stopped.',
  'power-out': 'The power ran out.',
  office: 'It reached the office.',
  unknown: 'The night got the better of you.',
});
export function describeEnding(kind, { mode = 'fnaf1', night = 1, reason = 'unknown', who = null } = {}) {
  if (kind === 'night-complete') {
    const last = night === 6;
    return { kind, mode, night, title: last ? 'Night 6 Complete' : `Night ${night} Complete`, text: last ? 'You outlasted the nightmare shift.' : '6 AM. The shift is over.' };
  }
  if (kind === 'game-over') {
    return { kind, mode, night, who, reason, title: 'Game Over', text: GAME_OVER_REASONS[reason] ?? GAME_OVER_REASONS.unknown };
  }
  throw new RangeError(`unknown ending kind ${kind}`);
}
/** Derive an ending from a mode snapshot (null while the night is still running). */
export function endingFromSnapshot(snap) {
  if (!snap) return null;
  if (snap.won) return describeEnding('night-complete', { mode: snap.mode, night: snap.night });
  if (snap.dead) return describeEnding('game-over', { mode: snap.mode, night: snap.night, who: snap.scare ?? null, reason: snap.deathReason ?? 'unknown' });
  return null;
}
