export const defaultIntent = {
  targetDuration: 30,
  style: "balanced",
  focus: "none",
  template: "general",
  keepStart: true,
  keepEnd: false,
};

export const createSegment = (start, end, energy, tags) => ({
  id: `${start.toFixed(2)}-${end.toFixed(2)}`,
  start,
  end,
  duration: Math.max(0, end - start),
  energy,
  tags,
});

export const createTimelineClip = (segment, reason) => ({
  id: segment.id,
  start: segment.start,
  end: segment.end,
  duration: segment.duration,
  energy: segment.energy,
  tags: segment.tags,
  reason,
});
