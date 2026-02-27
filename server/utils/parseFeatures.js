const timeToSeconds = (time) => {
  if (typeof time === "number") return time;
  if (typeof time !== "string") return 0;

  // 处理 HH:MM:SS 或 MM:SS 格式
  const parts = time.split(":").map(Number);
  if (parts.some(isNaN)) return 0;

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }
  return 0;
};

const normalizeText = (text) =>
  text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

const tryExtractJson = (text) => {
  const normalized = normalizeText(text);
  const first = normalized.indexOf("{");
  const firstArray = normalized.indexOf("[");

  // 决定是从 { 开始还是从 [ 开始
  let startIdx = -1;
  let endChar = "";
  if (first !== -1 && (firstArray === -1 || first < firstArray)) {
    startIdx = first;
    endChar = "}";
  } else if (firstArray !== -1) {
    startIdx = firstArray;
    endChar = "]";
  }

  if (startIdx === -1) return null;

  const lastIdx = normalized.lastIndexOf(endChar);
  if (lastIdx === -1 || lastIdx <= startIdx) return null;

  const snippet = normalized.slice(startIdx, lastIdx + 1);
  try {
    return JSON.parse(snippet);
  } catch (error) {
    return null;
  }
};

export const parseFeatures = (text, durationLimit = 0) => {
  let payload = tryExtractJson(text);
  if (!payload) return null;

  // 如果返回的是数组，将其包装成对象
  if (Array.isArray(payload)) {
    payload = { segments: payload };
  }

  const rawSegments = Array.isArray(payload.segments)
    ? payload.segments
    : Array.isArray(payload.clips)
      ? payload.clips
      : [];

  const segments = rawSegments
    .map((segment) => {
      const start = timeToSeconds(segment.start);
      const end = timeToSeconds(segment.end);
      const energy = Number(segment.energy || 0.5);
      const label = segment.label || segment.description || "Clip";
      
      if (isNaN(start) || isNaN(end) || start >= end) return null;
      
      return {
        id: `${start.toFixed(2)}-${end.toFixed(2)}`,
        start,
        end,
        duration: end - start,
        energy,
        label,
        tags: segment.tags || {},
      };
    })
    .filter(Boolean);

  if (segments.length === 0 && !Array.isArray(payload.events)) return null;

  const maxEnd = segments.length > 0 ? Math.max(...segments.map((s) => s.end)) : 0;
  const duration = durationLimit > 0 ? durationLimit : maxEnd;

  const rhythmScore =
    segments.length > 0
      ? segments.reduce((sum, segment) => sum + segment.energy, 0) / segments.length
      : 0;

  const events = (Array.isArray(payload.events) ? payload.events : [])
    .map(ev => ({
      ...ev,
      start: timeToSeconds(ev.start),
      end: timeToSeconds(ev.end),
      label: ev.label || ev.description || "Event"
    }))
    .filter(ev => !isNaN(ev.start) && !isNaN(ev.end));

  const edits = Array.isArray(payload.edits) ? [...payload.edits] : [];

  // 增强逻辑：从 agentSteps (Re-Act 过程) 中提取潜在的工具调用
  if (Array.isArray(payload.steps)) {
    payload.steps.forEach(step => {
      if (!step.action) return;
      
      // 提取 split_video(start, end)
      const splitMatch = step.action.match(/split_video\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i);
      if (splitMatch) {
        edits.push({
          type: "split",
          start: parseFloat(splitMatch[1]),
          end: parseFloat(splitMatch[2])
        });
      }

      // 提取 adjust_speed(start, end, rate)
      const speedMatch = step.action.match(/adjust_speed\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i);
      if (speedMatch) {
        edits.push({
          type: "speed",
          start: parseFloat(speedMatch[1]),
          end: parseFloat(speedMatch[2]),
          rate: parseFloat(speedMatch[3])
        });
      }

      // 提取 delete_segment(start, end)
      const deleteMatch = step.action.match(/delete_segment\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i);
      if (deleteMatch) {
        edits.push({
          type: "delete",
          start: parseFloat(deleteMatch[1]),
          end: parseFloat(deleteMatch[2]),
        });
      }

      // 提取 add_text(start, end, "text", "position")
      const textMatch = step.action.match(/add_text\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*["']([^"']+)["']\s*(?:,\s*["'](\w+)["'])?\s*\)/i);
      if (textMatch) {
        edits.push({
          type: "text",
          start: parseFloat(textMatch[1]),
          end: parseFloat(textMatch[2]),
          text: textMatch[3],
          position: textMatch[4] || "bottom",
        });
      }

      // 提取 fade_in(startTime, duration)
      const fadeInMatch = step.action.match(/fade_in\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i);
      if (fadeInMatch) {
        const st = parseFloat(fadeInMatch[1]);
        const dur = parseFloat(fadeInMatch[2]);
        edits.push({ type: "fade", start: st, end: st + dur, direction: "in" });
      }

      // 提取 fade_out(startTime, duration)
      const fadeOutMatch = step.action.match(/fade_out\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i);
      if (fadeOutMatch) {
        const st = parseFloat(fadeOutMatch[1]);
        const dur = parseFloat(fadeOutMatch[2]);
        edits.push({ type: "fade", start: st, end: st + dur, direction: "out" });
      }

      // 提取 add_bgm("keywords", volume)
      const bgmMatch = step.action.match(/add_bgm\s*\(\s*["']([^"']*)["']\s*(?:,\s*([\d.]+))?\s*\)/i);
      if (bgmMatch) {
        edits.push({
          type: "bgm",
          keywords: bgmMatch[1],
          volume: bgmMatch[2] ? parseFloat(bgmMatch[2]) : 0.3,
        });
      }
    });
  }

  const normalizedEdits = edits
    .map((edit) => {
      if (!edit || typeof edit !== "object") return null;
      const rawType = String(edit.type || "").toLowerCase();

      // BGM 没有 start/end，单独处理
      if (rawType === "bgm") {
        return {
          type: "bgm",
          start: 0,
          end: duration > 0 ? duration : 999,
          keywords: String(edit.keywords || edit.mood || ""),
          volume: Math.min(1, Math.max(0, Number(edit.volume ?? 0.3))),
        };
      }

      const start = timeToSeconds(edit.start);
      const end = timeToSeconds(edit.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

      const durationClamp = duration > 0 ? duration : 0;
      const clampedStart = durationClamp > 0 ? Math.max(0, Math.min(start, durationClamp)) : start;
      const clampedEnd = durationClamp > 0 ? Math.max(0, Math.min(end, durationClamp)) : end;
      if (!(clampedStart < clampedEnd)) return null;

      if (rawType === "slow") {
        const rate = Number(edit.rate ?? 0.5);
        return {
          ...edit,
          type: "speed",
          start: clampedStart,
          end: clampedEnd,
          rate: Number.isFinite(rate) && rate > 0 ? rate : 0.5,
        };
      }

      if (rawType === "speed") {
        const rate = Number(edit.rate ?? edit.speed ?? 1);
        return {
          ...edit,
          type: "speed",
          start: clampedStart,
          end: clampedEnd,
          rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
        };
      }

      if (rawType === "delete" || rawType === "remove" || rawType === "cut" || rawType === "drop") {
        return {
          ...edit,
          type: "delete",
          start: clampedStart,
          end: clampedEnd,
        };
      }

      if (rawType === "split") {
        return {
          ...edit,
          type: "split",
          start: clampedStart,
          end: clampedEnd,
        };
      }

      if (rawType === "text") {
        return {
          ...edit,
          type: "text",
          start: clampedStart,
          end: clampedEnd,
          text: String(edit.text || ""),
          position: edit.position || "bottom",
        };
      }

      if (rawType === "fade") {
        return {
          ...edit,
          type: "fade",
          start: clampedStart,
          end: clampedEnd,
          direction: edit.direction === "out" ? "out" : "in",
        };
      }

      return {
        ...edit,
        type: rawType || edit.type,
        start: clampedStart,
        end: clampedEnd,
      };
    })
    .filter(Boolean);

  return {
    duration,
    segmentCount: segments.length,
    segments,
    keyframes: segments.map((segment) => ({
      time: Number((segment.start + segment.duration / 2).toFixed(2)),
      energy: segment.energy,
    })),
    rhythmScore: Number((payload.rhythmScore ?? rhythmScore).toFixed(2)),
    events,
    edits: normalizedEdits,
    summary: payload.summary || "",
  };
};
