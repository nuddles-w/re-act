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
import { getDraftManager } from "../draftManager.js";
import { buildDraftHint, buildReadDraftGuidance } from "../utils/draftHelpers.js";
import { executeDraftTool } from "../tools/draftTools.js";

const MAX_ROUNDS = 8;

// ── 工具名白名单（structural edits，直接 ok）────────────────────────
const STRUCTURAL_TOOLS = new Set([
  "split_video", "delete_segment", "adjust_speed",
  "add_text", "fade_in", "fade_out", "add_bgm",
]);

// ── Draft 工具集 ──────────────────────────────────────────────────
const DRAFT_TOOLS = new Set([
  "read_draft", "add_segment", "modify_segment",
  "delete_segment", "split_segment", "move_segment",
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

function buildInitialMessage({ request, duration, conversationHistory, conversationSummary, editContext, sessionId }) {
  const historyText = formatHistoryForPrompt(conversationHistory, 6, conversationSummary);

  // 获取 draft 提示
  const draftManager = getDraftManager();
  const draft = draftManager.getDraft(sessionId);
  const draftHint = buildDraftHint(draft);

  // 智能引导
  const guidance = buildReadDraftGuidance(request, conversationHistory);

  return [
    draftHint,
    editContext || null,
    historyText || null,
    `用户指令: "${request || "分析并剪辑视频"}"`,
    `视频时长: ${duration}s`,
    guidance || null,
    historyText ? "请结合对话历史和当前编辑状态理解用户意图，支持指代（如'刚才那个''再快一点'）。" : null,
  ].filter(Boolean).join("\n\n");
}

/**
 * 主入口
 * @param {object} opts
 * @param {string}  opts.sessionId          - 会话 ID
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
  sessionId,
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
  const startTime = Date.now();

  // Token 和成本统计
  const stats = {
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    orchestratorCalls: 0,
    videoAnalysisCalls: 0,
  };

  // 已上传的视频文件（analyze_video tool 调用时填充）
  let uploadedFile = cachedFileUri
    ? { fileUri: cachedFileUri, mimeType: cachedMimeType || "video/mp4" }
    : null;

  // 多轮对话消息列表
  const messages = [];
  messages.push({
    role: "user",
    content: buildInitialMessage({ request, duration, conversationHistory, conversationSummary, editContext, sessionId }),
  });

  let lastResponseText = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    onProgress?.(`🧠 推理第 ${round + 1} 轮...`);

    let responseText, usage;
    try {
      const result = await runOrchestratorTurn({ messages });
      responseText = result.text;
      usage = result.usage;

      // 累计 orchestrator token 统计
      if (usage) {
        stats.totalTokensIn += usage.promptTokenCount || 0;
        stats.totalTokensOut += usage.candidatesTokenCount || 0;
        stats.totalCost += usage.cost || 0;
        stats.orchestratorCalls++;
      }
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
      const totalTime = Date.now() - startTime;
      const features = parseFeatures(responseText, duration);

      // 构建性能摘要
      const performanceSummary = {
        totalTime: `${(totalTime / 1000).toFixed(1)}s`,
        rounds: round + 1,
        tokensIn: stats.totalTokensIn,
        tokensOut: stats.totalTokensOut,
        totalTokens: stats.totalTokensIn + stats.totalTokensOut,
        cost: `$${stats.totalCost.toFixed(4)}`,
        orchestratorCalls: stats.orchestratorCalls,
        videoAnalysisCalls: stats.videoAnalysisCalls,
      };

      console.log(`[agentLoop] ✅ 完成 | 耗时=${performanceSummary.totalTime} 轮数=${performanceSummary.rounds} tokens=${performanceSummary.totalTokens} 成本=${performanceSummary.cost}`);

      return {
        source: "agent-loop",
        features: {
          ...features,
          summary: parsed.final_answer,
          agentSteps: debugTimeline,
          performance: performanceSummary,
        },
        rawResponse: responseText,
        debugTimeline,
        uploadedFileUri: uploadedFile?.fileUri ?? null,
        uploadedFileMimeType: uploadedFile?.mimeType ?? null,
      };
    }

    // ── 执行工具 ──────────────────────────────────────────────────
    const { toolName, args } = parseAction(parsed.action);

    let observation;

    // ── Draft 工具 ────────────────────────────────────────────────
    if (DRAFT_TOOLS.has(toolName)) {
      onProgress?.(`🔧 执行 ${toolName}...`);
      observation = await executeDraftTool(toolName, args, sessionId);
      logEntry.observation = observation;
      console.log(`[agentLoop] ${toolName} → ${JSON.stringify(observation).slice(0, 100)}`);

    // ── 视频分析工具 ──────────────────────────────────────────────
    } else if (toolName === "analyze_video") {
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

        // 累计视频分析 token 统计
        if (analysis.usage) {
          stats.totalTokensIn += analysis.usage.promptTokenCount || 0;
          stats.totalTokensOut += analysis.usage.candidatesTokenCount || 0;
          stats.totalCost += analysis.usage.cost || 0;
          stats.videoAnalysisCalls++;
        }
      }

    // ── 结构性编辑工具（向后兼容）──────────────────────────────────
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
