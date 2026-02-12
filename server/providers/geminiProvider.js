import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import fs from "fs";
import path from "path";
import os from "os";
import { buildMockFeatures } from "../utils/mockFeatures.js";
import { parseFeatures } from "../utils/parseFeatures.js";

export async function analyzeVideoWithGemini({ video, duration, request, intent, prompt }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = "gemini-1.5-flash"; // Flash is stable for video

  const debugTimeline = [
    {
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: "准备调用 Gemini (File API 模式)",
      data: { model: modelName, hasRequest: Boolean(request), size: video.buffer.length },
    },
  ];

  if (!apiKey) {
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "error",
      message: "缺少 API Key",
    });
    return {
      features: buildMockFeatures(video, duration, "", intent, request),
      debugTimeline,
    };
  }

  let tempFilePath = null;
  let fileMetadata = null;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const fileManager = new GoogleAIFileManager(apiKey);

    // 1. 写入临时文件
    tempFilePath = path.join(os.tmpdir(), `gemini-${Date.now()}-${video.name}`);
    fs.writeFileSync(tempFilePath, video.buffer);

    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: "开始上传视频",
    });

    // 2. 上传
    const uploadResponse = await fileManager.uploadFile(tempFilePath, {
      mimeType: video.mimeType || "video/mp4",
      displayName: video.name,
    });
    fileMetadata = uploadResponse.file;

    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: "上传成功，等待处理",
      data: { uri: fileMetadata.uri },
    });

    // 3. 轮询状态
    let file = await fileManager.getFile(fileMetadata.name);
    let attempts = 0;
    while (file.state === FileState.PROCESSING && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      file = await fileManager.getFile(fileMetadata.name);
      attempts++;
    }

    if (file.state !== FileState.ACTIVE) {
      throw new Error(`File processing failed with state: ${file.state}`);
    }

    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: "处理完成，开始分析",
    });

    // 4. 分析
    const model = genAI.getGenerativeModel({ model: modelName });
    const analysisPrompt = prompt || `请分析该视频并输出 JSON。识别：${request || "视频内容"}。
JSON 格式：
{
  "segments": [{"start": 0, "end": 5, "energy": 0.5}],
  "events": [{"label": "描述", "start": 0, "end": 5, "confidence": 0.9}]
}`;

    const result = await model.generateContent([
      {
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri,
        },
      },
      { text: analysisPrompt },
    ]);

    const responseText = result.response.text();
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "model",
      level: "info",
      message: "收到模型响应",
      data: { text: responseText.slice(0, 100) },
    });

    const features = parseFeatures(responseText, duration);
    return {
      source: "gemini",
      features: features || buildMockFeatures(video, duration, responseText, intent, request),
      debugTimeline,
    };

  } catch (error) {
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "error",
      message: "识别失败",
      data: { error: String(error) },
    });
    return {
      features: buildMockFeatures(video, duration, "", intent, request),
      debugTimeline,
    };
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    if (fileMetadata) {
      try {
        const fileManager = new GoogleAIFileManager(apiKey);
        await fileManager.deleteFile(fileMetadata.name);
      } catch (e) {}
    }
  }
}
