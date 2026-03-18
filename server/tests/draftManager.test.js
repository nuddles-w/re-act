/**
 * DraftManager undo/redo 核心测试
 * Run: node --test server/tests/draftManager.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftManager } from "../draftManager.js";

function makeManager() {
  return new DraftManager();
}

function addSegment(dm, sessionId, trackId, start, duration) {
  dm.updateDraft(sessionId, {
    type: "add_segment",
    data: {
      trackId,
      segment: {
        id: `seg-${start}`,
        type: "video",
        timelineStart: start,
        timelineDuration: duration,
        sourceId: "src1",
        sourceStart: start,
        sourceEnd: start + duration,
      },
    },
  });
}

// ── 基础快照 ────────────────────────────────────────────────────────

test("初始状态：canUndo=false, canRedo=false", () => {
  const dm = makeManager();
  dm.getDraft("s1"); // 触发初始化
  const state = dm.getUndoRedoState("s1");
  assert.equal(state.canUndo, false);
  assert.equal(state.canRedo, false);
});

test("beginBatch + updateDraft + commitBatch 保存一个快照", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "添加片段");
  addSegment(dm, "s1", "V1", 0, 5);
  dm.commitBatch("s1");

  const state = dm.getUndoRedoState("s1");
  assert.equal(state.canUndo, true);
  assert.equal(state.canRedo, false);
  assert.equal(state.historySize, 2); // 初始快照 + 1
});

test("多次 updateDraft 在一个 batch 内只产生一个快照", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "split_segment");
  addSegment(dm, "s1", "V1", 0, 5);
  addSegment(dm, "s1", "V1", 5, 5);
  dm.commitBatch("s1");

  const state = dm.getUndoRedoState("s1");
  assert.equal(state.historySize, 2); // 初始 + 1，不是 3
});

// ── undo ────────────────────────────────────────────────────────────

test("undo 恢复到上一个状态", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "添加片段");
  addSegment(dm, "s1", "V1", 0, 5);
  dm.commitBatch("s1");

  const result = dm.undo("s1");
  assert.equal(result.canUndo, false);
  assert.equal(result.canRedo, true);

  const draft = dm.getDraft("s1");
  const v1 = draft.tracks.find(t => t.id === "V1");
  assert.equal(v1.segments.length, 0, "undo 后片段应消失");
});

test("undo 到最早状态后 canUndo=false", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "op1");
  addSegment(dm, "s1", "V1", 0, 5);
  dm.commitBatch("s1");

  dm.undo("s1");
  const result = dm.undo("s1"); // 再 undo，已到底
  assert.equal(result.canUndo, false);
});

// ── redo ────────────────────────────────────────────────────────────

test("undo 后 redo 恢复到最新状态", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "添加片段");
  addSegment(dm, "s1", "V1", 0, 5);
  dm.commitBatch("s1");

  dm.undo("s1");
  const result = dm.redo("s1");
  assert.equal(result.canUndo, true);
  assert.equal(result.canRedo, false);

  const draft = dm.getDraft("s1");
  const v1 = draft.tracks.find(t => t.id === "V1");
  assert.equal(v1.segments.length, 1, "redo 后片段应恢复");
});

test("redo 到最新状态后 canRedo=false", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "op1");
  addSegment(dm, "s1", "V1", 0, 5);
  dm.commitBatch("s1");

  dm.undo("s1");
  dm.redo("s1");
  const result = dm.redo("s1"); // 再 redo，已到顶
  assert.equal(result.canRedo, false);
});

// ── 新操作截断 redo 历史 ────────────────────────────────────────────

test("undo 后新操作截断 redo 历史", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "op1");
  addSegment(dm, "s1", "V1", 0, 5);
  dm.commitBatch("s1");

  dm.beginBatch("s1", "op2");
  addSegment(dm, "s1", "V1", 10, 5);
  dm.commitBatch("s1");

  dm.undo("s1"); // 回到 op1 之后

  // 新操作
  dm.beginBatch("s1", "op3");
  addSegment(dm, "s1", "T1", 0, 3);
  dm.commitBatch("s1");

  const state = dm.getUndoRedoState("s1");
  assert.equal(state.canRedo, false, "新操作后 redo 历史应被截断");
  assert.equal(state.historySize, 3); // 初始 + op1 + op3
});

// ── updateDraftWithSnapshot（UI 操作）──────────────────────────────

test("updateDraftWithSnapshot 立即保存快照", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.updateDraftWithSnapshot("s1", {
    type: "add_segment",
    data: {
      trackId: "T1",
      segment: {
        id: "seg-t1",
        type: "text",
        timelineStart: 0,
        timelineDuration: 3,
        content: "hello",
      },
    },
  }, "UI添加文字");

  const state = dm.getUndoRedoState("s1");
  assert.equal(state.canUndo, true);
  assert.equal(state.historySize, 2);
});

// ── batch 失败不保存快照 ────────────────────────────────────────────

test("batch 失败时清除 batch，不保存快照", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "失败操作");
  // 不 commit，直接删除（模拟工具执行失败）
  dm.batches.delete("s1");

  const state = dm.getUndoRedoState("s1");
  assert.equal(state.historySize, 1, "失败操作不应产生快照");
  assert.equal(state.canUndo, false);
});

// ── clearSession ────────────────────────────────────────────────────

test("clearSession 清除所有历史", () => {
  const dm = makeManager();
  dm.getDraft("s1");

  dm.beginBatch("s1", "op1");
  addSegment(dm, "s1", "V1", 0, 5);
  dm.commitBatch("s1");

  dm.clearSession("s1");

  // 重新初始化
  dm.getDraft("s1");
  const state = dm.getUndoRedoState("s1");
  assert.equal(state.historySize, 1);
  assert.equal(state.canUndo, false);
});
