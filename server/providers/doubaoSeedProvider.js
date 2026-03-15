import fs from "fs";
import path from "path";
import os from "os";
import FormData from "form-data";
import fetch from "node-fetch";
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
    return { maxWidth: 960, maxHeight: 540, fps: 2, audioBitrate: "48k" };
  }
  return { maxWidth: 1280, maxHeight: 720, fps: 3, audioBitrate: "64k" };
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

/**
 * 准备 Doubao 视频上传（使用 Files API）
 * 用于 agentLoop 的视频预处理
 */
export async function prepareDoubaoUpload(video, apiKey, onProgress = null) {
  const baseUrl = process.env.DOUBAO_ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
  let tempInputPath = null;
  let tempCompressedPath = null;
  let cleanupInput = false;

  try {
    onProgress?.("📦 正在压缩视频...");

    let inputPath = video.path;
    if (!inputPath || !fs.existsSync(inputPath)) {
      tempInputPath = path.join(os.tmpdir(), `doubao-prep-${Date.now()}-${video.name}`);
      fs.writeFileSync(tempInputPath, video.buffer);
      inputPath = tempInputPath;
      cleanupInput = true;
    }

    let uploadPath = inputPath;
    const profile = resolveCompressionProfile(video.duration || 0, video.size || 0);
    tempCompressedPath = inputPath.replace(/\.[^.]+$/, "") + "-compressed.mp4";

    try {
      onProgress?.(`🔧 压缩视频中 (${profile.maxWidth}x${profile.maxHeight} @ ${profile.fps}fps)...`);
      const compressResult = await compressVideoForUpload(inputPath, tempCompressedPath, profile);
      const ratio = ((1 - compressResult.outputSize / compressResult.inputSize) * 100).toFixed(0);
      uploadPath = tempCompressedPath;
      onProgress?.(`📦 压缩完成 (${profile.maxWidth}x${profile.maxHeight} @ ${profile.fps}fps, 缩小 ${ratio}%)，正在上传到 Doubao...`);
    } catch (e) {
      console.warn(`[doubao] compress failed, uploading original: ${e.message}`);
      uploadPath = inputPath;
      onProgress?.("⬆️ 正在上传视频到 Doubao...");
    }

    // 使用 Files API 上传
    const formData = new FormData();
    formData.append('file', fs.createReadStream(uploadPath));
    formData.append('purpose', 'user_data');
    formData.append('preprocess_configs[video][fps]', String(profile.fps));

    console.log('[doubao] FormData fields:', {
      purpose: 'user_data',
      fps: String(profile.fps),
      uploadPath,
    });

    const uploadResponse = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => "");
      throw new Error(`Doubao file upload error: ${uploadResponse.status} ${text}`);
    }

    const fileInfo = await uploadResponse.json();
    console.log(`[doubao] File uploaded: ${fileInfo.id}, status: ${fileInfo.status}`);

    // 等待文件处理完成
    let fileStatus = fileInfo.status;
    let fileId = fileInfo.id;
    let attempts = 0;
    const maxAttempts = 60; // 最多等待 2 分钟

    while (fileStatus === 'processing' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;

      const statusResponse = await fetch(`${baseUrl}/files/${fileId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        fileStatus = statusData.status;
        console.log(`[doubao] File processing status: ${fileStatus} (attempt ${attempts})`);
      }
    }

    if (fileStatus !== 'processed' && fileStatus !== 'active') {
      throw new Error(`File processing failed or timeout. Status: ${fileStatus}`);
    }

    onProgress?.("✅ 视频上传完成");

    return {
      fileId,
      mimeType: video.mimeType || "video/mp4",
      fps: profile.fps,
    };
  } finally {
    if (cleanupInput && tempInputPath && fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
    if (tempCompressedPath && fs.existsSync(tempCompressedPath)) fs.unlinkSync(tempCompressedPath);
  }
}

/**
 * Doubao 视频内容分析（用于 agentLoop 的 analyze_video 工具）
 * 使用 Responses API + File ID
 */
export async function analyzeDoubaoVideoContent({ fileId, fps, query, duration }) {
  const apiKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY;
  const baseUrl = process.env.DOUBAO_ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
  const model = process.env.DOUBAO_MODEL || "ep-20260315183946-zh65s";

  console.log('[doubao] analyzeVideoContent called with:', { fileId, fps, query: query?.substring(0, 50), duration, model });

  if (!apiKey) {
    throw new Error("Missing Doubao API Key");
  }

  // 使用 Responses API 的格式
  const body = {
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_video",
            file_id: fileId,
          },
          {
            type: "input_text",
            text: `${query || "分析视频中的关键事件"}

请仔细观察视频画面，返回纯 JSON：
{
  "description": "视频内容简述（1-2句）",
  "events": [
    { "label": "事件描述（中文）", "start": 0.0, "end": 5.0, "confidence": 0.9 }
  ]
}

**重要提示**：
- 当用户查询涉及颜色、服装、外观特征时（如"白色球衣"、"红色衣服"），必须逐帧仔细核对每个事件中人物的视觉特征
- 只标注完全符合查询条件的事件，宁可遗漏也不要误判
- 如果无法确定某个事件是否符合条件（如光照导致颜色不清晰），将 confidence 设为 0.7 以下
- 对于体育比赛视频，注意区分不同队伍/球员的服装颜色，避免混淆

events 精确标注每个关键事件的起止时间（秒）。时间必须在视频时长范围内。
禁止 Markdown，只输出纯 JSON。`,
          },
        ],
      },
    ],
  };

  console.log('[doubao] Sending request to:', `${baseUrl}/responses`);
  console.log('[doubao] Request body:', JSON.stringify(body, null, 2));

  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  console.log('[doubao] Response status:', response.status, response.statusText);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error('[doubao] API error response:', text);
    throw new Error(`Doubao API error: ${response.status} ${text}`);
  }

  const completion = await response.json();

  console.log('[doubao] analyzeVideoContent raw response:', JSON.stringify(completion, null, 2));

  // Responses API 的响应格式：output 是数组，找到 type="message" 的那个
  const messageOutput = completion?.output?.find(o => o.type === 'message');
  const responseText = messageOutput?.content?.[0]?.text ?? "{}";

  console.log('[doubao] analyzeVideoContent extracted text:', responseText);

  let parsed = {};
  try {
    parsed = JSON.parse(responseText);
    console.log('[doubao] Parsed JSON:', parsed);
  } catch (e) {
    console.error("[doubao] Failed to parse video analysis response:", e);
    console.error("[doubao] Raw text was:", responseText);
  }

  const result = {
    description: parsed.description || "",
    events: parsed.events || [],
    usage: completion.usage ? {
      promptTokenCount: completion.usage.input_tokens || 0,
      candidatesTokenCount: completion.usage.output_tokens || 0,
      cost: 0,
    } : null,
  };

  console.log('[doubao] Returning result:', { description: result.description, eventCount: result.events.length });

  return result;
}

/**
 * Doubao Orchestrator 推理（用于 agentLoop 的多轮对话）
 */
export async function runDoubaoOrchestratorTurn({ messages }) {
  const apiKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY;
  const baseUrl = process.env.DOUBAO_ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
  const model = process.env.DOUBAO_MODEL || "doubao-seed-2-0-pro-260215";

  if (!apiKey) {
    throw new Error("Missing Doubao API Key");
  }

  const body = {
    model,
    messages: [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      ...messages,
    ],
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
    throw new Error(`Doubao API error: ${response.status} ${text}`);
  }

  const completion = await response.json();
  const responseText = completion?.choices?.[0]?.message?.content ?? "{}";

  return {
    text: responseText,
    usage: completion.usage ? {
      promptTokenCount: completion.usage.prompt_tokens || 0,
      candidatesTokenCount: completion.usage.completion_tokens || 0,
      cost: 0,
    } : null,
  };
}
