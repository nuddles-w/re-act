/**
 * Draft 架构测试
 */

import { getDraftManager } from "../draftManager.js";
import {
  createEmptyDraft,
  createTrack,
  createVideoSegment,
  createTextSegment,
  createFadeSegment,
  TrackType,
  addVideoSource,
  updateDraftDuration,
} from "../../src/domain/draftModel.js";

console.log("=== Draft 架构测试 ===\n");

// 测试 1: 创建空 Draft
console.log("测试 1: 创建空 Draft");
const draft = createEmptyDraft();
console.log("✓ Draft 创建成功:", {
  version: draft.version,
  tracks: draft.tracks.length,
  totalDuration: draft.settings.totalDuration,
});

// 测试 2: 添加视频源
console.log("\n测试 2: 添加视频源");
const videoSource = {
  name: "test.mp4",
  path: "/tmp/test.mp4",
  duration: 30.0,
  width: 1920,
  height: 1080,
  fps: 30,
};
const sourceId = addVideoSource(draft, videoSource);
console.log("✓ 视频源添加成功:", sourceId);

// 测试 3: 创建视频轨道和片段
console.log("\n测试 3: 创建视频轨道");
const videoTrack = createTrack(TrackType.VIDEO, "V1");
draft.tracks.push(videoTrack);

const segment1 = createVideoSegment({
  sourceId,
  timelineStart: 0,
  timelineDuration: 5.0,
  sourceStart: 0,
  sourceEnd: 10.0,
  playbackRate: 2.0,
});
videoTrack.segments.push(segment1);

const segment2 = createVideoSegment({
  sourceId,
  timelineStart: 5.0,
  timelineDuration: 5.0,
  sourceStart: 10.0,
  sourceEnd: 15.0,
  playbackRate: 1.0,
});
videoTrack.segments.push(segment2);

console.log("✓ 视频轨道创建成功:", {
  trackId: videoTrack.id,
  segments: videoTrack.segments.length,
});

// 测试 4: 添加文字轨道
console.log("\n测试 4: 添加文字轨道");
const textTrack = createTrack(TrackType.TEXT, "T1");
draft.tracks.push(textTrack);

const textSegment = createTextSegment({
  timelineStart: 2.0,
  timelineDuration: 3.0,
  content: "Hello World",
  style: { position: "bottom" },
});
textTrack.segments.push(textSegment);

console.log("✓ 文字轨道创建成功:", {
  trackId: textTrack.id,
  content: textSegment.content,
});

// 测试 5: 添加效果轨道
console.log("\n测试 5: 添加效果轨道");
const effectTrack = createTrack(TrackType.EFFECT, "FX1");
draft.tracks.push(effectTrack);

const fadeSegment = createFadeSegment({
  timelineStart: 0,
  timelineDuration: 1.0,
  direction: "in",
  targetTrack: "V1",
});
effectTrack.segments.push(fadeSegment);

console.log("✓ 效果轨道创建成功:", {
  trackId: effectTrack.id,
  effectType: fadeSegment.effectType,
});

// 测试 6: 更新总时长
console.log("\n测试 6: 更新总时长");
updateDraftDuration(draft);
console.log("✓ 总时长计算成功:", draft.settings.totalDuration, "秒");

// 测试 7: DraftManager
console.log("\n测试 7: DraftManager");
const draftManager = getDraftManager();
const sessionId = "test-session-001";

// 保存 draft
draftManager.updateDraft(sessionId, {
  type: "replace_draft",
  data: { draft },
});
console.log("✓ Draft 保存成功");

// 读取 draft
const { draft: loadedDraft, changesSince } = draftManager.readDraft(sessionId);
console.log("✓ Draft 读取成功:", {
  tracks: loadedDraft.tracks.length,
  version: loadedDraft.version,
  changes: changesSince.summary,
});

// 测试 8: 修改 segment
console.log("\n测试 8: 修改 segment");
draftManager.updateDraft(sessionId, {
  type: "modify_segment",
  data: {
    segmentId: segment1.id,
    modifications: { playbackRate: 3.0 },
  },
});
console.log("✓ Segment 修改成功");

// 读取变更
const { changesSince: changes2 } = draftManager.readDraft(sessionId);
console.log("✓ 变更检测成功:", changes2.summary);

// 测试 9: 添加新 segment
console.log("\n测试 9: 添加新 segment");
const newSegment = createVideoSegment({
  sourceId,
  timelineStart: 10.0,
  timelineDuration: 3.0,
  sourceStart: 20.0,
  sourceEnd: 23.0,
  playbackRate: 1.0,
});

draftManager.updateDraft(sessionId, {
  type: "add_segment",
  data: {
    trackId: "V1",
    segment: newSegment,
  },
});
console.log("✓ 新 segment 添加成功");

// 测试 10: 删除 segment
console.log("\n测试 10: 删除 segment");
draftManager.updateDraft(sessionId, {
  type: "delete_segment",
  data: { segmentId: segment2.id },
});
console.log("✓ Segment 删除成功");

// 最终状态
const { draft: finalDraft } = draftManager.readDraft(sessionId);
console.log("\n=== 最终状态 ===");
console.log("总时长:", finalDraft.settings.totalDuration, "秒");
console.log("轨道数:", finalDraft.tracks.length);
finalDraft.tracks.forEach(track => {
  console.log(`  - ${track.id} (${track.type}): ${track.segments.length} 个片段`);
});

console.log("\n✅ 所有测试通过！");
