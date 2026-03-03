/**
 * Tests for server/utils/parseFeatures.js
 * Run: node --test server/tests/parseFeatures.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeatures } from "../utils/parseFeatures.js";

// ── 基本解析 ────────────────────────────────────────────────────────
test("parseFeatures: valid segments JSON", () => {
  const json = JSON.stringify({
    segments: [
      { start: 0, end: 10, energy: 0.8, label: "Opening" },
      { start: 15, end: 25, energy: 0.6, label: "Action" },
    ],
    events: [],
    edits: [],
    summary: "Test video",
  });
  const result = parseFeatures(json);
  assert.ok(result, "should return a result");
  assert.equal(result.segments.length, 2, "should have 2 segments");
  assert.equal(result.segments[0].start, 0);
  assert.equal(result.segments[0].end, 10);
  assert.equal(result.segments[1].label, "Action");
  assert.equal(result.summary, "Test video");
});

test("parseFeatures: time strings MM:SS and HH:MM:SS", () => {
  const json = JSON.stringify({
    segments: [
      { start: "0:30", end: "1:20", energy: 0.7, label: "Scene 1" },
      { start: "1:30:00", end: "1:31:00", energy: 0.5, label: "Scene 2" },
    ],
    edits: [],
  });
  const result = parseFeatures(json);
  assert.ok(result);
  assert.equal(result.segments[0].start, 30);
  assert.equal(result.segments[0].end, 80);
  assert.equal(result.segments[1].start, 5400);
  assert.equal(result.segments[1].end, 5460);
});

test("parseFeatures: returns null for invalid input", () => {
  assert.equal(parseFeatures(""), null, "empty string → null");
  assert.equal(parseFeatures("not json at all"), null, "non-JSON → null");
  assert.equal(parseFeatures(null), null, "null → null");
});

test("parseFeatures: wraps bare array into segments", () => {
  const json = JSON.stringify([
    { start: 5, end: 10, energy: 0.9, label: "Clip" },
  ]);
  const result = parseFeatures(json);
  assert.ok(result);
  assert.equal(result.segments.length, 1);
});

test("parseFeatures: strips markdown code fences", () => {
  const json = "```json\n" + JSON.stringify({ segments: [{ start: 0, end: 5, energy: 0.5 }], edits: [] }) + "\n```";
  const result = parseFeatures(json);
  assert.ok(result, "should parse despite markdown fences");
  assert.equal(result.segments.length, 1);
});

test("parseFeatures: filters invalid segments (start >= end)", () => {
  const json = JSON.stringify({
    segments: [
      { start: 10, end: 5, energy: 0.8, label: "Bad" },  // invalid: start > end
      { start: 0, end: 10, energy: 0.6, label: "Good" },
    ],
    edits: [],
  });
  const result = parseFeatures(json);
  assert.ok(result);
  assert.equal(result.segments.length, 1, "bad segment should be filtered");
  assert.equal(result.segments[0].label, "Good");
});

// ── Edits 解析 ──────────────────────────────────────────────────────
test("parseFeatures: normalizes delete edit aliases (remove/cut/drop)", () => {
  const json = JSON.stringify({
    segments: [{ start: 0, end: 30, energy: 0.5 }],
    edits: [
      { type: "remove", start: 5, end: 10 },
      { type: "cut", start: 15, end: 20 },
      { type: "drop", start: 22, end: 25 },
    ],
  });
  const result = parseFeatures(json, 30);
  assert.ok(result);
  assert.equal(result.edits.length, 3);
  result.edits.forEach(e => assert.equal(e.type, "delete", `type should be 'delete', got '${e.type}'`));
});

test("parseFeatures: normalizes slow as speed edit", () => {
  const json = JSON.stringify({
    segments: [{ start: 0, end: 30, energy: 0.5 }],
    edits: [{ type: "slow", start: 5, end: 15 }],
  });
  const result = parseFeatures(json, 30);
  assert.ok(result);
  assert.equal(result.edits[0].type, "speed");
  assert.equal(result.edits[0].rate, 0.5);
});

test("parseFeatures: BGM edit gets start=0 end=duration without time range", () => {
  const json = JSON.stringify({
    segments: [{ start: 0, end: 30, energy: 0.5 }],
    edits: [{ type: "bgm", keywords: "happy upbeat pop", volume: 0.4 }],
  });
  const result = parseFeatures(json, 30);
  assert.ok(result);
  const bgm = result.edits.find(e => e.type === "bgm");
  assert.ok(bgm, "should have bgm edit");
  assert.equal(bgm.start, 0);
  assert.equal(bgm.end, 30);
  assert.equal(bgm.keywords, "happy upbeat pop");
  assert.ok(Math.abs(bgm.volume - 0.4) < 0.001);
});

test("parseFeatures: clamps edits to duration", () => {
  const json = JSON.stringify({
    segments: [{ start: 0, end: 30, energy: 0.5 }],
    edits: [{ type: "delete", start: 25, end: 50 }],  // end exceeds duration
  });
  const result = parseFeatures(json, 30);
  assert.ok(result);
  assert.equal(result.edits[0].end, 30, "end should be clamped to duration");
});

test("parseFeatures: text edit preserves text and position", () => {
  const json = JSON.stringify({
    segments: [{ start: 0, end: 30, energy: 0.5 }],
    edits: [{ type: "text", start: 5, end: 15, text: "Hello World", position: "top" }],
  });
  const result = parseFeatures(json, 30);
  assert.ok(result);
  const textEdit = result.edits.find(e => e.type === "text");
  assert.ok(textEdit);
  assert.equal(textEdit.text, "Hello World");
  assert.equal(textEdit.position, "top");
});

test("parseFeatures: fade direction defaults to 'in'", () => {
  const json = JSON.stringify({
    segments: [{ start: 0, end: 30, energy: 0.5 }],
    edits: [{ type: "fade", start: 0, end: 1.5 }],  // no direction specified
  });
  const result = parseFeatures(json, 30);
  assert.ok(result);
  assert.equal(result.edits[0].direction, "in");
});

// ── Re-Act 步骤解析 ──────────────────────────────────────────────────
test("parseFeatures: extracts bgm from agent steps", () => {
  const json = JSON.stringify({
    segments: [],
    edits: [],
    steps: [
      { thought: "add bgm", action: "add_bgm(\"calm piano\", 0.3)", observation: "done" },
    ],
  });
  const result = parseFeatures(json, 60);
  assert.ok(result);
  const bgm = result.edits.find(e => e.type === "bgm");
  assert.ok(bgm, "should extract bgm from steps");
  assert.equal(bgm.keywords, "calm piano");
});

test("parseFeatures: extracts delete_segment from agent steps", () => {
  const json = JSON.stringify({
    segments: [],
    edits: [],
    steps: [
      { thought: "delete boring part", action: "delete_segment(0.0, 4.0)", observation: "done" },
    ],
  });
  const result = parseFeatures(json, 30);
  assert.ok(result);
  const del = result.edits.find(e => e.type === "delete");
  assert.ok(del, "should extract delete from steps");
  assert.equal(del.start, 0);
  assert.equal(del.end, 4);
});

console.log("\n✅ parseFeatures tests complete");
