/**
 * Draft 辅助函数
 *
 * 用于生成 AI 可读的上下文、摘要等
 */

/**
 * 生成轻量级 draft 提示（不是完整 draft）
 */
export function buildDraftHint(draft) {
  if (!draft || !draft.tracks || draft.tracks.length === 0) {
    return "[草稿概览]\n当前草稿为空";
  }

  const videoSegments = draft.tracks.find(t => t.type === "video")?.segments.length || 0;
  const audioSegments = draft.tracks.find(t => t.type === "audio")?.segments.length || 0;
  const textSegments = draft.tracks.find(t => t.type === "text")?.segments.length || 0;
  const effectSegments = draft.tracks.find(t => t.type === "effect")?.segments.length || 0;

  return `
[草稿概览]
- 总时长: ${draft.settings.totalDuration.toFixed(1)}s
- 视频片段: ${videoSegments} 个
- 音频片段: ${audioSegments} 个
- 文字片段: ${textSegments} 个
- 效果片段: ${effectSegments} 个

💡 如需详细信息，使用 read_draft() 工具
  `.trim();
}

/**
 * 生成完整的 draft 上下文（用于 read_draft 工具返回）
 */
export function buildDraftContext(draft) {
  if (!draft || !draft.tracks || draft.tracks.length === 0) {
    return "当前草稿为空";
  }

  const lines = [];

  lines.push(`总时长: ${draft.settings.totalDuration.toFixed(1)}s`);
  lines.push(`分辨率: ${draft.settings.resolution.width}x${draft.settings.resolution.height}`);
  lines.push(`帧率: ${draft.settings.fps} fps`);
  lines.push("");

  draft.tracks.forEach(track => {
    lines.push(`[${track.id}] ${track.type} 轨道 (${track.segments.length} 个片段)`);
    if (track.segments.length === 0) {
      lines.push("  (空)");
    } else {
      track.segments.forEach(seg => {
        const desc = formatSegmentDescription(seg, track.type);
        lines.push(`  - ${seg.id}: ${desc}`);
      });
    }
    lines.push("");
  });

  return lines.join("\n");
}

/**
 * 格式化 segment 描述
 */
export function formatSegmentDescription(seg, trackType) {
  const time = `${seg.timelineStart.toFixed(1)}s-${(seg.timelineStart + seg.timelineDuration).toFixed(1)}s`;

  if (trackType === "video") {
    const source = seg.sourceStart !== undefined
      ? `, 源片段 ${seg.sourceStart.toFixed(1)}s-${seg.sourceEnd.toFixed(1)}s`
      : "";
    const rate = seg.playbackRate !== 1.0 ? `, 速度 ${seg.playbackRate}x` : "";
    const vol = seg.volume !== 1.0 ? `, 音量 ${(seg.volume * 100).toFixed(0)}%` : "";
    return `${time}${source}${rate}${vol}`;
  }

  if (trackType === "audio") {
    const source = seg.sourceStart !== undefined
      ? `, 源片段 ${seg.sourceStart.toFixed(1)}s-${seg.sourceEnd.toFixed(1)}s`
      : "";
    const vol = seg.volume !== 1.0 ? `, 音量 ${(seg.volume * 100).toFixed(0)}%` : "";
    const fade = [];
    if (seg.fadeIn > 0) fade.push(`淡入${seg.fadeIn}s`);
    if (seg.fadeOut > 0) fade.push(`淡出${seg.fadeOut}s`);
    const fadeStr = fade.length > 0 ? `, ${fade.join(", ")}` : "";
    return `${time}${source}${vol}${fadeStr}`;
  }

  if (trackType === "text") {
    const content = seg.content ? `"${seg.content.slice(0, 20)}${seg.content.length > 20 ? "..." : ""}"` : "";
    const pos = seg.style?.position ? `, 位置: ${seg.style.position}` : "";
    return `${time}, ${content}${pos}`;
  }

  if (trackType === "effect") {
    if (seg.effectType === "fade") {
      const target = seg.targetTrack ? ` → ${seg.targetTrack}` : " → 所有视频";
      return `${time}, ${seg.effectType} ${seg.direction}${target}`;
    }
    return `${time}, ${seg.effectType}`;
  }

  return time;
}

/**
 * 智能引导：根据用户指令判断是否需要读取 draft
 */
export function buildReadDraftGuidance(request, conversationHistory) {
  const needsContext = [
    /再|更|继续|还要|也/,           // 相对指令
    /刚才|之前|上一个|那个|这个/,    // 指代
    /所有|每个|全部|整个/,          // 批量操作
    /修改|改成|调整|删除|移动/,     // 修改操作
  ];

  const isFirstRequest = !conversationHistory || conversationHistory.length === 0;

  if (isFirstRequest) {
    return ""; // 首次请求通常不需要提示
  }

  const needsRead = needsContext.some(pattern => pattern.test(request));

  if (needsRead) {
    return `
⚠️ 提示：此指令可能需要当前草稿的详细信息，建议先调用 read_draft() 工具。
    `.trim();
  }

  return "";
}

/**
 * 生成 draft 的 JSON 摘要（用于 read_draft 返回）
 */
export function buildDraftSummary(draft) {
  const summary = {
    totalDuration: draft.settings.totalDuration,
    resolution: draft.settings.resolution,
    tracks: draft.tracks.map(track => ({
      id: track.id,
      type: track.type,
      enabled: track.enabled,
      segmentCount: track.segments.length,
      segments: track.segments.map(seg => ({
        id: seg.id,
        type: seg.type,
        timelineStart: seg.timelineStart,
        timelineDuration: seg.timelineDuration,
        // 根据类型添加关键信息
        ...(seg.type === "video" && {
          playbackRate: seg.playbackRate,
          volume: seg.volume,
        }),
        ...(seg.type === "text" && {
          content: seg.content,
          position: seg.style?.position,
        }),
        ...(seg.type === "fade" && {
          direction: seg.direction,
          targetTrack: seg.targetTrack,
        }),
      })),
    })),
  };

  return summary;
}

/**
 * 深度 diff 两个对象
 */
export function deepDiff(oldObj, newObj) {
  const changes = {};

  for (const key in newObj) {
    if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
      changes[key] = {
        old: oldObj[key],
        new: newObj[key],
      };
    }
  }

  return changes;
}
