const normalizeText = (text) =>
  text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

const tryExtractJson = (text) => {
  const normalized = normalizeText(text);
  const first = normalized.indexOf("{");
  const last = normalized.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const snippet = normalized.slice(first, last + 1);
  try {
    return JSON.parse(snippet);
  } catch (error) {
    return null;
  }
};

export const parseFeatures = (text) => {
  const payload = tryExtractJson(text);
  if (!payload || !Array.isArray(payload.segments)) return null;

  const segments = payload.segments
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .map((segment) => {
      const start = Number(segment.start);
      const end = Number(segment.end);
      const energy = Number(segment.energy || 0.5);
      return {
        id: `${start.toFixed(2)}-${end.toFixed(2)}`,
        start,
        end,
        duration: Math.max(0, end - start),
        energy,
        tags: {},
      };
    });

  if (segments.length === 0) return null;

  const duration = Math.max(...segments.map((segment) => segment.end));
  const rhythmScore =
    segments.reduce((sum, segment) => sum + segment.energy, 0) / segments.length;

  return {
    duration,
    segmentCount: segments.length,
    segments,
    keyframes: segments.map((segment) => ({
      time: Number((segment.start + segment.duration / 2).toFixed(2)),
      energy: segment.energy,
    })),
    rhythmScore: Number((payload.rhythmScore ?? rhythmScore).toFixed(2)),
    events: Array.isArray(payload.events) ? payload.events : [],
    edits: Array.isArray(payload.edits) ? payload.edits : [],
  };
};
