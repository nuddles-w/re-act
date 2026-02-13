import { GoogleGenerativeAI } from "@google/generative-ai";
import { AGENT_SYSTEM_PROMPT } from "./agentProtocol.js";
import { parseFeatures } from "../utils/parseFeatures.js";
import { buildMockFeatures } from "../utils/mockFeatures.js";

export const analyzeWithMockAgent = async ({ video, duration, request, pe, intent }) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = "gemini-2.5-flash"; // 升级到 2.5 Flash 以获得更好的推理能力

  const debugTimeline = [
    {
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: "进入 Mock 调试模式 (跳过视频处理)",
      data: { name: video.name, duration, request },
    },
  ];

  // 如果没有 API Key，直接返回纯本地 Mock 数据，不调用 Gemini
  if (!apiKey) {
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "warn",
      message: "未检测到 API Key，返回基础模拟数据",
    });
    const fallbackFeatures = buildMockFeatures(video, duration, "", intent, request);
    return {
      source: "local-mock-fallback",
      features: {
        ...fallbackFeatures,
        summary: "未检测到 API Key，这是本地生成的模拟结果。",
        agentSteps: [
          { thought: "检测到缺少 API Key。", action: "fallback_to_local()", observation: "使用本地策略引擎" }
        ],
      },
      debugTimeline,
    };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: modelName,
      systemInstruction: AGENT_SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    // 模拟视频上下文
    const mockContext = `
[DEBUG MOCK CONTEXT]
当前是调试模式，你无法看到真实视频，但请假设视频内容如下：
- 总时长: ${duration}s
- 0s - 5s: 厨师准备食材。
- 5s - 12s: 厨师正在【捣碎鸡蛋】，动作非常连贯。
- 12s - 15s: 厨师在碗里搅拌。
- 15s - 22s: 厨师向碗中【加入沙拉酱】，并继续搅拌。
- 22s - 30s: 最后的摆盘和展示。

请基于以上模拟内容和用户指令进行推理。
`;

    const finalPrompt = `${mockContext}\n用户指令: "${request}"\n视频时长: ${duration}s\n请开始推理并输出 JSON。`;

    const result = await model.generateContent(finalPrompt);
    const responseText = result.response.text();

    let agentPayload;
    try {
      agentPayload = JSON.parse(responseText);
    } catch (e) {
      // 尝试二次解析（处理 Markdown 代码块）
      const match = responseText.match(/\{[\s\S]*\}/);
      if (match) {
        agentPayload = JSON.parse(match[0]);
      } else {
        throw new Error("Could not parse AI response as JSON");
      }
    }

    const features = parseFeatures(responseText, duration) || buildMockFeatures(video, duration, "", intent, request);

    return {
      source: "gemini-mock-agent",
      features: {
        ...features,
        summary: agentPayload.final_answer || "任务处理完成",
        agentSteps: agentPayload.steps || [],
      },
      rawResponse: responseText,
      debugTimeline,
    };
  } catch (error) {
    console.error("Mock Agent Error:", error);
    
    const isQuotaExceeded = error.message?.includes("429") || error.message?.includes("quota");
    
    // 如果 AI 报错（如 404 或 429），则进入“本地仿真模式”，根据用户输入模拟 Agent 推理过程
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: isQuotaExceeded ? "info" : "warn",
      message: isQuotaExceeded ? "API 配额已耗尽，自动切换到仿真引擎" : "API 调用失败，进入本地 Agent 仿真模式",
      data: { error: error.message }
    });
    
    // 发生错误时，返回 fallback 特征，确保前端不显示“识别异常”
    const fallbackFeatures = buildMockFeatures(video, duration, "", intent, request);
    return {
      source: "gemini-mock-error-fallback",
      features: {
        ...fallbackFeatures,
        summary: `Mock 推理失败: ${error.message}`,
        agentSteps: [
          { thought: "推理过程中发生错误。", action: "error_handling", observation: error.message }
        ],
      },
      debugTimeline,
    };
  }
};
