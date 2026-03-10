/**
 * 构建编辑状态上下文 — 让 LLM 知道当前视频的编辑状态
 * 模仿 Claude Code 的 CLAUDE.md 项目记忆思路
 */

/**
 * 从 session 数据生成当前编辑状态描述
 * @param {Object} session - sessionManager 中的 session 对象
 * @returns {string} 格式化的编辑状态文本
 */
export function buildEditContext(session) {
  if (!session) return "";

  const { videoInfo, analysisResult } = session;
  const features = analysisResult?.features;
  if (!features) return "";

  const lines = ["=== 当前编辑状态 ==="];

  // 视频基本信息
  lines.push(`视频: ${videoInfo.name} (${videoInfo.duration}s)`);

  // 已识别的片段
  if (features.segments?.length) {
    const segDesc = features.segments
      .map(s => `[${s.start}-${s.end}s ${s.label || ""}]`)
      .join(" ");
    lines.push(`时间线片段: ${segDesc}`);
  }

  // 已应用的编辑
  if (features.edits?.length) {
    const editDescs = features.edits.map(e => {
      switch (e.type) {
        case "speed": return `变速${e.rate}x(${e.start}-${e.end}s)`;
        case "delete": return `删除(${e.start}-${e.end}s)`;
        case "split": return `分割(${e.start}-${e.end}s)`;
        case "text": return `文字"${e.text}"(${e.start}-${e.end}s @${e.position || "bottom"})`;
        case "fade": return `淡${e.direction === "in" ? "入" : "出"}(${e.start}-${e.end}s)`;
        case "bgm": return `背景音乐(${e.keywords})`;
        default: return `${e.type}(${e.start}-${e.end}s)`;
      }
    });
    lines.push(`已应用编辑: ${editDescs.join(", ")}`);
  } else {
    lines.push("已应用编辑: 无");
  }

  // 摘要
  if (features.summary) {
    lines.push(`视频摘要: ${features.summary}`);
  }

  return lines.join("\n");
}

/**
 * 格式化对话历史为 prompt 文本（用于 Gemini 等不支持 multi-turn 的场景）
 * @param {Array} history - conversationHistory 数组
 * @param {number} maxTurns - 最多保留几轮（默认 6）
 * @param {string|null} summary - 早期对话的压缩摘要
 * @returns {string}
 */
export function formatHistoryForPrompt(history, maxTurns = 6, summary = null) {
  if (!history?.length && !summary) return "";

  const recent = (history || []).slice(-maxTurns * 2);
  if (!recent.length && !summary) return "";

  const lines = ["=== 对话历史 ==="];
  if (summary) {
    lines.push(`[早期对话摘要] ${summary}`);
    lines.push("");
  }
  for (const msg of recent) {
    if (!msg.content?.trim()) continue;
    const role = msg.role === "user" ? "用户" : "AI";
    lines.push(`${role}: ${msg.content}`);
  }
  lines.push("=== 当前请求 ===");

  return lines.join("\n");
}

/**
 * 格式化对话历史为 messages 数组（用于 Doubao 等支持 multi-turn 的 API）
 * @param {Array} history - conversationHistory 数组
 * @param {number} maxTurns - 最多保留几轮
 * @param {string|null} summary - 早期对话的压缩摘要
 * @returns {Array<{role: string, content: string}>}
 */
export function formatHistoryForMessages(history, maxTurns = 6, summary = null) {
  const messages = [];

  // 摘要作为第一条 user message 注入
  if (summary) {
    messages.push({ role: "user", content: `[之前的对话摘要] ${summary}` });
    messages.push({ role: "assistant", content: "好的，我已了解之前的编辑历史，请继续。" });
  }

  if (history?.length) {
    const recent = history.slice(-maxTurns * 2);
    for (const msg of recent) {
      if (!msg.content?.trim()) continue;
      messages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      });
    }
  }

  return messages;
}
