/**
 * Tests for the filter_complex string built in /api/export
 * This file replicates the filter-building logic to verify
 * aspect ratio, color, and filter_complex correctness.
 *
 * Run: node --test server/tests/exportFilterComplex.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// ── Replicate the filter_complex builder (mirrors server/index.js) ──────────

function buildExportFilterComplex(timeline, { colorAdjust = {}, activeFilter = "none", exportFormat = "original" } = {}) {
  let filterComplex = "";
  let concatInputs = "";

  timeline.clips.forEach((clip, i) => {
    const rate = clip.playbackRate || 1;
    const vpts = (1 / rate).toFixed(4);
    filterComplex += `[0:v]trim=start=${clip.start}:end=${clip.end},setpts=PTS-STARTPTS,setpts=${vpts}*PTS[v${i}];`;
    let atempoFilter = "";
    if (rate > 2.0) {
      let r = rate;
      while (r > 2.0) { atempoFilter += "atempo=2.0,"; r /= 2.0; }
      atempoFilter += `atempo=${r.toFixed(4)}`;
    } else if (rate < 0.5) {
      let r = rate;
      while (r < 0.5) { atempoFilter += "atempo=0.5,"; r /= 0.5; }
      atempoFilter += `atempo=${r.toFixed(4)}`;
    } else {
      atempoFilter = `atempo=${rate.toFixed(4)}`;
    }
    filterComplex += `[0:a]atrim=start=${clip.start}:end=${clip.end},asetpts=PTS-STARTPTS,${atempoFilter}[a${i}];`;
    concatInputs += `[v${i}][a${i}]`;
  });

  const textEdits = Array.isArray(timeline.textEdits) ? timeline.textEdits.filter(e => e.text) : [];
  const fadeEdits = Array.isArray(timeline.fadeEdits) ? timeline.fadeEdits : [];
  const bgmEdits  = Array.isArray(timeline.bgmEdits)  ? timeline.bgmEdits  : [];
  const needsPost = textEdits.length > 0 || fadeEdits.length > 0 || bgmEdits.length > 0;

  const concatVLabel = needsPost ? "[concatv]" : "[outv]";
  const concatALabel = needsPost ? "[concata]" : "[outa]";
  filterComplex += `${concatInputs}concat=n=${timeline.clips.length}:v=1:a=1${concatVLabel}${concatALabel}`;

  let finalVideoLabel = concatVLabel;
  let finalAudioLabel = concatALabel;

  if (needsPost) {
    fadeEdits.forEach((fade, i) => {
      const st = (fade.timelineStart !== undefined ? fade.timelineStart : fade.start).toFixed(3);
      const dur = Math.max(0.1, (fade.timelineEnd !== undefined ? fade.timelineEnd : fade.end) - parseFloat(st)).toFixed(3);
      const nv = `[vfade${i}]`;
      const na = `[afade${i}]`;
      filterComplex += `;${finalVideoLabel}fade=t=${fade.direction}:st=${st}:d=${dur}${nv}`;
      filterComplex += `;${finalAudioLabel}afade=t=${fade.direction}:st=${st}:d=${dur}${na}`;
      finalVideoLabel = nv;
      finalAudioLabel = na;
    });
    if (finalVideoLabel !== "[outv]") {
      filterComplex += `;${finalVideoLabel}null[outv]`;
      finalVideoLabel = "[outv]";
    }
    if (finalAudioLabel !== "[outa]") {
      filterComplex += `;${finalAudioLabel}anull[outa]`;
      finalAudioLabel = "[outa]";
    }
  }

  const br = parseFloat(colorAdjust.brightness || 0);
  const ct = parseFloat(colorAdjust.contrast || 0);
  const sat = parseFloat(colorAdjust.saturation || 0);
  const hue = parseFloat(colorAdjust.hue || 0);
  const sharp = parseFloat(colorAdjust.sharpness || 0);
  if (br !== 0 || ct !== 0 || sat !== 0) {
    filterComplex += `;${finalVideoLabel}eq=brightness=${br}:contrast=${(1 + ct).toFixed(3)}:saturation=${(1 + sat).toFixed(3)}[vcol]`;
    finalVideoLabel = "[vcol]";
  }
  if (hue !== 0) {
    filterComplex += `;${finalVideoLabel}hue=h=${hue}[vhue]`;
    finalVideoLabel = "[vhue]";
  }
  if (sharp > 0) {
    filterComplex += `;${finalVideoLabel}unsharp=5:5:${(sharp * 1.5).toFixed(2)}:5:5:0[vsharp]`;
    finalVideoLabel = "[vsharp]";
  }
  if (activeFilter === "bw") {
    filterComplex += `;${finalVideoLabel}hue=s=0[vfilt]`;
    finalVideoLabel = "[vfilt]";
  } else if (activeFilter === "vintage") {
    filterComplex += `;${finalVideoLabel}curves=preset=vintage[vfilt]`;
    finalVideoLabel = "[vfilt]";
  } else if (activeFilter === "cool") {
    filterComplex += `;${finalVideoLabel}colorbalance=bs=0.08:bm=0.08:bh=0.08:rs=-0.06:rm=-0.06:rh=-0.06[vfilt]`;
    finalVideoLabel = "[vfilt]";
  } else if (activeFilter === "warm") {
    filterComplex += `;${finalVideoLabel}colorbalance=rs=0.08:rm=0.08:rh=0.08:bs=-0.06:bm=-0.06:bh=-0.06[vfilt]`;
    finalVideoLabel = "[vfilt]";
  } else if (activeFilter === "vivid") {
    filterComplex += `;${finalVideoLabel}eq=saturation=1.6:contrast=1.1[vfilt]`;
    finalVideoLabel = "[vfilt]";
  } else if (activeFilter === "cinematic") {
    filterComplex += `;${finalVideoLabel}eq=saturation=0.85:contrast=1.15:brightness=-0.03[vfilt]`;
    finalVideoLabel = "[vfilt]";
  }

  let padW = 0, padH = 0;
  if (exportFormat === "16:9") { padW = 1920; padH = 1080; }
  else if (exportFormat === "9:16") { padW = 1080; padH = 1920; }
  else if (exportFormat === "1:1") { padW = 1080; padH = 1080; }
  else if (exportFormat === "4:3") { padW = 1440; padH = 1080; }
  if (padW > 0) {
    filterComplex += `;${finalVideoLabel}scale=${padW}:${padH}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${padW}:${padH}:(ow-iw)/2:(oh-ih)/2:color=black[vpad]`;
    finalVideoLabel = "[vpad]";
  }

  return { filterComplex, finalVideoLabel, finalAudioLabel };
}

const simpleTl = {
  clips: [{ start: 0, end: 30, duration: 30, playbackRate: 1 }],
  textEdits: [], fadeEdits: [], bgmEdits: [],
  totalTimelineDuration: 30,
};

// ── 基础 filter_complex ─────────────────────────────────────────────
test("filterComplex: single clip basic structure", () => {
  const { filterComplex, finalVideoLabel, finalAudioLabel } = buildExportFilterComplex(simpleTl);
  assert.ok(filterComplex.includes("[0:v]trim=start=0:end=30"), "should have video trim");
  assert.ok(filterComplex.includes("[0:a]atrim=start=0:end=30"), "should have audio trim");
  assert.ok(filterComplex.includes("concat=n=1:v=1:a=1"), "should concat");
  assert.equal(finalVideoLabel, "[outv]");
  assert.equal(finalAudioLabel, "[outa]");
});

test("filterComplex: multiple clips concat", () => {
  const tl = {
    clips: [
      { start: 0, end: 10, duration: 10, playbackRate: 1 },
      { start: 15, end: 25, duration: 10, playbackRate: 1 },
    ],
    textEdits: [], fadeEdits: [], bgmEdits: [],
    totalTimelineDuration: 20,
  };
  const { filterComplex } = buildExportFilterComplex(tl);
  assert.ok(filterComplex.includes("concat=n=2:v=1:a=1"), "should concat 2 clips");
  assert.ok(filterComplex.includes("[v0][a0][v1][a1]"), "should reference both clips");
});

// ── Speed 变速 ──────────────────────────────────────────────────────
test("filterComplex: 2x speed uses correct setpts and atempo", () => {
  const tl = {
    clips: [{ start: 0, end: 30, duration: 30, playbackRate: 2 }],
    textEdits: [], fadeEdits: [], bgmEdits: [],
    totalTimelineDuration: 15,
  };
  const { filterComplex } = buildExportFilterComplex(tl);
  assert.ok(filterComplex.includes("setpts=0.5000*PTS"), "2x speed should halve PTS");
  assert.ok(filterComplex.includes("atempo=2.0000"), "2x speed needs atempo=2.0");
});

test("filterComplex: >2x speed uses chained atempo", () => {
  const tl = {
    clips: [{ start: 0, end: 30, duration: 30, playbackRate: 4 }],
    textEdits: [], fadeEdits: [], bgmEdits: [],
    totalTimelineDuration: 7.5,
  };
  const { filterComplex } = buildExportFilterComplex(tl);
  assert.ok(filterComplex.includes("atempo=2.0,atempo=2.0"), "4x needs two atempo=2.0");
});

// ── 调色滤镜 ────────────────────────────────────────────────────────
test("filterComplex: brightness adds eq filter", () => {
  const { filterComplex, finalVideoLabel } = buildExportFilterComplex(simpleTl, {
    colorAdjust: { brightness: 0.2, contrast: 0, saturation: 0 },
  });
  assert.ok(filterComplex.includes("eq=brightness=0.2"), "should add eq for brightness");
  assert.equal(finalVideoLabel, "[vcol]");
});

test("filterComplex: bw filter adds hue=s=0", () => {
  const { filterComplex, finalVideoLabel } = buildExportFilterComplex(simpleTl, {
    activeFilter: "bw",
  });
  assert.ok(filterComplex.includes("hue=s=0"), "bw filter should desaturate");
  assert.equal(finalVideoLabel, "[vfilt]");
});

test("filterComplex: vintage filter adds curves=preset=vintage", () => {
  const { filterComplex } = buildExportFilterComplex(simpleTl, { activeFilter: "vintage" });
  assert.ok(filterComplex.includes("curves=preset=vintage"), "vintage should use curves preset");
});

test("filterComplex: no color/filter = no extra labels (clean path)", () => {
  const { filterComplex, finalVideoLabel } = buildExportFilterComplex(simpleTl);
  assert.ok(!filterComplex.includes("eq="), "no color adjustments = no eq filter");
  assert.equal(finalVideoLabel, "[outv]");
});

// ── 画幅比例 ────────────────────────────────────────────────────────
test("filterComplex: 9:16 adds scale+pad filter with 1080x1920", () => {
  const { filterComplex, finalVideoLabel } = buildExportFilterComplex(simpleTl, {
    exportFormat: "9:16",
  });
  assert.ok(filterComplex.includes("scale=1080:1920"), "9:16 should scale to 1080x1920");
  assert.ok(filterComplex.includes("pad=1080:1920"), "9:16 should pad to 1080x1920");
  assert.ok(filterComplex.includes("force_original_aspect_ratio=decrease"), "should keep aspect ratio");
  assert.equal(finalVideoLabel, "[vpad]", "final label should be [vpad]");
});

test("filterComplex: 16:9 adds scale+pad filter with 1920x1080", () => {
  const { filterComplex, finalVideoLabel } = buildExportFilterComplex(simpleTl, {
    exportFormat: "16:9",
  });
  assert.ok(filterComplex.includes("scale=1920:1080"), "16:9 should scale to 1920x1080");
  assert.ok(filterComplex.includes("pad=1920:1080"), "16:9 should pad to 1920x1080");
  assert.equal(finalVideoLabel, "[vpad]");
});

test("filterComplex: 1:1 adds scale+pad filter with 1080x1080", () => {
  const { filterComplex, finalVideoLabel } = buildExportFilterComplex(simpleTl, {
    exportFormat: "1:1",
  });
  assert.ok(filterComplex.includes("scale=1080:1080"), "1:1 should scale to 1080x1080");
  assert.equal(finalVideoLabel, "[vpad]");
});

test("filterComplex: 4:3 adds scale+pad filter with 1440x1080", () => {
  const { filterComplex } = buildExportFilterComplex(simpleTl, { exportFormat: "4:3" });
  assert.ok(filterComplex.includes("scale=1440:1080"), "4:3 should scale to 1440x1080");
});

test("filterComplex: original format adds NO pad filter", () => {
  const { filterComplex, finalVideoLabel } = buildExportFilterComplex(simpleTl, {
    exportFormat: "original",
  });
  assert.ok(!filterComplex.includes("pad="), "original format should not add pad");
  assert.equal(finalVideoLabel, "[outv]");
});

// ── 组合：比例 + 调色 ───────────────────────────────────────────────
test("filterComplex: 9:16 + bw filter: pad applied AFTER color filter", () => {
  const { filterComplex, finalVideoLabel } = buildExportFilterComplex(simpleTl, {
    exportFormat: "9:16",
    activeFilter: "bw",
  });
  const bwIdx = filterComplex.indexOf("hue=s=0");
  const padIdx = filterComplex.indexOf("scale=1080:1920");
  assert.ok(bwIdx !== -1, "bw filter should be present");
  assert.ok(padIdx !== -1, "pad filter should be present");
  assert.ok(bwIdx < padIdx, "color filter should come before pad filter");
  assert.equal(finalVideoLabel, "[vpad]");
});

// ── Fade 后处理 ─────────────────────────────────────────────────────
test("filterComplex: fade edit uses [concatv]/[concata] labels", () => {
  const tl = {
    clips: [{ start: 0, end: 30, duration: 30, playbackRate: 1 }],
    textEdits: [],
    fadeEdits: [{ type: "fade", start: 0, end: 1.5, direction: "in", timelineStart: 0, timelineEnd: 1.5 }],
    bgmEdits: [],
    totalTimelineDuration: 30,
  };
  const { filterComplex } = buildExportFilterComplex(tl);
  assert.ok(filterComplex.includes("[concatv]"), "should use [concatv] when needsPost=true");
  assert.ok(filterComplex.includes("fade=t=in"), "should add fade filter");
});

console.log("\n✅ exportFilterComplex tests complete");
