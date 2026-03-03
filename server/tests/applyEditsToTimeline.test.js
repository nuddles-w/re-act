/**
 * Tests for src/domain/applyEditsToTimeline.js
 * Run: node --test server/tests/applyEditsToTimeline.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEditsToTimeline } from "../../src/domain/applyEditsToTimeline.js";

const makeTimeline = (clips) => ({
  clips,
  totalDuration: clips.reduce((s, c) => Math.max(s, c.end), 0),
});

const singleClip = makeTimeline([
  { id: "c0", start: 0, end: 30, duration: 30, energy: 0.5 },
]);

// ── 基础行为 ────────────────────────────────────────────────────────
test("applyEditsToTimeline: no edits returns original clips with timeline positions", () => {
  const result = applyEditsToTimeline(singleClip, [], 30);
  assert.ok(result);
  assert.equal(result.clips.length, 1);
  assert.equal(result.clips[0].timelineStart, 0);
  assert.ok(Math.abs(result.clips[0].displayDuration - 30) < 0.01);
  assert.deepEqual(result.textEdits, []);
  assert.deepEqual(result.fadeEdits, []);
});

test("applyEditsToTimeline: null/undefined timeline returns falsy", () => {
  assert.equal(applyEditsToTimeline(null, [], 30), null);
  assert.equal(applyEditsToTimeline(undefined, [], 30), undefined);
});

// ── Delete 编辑 ─────────────────────────────────────────────────────
test("applyEditsToTimeline: delete removes middle segment", () => {
  const tl = makeTimeline([
    { id: "c0", start: 0, end: 30, duration: 30, energy: 0.5 },
  ]);
  const result = applyEditsToTimeline(tl, [
    { type: "delete", start: 10, end: 20 },
  ], 30);
  assert.ok(result);
  // Should split at 10 and 20, then remove the 10-20 segment
  assert.equal(result.clips.length, 2);
  assert.ok(result.clips.every(c => !(c.start >= 10 && c.end <= 20)));
});

test("applyEditsToTimeline: delete from start", () => {
  const result = applyEditsToTimeline(singleClip, [
    { type: "delete", start: 0, end: 10 },
  ], 30);
  assert.ok(result);
  assert.equal(result.clips.length, 1);
  assert.ok(result.clips[0].start >= 10 - 0.1);
});

test("applyEditsToTimeline: delete to end", () => {
  const result = applyEditsToTimeline(singleClip, [
    { type: "delete", start: 20, end: 30 },
  ], 30);
  assert.ok(result);
  assert.equal(result.clips.length, 1);
  assert.ok(result.clips[0].end <= 20 + 0.1);
});

test("applyEditsToTimeline: multiple deletes", () => {
  const result = applyEditsToTimeline(singleClip, [
    { type: "delete", start: 5, end: 10 },
    { type: "delete", start: 20, end: 25 },
  ], 30);
  assert.ok(result);
  assert.equal(result.clips.length, 3);
});

// ── Speed 编辑 ──────────────────────────────────────────────────────
test("applyEditsToTimeline: speed 2x halves display duration", () => {
  const result = applyEditsToTimeline(singleClip, [
    { type: "speed", start: 0, end: 30, rate: 2 },
  ], 30);
  assert.ok(result);
  const clip = result.clips[0];
  assert.equal(clip.playbackRate, 2);
  assert.ok(Math.abs(clip.displayDuration - 15) < 0.01, `expected 15, got ${clip.displayDuration}`);
  assert.ok(Math.abs(result.totalTimelineDuration - 15) < 0.01);
});

test("applyEditsToTimeline: speed 0.5x doubles display duration", () => {
  const result = applyEditsToTimeline(singleClip, [
    { type: "speed", start: 0, end: 30, rate: 0.5 },
  ], 30);
  assert.ok(result);
  assert.ok(Math.abs(result.clips[0].displayDuration - 60) < 0.01);
});

// ── Timeline 位置计算 ────────────────────────────────────────────────
test("applyEditsToTimeline: timeline positions are cumulative", () => {
  const tl = makeTimeline([
    { id: "c1", start: 0, end: 10, duration: 10, energy: 0.5 },
    { id: "c2", start: 15, end: 25, duration: 10, energy: 0.5 },
  ]);
  const result = applyEditsToTimeline(tl, [], 30);
  assert.equal(result.clips[0].timelineStart, 0);
  assert.ok(Math.abs(result.clips[1].timelineStart - 10) < 0.01);
  assert.ok(Math.abs(result.totalTimelineDuration - 20) < 0.01);
});

// ── Text 编辑 ───────────────────────────────────────────────────────
test("applyEditsToTimeline: text edits stored separately, do not split clips", () => {
  const result = applyEditsToTimeline(singleClip, [
    { type: "text", start: 5, end: 10, text: "Hello", position: "top" },
  ], 30);
  assert.ok(result);
  assert.equal(result.clips.length, 1, "text edit must not split clip");
  assert.equal(result.textEdits.length, 1);
  assert.equal(result.textEdits[0].text, "Hello");
});

// ── Fade 编辑 ───────────────────────────────────────────────────────
test("applyEditsToTimeline: fade edits stored separately, do not split clips", () => {
  const result = applyEditsToTimeline(singleClip, [
    { type: "fade", start: 0, end: 1.5, direction: "in" },
  ], 30);
  assert.ok(result);
  assert.equal(result.clips.length, 1);
  assert.equal(result.fadeEdits.length, 1);
  assert.equal(result.fadeEdits[0].direction, "in");
});

// ── BGM 编辑 ────────────────────────────────────────────────────────
test("applyEditsToTimeline: bgm edits stored in bgmEdits, do not split clips", () => {
  const result = applyEditsToTimeline(singleClip, [
    { type: "bgm", start: 0, end: 30, keywords: "lofi chill", volume: 0.3 },
  ], 30);
  assert.ok(result);
  assert.equal(result.clips.length, 1);
  assert.equal(result.bgmEdits.length, 1);
  assert.equal(result.bgmEdits[0].keywords, "lofi chill");
});

// ── 总时长计算 ──────────────────────────────────────────────────────
test("applyEditsToTimeline: totalTimelineDuration sums all clip display durations", () => {
  const tl = makeTimeline([
    { id: "a", start: 0, end: 10, duration: 10, energy: 0.5 },
    { id: "b", start: 10, end: 20, duration: 10, energy: 0.5 },
    { id: "c", start: 20, end: 30, duration: 10, energy: 0.5 },
  ]);
  const result = applyEditsToTimeline(tl, [], 30);
  assert.ok(Math.abs(result.totalTimelineDuration - 30) < 0.01);
});

console.log("\n✅ applyEditsToTimeline tests complete");
