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

const buildSegments = (duration, random) => {
  const segmentCount = Math.max(6, Math.min(12, Math.round(duration / 6)));
  const segmentLength = duration / segmentCount;

  return Array.from({ length: segmentCount }, (_, index) => {
    const start = index * segmentLength;
    const end = index === segmentCount - 1 ? duration : (index + 1) * segmentLength;
    const energy = Number((0.3 + random() * 0.7).toFixed(2));
    const motionScore = Number((0.2 + random() * 0.8).toFixed(2));
    const speechDensity = Number((0.2 + random() * 0.8).toFixed(2));
    return {
      id: `${start.toFixed(2)}-${end.toFixed(2)}`,
      start,
      end,
      duration: Math.max(0, end - start),
      energy,
      tags: {},
    };
  });
};

const buildEditsFromRequest = (segments, requestText) => {
  if (!requestText) return { events: [], edits: [] };
  const text = requestText.toLowerCase();
  const targetSegment =
    segments[Math.max(0, Math.floor(segments.length / 2))] || segments[0];

  const events = [];
  if (text.includes("日出") || text.includes("太阳升起")) {
    events.push({
      type: "sunrise",
      label: "太阳升起",
      start: targetSegment.start,
      end: targetSegment.end,
      confidence: 0.72,
    });
  }

  if (text.includes("鸡蛋") || text.includes("捣碎")) {
    events.push({
      type: "action",
      label: "鸡蛋被捣碎",
      start: targetSegment.start,
      end: targetSegment.end,
      confidence: 0.85,
    });
  }

  const edits = [];
  if (text.includes("变慢") || text.includes("0.5")) {
    edits.push({
      type: "slow",
      start: targetSegment.start,
      end: targetSegment.end,
      rate: 0.5,
      reason: "根据用户诉求降速",
      split: true,
    });
  }

  if (text.includes("分割") && edits.length === 0) {
    edits.push({
      type: "split",
      start: targetSegment.start,
      end: targetSegment.end,
      reason: "根据用户诉求分割",
      split: true,
    });
  }

  return { events, edits };
};

export const buildMockFeatures = (
  video,
  duration,
  rawText = "",
  intent = null,
  requestText = ""
) => {
  const seed = hashString(
    `${video.name}-${video.size}-${duration}-${rawText}-${requestText}`
  );
  const random = createSeededRandom(seed);
  const segments = buildSegments(duration || 30, random);
  const rhythmScore =
    segments.reduce((sum, segment) => sum + segment.energy, 0) / segments.length;
  const requestEdits = buildEditsFromRequest(segments, requestText);

  return {
    duration: duration || 30,
    segmentCount: segments.length,
    segments,
    keyframes: segments.map((segment) => ({
      time: Number((segment.start + segment.duration / 2).toFixed(2)),
      energy: segment.energy,
    })),
    rhythmScore: Number(rhythmScore.toFixed(2)),
    intentHint: intent,
    events: requestEdits.events,
    edits: requestEdits.edits,
  };
};
