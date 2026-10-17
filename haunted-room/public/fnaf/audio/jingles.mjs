// Original music-box jingles for the FNAF audio layer. Composed for this
// project; not a transcription of any existing tune. Distinct from
// MELODY in music-box.mjs (A minor lullaby): this one lives in D minor/Locrian
// colour with a falling tritone and a stalled final bar.
// Note data only; fnaf-audio.mjs renders it with synthesized bell voices.

export const POWER_OUT_JINGLE = Object.freeze({
  name: "power-out-jingle",
  bpm: 58,
  notes: Object.freeze(
    [
      [74, 1], [77, 1], [81, 0.5], [80, 0.5], [77, 1],
      [75, 1], [74, 1], [70, 0.5], [69, 0.5], [67, 1],
      [69, 0.5], [70, 0.5], [74, 1], [73, 1], [70, 1],
      [69, 1.5], [66, 0.5], [62, 3],
    ].map(([midi, beats]) => Object.freeze({ midi, beats })),
  ),
});

export const JINGLES = Object.freeze({ "power-out": POWER_OUT_JINGLE });

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function jingleDuration(j) {
  const beat = 60 / j.bpm;
  return j.notes.reduce((s, n) => s + n.beats * beat, 0);
}

// Returns [{midi, at, dur}] with start offsets in seconds.
export function scheduleJingle(j, { tempoScale = 1, dropRng = null, dropP = 0 } = {}) {
  const beat = 60 / (j.bpm * tempoScale);
  const out = [];
  let t = 0;
  for (const n of j.notes) {
    if (!(dropRng && dropP > 0 && dropRng() < dropP)) out.push({ midi: n.midi, at: t, dur: n.beats * beat });
    t += n.beats * beat;
  }
  return out;
}
