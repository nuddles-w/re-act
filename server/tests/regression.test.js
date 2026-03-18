/**
 * 项目基础功能回归测试
 * Run: node --test server/tests/regression.test.js
 *
 * 覆盖范围：
 * 1. DraftManager 基础 CRUD
 * 2. draftToTimeline 转换
 * 3. Draft 多轨道完整性
 * 4. 多轮对话增量更新（不覆盖已有数据）
 * 5. split_segment 原子性
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftManager } from "../draftManager.js";
import { draftToTimeline } from "../converters/draftToTimeline.js";

// ── 工具函数 ────────────────────────────────────────────────────────

function makeManager() {
  return new DraftManager();
}

function makeVideoSegment(id, timelineStart, duration, sourceStart) {
  return {
    id,
    type: "video",
    sourceId: "src1",
    timelineStart,
    timelineDuration: duration,
    sourceStart: sourceStart ?? timelineStart,
    sourceEnd: (sourceStart ?? timelineStart) + duration,
    playbackRate: 1.0,
    volume: 1.0,
  };
}

function makeTextSegment(id, timelineStart, duration, content) {
  return {
    id,
    type: "text",
    timelineStart,
    timelineDuration: duration,
    content,
    style: { fontSize: 48, color: "#ffffff", position: "bottom" },
  };
}

function makeFadeSegment(id, timelineStart, duration, direction) {
  return {
    id,
    type: "fade",
    effectType: "fade",
    timelineStart,
    timelineDuration: duration,
    direction,
  };
}

// ── 1. DraftManager 基础 CRUD ───────────────────────────────────────

test("getDraft 初始化包含 V1/A1/T1/FX1 四条轨道", () => {
  const dm = makeManager();
  const draft = dm.getDraft("s1");
  const ids = draft.tracks.map(t => t.id);
  assert.ok(ids.includes("V1"), "缺少 V1 轨道");
  assert.ok(ids.includes("A1"), "缺少 A1 轨道");
  assert.ok(ids.includes("T1"), "缺少 T1 轨道");
  assert.ok(ids.includes("FX1"), "缺少 FX1 轨道");
});

test("add_segment 添加视频片段到 V1", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("seg1", 0, 10) },
  });
  const draft = dm.getDraft("s1");
  const v1 = draft.tracks.find(t => t.id === "V1");
  assert.equal(v1.segments.length, 1);
  assert.equal(v1.segments[0].id, "seg1");
});

test("modify_segment 修改片段属性", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("seg1", 0, 10) },
  });
  dm.updateDraft("s1", {
    type: "modify_segment",
    data: { segmentId: "seg1", modifications: { playbackRate: 2.0 } },
  });
  const draft = dm.getDraft("s1");
  const seg = draft.tracks.find(t => t.id === "V1").segments[0];
  assert.equal(seg.playbackRate, 2.0);
});

test("delete_segment 删除片段", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("seg1", 0, 10) },
  });
  dm.updateDraft("s1", {
    type: "delete_segment",
    data: { segmentId: "seg1" },
  });
  const draft = dm.getDraft("s1");
  const v1 = draft.tracks.find(t => t.id === "V1");
  assert.equal(v1.segments.length, 0);
});

test("add_segment 重叠时抛出错误", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("seg1", 0, 10) },
  });
  assert.throws(() => {
    dm.updateDraft("s1", {
      type: "add_segment",
      data: { trackId: "V1", segment: makeVideoSegment("seg2", 5, 10) }, // 重叠
    });
  }, /overlaps/);
});

test("version 每次 updateDraft 递增", () => {
  const dm = makeManager();
  const draft0 = dm.getDraft("s1");
  const v0 = draft0.version || 0;
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("seg1", 0, 5) },
  });
  const draft1 = dm.getDraft("s1");
  assert.equal(draft1.version, v0 + 1);
});

// ── 2. draftToTimeline 转换 ─────────────────────────────────────────

test("draftToTimeline: null draft 返回空结构", () => {
  const result = draftToTimeline(null);
  assert.deepEqual(result.clips, []);
  assert.equal(result.totalDuration, 0);
});

test("draftToTimeline: 视频片段正确转换为 clips", () => {
  const dm = makeManager();
  const draft = dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("seg1", 0, 10, 5) },
  });
  const timeline = draftToTimeline(dm.getDraft("s1"));
  assert.equal(timeline.clips.length, 1);
  const clip = timeline.clips[0];
  assert.equal(clip.start, 5);       // sourceStart
  assert.equal(clip.end, 15);        // sourceEnd
  assert.equal(clip.timelineStart, 0);
  assert.equal(clip.displayDuration, 10);
});

test("draftToTimeline: 文字片段转换为 textEdits", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "T1", segment: makeTextSegment("t1", 2, 5, "Hello") },
  });
  const timeline = draftToTimeline(dm.getDraft("s1"));
  assert.equal(timeline.textEdits.length, 1);
  assert.equal(timeline.textEdits[0].text, "Hello");
  assert.equal(timeline.textEdits[0].start, 2);
  assert.equal(timeline.textEdits[0].end, 7);
});

test("draftToTimeline: 淡入淡出片段转换为 fadeEdits", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "FX1", segment: makeFadeSegment("fx1", 0, 1, "in") },
  });
  const timeline = draftToTimeline(dm.getDraft("s1"));
  assert.equal(timeline.fadeEdits.length, 1);
  assert.equal(timeline.fadeEdits[0].direction, "in");
});

test("draftToTimeline: totalDuration 等于最长片段结束时间", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("seg1", 0, 30) },
  });
  const timeline = draftToTimeline(dm.getDraft("s1"));
  assert.equal(timeline.totalDuration, 30);
});

// ── 3. 多轨道完整性 ─────────────────────────────────────────────────

test("多轨道同时操作互不干扰", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("v1", 0, 10) },
  });
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "T1", segment: makeTextSegment("t1", 0, 5, "Test") },
  });
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "FX1", segment: makeFadeSegment("fx1", 0, 1, "in") },
  });
  const draft = dm.getDraft("s1");
  assert.equal(draft.tracks.find(t => t.id === "V1").segments.length, 1);
  assert.equal(draft.tracks.find(t => t.id === "T1").segments.length, 1);
  assert.equal(draft.tracks.find(t => t.id === "FX1").segments.length, 1);
});

test("delete_segment 只删除目标片段，不影响其他轨道", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("v1", 0, 10) },
  });
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "T1", segment: makeTextSegment("t1", 0, 5, "Test") },
  });
  dm.updateDraft("s1", {
    type: "delete_segment",
    data: { segmentId: "v1" },
  });
  const draft = dm.getDraft("s1");
  assert.equal(draft.tracks.find(t => t.id === "V1").segments.length, 0);
  assert.equal(draft.tracks.find(t => t.id === "T1").segments.length, 1, "T1 不应受影响");
});

// ── 4. 多轮对话增量更新 ─────────────────────────────────────────────

test("多轮对话：第二轮操作不覆盖第一轮的片段", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  // 第一轮：AI 添加视频片段
  dm.beginBatch("s1", "第一轮");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("v1", 0, 10) },
  });
  dm.commitBatch("s1");

  // 第二轮：AI 添加文字
  dm.beginBatch("s1", "第二轮");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "T1", segment: makeTextSegment("t1", 0, 5, "字幕") },
  });
  dm.commitBatch("s1");

  const draft = dm.getDraft("s1");
  assert.equal(draft.tracks.find(t => t.id === "V1").segments.length, 1, "第一轮视频片段应保留");
  assert.equal(draft.tracks.find(t => t.id === "T1").segments.length, 1, "第二轮文字片段应存在");
});

test("多轮对话：undo 第二轮后第一轮数据完整", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "第一轮");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("v1", 0, 10) },
  });
  dm.commitBatch("s1");

  dm.beginBatch("s1", "第二轮");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "T1", segment: makeTextSegment("t1", 0, 5, "字幕") },
  });
  dm.commitBatch("s1");

  dm.undo("s1"); // 撤销第二轮

  const draft = dm.getDraft("s1");
  assert.equal(draft.tracks.find(t => t.id === "V1").segments.length, 1, "第一轮视频片段应保留");
  assert.equal(draft.tracks.find(t => t.id === "T1").segments.length, 0, "第二轮文字应被撤销");
});

// ── 5. split_segment 原子性 ─────────────────────────────────────────

test("split_segment 批量操作：一次 batch = 一个快照", () => {
  const dm = makeManager();
  dm.getDraft("s1");
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("v1", 0, 20) },
  });
  // 手动保存初始快照
  dm._pushSnapshot("s1", dm.getDraft("s1"), "初始有片段");

  const snapshotsBefore = dm.snapshots.get("s1").length;

  // 模拟 split_segment：删除原片段 + 添加两个新片段（一个 batch）
  dm.beginBatch("s1", "split_segment");
  dm.updateDraft("s1", { type: "delete_segment", data: { segmentId: "v1" } });
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("v1a", 0, 10) },
  });
  dm.updateDraft("s1", {
    type: "add_segment",
    data: { trackId: "V1", segment: makeVideoSegment("v1b", 10, 10) },
  });
  dm.commitBatch("s1");

  const snapshotsAfter = dm.snapshots.get("s1").length;
  assert.equal(snapshotsAfter - snapshotsBefore, 1, "split 应只产生一个快照");

  // undo 后恢复原始状态
  dm.undo("s1");
  const draft = dm.getDraft("s1");
  const v1 = draft.tracks.find(t => t.id === "V1");
  assert.equal(v1.segments.length, 1, "undo split 后应恢复为一个片段");
  assert.equal(v1.segments[0].id, "v1");
});
