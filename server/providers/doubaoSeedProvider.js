import fs from "fs";
import path from "path";
import os from "os";
import { buildMockFeatures } from "../utils/mockFeatures.js";
import { parseFeatures } from "../utils/parseFeatures.js";
import { AGENT_SYSTEM_PROMPT } from "./agentProtocol.js";
import { compressVideoForUpload } from "../utils/compressVideo.js";
import { formatHistoryForMessages } from "../utils/buildEditContext.js";

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

const resolveCompressionProfile = (duration, size) => {
  if (duration && duration >= 1800) {
    return { maxWidth: 854, maxHeight: 480, fps: 0.5, audioBitrate: "32k" };
  }
  if (duration && duration >= 900) {
    return { maxWidth: 960, maxHeight: 540, fps: 1, audioBitrate: "48k" };
  }
  if (size && size >= 800 * 1024 * 1024) {
    return { maxWidth: 854, maxHeight: 480, fps: 0.5, audioBitrate: "32k" };
  }
  if (size && size >= 200 * 1024 * 1024) {
    return { maxWidth: 960, maxHeight: 540, fps: 1, audioBitrate: "48k" };
  }
  return { maxWidth: 1280, maxHeight: 720, fps: 2, audioBitrate: "64k" };
};

const toDataUrl = (buffer, mimeType) => {
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
  conversationHistory,
  conversationSummary,
  editContext,
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
        size: video.size,
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

  let tempInputPath = null;
  let tempCompressedPath = null;
  let cleanupInput = false;

  try {
    onProgress?.("⬆️ 正在上传视频到 Doubao...");
    let inputPath = video.path;
    if (!inputPath || !fs.existsSync(inputPath)) {
      tempInputPath = path.join(os.tmpdir(), `doubao-${Date.now()}-${video.name}`);
      fs.writeFileSync(tempInputPath, video.buffer);
      inputPath = tempInputPath;
      cleanupInput = true;
    }

    let uploadPath = inputPath;
    if ((video.size || 0) > 50 * 1024 * 1024 || duration > 600) {
      tempCompressedPath = inputPath.replace(/\.[^.]+$/, "") + "-compressed.mp4";
      const profile = resolveCompressionProfile(duration, video.size || 0);
      await compressVideoForUpload(inputPath, tempCompressedPath, profile);
      uploadPath = tempCompressedPath;
    }

    const videoUrl = toDataUrl(fs.readFileSync(uploadPath), video.mimeType);
    const userText = [
      pe ? `PE: ${pe}` : null,
      intent ? `Intent: ${JSON.stringify(intent)}` : null,
      prompt ? `Prompt: ${prompt}` : null,
      editContext || null,
      request ? `User request: ${request}` : null,
      duration ? `Video duration: ${duration}s` : null,
      "",
      "请按系统提示词要求，输出【纯 JSON】结果。若需要调用工具，请把调用过程写入 steps[].action 字段。",
    ]
      .filter(Boolean)
      .join("\n");

    // 构建 multi-turn messages：system + 历史对话 + 当前请求（含视频）
    const historyMessages = formatHistoryForMessages(conversationHistory, 6, conversationSummary);
    const body = {
      model,
      messages: [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        ...historyMessages,
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
  } finally {
    if (cleanupInput && tempInputPath && fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
    if (tempCompressedPath && fs.existsSync(tempCompressedPath)) fs.unlinkSync(tempCompressedPath);
  }
}
