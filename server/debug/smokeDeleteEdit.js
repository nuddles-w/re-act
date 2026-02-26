import assert from "node:assert/strict";
import { parseFeatures } from "../utils/parseFeatures.js";
import { applyEditsToTimeline } from "../../src/domain/applyEditsToTimeline.js";

const testParseDeleteFromSteps = () => {
  const text = JSON.stringify({
    steps: [
      {
        thought: "删除无用片段",
        action: "delete_segment(10, 20)",
        observation: "OK",
      },
    ],
    segments: [{ start: 0, end: 30, energy: 0.5, label: "All" }],
  });

  const features = parseFeatures(text, 30);
  assert.ok(features);
  assert.ok(Array.isArray(features.edits));
  assert.deepEqual(features.edits[0], { type: "delete", start: 10, end: 20 });
};

const testApplyDelete = () => {
  const timeline = {
    clips: [
      {
        id: "base",
        start: 0,
        end: 30,
        duration: 30,
        energy: 0.5,
        label: "Original",
      },
    ],
  };

  const updated = applyEditsToTimeline(timeline, [{ type: "delete", start: 10, end: 20 }], 30);
  assert.ok(updated);
  assert.equal(updated.clips.length, 2);
  assert.equal(updated.clips[0].start, 0);
  assert.equal(updated.clips[0].end, 10);
  assert.equal(updated.clips[1].start, 20);
  assert.equal(updated.clips[1].end, 30);
  assert.equal(Number(updated.totalTimelineDuration.toFixed(4)), 20);
  assert.equal(updated.clips[0].timelineStart, 0);
  assert.equal(Number(updated.clips[1].timelineStart.toFixed(4)), 10);
};

testParseDeleteFromSteps();
testApplyDelete();
console.log("smokeDeleteEdit: ok");

