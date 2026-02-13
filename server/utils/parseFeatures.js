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
    });
  }

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
    edits,
    summary: payload.summary || "",
  };
};
