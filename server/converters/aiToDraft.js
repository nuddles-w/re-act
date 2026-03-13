/**
 * AI 输出转换为 Draft
 *
 * 将 AI 生成的 segments 和 edits 转换为 Draft 结构
 */

import {
  createEmptyDraft,
  createTrack,
  createVideoSegment,
  createTextSegment,
  createFadeSegment,
  createAudioSegment,
  addVideoSource,
  updateDraftDuration,
  TrackType,
} from "../../src/domain/draftModel.js";

/**
 * 将 AI 输出转换为 Draft
 * @param {object} aiOutput - { segments, events, edits, summary }
 * @param {object} videoSource - { name, path, duration, width, height, fps }
 * @param {string} sessionId
 * @returns {object} draft
 */
export function aiOutputToDraft(aiOutput, videoSource, sessionId) {
  const draft = createEmptyDraft();

  // 添加视频源
  const sourceId = addVideoSource(draft, videoSource);

  // 创建视频轨道
  const videoTrack = createTrack(TrackType.VIDEO, "V1");
  draft.tracks.push(videoTrack);

  // 转换 segments（AI 推荐的视频片段）
  if (aiOutput.segments && aiOutput.segments.length > 0) {
    convertSegmentsToDraft(aiOutput.segments, videoTrack, sourceId, videoSource.duration);
  } else {
    // 如果没有 segments，创建一个完整视频片段
    const fullSegment = createVideoSegment({
      sourceId,
      timelineStart: 0,
      timelineDuration: videoSource.duration,
      sourceStart: 0,
      sourceEnd: videoSource.duration,
      playbackRate: 1.0,
    });
    videoTrack.segments.push(fullSegment);
  }

  // 转换 edits（各种编辑操作）
  if (aiOutput.edits && aiOutput.edits.length > 0) {
    convertEditsToDraft(aiOutput.edits, draft, videoTrack);
  }

  // 更新总时长
  updateDraftDuration(draft);

  return draft;
}

/**
 * 转换 segments 到视频轨道
 */
function convertSegmentsToDraft(segments, videoTrack, sourceId, totalDuration) {
  let currentTimelineTime = 0;

  segments.forEach((seg, index) => {
    const sourceStart = seg.start || 0;
    const sourceEnd = seg.end || seg.start + (seg.duration || 1);
    const sourceDuration = sourceEnd - sourceStart;
    const playbackRate = seg.playbackRate || 1.0;
    const timelineDuration = sourceDuration / playbackRate;

    const videoSegment = createVideoSegment({
      sourceId,
      timelineStart: currentTimelineTime,
      timelineDuration,
      sourceStart,
      sourceEnd,
      playbackRate,
      volume: seg.volume || 1.0,
    });

    videoTrack.segments.push(videoSegment);
    currentTimelineTime += timelineDuration;
  });
}

/**
 * 转换 edits 到对应的轨道
 */
function convertEditsToDraft(edits, draft, videoTrack) {
  const textEdits = edits.filter(e => e.type === "text");
  const fadeEdits = edits.filter(e => e.type === "fade");
  const speedEdits = edits.filter(e => e.type === "speed");
  const deleteEdits = edits.filter(e => e.type === "delete");
  const bgmEdits = edits.filter(e => e.type === "bgm");

  // 处理文字编辑
  if (textEdits.length > 0) {
    const textTrack = createTrack(TrackType.TEXT, "T1");
    draft.tracks.push(textTrack);

    textEdits.forEach(edit => {
      const textSegment = createTextSegment({
        timelineStart: edit.start,
        timelineDuration: edit.end - edit.start,
        content: edit.text,
        style: {
          fontSize: 48,
          color: "#ffffff",
          position: edit.position || "bottom",
          fontFamily: "Arial",
          stroke: { color: "#000000", width: 2 },
        },
      });
      textTrack.segments.push(textSegment);
    });
  }

  // 处理淡入淡出效果
  if (fadeEdits.length > 0) {
    const effectTrack = createTrack(TrackType.EFFECT, "FX1");
    draft.tracks.push(effectTrack);

    fadeEdits.forEach(edit => {
      const fadeSegment = createFadeSegment({
        timelineStart: edit.start,
        timelineDuration: edit.end - edit.start,
        direction: edit.direction, // "in" | "out"
        targetTrack: "V1",
      });
      effectTrack.segments.push(fadeSegment);
    });
  }

  // 处理速度调整（应用到视频片段）
  speedEdits.forEach(edit => {
    applySpeedEditToSegments(videoTrack, edit);
  });

  // 处理删除操作（从视频轨道移除片段）
  deleteEdits.forEach(edit => {
    applyDeleteEditToSegments(videoTrack, edit);
  });

  // 处理背景音乐
  if (bgmEdits.length > 0) {
    const audioTrack = createTrack(TrackType.AUDIO, "A1");
    draft.tracks.push(audioTrack);

    // BGM 暂时只记录关键词，实际音频在导出时下载
    bgmEdits.forEach(edit => {
      audioTrack.segments.push({
        id: `seg-a-bgm-${Date.now()}`,
        type: "bgm",
        keywords: edit.keywords,
        volume: edit.volume || 0.3,
        timelineStart: 0,
        timelineDuration: 0, // 导出时根据视频总时长确定
      });
    });
  }
}

/**
 * 应用速度调整到视频片段
 */
function applySpeedEditToSegments(videoTrack, speedEdit) {
  const { start, end, rate } = speedEdit;

  videoTrack.segments.forEach(segment => {
    // 检查片段是否在速度调整范围内
    const segStart = segment.sourceStart;
    const segEnd = segment.sourceEnd;

    if (segStart >= start && segEnd <= end) {
      // 完全在范围内，直接调整速度
      segment.playbackRate = rate;
      segment.timelineDuration = (segEnd - segStart) / rate;
    } else if (segStart < end && segEnd > start) {
      // 部分重叠，需要分割（这里简化处理，实际应该分割片段）
      console.warn(`[aiToDraft] Speed edit overlaps with segment, skipping split`);
    }
  });

  // 重新计算 timelineStart
  let currentTime = 0;
  videoTrack.segments.forEach(segment => {
    segment.timelineStart = currentTime;
    currentTime += segment.timelineDuration;
  });
}

/**
 * 应用删除操作到视频片段
 */
function applyDeleteEditToSegments(videoTrack, deleteEdit) {
  const { start, end } = deleteEdit;

  // 过滤掉在删除范围内的片段
  videoTrack.segments = videoTrack.segments.filter(segment => {
    const segStart = segment.sourceStart;
    const segEnd = segment.sourceEnd;

    // 完全在删除范围内，移除
    if (segStart >= start && segEnd <= end) {
      return false;
    }

    // 部分重叠，需要裁剪（这里简化处理）
    if (segStart < end && segEnd > start) {
      console.warn(`[aiToDraft] Delete edit overlaps with segment, keeping segment`);
    }

    return true;
  });

  // 重新计算 timelineStart
  let currentTime = 0;
  videoTrack.segments.forEach(segment => {
    segment.timelineStart = currentTime;
    currentTime += segment.timelineDuration;
  });
}
