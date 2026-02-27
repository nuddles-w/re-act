import { buildMockFeatures } from "../utils/mockFeatures.js";
import { parseFeatures } from "../utils/parseFeatures.js";
import { AGENT_SYSTEM_PROMPT } from "./agentProtocol.js";

const getAtempoChain = (rate) => {
  if (!Number.isFinite(rate) || rate <= 0) return "atempo=1.0";
  if (rate >= 0.5 && rate <= 2.0) return `atempo=${rate.toFixed(4)}`;

  const filters = [];
  if (rate > 2.0) {
    let temp = rate;
    while (temp > 2.0) {
      filters.push("atempo=2.0");
      temp /= 2.0;
    }
    filters.push(`atempo=${temp.toFixed(4)}`);
    return filters.join(",");
  }

  let temp = rate;
  while (temp < 0.5) {
    filters.push("atempo=0.5");
    temp /= 0.5;
  }
  filters.push(`atempo=${temp.toFixed(4)}`);
  return filters.join(",");
};

const normalizeVideoDataUrl = (buffer, mimeType) => {
  const base64 = buffer.toString("base64");
  const safeMime = mimeType || "video/mp4";
  return `data:${safeMime};base64,${base64}`;
};

export async function analyzeVideoWithDoubaoSeed({
  video,
  duration,
  request,
  intent,
  prompt,
  pe,
  onProgress = null,
}) {
  const apiKey =
    process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY;
  const baseUrl = process.env.DOUBAO_ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
  const model = process.env.DOUBAO_MODEL || "doubao-seed-2-0-lite-260215";
  const fps = Number(process.env.DOUBAO_VIDEO_FPS || 1);

  const debugTimeline = [
    {
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: "准备调用 Doubao Seed 2.0 (视频理解)",
      data: {
        model,
        baseUrl,
        fps,
        hasRequest: Boolean(request),
        size: video.buffer.length,
        pe,
      },
    },
  ];

  if (!apiKey) {
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "error",
      message: "缺少 Doubao API Key",
    });
    return {
      source: "doubao-seed-2.0",
      features: buildMockFeatures(video, duration, "", intent, request),
      debugTimeline,
    };
  }

  try {
    onProgress?.("⬆️ 正在上传视频到 Doubao...");
    const videoUrl = normalizeVideoDataUrl(video.buffer, video.mimeType);
    const userText = [
      pe ? `PE: ${pe}` : null,
      intent ? `Intent: ${JSON.stringify(intent)}` : null,
      prompt ? `Prompt: ${prompt}` : null,
      request ? `User request: ${request}` : null,
      duration ? `Video duration: ${duration}s` : null,
      "",
      "请按系统提示词要求，输出【纯 JSON】结果。若需要调用工具，请把调用过程写入 steps[].action 字段。",
    ]
      .filter(Boolean)
      .join("\n");

    const body = {
      model,
      messages: [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "video_url", video_url: { url: videoUrl, fps } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      stream: false,
    };

    onProgress?.("🧠 Doubao Seed 正在进行视频理解与推理...");
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
      throw new Error(`Doubao API error: ${response.status} ${text}`);
    }

    const completion = await response.json();
    const responseText = completion?.choices?.[0]?.message?.content ?? "";

    const parsed = parseFeatures(responseText, duration) || buildMockFeatures(video, duration, responseText, intent, request);

    return {
      source: "doubao-seed-2.0",
      features: parsed,
      rawResponse: responseText,
      debugTimeline,
    };
  } catch (error) {
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "error",
      message: "Doubao 调用失败，回退到本地 mock",
      data: { error: String(error) },
    });
    return {
      source: "doubao-seed-2.0-error-fallback",
      features: buildMockFeatures(video, duration, "", intent, request),
      rawResponse: String(error),
      debugTimeline,
    };
  }
}

