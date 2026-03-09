/**
 * 对话历史压缩器 — 当对话轮数超过阈值时，调用 LLM 将早期对话压缩为摘要
 * 模仿 Claude Code 的自动上下文压缩机制
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

const COMPRESS_THRESHOLD = 6; // 超过 6 轮（12 条消息）触发压缩
const KEEP_RECENT = 4;        // 压缩后保留最近 4 轮原文

const SUMMARIZE_PROMPT = `你是一个视频剪辑助手的记忆压缩模块。请将以下对话历史压缩为一段简洁的摘要，保留关键信息：
- 用户上传了什么视频（文件名、时长）
- 已完成的编辑操作（片段选择、变速、删除、文字、淡入淡出等）
- 当前时间线状态（哪些片段保留了、做了什么修改）
- 用户的偏好或反复提到的要求

输出纯文本摘要，不要用 JSON，不要用 Markdown，控制在 200 字以内。`;

/**
 * 判断是否需要压缩
 * @param {Array} conversationHistory
 * @returns {boolean}
 */
export function needsCompression(conversationHistory) {
  if (!conversationHistory?.length) return false;
  const turns = Math.floor(conversationHistory.length / 2);
  return turns > COMPRESS_THRESHOLD;
}

/**
 * 压缩对话历史：早期对话 → 摘要，保留最近几轮原文
 * @param {Array} conversationHistory - 完整对话历史
 * @param {string|null} existingSummary - 已有的摘要（会被合并）
 * @returns {{ summary: string, keptHistory: Array }} 压缩后的摘要 + 保留的近期历史
 */
export async function compressConversation(conversationHistory, existingSummary = null) {
  if (!conversationHistory?.length) {
    return { summary: existingSummary || "", keptHistory: [] };
  }

  const keepCount = KEEP_RECENT * 2; // 每轮 2 条
  const toCompress = conversationHistory.slice(0, -keepCount);
  const keptHistory = conversationHistory.slice(-keepCount);

  if (toCompress.length === 0) {
    return { summary: existingSummary || "", keptHistory: conversationHistory };
  }

  // 构建要压缩的文本
  const historyText = toCompress
    .map(msg => `${msg.role === "user" ? "用户" : "AI"}: ${msg.content}`)
    .join("\n");

  const inputText = [
    existingSummary ? `之前的摘要：${existingSummary}\n` : null,
    "需要压缩的新对话：",
    historyText,
  ].filter(Boolean).join("\n");

  try {
    const summary = await callLLMForSummary(inputText);
    console.log(`[compress] ${toCompress.length} messages → summary (${summary.length} chars), kept ${keptHistory.length} recent`);
    return { summary, keptHistory };
  } catch (error) {
    console.warn(`[compress] LLM summarization failed, falling back to truncation: ${error.message}`);
    // 降级：直接截断，用简单拼接代替 LLM 摘要
    const fallbackSummary = [
      existingSummary,
      toCompress.map(msg => `${msg.role === "user" ? "用户" : "AI"}: ${msg.content}`).join(" | "),
    ].filter(Boolean).join(" | ").slice(0, 500);

    return { summary: fallbackSummary, keptHistory };
  }
}

/**
 * 调用 LLM 生成摘要（优先 Gemini，降级 Doubao）
 */
async function callLLMForSummary(inputText) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent([
      { text: `${SUMMARIZE_PROMPT}\n\n${inputText}` },
    ]);
    return result.response.text().trim();
  }

  const doubaoKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY;
  if (doubaoKey) {
    const baseUrl = process.env.DOUBAO_ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
    const modelName = process.env.DOUBAO_MODEL || "doubao-seed-2-0-lite-260215";
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doubaoKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: SUMMARIZE_PROMPT },
          { role: "user", content: inputText },
        ],
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`Doubao API error: ${response.status}`);
    const completion = await response.json();
    return (completion?.choices?.[0]?.message?.content ?? "").trim();
  }

  throw new Error("No API key available for summarization");
}
