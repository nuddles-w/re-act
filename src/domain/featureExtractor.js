import { createSegment } from "./models.js";

const hashString = (value) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

const createSeededRandom = (seed) => {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
};

export const extractFeaturesFromVideo = (file, duration) => {
  const seed = hashString(`${file.name}-${file.size}-${duration}`);
  const random = createSeededRandom(seed);
  const segmentCount = Math.max(6, Math.min(12, Math.round(duration / 6)));
  const segmentLength = duration / segmentCount;

  const segments = Array.from({ length: segmentCount }, (_, index) => {
    const start = index * segmentLength;
    const end = index === segmentCount - 1 ? duration : (index + 1) * segmentLength;
    const energy = Number((0.3 + random() * 0.7).toFixed(2));
    const motionScore = Number((0.2 + random() * 0.8).toFixed(2));
    const speechDensity = Number((0.2 + random() * 0.8).toFixed(2));
    const tags = {
      hasFace: random() > 0.6,
      hasAction: random() > 0.55,
      hasDialogue: random() > 0.5,
      motionScore,
      speechDensity,
    };
    return createSegment(start, end, energy, tags);
  });

  const keyframes = segments.map((segment) => ({
    time: Number((segment.start + segment.duration / 2).toFixed(2)),
    energy: segment.energy,
  }));

  const rhythmScore =
    segments.reduce((sum, segment) => sum + segment.energy, 0) / segments.length;

  return {
    duration,
    segmentCount,
    segments,
    keyframes,
    rhythmScore: Number(rhythmScore.toFixed(2)),
  };
};
