import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import fs from "fs";
import path from "path";
import os from "os";
import { buildMockFeatures } from "../utils/mockFeatures.js";
import { parseFeatures } from "../utils/parseFeatures.js";
import { AGENT_SYSTEM_PROMPT } from "./agentProtocol.js";
import { compressVideoForUpload } from "../utils/compressVideo.js";

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
    if (video.path && fs.existsSync(video.path)) {
      tempInputPath = video.path;
      cleanupInput = true;
    } else {
      tempInputPath = path.join(os.tmpdir(), `gemini-prep-${Date.now()}-${video.name}`);
      fs.writeFileSync(tempInputPath, video.buffer);
      cleanupInput = true;
    }

    onProgress?.("📦 正在压缩视频...");
    tempCompressedPath = tempInputPath.replace(/\.[^.]+$/, "") + "-compressed.mp4";
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

    return { fileUri: file.uri, mimeType: file.mimeType, fileMetadata, fileManager };
  } finally {
    if (cleanupInput && tempInputPath && fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
    if (tempCompressedPath && fs.existsSync(tempCompressedPath)) fs.unlinkSync(tempCompressedPath);
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
  onProgress = null,
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = "gemini-2.5-flash";
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

    const finalPrompt =
      `用户指令: "${request || "分析并剪辑视频"}"\n` +
      `视频时长: ${duration}s\n` +
      `文件名: ${video?.name || "video"}\n\n` +
      `请基于视频内容和用户指令，执行 Re-Act 推理并给出剪辑方案。`;

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
    // 异步清理远端文件，不阻塞响应
    if (activeFile?.fileMetadata && activeFile?.fileManager) {
      activeFile.fileManager.deleteFile(activeFile.fileMetadata.name).catch(() => {});
    }
  }
}
