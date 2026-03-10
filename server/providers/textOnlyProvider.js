/**
 * 文本模式 Provider：调用 LLM 处理用户请求，但不上传视频内容。
 * 适用于：添加文字、淡入淡出、指定时间段操作等不需要理解视频画面的编辑。
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { parseFeatures } from "../utils/parseFeatures.js";
import { AGENT_SYSTEM_PROMPT } from "./agentProtocol.js";
import { formatHistoryForPrompt, formatHistoryForMessages } from "../utils/buildEditContext.js";

// ── Gemini 文本模式 ──────────────────────────────────────────────────
async function textOnlyWithGemini({ duration, request, intent, prompt, pe, conversationHistory, conversationSummary, editContext }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = "gemini-2.5-flash";

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: AGENT_SYSTEM_PROMPT,
    generationConfig: { responseMimeType: "application/json" },
  });

  const historyText = formatHistoryForPrompt(conversationHistory, 6, conversationSummary);

  const finalPrompt = [
    pe ? `PE: ${pe}` : null,
    intent ? `Intent: ${JSON.stringify(intent)}` : null,
    prompt ? `Prompt: ${prompt}` : null,
    editContext || null,
    historyText || null,
    `用户指令: "${request || "按用户要求编辑视频"}"`,
    `视频时长: ${duration}s`,
    "",
    "注意：本次无需分析视频内容，请直接根据用户指令和视频时长生成剪辑方案。",
    historyText ? "请结合对话历史和当前编辑状态理解用户意图，支持指代（如'刚才那个''再快一点'）。" : null,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await model.generateContent([{ text: finalPrompt }]);
  const responseText = result.response.text();
  const features = parseFeatures(responseText, duration);

  console.log(`[textOnly:gemini] === LLM 原始响应 ===\n${responseText}`);
  console.log(`[textOnly:gemini] === 解析后特征 ===`, JSON.stringify({
    segments: features.segments?.length ?? 0,
    edits: features.edits?.length ?? 0,
    events: features.events?.length ?? 0,
    segmentDetails: features.segments?.map(s => ({ start: s.start, end: s.end, label: s.label })),
    editDetails: features.edits,
  }, null, 2));

  let agentPayload = {};
  try { agentPayload = JSON.parse(responseText); } catch (_) {}

  return {
    source: "gemini-text-only",
    features: {
      ...features,
      summary: agentPayload.final_answer,
      agentSteps: agentPayload.steps,
    },
    rawResponse: responseText,
  };
}

// ── Doubao 文本模式 ──────────────────────────────────────────────────
async function textOnlyWithDoubao({ duration, request, intent, prompt, pe, conversationHistory, conversationSummary, editContext }) {
  const apiKey =
    process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY;
  const baseUrl = process.env.DOUBAO_ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
  const model = process.env.DOUBAO_MODEL || "doubao-seed-2-0-lite-260215";

  const userText = [
    pe ? `PE: ${pe}` : null,
    intent ? `Intent: ${JSON.stringify(intent)}` : null,
    prompt ? `Prompt: ${prompt}` : null,
    editContext || null,
    request ? `User request: ${request}` : null,
    duration ? `Video duration: ${duration}s` : null,
    "",
    "注意：本次无需分析视频内容，请直接根据用户指令和视频时长生成剪辑方案。",
    "请按系统提示词要求，输出【纯 JSON】结果。",
  ]
    .filter(Boolean)
    .join("\n");

  // 构建 multi-turn messages：system + 历史对话 + 当前请求
  const historyMessages = formatHistoryForMessages(conversationHistory, 6, conversationSummary);
  const body = {
    model,
    messages: [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      ...historyMessages,
      { role: "user", content: userText },
    ],
    response_format: { type: "json_object" },
    stream: false,
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Doubao text-only API error: ${response.status} ${text}`);
  }

  const completion = await response.json();
  const responseText = completion?.choices?.[0]?.message?.content ?? "";
  const features = parseFeatures(responseText, duration);

  let agentPayload = {};
  try { agentPayload = JSON.parse(responseText); } catch (_) {}

  return {
    source: "doubao-text-only",
    features: {
      ...features,
      summary: agentPayload.final_answer,
      agentSteps: agentPayload.steps,
    },
    rawResponse: responseText,
  };
}

/**
 * 根据当前配置的引擎（gemini / doubao / auto）调用对应的文本模式 provider。
 */
export async function analyzeTextOnly({ engine, duration, request, intent, prompt, pe, conversationHistory, conversationSummary, editContext, onProgress = null }) {
  const debugTimeline = [
    {
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: "跳过视频上传，使用文本模式推理（操作无需视频内容理解）",
      data: { engine, request },
    },
  ];

  try {
    // 选择合适的 API
    onProgress?.("💬 本次操作无需视频理解，直接文本推理...");
    let result;
    if (
      engine === "doubao" ||
      (engine === "auto" &&
        !process.env.GEMINI_API_KEY &&
        (process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY))
    ) {
      onProgress?.("🧠 Doubao 文本推理中...");
      result = await textOnlyWithDoubao({ duration, request, intent, prompt, pe, conversationHistory, conversationSummary, editContext });
    } else if (engine === "gemini" || (engine === "auto" && process.env.GEMINI_API_KEY)) {
      onProgress?.("🧠 Gemini 文本推理中...");
      result = await textOnlyWithGemini({ duration, request, intent, prompt, pe, conversationHistory, conversationSummary, editContext });
    } else {
      // 无可用 API key，返回空结果
      return {
        source: "text-only-no-key",
        features: { edits: [], events: [], segments: [] },
        debugTimeline,
      };
    }

    return { ...result, debugTimeline };
  } catch (error) {
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "error",
      message: "文本模式推理失败",
      data: { error: String(error) },
    });
    return {
      source: "text-only-error",
      features: { edits: [], events: [], segments: [] },
      debugTimeline,
    };
  }
}
