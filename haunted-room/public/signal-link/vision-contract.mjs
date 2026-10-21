// Internal visual observations. Separate from the partner's Signal Scope protocol.
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\x00-\x1f\x7f]/.test(v);
export function validVision(m) {
  const validSource = m?.source === 'roboflow'
    ? Number.isFinite(m.confidence) && m.confidence >= 0 && m.confidence <= 1
    : m?.source === 'local_graph_detector' && m.model_id === 'local-graph/1' && m.label === 'graph_change' && m.confidence === null &&
      Number.isFinite(m.score) && m.score >= 2 && m.score <= 1600 && Number.isFinite(m.amplitude_px) && m.amplitude_px >= 3 && m.amplitude_px <= 1600 && Number.isFinite(m.coverage) && m.coverage >= .65 && m.coverage <= 1;
  return !!m && validSource && m.schema === 'horror.vision.v1' &&
    m.event === 'visual_pattern' && m.emotion === null && m.quality === 'unverified' &&
    ['id', 'session_id', 'encounter_id', 'model_id', 'label'].every(k => text(m[k])) &&
    ['created_at_ms', 'received_at_ms'].every(k => Number.isSafeInteger(m[k]) && m[k] >= 0);
}
