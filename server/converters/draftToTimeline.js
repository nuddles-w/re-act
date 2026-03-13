/**
 * Draft 转换为 Timeline（向后兼容）
 *
 * 将新的 Draft 结构转换为旧的 timeline 格式，保证现有前端代码能继续工作
 */

/**
 * 将 Draft 转换为 Timeline
 * @param {object} draft
 * @returns {object} timeline - { clips, totalDuration, textEdits, fadeEdits, bgmEdits }
 */
export function draftToTimeline(draft) {
  if (!draft || !draft.tracks) {
    return {
      clips: [],
      totalDuration: 0,
      textEdits: [],
      fadeEdits: [],
      bgmEdits: [],
    };
  }

  const timeline = {
    clips: [],
    totalDuration: draft.settings.totalDuration,
    textEdits: [],
    fadeEdits: [],
    bgmEdits: [],
  };

  // 转换视频轨道
  const videoTrack = draft.tracks.find(t => t.type === "video");
  if (videoTrack) {
    timeline.clips = convertVideoSegmentsToClips(videoTrack.segments);
  }

  // 转换文字轨道
  const textTrack = draft.tracks.find(t => t.type === "text");
  if (textTrack) {
    timeline.textEdits = convertTextSegmentsToEdits(textTrack.segments);
  }

  // 转换效果轨道
  const effectTrack = draft.tracks.find(t => t.type === "effect");
  if (effectTrack) {
    timeline.fadeEdits = convertFadeSegmentsToEdits(effectTrack.segments);
  }

  // 转换音频轨道
  const audioTrack = draft.tracks.find(t => t.type === "audio");
  if (audioTrack) {
    timeline.bgmEdits = convertAudioSegmentsToBgmEdits(audioTrack.segments);
  }

  return timeline;
}

/**
 * 转换视频 segments 为 clips
 */
function convertVideoSegmentsToClips(segments) {
  return segments.map(seg => ({
    id: seg.id,
    start: seg.sourceStart,
    end: seg.sourceEnd,
    duration: seg.sourceEnd - seg.sourceStart,
    timelineStart: seg.timelineStart,
    displayDuration: seg.timelineDuration,
    playbackRate: seg.playbackRate || 1.0,
    volume: seg.volume || 1.0,
    energy: 0.5, // 默认值
    label: `Clip ${seg.id}`,
    transform: seg.transform,
    filters: seg.filters,
  }));
}

/**
 * 转换文字 segments 为 textEdits
 */
function convertTextSegmentsToEdits(segments) {
  return segments.map(seg => ({
    type: "text",
    start: seg.timelineStart,
    end: seg.timelineStart + seg.timelineDuration,
    timelineStart: seg.timelineStart,
    timelineEnd: seg.timelineStart + seg.timelineDuration,
    text: seg.content,
    position: seg.style?.position || "bottom",
    style: seg.style,
  }));
}

/**
 * 转换淡入淡出 segments 为 fadeEdits
 */
function convertFadeSegmentsToEdits(segments) {
  return segments
    .filter(seg => seg.effectType === "fade")
    .map(seg => ({
      type: "fade",
      start: seg.timelineStart,
      end: seg.timelineStart + seg.timelineDuration,
      timelineStart: seg.timelineStart,
      timelineEnd: seg.timelineStart + seg.timelineDuration,
      direction: seg.direction,
      mode: seg.direction, // "in" | "out"
    }));
}

/**
 * 转换音频 segments 为 bgmEdits
 */
function convertAudioSegmentsToBgmEdits(segments) {
  return segments
    .filter(seg => seg.type === "bgm")
    .map(seg => ({
      type: "bgm",
      keywords: seg.keywords,
      volume: seg.volume || 0.3,
    }));
}
