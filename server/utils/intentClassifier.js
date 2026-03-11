/**
 * 判断用户请求是否需要理解视频内容（上传视频给 AI 分析）。
 * 使用轻量 LLM 调用进行分类，fallback 到保守策略（需要上传）。
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

const CLASSIFY_PROMPT = `你是一个视频编辑路由器。判断用户的编辑指令是否需要「理解视频画面内容」才能完成。

需要理解视频内容的例子（返回 true）：
- 找出白色球员进球的片段
- 删除无聊的部分
- 制作精彩集锦
- 分析视频内容
- 找到人物说话的片段

不需要理解视频内容的例子（返回 false）：
- 把视频裁剪到4分30秒
- 在开头加一行文字"春节快乐"
- 整体加速到2倍速
- 删除最后30秒
- 从第10秒到第1分钟截取
- 添加淡入淡出效果
- 在结尾加字幕

只回答 true 或 false，不要有任何其他内容。

用户指令：`;

/**
 * 用 LLM 判断是否需要视频内容理解。
 * @param {string} request
 * @returns {Promise<boolean>}
 */
export async function needsVideoAnalysis(request) {
  if (!request || !request.trim()) return false;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return true; // 没有 key 则保守策略

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(CLASSIFY_PROMPT + request);
    const text = result.response.text().trim().toLowerCase();
    const needsVideo = !text.startsWith("false");
    console.log(`[intentClassifier] "${request}" → needsVideo=${needsVideo} (model: "${text}")`);
    return needsVideo;
  } catch (e) {
    console.warn(`[intentClassifier] LLM 分类失败，fallback true: ${e.message}`);
    return true; // 失败时保守策略
  }
}
