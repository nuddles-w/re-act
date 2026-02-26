/**
 * 文本模式 Provider：调用 LLM 处理用户请求，但不上传视频内容。
 * 适用于：添加文字、淡入淡出、指定时间段操作等不需要理解视频画面的编辑。
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { parseFeatures } from "../utils/parseFeatures.js";
import { AGENT_SYSTEM_PROMPT } from "./agentProtocol.js";

// ── Gemini 文本模式 ──────────────────────────────────────────────────
async function textOnlyWithGemini({ duration, request, intent, prompt, pe }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = "gemini-2.5-flash";

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: AGENT_SYSTEM_PROMPT,
    generationConfig: { responseMimeType: "application/json" },
  });

  const finalPrompt = [
    pe ? `PE: ${pe}` : null,
    intent ? `Intent: ${JSON.stringify(intent)}` : null,
    prompt ? `Prompt: ${prompt}` : null,
    `用户指令: "${request || "按用户要求编辑视频"}"`,
    `视频时长: ${duration}s`,
    "",
    "注意：本次无需分析视频内容，请直接根据用户指令和视频时长生成剪辑方案。",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await model.generateContent([{ text: finalPrompt }]);
  const responseText = result.response.text();
  const features = parseFeatures(responseText, duration);

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
async function textOnlyWithDoubao({ duration, request, intent, prompt, pe }) {
  const apiKey =
    process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY;
  const baseUrl = process.env.DOUBAO_ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
  const model = process.env.DOUBAO_MODEL || "doubao-seed-2-0-lite-260215";

  const userText = [
    pe ? `PE: ${pe}` : null,
    intent ? `Intent: ${JSON.stringify(intent)}` : null,
    prompt ? `Prompt: ${prompt}` : null,
    request ? `User request: ${request}` : null,
    duration ? `Video duration: ${duration}s` : null,
    "",
    "注意：本次无需分析视频内容，请直接根据用户指令和视频时长生成剪辑方案。",
    "请按系统提示词要求，输出【纯 JSON】结果。",
  ]
    .filter(Boolean)
    .join("\n");

  const body = {
    model,
    messages: [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      { role: "user", content: userText }, // 纯文本，不含 video_url
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
export async function analyzeTextOnly({ engine, duration, request, intent, prompt, pe }) {
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
    let result;
    if (
      engine === "doubao" ||
      (engine === "auto" &&
        !process.env.GEMINI_API_KEY &&
        (process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY))
    ) {
      result = await textOnlyWithDoubao({ duration, request, intent, prompt, pe });
    } else if (engine === "gemini" || (engine === "auto" && process.env.GEMINI_API_KEY)) {
      result = await textOnlyWithGemini({ duration, request, intent, prompt, pe });
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
