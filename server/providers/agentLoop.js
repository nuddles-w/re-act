/**
 * 真正的 Tool-based ReAct 执行引擎
 *
 * 流程：
 *   1. 启动视频预压缩（后台）
 *   2. 循环调用 Orchestrator（text-only flash 模型）
 *   3. 解析 action → 真实执行工具 → 将 Observation 注入下一轮
 *   4. 遇到 final_answer 时结束，返回 features
 *
 * analyze_video 是唯一需要视频的工具：
 *   - 触发时先等待压缩完成，再上传，再调用 analyzeVideoContent
 *   - 已上传过则复用 fileUri（缓存）
 */
import { prepareGeminiUpload, analyzeVideoContent, runOrchestratorTurn } from "./geminiProvider.js";
import { parseFeatures } from "../utils/parseFeatures.js";
import { formatHistoryForPrompt } from "../utils/buildEditContext.js";

const MAX_ROUNDS = 8;

// ── 工具名白名单（structural edits，直接 ok）────────────────────────
const STRUCTURAL_TOOLS = new Set([
  "split_video", "delete_segment", "adjust_speed",
  "add_text", "fade_in", "fade_out", "add_bgm",
]);

/**
 * 解析 action 字符串，如 add_text(8, 15, "标题", "bottom")
 * → { toolName: "add_text", args: [8, 15, "标题", "bottom"] }
 */
function parseAction(actionStr) {
  if (!actionStr) return { toolName: null, args: [] };
  const match = actionStr.match(/^(\w+)\(([\s\S]*)\)$/);
  if (!match) return { toolName: actionStr.trim(), args: [] };
  const toolName = match[1];
  try {
    const args = JSON.parse(`[${match[2]}]`);
    return { toolName, args };
  } catch (_) {
    // 兜底：把整体作为一个字符串参数
    return { toolName, args: [match[2].replace(/^['"`]|['"`]$/g, "")] };
  }
}

function buildInitialMessage({ request, duration, conversationHistory, conversationSummary, editContext }) {
  const historyText = formatHistoryForPrompt(conversationHistory, 6, conversationSummary);
  return [
    editContext || null,
    historyText || null,
    `用户指令: "${request || "分析并剪辑视频"}"`,
    `视频时长: ${duration}s`,
    historyText ? "请结合对话历史和当前编辑状态理解用户意图，支持指代（如'刚才那个''再快一点'）。" : null,
  ].filter(Boolean).join("\n");
}

/**
 * 主入口
 * @param {object} opts
 * @param {object}  opts.video              - { name, size, mimeType, buffer?, path?, duration }
 * @param {string}  opts.cachedFileUri      - 已上传视频的 fileUri（会话复用）
 * @param {string}  opts.cachedMimeType     - 对应 mimeType
 * @param {number}  opts.duration
 * @param {string}  opts.request
 * @param {Array}   opts.conversationHistory
 * @param {string}  opts.conversationSummary
 * @param {string}  opts.editContext
 * @param {Function} opts.onProgress
 */
export async function runAgentLoop({
  video,
  cachedFileUri,
  cachedMimeType,
  duration,
  request,
  conversationHistory,
  conversationSummary,
  editContext,
  onProgress,
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const debugTimeline = [];

  // 已上传的视频文件（analyze_video tool 调用时填充）
  let uploadedFile = cachedFileUri
    ? { fileUri: cachedFileUri, mimeType: cachedMimeType || "video/mp4" }
    : null;

  // 多轮对话消息列表
  const messages = [];
  messages.push({
    role: "user",
    content: buildInitialMessage({ request, duration, conversationHistory, conversationSummary, editContext }),
  });

  let lastResponseText = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    onProgress?.(`🧠 推理第 ${round + 1} 轮...`);

    let responseText;
    try {
      responseText = await runOrchestratorTurn({ messages });
    } catch (e) {
      console.error(`[agentLoop] round ${round + 1} LLM error:`, e.message);
      debugTimeline.push({ round: round + 1, error: String(e) });
      break;
    }

    lastResponseText = responseText;
    messages.push({ role: "model", content: responseText });

    let parsed = {};
    try { parsed = JSON.parse(responseText); } catch (_) {}

    const logEntry = { round: round + 1, thought: parsed.thought, action: parsed.action };
    debugTimeline.push(logEntry);
    console.log(`[agentLoop] round ${round + 1} | action="${parsed.action ?? "(final)"}" | thought="${(parsed.thought ?? "").slice(0, 80)}"`);

    // ── 任务完成 ──────────────────────────────────────────────────
    if (parsed.final_answer != null) {
      const features = parseFeatures(responseText, duration);
      return {
        source: "agent-loop",
        features: { ...features, summary: parsed.final_answer, agentSteps: debugTimeline },
        rawResponse: responseText,
        debugTimeline,
        uploadedFileUri: uploadedFile?.fileUri ?? null,
        uploadedFileMimeType: uploadedFile?.mimeType ?? null,
      };
    }

    // ── 执行工具 ──────────────────────────────────────────────────
    const { toolName, args } = parseAction(parsed.action);

    let observation;

    if (toolName === "analyze_video") {
      const query = args[0] || "";
      onProgress?.(`🔍 分析视频内容${query ? `（${query}）` : ""}...`);

      // 需要视频：上传（如无缓存）
      if (!uploadedFile) {
        if (!video) {
          observation = { error: "no video file available" };
        } else {
          onProgress?.("⬆️ 上传视频到 Gemini...");
          uploadedFile = await prepareGeminiUpload(video, apiKey, onProgress);
        }
      }

    if (uploadedFile) {
        const analysis = await analyzeVideoContent({
          fileUri: uploadedFile.fileUri,
          mimeType: uploadedFile.mimeType,
          query,
          duration,
        });
        observation = analysis;
        logEntry.observation = { events: analysis.events?.length, description: analysis.description?.slice(0, 80) };
        console.log(`[agentLoop] analyze_video → ${analysis.events?.length ?? 0} events`);
      }
    } else if (STRUCTURAL_TOOLS.has(toolName)) {
      // 结构性编辑工具：不需要执行，只是告知模型已记录
      observation = { ok: true };
      logEntry.observation = { ok: true };
    } else {
      observation = { ok: true, note: `unknown tool: ${toolName}` };
      logEntry.observation = observation;
    }

    messages.push({
      role: "user",
      content: JSON.stringify({ observation }),
    });
  }

  // 超过最大轮数，尝试解析最后一次响应
  console.warn("[agentLoop] max rounds reached, parsing last response");
  const features = parseFeatures(lastResponseText || "{}", duration);
  return {
    source: "agent-loop-timeout",
    features,
    rawResponse: lastResponseText,
    debugTimeline,
  };
}
