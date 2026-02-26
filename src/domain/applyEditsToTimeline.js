const mediaToTimelineTime = (mediaTime, clips) => {
  for (const clip of clips) {
    if (mediaTime >= clip.start - 0.05 && mediaTime <= clip.end + 0.05) {
      const offset = Math.max(0, mediaTime - clip.start);
      return clip.timelineStart + offset / (clip.playbackRate || 1);
    }
  }
  return mediaTime;
};

export const applyEditsToTimeline = (timeline, edits, totalDuration = 0) => {
  if (!timeline) return timeline;
  if (!edits || edits.length === 0) return { ...timeline, textEdits: [], fadeEdits: [] };

  let currentClips =
    timeline.clips && timeline.clips.length > 0
      ? [...timeline.clips]
      : [
          {
            start: 0,
            end: totalDuration,
            duration: totalDuration,
            id: "base-clip",
            energy: 0.5,
            label: "Original Video",
          },
        ];

  const hasDelete = edits.some((e) => e?.type === "delete");
  const splitEpsilon = hasDelete ? 0.02 : 0.1;

  const splitPoints = new Set();
  edits.forEach((edit) => {
    // text 和 fade 编辑不影响视频片段的分割
    if (edit?.type === "text" || edit?.type === "fade") return;
    if (edit.start != null && edit.start > 0) splitPoints.add(Number(edit.start.toFixed(2)));
    if (edit.end != null && edit.end > 0) splitPoints.add(Number(edit.end.toFixed(2)));
  });

  const sortedPoints = Array.from(splitPoints).sort((a, b) => a - b);

  sortedPoints.forEach((point) => {
    const newClips = [];
    currentClips.forEach((clip) => {
      if (point > clip.start + splitEpsilon && point < clip.end - splitEpsilon) {
        newClips.push(
          {
            ...clip,
            end: point,
            duration: point - clip.start,
            id: `split-${clip.start.toFixed(2)}-${point.toFixed(2)}`,
          },
          {
            ...clip,
            start: point,
            duration: clip.end - point,
            id: `split-${point.toFixed(2)}-${clip.end.toFixed(2)}`,
          }
        );
      } else {
        newClips.push(clip);
      }
    });
    currentClips = newClips;
  });

  const deleteEdits = edits.filter((e) => e?.type === "delete");
  if (deleteEdits.length > 0) {
    const coverTolerance = 0.02;
    currentClips = currentClips.filter((clip) => {
      const covered = deleteEdits.some(
        (e) => e.start <= clip.start + coverTolerance && e.end >= clip.end - coverTolerance
      );
      return !covered;
    });
  }

  const finalClips = currentClips.map((clip) => {
    const speedEdit = edits.find(
      (e) => e.type === "speed" && e.start <= clip.start + 0.2 && e.end >= clip.end - 0.2
    );

    const splitEdit = edits.find(
      (e) => e.type === "split" && e.start <= clip.start + 0.2 && e.end >= clip.end - 0.2
    );

    const edit = speedEdit || splitEdit;

    if (!edit) return { ...clip, playbackRate: 1 };

    return {
      ...clip,
      playbackRate: edit.rate || 1,
      edit,
    };
  });

  let currentTimelineTime = 0;
  const clipsWithTimelinePositions = finalClips.map((clip) => {
    const playbackRate = clip.playbackRate || 1;
    const displayDuration = clip.duration / playbackRate;
    const timelineClip = {
      ...clip,
      timelineStart: currentTimelineTime,
      displayDuration,
    };
    currentTimelineTime += displayDuration;
    return timelineClip;
  });

  const textEdits = edits
    .filter((e) => e?.type === "text")
    .map((edit) => ({
      ...edit,
      timelineStart: mediaToTimelineTime(edit.start, clipsWithTimelinePositions),
      timelineEnd: mediaToTimelineTime(edit.end, clipsWithTimelinePositions),
    }));

  const fadeEdits = edits
    .filter((e) => e?.type === "fade")
    .map((edit) => ({
      ...edit,
      timelineStart: mediaToTimelineTime(edit.start, clipsWithTimelinePositions),
      timelineEnd: mediaToTimelineTime(edit.end, clipsWithTimelinePositions),
    }));

  return {
    ...timeline,
    clips: clipsWithTimelinePositions,
    totalTimelineDuration: currentTimelineTime,
    textEdits,
    fadeEdits,
  };
};

