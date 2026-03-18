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
import { searchAndDownloadBgm } from "../utils/fetchBgm.js";

/**
 * 将 AI 输出转换为 Draft
 * @param {object} aiOutput - { segments, events, edits, summary }
 * @param {object} videoSource - { name, path, duration, width, height, fps }
 * @param {string} sessionId
 * @param {Function} onProgress - 进度回调
 * @param {object} existingDraft - 现有 Draft（多轮对话时传入，用于增量更新）
 * @returns {Promise<object>} draft
 */
export async function aiOutputToDraft(aiOutput, videoSource, sessionId, onProgress, existingDraft = null) {
  const edits = aiOutput.edits || [];
  const splitEdits = edits.filter(e => e.type === "split");
  const speedEdits = edits.filter(e => e.type === "speed");
  const deleteEdits = edits.filter(e => e.type === "delete");
  const textEdits = edits.filter(e => e.type === "text");
  const fadeEdits = edits.filter(e => e.type === "fade");
  const bgmEdits = edits.filter(e => e.type === "bgm");

  // 多轮对话增量更新：在现有 Draft 基础上操作
  if (existingDraft && existingDraft.tracks && existingDraft.tracks.length > 0) {
    const draft = JSON.parse(JSON.stringify(existingDraft));
    const videoTrack = draft.tracks.find(t => t.type === "video");

    if (videoTrack && videoTrack.segments.length > 0) {
      // 应用结构性编辑到现有片段
      deleteEdits.forEach(edit => applyDeleteEditToSegments(videoTrack, edit));
      speedEdits.forEach(edit => applySpeedEditToSegments(videoTrack, edit));
      splitEdits.forEach(edit => applySplitEditToSegments(videoTrack, edit));
    }

    // 增量添加文字、特效、BGM
    await convertNonStructuralEdits(draft, videoTrack, textEdits, fadeEdits, bgmEdits, sessionId, onProgress);
    updateDraftDuration(draft);
    console.log(`[aiToDraft] 增量更新 Draft: ${deleteEdits.length} 删除, ${speedEdits.length} 变速, ${splitEdits.length} 分割, ${textEdits.length} 文字`);
    return draft;
  }

  // 首次创建 Draft
  const draft = createEmptyDraft();

  // 添加视频源
  const sourceId = addVideoSource(draft, videoSource);

  // 创建视频轨道
  const videoTrack = createTrack(TrackType.VIDEO, "V1");
  draft.tracks.push(videoTrack);

  // 决定视频片段的构建策略
  const hasStructuralEdits = deleteEdits.length > 0 || speedEdits.length > 0;

  if (aiOutput.segments && aiOutput.segments.length > 0 && !hasStructuralEdits) {
    // AI 返回了精选片段，且没有结构性编辑，直接使用
    convertSegmentsToDraft(aiOutput.segments, videoTrack, sourceId, videoSource.duration);
  } else {
    // 从完整视频开始，应用 delete 和 speed edits
    const fullSegment = createVideoSegment({
      sourceId,
      timelineStart: 0,
      timelineDuration: videoSource.duration,
      sourceStart: 0,
      sourceEnd: videoSource.duration,
      playbackRate: 1.0,
    });
    videoTrack.segments.push(fullSegment);

    // 先应用 delete edits（删除片段）
    deleteEdits.forEach(edit => {
      applyDeleteEditToSegments(videoTrack, edit);
    });

    // 再应用 speed edits（调整速度）
    speedEdits.forEach(edit => {
      applySpeedEditToSegments(videoTrack, edit);
    });

    // 应用 volume edits（调整音量）
    volumeEdits.forEach(edit => {
      applyVolumeEditToSegments(videoTrack, edit);
    });
  }

  // 处理文字和特效（需要 mediaTime → timelineTime 转换）
  await convertNonStructuralEdits(draft, videoTrack, textEdits, fadeEdits, bgmEdits, sessionId, onProgress);

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
 * 处理文字、特效、BGM（需要 mediaTime → timelineTime 转换）
 */
async function convertNonStructuralEdits(draft, videoTrack, textEdits, fadeEdits, bgmEdits, sessionId, onProgress) {
  // 构建 mediaTime → timelineTime 映射函数
  const mediaToTimeline = (mediaTime) => {
    let timelineTime = 0;
    for (const seg of videoTrack.segments) {
      if (mediaTime >= seg.sourceStart && mediaTime <= seg.sourceEnd) {
        const offset = mediaTime - seg.sourceStart;
        return seg.timelineStart + offset / seg.playbackRate;
      }
      if (mediaTime < seg.sourceStart) break;
    }
    return timelineTime;
  };

  // 处理文字编辑
  if (textEdits.length > 0) {
    const textTrack = createTrack(TrackType.TEXT, "T1");
    draft.tracks.push(textTrack);

    textEdits.forEach(edit => {
      const timelineStart = mediaToTimeline(edit.start);
      const timelineEnd = mediaToTimeline(edit.end);

      const textSegment = createTextSegment({
        timelineStart,
        timelineDuration: timelineEnd - timelineStart,
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
      const timelineStart = mediaToTimeline(edit.start);
      const timelineEnd = mediaToTimeline(edit.end);

      const fadeSegment = createFadeSegment({
        timelineStart,
        timelineDuration: timelineEnd - timelineStart,
        direction: edit.direction,
        targetTrack: "V1",
      });
      effectTrack.segments.push(fadeSegment);
    });
  }

  // 处理背景音乐
  if (bgmEdits.length > 0) {
    const audioTrack = createTrack(TrackType.AUDIO, "A1");
    draft.tracks.push(audioTrack);

    const totalTimelineDuration = videoTrack.segments.reduce((sum, seg) => sum + seg.timelineDuration, 0);

    for (const edit of bgmEdits) {
      try {
        onProgress?.(`🎵 正在下载背景音乐...`);
        console.log(`[aiToDraft] Downloading BGM with keywords: "${edit.keywords}"`);
        const bgm = await searchAndDownloadBgm(edit.keywords, sessionId || `bgm-${Date.now()}`);
        console.log(`[aiToDraft] BGM downloaded: ${bgm.title} - ${bgm.artist} (${bgm.path})`);
        onProgress?.(`✅ 背景音乐已下载: ${bgm.title}`);

        audioTrack.segments.push({
          id: `seg-a-bgm-${Date.now()}`,
          type: "audio",
          sourceFile: bgm.path,
          timelineStart: 0,
          timelineDuration: totalTimelineDuration,
          volume: edit.volume || 0.3,
          metadata: {
            title: bgm.title,
            artist: bgm.artist,
            keywords: edit.keywords,
          },
        });
      } catch (error) {
        console.error(`[aiToDraft] Failed to download BGM: ${error.message}`);
        audioTrack.segments.push({
          id: `seg-a-bgm-${Date.now()}`,
          type: "bgm",
          keywords: edit.keywords,
          volume: edit.volume || 0.3,
          timelineStart: 0,
          timelineDuration: totalTimelineDuration,
          error: error.message,
        });
      }
    }
  }
}

/**
 * 应用速度调整到视频片段
 */
function applySpeedEditToSegments(videoTrack, speedEdit) {
  const { start, end, rate } = speedEdit;
  const newSegments = [];

  videoTrack.segments.forEach(segment => {
    const segStart = segment.sourceStart;
    const segEnd = segment.sourceEnd;

    // 完全在范围外，保持不变
    if (segEnd <= start || segStart >= end) {
      newSegments.push(segment);
      return;
    }

    // 完全在范围内，调整速度
    if (segStart >= start && segEnd <= end) {
      segment.playbackRate = rate;
      segment.timelineDuration = (segEnd - segStart) / rate;
      newSegments.push(segment);
      return;
    }

    // 部分重叠，需要分割
    if (segStart < start && segEnd > start) {
      // 分割：前半部分保持原速
      newSegments.push(createVideoSegment({
        sourceId: segment.sourceId,
        timelineStart: 0, // 稍后重新计算
        timelineDuration: start - segStart,
        sourceStart: segStart,
        sourceEnd: start,
        playbackRate: segment.playbackRate,
        volume: segment.volume,
      }));

      // 后半部分应用新速度
      const overlapEnd = Math.min(segEnd, end);
      newSegments.push(createVideoSegment({
        sourceId: segment.sourceId,
        timelineStart: 0,
        timelineDuration: (overlapEnd - start) / rate,
        sourceStart: start,
        sourceEnd: overlapEnd,
        playbackRate: rate,
        volume: segment.volume,
      }));

      // 如果还有剩余部分
      if (segEnd > end) {
        newSegments.push(createVideoSegment({
          sourceId: segment.sourceId,
          timelineStart: 0,
          timelineDuration: segEnd - end,
          sourceStart: end,
          sourceEnd: segEnd,
          playbackRate: segment.playbackRate,
          volume: segment.volume,
        }));
      }
    } else if (segStart < end && segEnd > end) {
      // 只有后半部分重叠
      newSegments.push(createVideoSegment({
        sourceId: segment.sourceId,
        timelineStart: 0,
        timelineDuration: (end - segStart) / rate,
        sourceStart: segStart,
        sourceEnd: end,
        playbackRate: rate,
        volume: segment.volume,
      }));

      newSegments.push(createVideoSegment({
        sourceId: segment.sourceId,
        timelineStart: 0,
        timelineDuration: segEnd - end,
        sourceStart: end,
        sourceEnd: segEnd,
        playbackRate: segment.playbackRate,
        volume: segment.volume,
      }));
    }
  });

  videoTrack.segments = newSegments;

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
  const newSegments = [];

  videoTrack.segments.forEach(segment => {
    const segStart = segment.sourceStart;
    const segEnd = segment.sourceEnd;

    // 完全在删除范围外，保留
    if (segEnd <= start || segStart >= end) {
      newSegments.push(segment);
      return;
    }

    // 完全在删除范围内，丢弃
    if (segStart >= start && segEnd <= end) {
      return;
    }

    // 部分重叠，裁剪
    if (segStart < start && segEnd > start) {
      // 保留前半部分
      const newEnd = Math.min(segEnd, start);
      newSegments.push(createVideoSegment({
        sourceId: segment.sourceId,
        timelineStart: 0,
        timelineDuration: (newEnd - segStart) / segment.playbackRate,
        sourceStart: segStart,
        sourceEnd: newEnd,
        playbackRate: segment.playbackRate,
        volume: segment.volume,
      }));
    }

    if (segStart < end && segEnd > end) {
      // 保留后半部分
      newSegments.push(createVideoSegment({
        sourceId: segment.sourceId,
        timelineStart: 0,
        timelineDuration: (segEnd - end) / segment.playbackRate,
        sourceStart: end,
        sourceEnd: segEnd,
        playbackRate: segment.playbackRate,
        volume: segment.volume,
      }));
    }
  });

  videoTrack.segments = newSegments;

  // 重新计算 timelineStart
  let currentTime = 0;
  videoTrack.segments.forEach(segment => {
    segment.timelineStart = currentTime;
    currentTime += segment.timelineDuration;
  });
}

/**
 * 应用分割编辑到视频片段
 */
function applySplitEditToSegments(videoTrack, splitEdit) {
  const splitTime = splitEdit.start;
  const newSegments = [];

  videoTrack.segments.forEach(segment => {
    if (splitTime <= segment.sourceStart || splitTime >= segment.sourceEnd) {
      newSegments.push(segment);
      return;
    }

    const rate = segment.playbackRate || 1;
    const offsetInSource = splitTime - segment.sourceStart;
    const offsetInTimeline = offsetInSource / rate;

    // 前半段
    newSegments.push(createVideoSegment({
      sourceId: segment.sourceId,
      timelineStart: segment.timelineStart,
      timelineDuration: offsetInTimeline,
      sourceStart: segment.sourceStart,
      sourceEnd: splitTime,
      playbackRate: rate,
      volume: segment.volume,
    }));

    // 后半段
    newSegments.push(createVideoSegment({
      sourceId: segment.sourceId,
      timelineStart: segment.timelineStart + offsetInTimeline,
      timelineDuration: segment.timelineDuration - offsetInTimeline,
      sourceStart: splitTime,
      sourceEnd: segment.sourceEnd,
      playbackRate: rate,
      volume: segment.volume,
    }));
  });

  videoTrack.segments = newSegments;
  console.log(`[aiToDraft] applySplitEdit at ${splitTime} → ${newSegments.length} segments`);
}

/**
 * 应用音量调整到视频片段
 */
function applyVolumeEditToSegments(videoTrack, volumeEdit) {
  const { start, end, volume } = volumeEdit;

  videoTrack.segments.forEach(segment => {
    const segStart = segment.sourceStart;
    const segEnd = segment.sourceEnd;

    // 检查片段是否在音量调整范围内
    if (segStart >= start - 0.1 && segEnd <= end + 0.1) {
      // 完全在范围内，调整音量
      segment.volume = volume;
    } else if (segStart < end && segEnd > start) {
      // 部分重叠，也应用音量（简化处理，不分割）
      segment.volume = volume;
    }
  });
}
