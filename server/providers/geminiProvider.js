import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import fs from "fs";
import path from "path";
import os from "os";
import { buildMockFeatures } from "../utils/mockFeatures.js";
import { parseFeatures } from "../utils/parseFeatures.js";

import { AGENT_SYSTEM_PROMPT } from "./agentProtocol.js";

export async function analyzeVideoWithGemini({ video, duration, request, intent, prompt, pe }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = "gemini-2.5-flash"; // 尝试使用最新的 2.5 Flash 模型

  const debugTimeline = [
    {
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: "准备调用 Gemini (Agent 模式)",
      data: { model: modelName, hasRequest: Boolean(request), size: video.buffer.length, pe },
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
      message: "处理完成，开始 Re-Act 推理",
    });

    // 4. 分析与推理
    // 使用 gemini-2.0-flash 获得更强的 Agent 推理能力
    const model = genAI.getGenerativeModel({ 
      model: modelName, 
      systemInstruction: AGENT_SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
      }
    });
    
    // 构造最终的 Prompt，包含当前视频的信息
    const finalPrompt = `用户指令: "${request || "分析并剪辑视频"}"
视频时长: ${duration}s
文件名: ${video.name}

请基于视频内容和用户指令，执行 Re-Act 推理并给出剪辑方案。`;

    const result = await model.generateContent([
      {
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri,
        },
      },
      { text: finalPrompt },
    ]);

    const responseText = result.response.text();
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "model",
      level: "info",
      message: "收到 Agent 响应",
      data: { text: responseText.slice(0, 100) },
    });

    // 解析结果
    let agentPayload;
    try {
      agentPayload = JSON.parse(responseText);
    } catch (e) {
      console.error("JSON parse failed", responseText);
      agentPayload = { steps: [], final_answer: "解析失败", edits: [] };
    }

    // 将 Agent 的 edits 转换为 features 格式
    const features = parseFeatures(responseText, duration);
    
    return {
      source: "gemini-agent",
      features: {
        ...features,
        summary: agentPayload.final_answer,
        agentSteps: agentPayload.steps,
      },
      rawResponse: responseText,
      debugTimeline,
    };

  } catch (error) {
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "error",
      message: "Agent 推理失败",
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
