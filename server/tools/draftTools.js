/**
 * Draft 工具执行器
 *
 * 处理所有 draft 相关的工具调用
 */

import { getDraftManager } from "../draftManager.js";
import {
  findSegmentById,
  getOrCreateTrack,
  createVideoSegment,
  createTextSegment,
  createFadeSegment,
  createAudioSegment,
} from "../../src/domain/draftModel.js";
import { buildDraftContext, buildDraftSummary } from "../utils/draftHelpers.js";

/**
 * 执行 draft 工具
 * @param {string} toolName
 * @param {array} args
 * @param {string} sessionId
 * @returns {object} observation
 */
export async function executeDraftTool(toolName, args, sessionId) {
  const draftManager = getDraftManager();

  try {
    switch (toolName) {
      case "read_draft":
        return await executeReadDraft(args, sessionId, draftManager);

      case "add_segment":
        return await executeAddSegment(args, sessionId, draftManager);

      case "modify_segment":
        return await executeModifySegment(args, sessionId, draftManager);

      case "delete_segment":
        return await executeDeleteSegment(args, sessionId, draftManager);

      case "split_segment":
        return await executeSplitSegment(args, sessionId, draftManager);

      case "move_segment":
        return await executeMoveSegment(args, sessionId, draftManager);

      default:
        return { error: `Unknown draft tool: ${toolName}` };
    }
  } catch (error) {
    console.error(`[draftTools] ${toolName} error:`, error.message);
    return { error: error.message };
  }
}

/**
 * read_draft 工具
 */
async function executeReadDraft(args, sessionId, draftManager) {
  const detailLevel = args[0] || "summary";

  const { draft, changesSince } = draftManager.readDraft(sessionId, false);

  if (detailLevel === "full") {
    return {
      draft,
      changesSince,
    };
  }

  // summary 模式：返回简化版本
  return {
    summary: buildDraftSummary(draft),
    context: buildDraftContext(draft),
    changesSince,
  };
}

/**
 * add_segment 工具
 */
async function executeAddSegment(args, sessionId, draftManager) {
  const [trackId, segmentData] = args;

  if (!trackId || !segmentData) {
    throw new Error("add_segment requires trackId and segment data");
  }

  // 解析 segment 数据（可能是 JSON 字符串）
  const segment = typeof segmentData === "string" ? JSON.parse(segmentData) : segmentData;

  // 确保 segment 有必要的字段
  if (segment.timelineStart === undefined || segment.timelineDuration === undefined) {
    throw new Error("segment must have timelineStart and timelineDuration");
  }

  // 确保 segment 有 type 字段
  if (!segment.type) {
    // 根据 trackId 推断类型
    const trackType = trackId.charAt(0).toLowerCase();
    if (trackType === 'v') segment.type = 'video';
    else if (trackType === 'a') segment.type = 'audio';
    else if (trackType === 't') segment.type = 'text';
    else if (trackType === 'f') segment.type = 'fade';
  }

  // 如果没有 id，生成一个
  if (!segment.id) {
    const trackType = trackId.charAt(0);
    segment.id = `seg-${trackType.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  // 更新 draft
  draftManager.updateDraft(sessionId, {
    type: "add_segment",
    data: { trackId, segment },
  });

  return {
    ok: true,
    segment_id: segment.id,
    message: `已添加片段到 ${trackId} 轨道`,
  };
}

/**
 * modify_segment 工具
 */
async function executeModifySegment(args, sessionId, draftManager) {
  const [segmentId, modifications] = args;

  if (!segmentId || !modifications) {
    throw new Error("modify_segment requires segmentId and modifications");
  }

  // 解析 modifications（可能是 JSON 字符串）
  const mods = typeof modifications === "string" ? JSON.parse(modifications) : modifications;

  // 更新 draft
  draftManager.updateDraft(sessionId, {
    type: "modify_segment",
    data: { segmentId, modifications: mods },
  });

  return {
    ok: true,
    message: `已修改片段 ${segmentId}`,
    modifications: Object.keys(mods),
  };
}

/**
 * delete_segment 工具
 */
async function executeDeleteSegment(args, sessionId, draftManager) {
  const [segmentId] = args;

  if (!segmentId) {
    throw new Error("delete_segment requires segmentId");
  }

  // 更新 draft
  draftManager.updateDraft(sessionId, {
    type: "delete_segment",
    data: { segmentId },
  });

  return {
    ok: true,
    message: `已删除片段 ${segmentId}`,
  };
}

/**
 * split_segment 工具
 */
async function executeSplitSegment(args, sessionId, draftManager) {
  const [segmentId, splitTime] = args;

  if (!segmentId || splitTime === undefined) {
    throw new Error("split_segment requires segmentId and splitTime");
  }

  const draft = draftManager.getDraft(sessionId);
  const result = findSegmentById(draft, segmentId);

  if (!result) {
    throw new Error(`Segment ${segmentId} not found`);
  }

  const { track, segment } = result;

  // 检查 splitTime 是否在 segment 范围内
  if (splitTime <= segment.timelineStart || splitTime >= segment.timelineStart + segment.timelineDuration) {
    throw new Error(`splitTime ${splitTime} is outside segment range`);
  }

  // 创建两个新 segment
  const duration1 = splitTime - segment.timelineStart;
  const duration2 = segment.timelineStart + segment.timelineDuration - splitTime;

  const segment1 = {
    ...segment,
    id: `${segment.id}-1`,
    timelineDuration: duration1,
  };

  const segment2 = {
    ...segment,
    id: `${segment.id}-2`,
    timelineStart: splitTime,
    timelineDuration: duration2,
  };

  // 如果是视频 segment，需要调整 sourceEnd
  if (segment.sourceStart !== undefined && segment.sourceEnd !== undefined) {
    const sourceDuration = segment.sourceEnd - segment.sourceStart;
    const sourceRate = sourceDuration / segment.timelineDuration;

    segment1.sourceEnd = segment1.sourceStart + duration1 * sourceRate;
    segment2.sourceStart = segment1.sourceEnd;
  }

  // 删除原 segment，添加两个新 segment
  draftManager.updateDraft(sessionId, {
    type: "delete_segment",
    data: { segmentId },
  });

  draftManager.updateDraft(sessionId, {
    type: "add_segment",
    data: { trackId: track.id, segment: segment1 },
  });

  draftManager.updateDraft(sessionId, {
    type: "add_segment",
    data: { trackId: track.id, segment: segment2 },
  });

  return {
    ok: true,
    message: `已在 ${splitTime}s 处分割片段`,
    new_segments: [segment1.id, segment2.id],
  };
}

/**
 * move_segment 工具
 */
async function executeMoveSegment(args, sessionId, draftManager) {
  const [segmentId, newTimelineStart] = args;

  if (!segmentId || newTimelineStart === undefined) {
    throw new Error("move_segment requires segmentId and newTimelineStart");
  }

  // 更新 draft
  draftManager.updateDraft(sessionId, {
    type: "modify_segment",
    data: {
      segmentId,
      modifications: { timelineStart: newTimelineStart },
    },
  });

  return {
    ok: true,
    message: `已将片段移动到 ${newTimelineStart}s`,
  };
}
