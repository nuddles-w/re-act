import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import fs from "fs";
import path from "path";
import os from "os";
import { buildMockFeatures } from "../utils/mockFeatures.js";
import { parseFeatures } from "../utils/parseFeatures.js";
import { AGENT_SYSTEM_PROMPT, ANALYZE_VIDEO_SYSTEM_PROMPT } from "./agentProtocol.js";
import { compressVideoForUpload } from "../utils/compressVideo.js";
import { computeVideoHash, getCachedFile, setCachedFile } from "../videoCache.js";
import { formatHistoryForPrompt } from "../utils/buildEditContext.js";

const resolveCompressionProfile = (duration, size) => {
  if (duration && duration >= 1800) {
    return { maxWidth: 854, maxHeight: 480, fps: 5, audioBitrate: "32k" };
  }
  if (duration && duration >= 900) {
    return { maxWidth: 960, maxHeight: 540, fps: 8, audioBitrate: "48k" };
  }
  if (size && size >= 800 * 1024 * 1024) {
    return { maxWidth: 854, maxHeight: 480, fps: 5, audioBitrate: "32k" };
  }
  if (size && size >= 200 * 1024 * 1024) {
    return { maxWidth: 960, maxHeight: 540, fps: 10, audioBitrate: "48k" };
  }
  return { maxWidth: 1280, maxHeight: 720, fps: 12, audioBitrate: "64k" };
};

/**
 * Phase 1：压缩 + 上传 + 轮询 ACTIVE
 * 可在用户写 prompt 时提前调用，把等待时间移出关键路径。
 * @returns {{ fileUri, mimeType, fileMetadata, fileManager }}
 */
export async function prepareGeminiUpload(video, apiKey, onProgress = null, compressionProfile = null) {
  const t0 = Date.now();
  const fileManager = new GoogleAIFileManager(apiKey);

  let tempInputPath = null;
  let tempCompressedPath = null;
  let cleanupInput = false;

  try {
    // 准备输入文件路径
    if (video.path && fs.existsSync(video.path)) {
      tempInputPath = video.path;
      cleanupInput = true;
    } else {
      tempInputPath = path.join(os.tmpdir(), `gemini-prep-${Date.now()}-${video.name}`);
      fs.writeFileSync(tempInputPath, video.buffer);
      cleanupInput = true;
    }

    // 计算视频 hash，检查缓存
    const videoHash = computeVideoHash(tempInputPath);
    const cached = getCachedFile(videoHash);

    // 先压缩视频（用于调试），即使有缓存也执行
    onProgress?.("📦 正在压缩视频...");
    tempCompressedPath = tempInputPath.replace(/\.[^.]+$/, "") + "-compressed.mp4";

    if (cached) {
      // 即使有缓存，也压缩一次用于调试
      try {
        const profile = compressionProfile || resolveCompressionProfile(video.duration || 0, video.size || 0);
        await compressVideoForUpload(tempInputPath, tempCompressedPath, profile);
        console.log(`[gemini:prepare] 已生成调试压缩文件（使用缓存，跳过上传）`);
      } catch (e) {
        console.warn(`[gemini:prepare] 调试压缩失败: ${e.message}`);
      }
      onProgress?.("✅ 使用缓存的视频文件，无需重新上传");
      return cached;
    }
    let uploadPath = tempInputPath;
    try {
      const profile =
        compressionProfile || resolveCompressionProfile(video.duration || 0, video.size || 0);
      const compressResult = await compressVideoForUpload(tempInputPath, tempCompressedPath, profile);
      const ratio = ((1 - compressResult.outputSize / compressResult.inputSize) * 100).toFixed(0);
      console.log(
        `[gemini:prepare] compress: ${compressResult.durationMs}ms  ` +
        `${(compressResult.inputSize / 1024 / 1024).toFixed(1)}MB → ` +
        `${(compressResult.outputSize / 1024 / 1024).toFixed(1)}MB (-${ratio}%)`
      );
      uploadPath = tempCompressedPath;
      onProgress?.(`📦 压缩完成（缩小 ${ratio}%），正在上传到 Gemini...`);
    } catch (e) {
      console.warn(`[gemini:prepare] compress failed, uploading original: ${e.message}`);
      onProgress?.("⬆️ 正在上传视频到 Gemini...");
    }

    const t1 = Date.now();
    const uploadResponse = await fileManager.uploadFile(uploadPath, {
      mimeType: "video/mp4",
      displayName: video.name,
    });
    const fileMetadata = uploadResponse.file;
    console.log(`[gemini:prepare] upload: ${Date.now() - t1}ms`);
    onProgress?.("⬆️ 上传完成，等待 Gemini 处理视频...");

    const t2 = Date.now();
    let file = await fileManager.getFile(fileMetadata.name);
    let rounds = 0;
    while (file.state === FileState.PROCESSING && rounds < 30) {
      if (rounds > 0 && rounds % 2 === 0) {
        onProgress?.(`⏳ Gemini 处理中... (已等待 ${rounds * 3}s)`);
      }
      await new Promise((r) => setTimeout(r, 3000));
      file = await fileManager.getFile(fileMetadata.name);
      rounds++;
    }
    console.log(`[gemini:prepare] poll: ${Date.now() - t2}ms (${rounds} rounds)`);

    if (file.state !== FileState.ACTIVE) {
      throw new Error(`File processing failed: ${file.state}`);
    }

    console.log(`[gemini:prepare] ✅ total: ${Date.now() - t0}ms  ← 已在用户写 prompt 时完成`);

    const result = { fileUri: file.uri, mimeType: file.mimeType, fileMetadata, fileManager };

    // 缓存文件信息
    setCachedFile(videoHash, result);

    return result;
  } finally {
    if (cleanupInput && tempInputPath && fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
    // 保留压缩文件用于调试
    if (tempCompressedPath && fs.existsSync(tempCompressedPath)) {
      const debugPath = path.join(os.tmpdir(), 'debug-compressed-latest.mp4');
      fs.copyFileSync(tempCompressedPath, debugPath);
      console.log(`[gemini:prepare] 压缩文件已保存到: ${debugPath}`);
      fs.unlinkSync(tempCompressedPath);
    }
  }
}

/**
 * Phase 2：推理
 * 如果提供了 preloadedFile，直接跳过上传进行推理；否则走完整流程（兜底）。
 */
export async function analyzeVideoWithGemini({
  video,
  duration,
  request,
  intent,
  prompt,
  pe,
  preloadedFile, // { fileUri, mimeType, fileMetadata, fileManager } from prepareGeminiUpload
  conversationHistory,
  conversationSummary,
  editContext,
  onProgress = null,
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = "gemini-2.5-pro";
  const tStart = Date.now();

  const debugTimeline = [
    {
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: preloadedFile
        ? "Gemini 推理（预上传模式，跳过上传+轮询）"
        : "Gemini 推理（完整流程：上传→轮询→推理）",
      data: { model: modelName, hasRequest: Boolean(request), pe, preloaded: !!preloadedFile },
    },
  ];

  if (!apiKey) {
    debugTimeline.push({ time: new Date().toISOString(), role: "system", level: "error", message: "缺少 API Key" });
    return { features: buildMockFeatures(video, duration, "", intent, request), debugTimeline };
  }

  let activeFile = preloadedFile ?? null;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);

    // 如果没有预上传文件，走完整上传流程（兜底）
    if (!activeFile) {
      debugTimeline.push({ time: new Date().toISOString(), role: "system", level: "info", message: "开始上传视频" });
      const profile = resolveCompressionProfile(duration, video?.size || 0);
      activeFile = await prepareGeminiUpload(video, apiKey, onProgress, profile);
    } else {
      onProgress?.("⚡ 视频已预处理完毕，直接开始推理...");
    }

    onProgress?.("🧠 正在进行 Re-Act 推理，分析用户意图...");
    debugTimeline.push({ time: new Date().toISOString(), role: "system", level: "info", message: "开始 Re-Act 推理" });

    const tInference = Date.now();
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: AGENT_SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json" },
    });

    const historyText = formatHistoryForPrompt(conversationHistory, 6, conversationSummary);

    const finalPrompt =
      (editContext ? `${editContext}\n\n` : "") +
      (historyText ? `${historyText}\n` : "") +
      `用户指令: "${request || "分析并剪辑视频"}"\n` +
      `视频时长: ${duration}s\n` +
      `文件名: ${video?.name || "video"}\n\n` +
      `请基于视频内容和用户指令，执行 Re-Act 推理并给出剪辑方案。` +
      (historyText ? "\n请结合对话历史和当前编辑状态理解用户意图，支持指代（如'刚才那个''再快一点'）。" : "");

    const result = await model.generateContent([
      { fileData: { mimeType: activeFile.mimeType, fileUri: activeFile.fileUri } },
      { text: finalPrompt },
    ]);

    const inferenceMs = Date.now() - tInference;
    const totalMs = Date.now() - tStart;
    console.log(
      `[gemini:analyze] 推理: ${inferenceMs}ms | ` +
      `总计: ${totalMs}ms | ` +
      `模式: ${preloadedFile ? "预上传✅" : "完整流程"}`
    );

    const responseText = result.response.text();
    debugTimeline.push({ time: new Date().toISOString(), role: "model", level: "info", message: "收到 Agent 响应", data: { text: responseText.slice(0, 100) } });

    let agentPayload = {};
    try { agentPayload = JSON.parse(responseText); } catch (_) {}

    const features = parseFeatures(responseText, duration);

    console.log(`[gemini:analyze] === LLM 原始响应 ===\n${responseText}`);
    console.log(`[gemini:analyze] === 解析后特征 ===`, JSON.stringify({
      segments: features.segments?.length ?? 0,
      edits: features.edits?.length ?? 0,
      events: features.events?.length ?? 0,
      segmentDetails: features.segments?.map(s => ({ start: s.start, end: s.end, label: s.label })),
      editDetails: features.edits,
    }, null, 2));

    return {
      source: "gemini-agent",
      features: { ...features, summary: agentPayload.final_answer, agentSteps: agentPayload.steps },
      rawResponse: responseText,
      debugTimeline,
    };
  } catch (error) {
    debugTimeline.push({ time: new Date().toISOString(), role: "system", level: "error", message: "Agent 推理失败", data: { error: String(error) } });
    return { features: buildMockFeatures(video, duration, "", intent, request), debugTimeline };
  } finally {
    // 不再删除远端文件，保留用于缓存复用
    // Gemini 文件会在 48 小时后自动过期
    // if (activeFile?.fileMetadata && activeFile?.fileManager) {
    //   activeFile.fileManager.deleteFile(activeFile.fileMetadata.name).catch(() => {});
    // }
  }
}

/**
 * Orchestrator：单轮文本推理（gemini-2.5-flash，无视频）
 * messages 格式：[{ role: "user"|"model", content: string }, ...]
 * 返回模型输出的原始字符串（JSON）
 */
export async function runOrchestratorTurn({ messages }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: AGENT_SYSTEM_PROMPT,
    generationConfig: { responseMimeType: "application/json" },
  });

  const contents = messages.map((m) => ({
    role: m.role === "model" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const result = await model.generateContent({ contents });
  return result.response.text();
}

/**
 * 视频内容分析器：用 gemini-2.5-pro + 已上传视频分析内容
 * 返回 { description: string, events: [{label, start, end, confidence}] }
 */
export async function analyzeVideoContent({ fileUri, mimeType, query, duration }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-pro",
    systemInstruction: ANALYZE_VIDEO_SYSTEM_PROMPT,
    generationConfig: { responseMimeType: "application/json" },
  });

  const prompt = [
    query ? `重点分析：${query}` : "分析所有重要事件和场景",
    `视频时长: ${duration}s`,
    "返回视频内容描述和完整事件列表，时间精确到小数点后一位。",
  ].join("\n");

  const result = await model.generateContent([
    { fileData: { mimeType, fileUri } },
    { text: prompt },
  ]);

  const text = result.response.text();
  console.log(`[gemini:analyzeContent] 原始响应:\n${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch (_) {
    return { description: text, events: [] };
  }
}
