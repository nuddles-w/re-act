/**
 * Draft 数据模型定义
 *
 * Draft 是剪辑项目的核心数据结构，采用多轨道设计
 */

// ── Track 类型 ────────────────────────────────────────────────
export const TrackType = {
  VIDEO: "video",
  AUDIO: "audio",
  TEXT: "text",
  EFFECT: "effect",
};

// ── Segment 基础结构 ──────────────────────────────────────────
export const SegmentType = {
  VIDEO: "video",
  AUDIO: "audio",
  TEXT: "text",
  FADE: "fade",
  FILTER: "filter",
};

// ── 工厂函数 ──────────────────────────────────────────────────

/**
 * 创建空白 Draft
 */
export function createEmptyDraft() {
  return {
    version: 1,
    lastModified: Date.now(),
    sources: {},
    tracks: [],
    settings: {
      totalDuration: 0,
      resolution: { width: 1920, height: 1080 },
      fps: 30,
      aspectRatio: "16:9",
    },
  };
}

/**
 * 创建 Track
 */
export function createTrack(type, id = null) {
  return {
    id: id || `${type.charAt(0).toUpperCase()}${Date.now()}`,
    type,
    enabled: true,
    locked: false,
    segments: [],
  };
}

/**
 * 创建视频 Segment
 */
export function createVideoSegment({
  sourceId,
  timelineStart,
  timelineDuration,
  sourceStart,
  sourceEnd,
  playbackRate = 1.0,
  volume = 1.0,
  transform = null,
  filters = null,
}) {
  return {
    id: `seg-v-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type: SegmentType.VIDEO,
    sourceId,
    timelineStart,
    timelineDuration,
    sourceStart,
    sourceEnd,
    playbackRate,
    volume,
    transform: transform || {
      scale: 1.0,
      x: 0,
      y: 0,
      rotate: 0,
      flipX: false,
      flipY: false,
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    filters: filters || {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      hue: 0,
      sharpness: 0,
    },
  };
}

/**
 * 创建音频 Segment
 */
export function createAudioSegment({
  sourceId,
  timelineStart,
  timelineDuration,
  sourceStart,
  sourceEnd,
  volume = 1.0,
  fadeIn = 0,
  fadeOut = 0,
}) {
  return {
    id: `seg-a-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type: SegmentType.AUDIO,
    sourceId,
    timelineStart,
    timelineDuration,
    sourceStart,
    sourceEnd,
    volume,
    fadeIn,
    fadeOut,
  };
}

/**
 * 创建文字 Segment
 */
export function createTextSegment({
  timelineStart,
  timelineDuration,
  content,
  style = null,
}) {
  return {
    id: `seg-t-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type: SegmentType.TEXT,
    timelineStart,
    timelineDuration,
    content,
    style: style || {
      fontSize: 48,
      color: "#ffffff",
      position: "bottom",
      fontFamily: "Arial",
      backgroundColor: null,
      stroke: { color: "#000000", width: 2 },
    },
  };
}

/**
 * 创建淡入淡出效果 Segment
 */
export function createFadeSegment({
  timelineStart,
  timelineDuration,
  direction,
  targetTrack = null,
}) {
  return {
    id: `seg-fx-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type: SegmentType.FADE,
    effectType: "fade",
    timelineStart,
    timelineDuration,
    direction, // "in" | "out"
    targetTrack, // 作用于哪个轨道，null 表示所有视频轨道
  };
}

/**
 * 添加视频源到 Draft
 */
export function addVideoSource(draft, videoFile) {
  const sourceId = `video-${Date.now()}`;
  draft.sources[sourceId] = {
    type: "video",
    name: videoFile.name,
    path: videoFile.path,
    duration: videoFile.duration,
    metadata: {
      width: videoFile.width || 1920,
      height: videoFile.height || 1080,
      fps: videoFile.fps || 30,
    },
  };
  return sourceId;
}

/**
 * 添加音频源到 Draft
 */
export function addAudioSource(draft, audioFile) {
  const sourceId = `audio-${Date.now()}`;
  draft.sources[sourceId] = {
    type: "audio",
    name: audioFile.name,
    path: audioFile.path,
    duration: audioFile.duration,
  };
  return sourceId;
}

/**
 * 查找或创建指定类型的轨道
 */
export function getOrCreateTrack(draft, trackType) {
  let track = draft.tracks.find(t => t.type === trackType && !t.locked);
  if (!track) {
    track = createTrack(trackType);
    draft.tracks.push(track);
  }
  return track;
}

/**
 * 根据 ID 查找 Segment
 */
export function findSegmentById(draft, segmentId) {
  for (const track of draft.tracks) {
    const segment = track.segments.find(s => s.id === segmentId);
    if (segment) {
      return { track, segment };
    }
  }
  return null;
}

/**
 * 获取指定时间点的活跃 Segments
 */
export function getActiveSegments(draft, timelineTime) {
  const active = [];
  draft.tracks.forEach(track => {
    if (!track.enabled) return;
    track.segments.forEach(segment => {
      if (
        timelineTime >= segment.timelineStart &&
        timelineTime < segment.timelineStart + segment.timelineDuration
      ) {
        active.push({ track, segment });
      }
    });
  });
  return active;
}

/**
 * 计算 Draft 的总时长
 */
export function calculateTotalDuration(draft) {
  let maxEnd = 0;
  draft.tracks.forEach(track => {
    track.segments.forEach(segment => {
      const end = segment.timelineStart + segment.timelineDuration;
      if (end > maxEnd) maxEnd = end;
    });
  });
  return maxEnd;
}

/**
 * 更新 Draft 的总时长
 */
export function updateDraftDuration(draft) {
  draft.settings.totalDuration = calculateTotalDuration(draft);
  draft.lastModified = Date.now();
}
