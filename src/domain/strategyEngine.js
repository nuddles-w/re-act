import { createTimelineClip } from "./models.js";

const scoreSegment = (segment, intent) => {
  const energy = segment.energy;
  const styleScore =
    intent.style === "fast"
      ? energy
      : intent.style === "slow"
        ? 1 - energy
        : 0.5 + energy * 0.5;

  const templateScore =
    intent.template === "vlog"
      ? (segment.tags.hasFace ? 0.25 : 0) + segment.tags.speechDensity * 0.2
      : intent.template === "sport"
        ? (segment.tags.hasAction ? 0.3 : 0) + segment.tags.motionScore * 0.25
        : intent.template === "story"
          ? (segment.tags.hasDialogue ? 0.2 : 0) + (1 - energy) * 0.2
          : 0.1;

  const focusScore =
    intent.focus === "face"
      ? segment.tags.hasFace
        ? 0.3
        : 0
      : intent.focus === "action"
        ? segment.tags.hasAction
          ? 0.3
          : 0
        : 0;

  return styleScore + focusScore + templateScore;
};

const buildReason = (segment, intent) => {
  const reasonParts = [];
  if (intent.style === "fast" && segment.energy > 0.7) reasonParts.push("高能量片段");
  if (intent.style === "slow" && segment.energy < 0.45) reasonParts.push("低能量片段");
  if (intent.focus === "face" && segment.tags.hasFace) reasonParts.push("包含人物");
  if (intent.focus === "action" && segment.tags.hasAction) reasonParts.push("动作明显");
  if (intent.template === "vlog" && segment.tags.hasDialogue)
    reasonParts.push("对白密度高");
  if (intent.template === "sport" && segment.tags.motionScore > 0.6)
    reasonParts.push("运动强度高");
  if (intent.template === "story" && segment.tags.hasDialogue)
    reasonParts.push("叙事片段");
  if (intent.focus === "none") reasonParts.push("均衡覆盖");
  if (reasonParts.length === 0) reasonParts.push("综合评分优先");
  return reasonParts.join(" · ");
};

export const buildTimeline = (features, intent) => {
  const targetDuration = Math.min(intent.targetDuration, features.duration);
  const selected = new Map();

  const reserveSegment = (segment, reason) => {
    if (!selected.has(segment.id)) {
      selected.set(segment.id, createTimelineClip(segment, reason));
    }
  };

  if (intent.keepStart && features.segments.length > 0) {
    reserveSegment(features.segments[0], "保留开场");
  }

  if (intent.keepEnd && features.segments.length > 1) {
    reserveSegment(
      features.segments[features.segments.length - 1],
      "保留结尾"
    );
  }

  const ranked = features.segments
    .map((segment) => ({
      segment,
      score: scoreSegment(segment, intent),
    }))
    .sort((a, b) => b.score - a.score);

  let accumulated = Array.from(selected.values()).reduce(
    (sum, clip) => sum + clip.duration,
    0
  );

  for (const entry of ranked) {
    if (accumulated >= targetDuration) break;
    if (selected.has(entry.segment.id)) continue;
    selected.set(
      entry.segment.id,
      createTimelineClip(entry.segment, buildReason(entry.segment, intent))
    );
    accumulated += entry.segment.duration;
  }

  const clips = Array.from(selected.values()).sort((a, b) => a.start - b.start);

  return {
    targetDuration,
    clips,
    totalDuration: clips.reduce((sum, clip) => sum + clip.duration, 0),
  };
};
