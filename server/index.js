import "dotenv/config";
import express from "express";
import multer from "multer";
import { analyzeVideoWithGemini, prepareGeminiUpload } from "./providers/geminiProvider.js";
import { analyzeVideoWithDoubaoSeed } from "./providers/doubaoSeedProvider.js";
import { analyzeWithMockAgent } from "./providers/mockAgentProvider.js";
import { analyzeWithMock } from "./providers/mockProvider.js";
import { analyzeTextOnly } from "./providers/textOnlyProvider.js";
import { needsVideoAnalysis } from "./utils/intentClassifier.js";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { createCanvas } from "canvas";
import { searchAndDownloadBgm } from "./utils/fetchBgm.js";
import {
  createSession,
  getSession,
  updateSessionFeatures,
  addConversation,
  getConversationHistory,
  deleteSession,
  getSessionStats,
} from "./sessionManager.js";

/**
 * 用 canvas 生成一张透明背景的文字 PNG，返回文件路径
 * @param {string} text
 * @param {"top"|"center"|"bottom"} position
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {string} outPath
 */
/**
 * 与前端预览完全一致的文字 PNG 生成逻辑：
 *   - fontSize  = videoHeight * 0.04
 *   - padding   = fontSize * 0.25
 *   - 无背景，白色描边文字（与预览保持一致）
 *   - 位置：top/center/bottom 各距视频边缘 8% 高度
 */
function generateTextPng(text, position, videoWidth, videoHeight, outPath) {
  const fontSize = Math.round(videoHeight * 0.04);
  const padding  = Math.round(fontSize * 0.25);
  const boxH     = fontSize + padding * 2;

  const canvas = createCanvas(videoWidth, videoHeight);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, videoWidth, videoHeight);

  // 计算背景条 Y 坐标（与前端 topPx 公式一致）
  let boxY;
  if (position === "top") {
    boxY = Math.round(videoHeight * 0.08);
  } else if (position === "center") {
    boxY = Math.round((videoHeight - boxH) / 2);
  } else { // bottom
    boxY = videoHeight - boxH - Math.round(videoHeight * 0.08);
  }

  // 白色文字 + 描边轮廓（无背景，提升可读性）
  ctx.font = `bold ${fontSize}px "PingFang SC", "STHeiti", "Heiti SC", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 先描边（黑色轮廓）
  ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
  ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.08));
  ctx.lineJoin = "round";
  ctx.strokeText(text, videoWidth / 2, boxY + boxH / 2);

  // 再填充白色文字
  ctx.fillStyle = "white";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillText(text, videoWidth / 2, boxY + boxH / 2);

  fs.writeFileSync(outPath, canvas.toBuffer("image/png"));
}

/**
 * 通过 ffprobe 获取视频宽高
 */
function probeVideoSize(inputPath) {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      inputPath,
    ];
    const proc = spawn("ffprobe", args);
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", () => {
      const [w, h] = out.trim().split(",").map(Number);
      resolve({ width: w || 1920, height: h || 1080 });
    });
  });
}

const app = express();
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 2048);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${file.originalname}`),
  }),
  limits: { fileSize: maxUploadMb * 1024 * 1024 },
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ── Gemini 预上传缓存 ──────────────────────────────────────────────
// prepareId → { promise: Promise<{fileUri,mimeType,fileMetadata,fileManager}>, createdAt }
const prepareMap = new Map();

// 每 5 分钟清理超过 15 分钟的过期条目
setInterval(() => {
  const expiry = Date.now() - 15 * 60 * 1000;
  for (const [id, entry] of prepareMap) {
    if (entry.createdAt < expiry) {
      // 尝试删除 Gemini 远端文件（已经过时了，不影响主流程）
      entry.promise.then((data) => {
        if (data?.fileMetadata && data?.fileManager) {
          data.fileManager.deleteFile(data.fileMetadata.name).catch(() => {});
        }
      }).catch(() => {});
      prepareMap.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── 导出文件缓存（SSE 模式：FFmpeg 写完后存这里，前端来取）────────────────
const exportFileMap = new Map(); // fileId → { path, filename, createdAt }
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of exportFileMap) {
    if (now - entry.createdAt > 30 * 60 * 1000) {
      try { if (fs.existsSync(entry.path)) fs.unlinkSync(entry.path); } catch (_) {}
      exportFileMap.delete(id);
    }
  }
}, 5 * 60 * 1000);

app.get("/api/export/file/:fileId", (req, res) => {
  const entry = exportFileMap.get(req.params.fileId);
  if (!entry || !fs.existsSync(entry.path)) return res.status(404).json({ error: "not_found" });
  res.download(entry.path, entry.filename, () => {
    exportFileMap.delete(req.params.fileId);
    try { fs.unlinkSync(entry.path); } catch (_) {}
  });
});

const PROVIDERS = {
  gemini: analyzeVideoWithGemini,
  doubao: analyzeVideoWithDoubaoSeed,
  mock: analyzeWithMock,
  "mock-agent": analyzeWithMockAgent,
};

const resolveEngine = (req) => {
  const engineRaw = String(req.body.engine || "").trim();
  if (engineRaw) return engineRaw;

  const isMock = req.body.isMock === "true";
  if (isMock) return "mock-agent";

  return "auto";
};

const resolveProvider = (engine) => {
  if (engine === "auto") {
    if (process.env.GEMINI_API_KEY) return PROVIDERS.gemini;
    if (process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY)
      return PROVIDERS.doubao;
    console.warn("[analyze] no provider key found, fallback to mock");
    return PROVIDERS.mock;
  }
  return PROVIDERS[engine];
};

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ── Gemini 预上传端点（GEMINI_EAGER_UPLOAD=true 时启用）──────────────
app.post("/api/prepare", upload.single("video"), (req, res) => {
  if (process.env.GEMINI_EAGER_UPLOAD !== "true") {
    return res.status(404).json({ error: "eager_upload_disabled" });
  }

  const videoFile = req.file;
  if (!videoFile) return res.status(400).json({ error: "missing_video" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: "no_gemini_key" });

  const prepareId = `prep-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

  // 立刻返回 prepareId，后台异步跑压缩 + 上传 + 轮询
  const preparePromise = prepareGeminiUpload(
    {
      name: videoFile.originalname,
      size: videoFile.size,
      mimeType: videoFile.mimetype,
      buffer: videoFile.buffer,
      path: videoFile.path,
    },
    apiKey
  ).catch((err) => {
    console.error(`[prepare:${prepareId}] failed:`, err.message);
    return null; // 失败时返回 null，analyze 会走兜底流程
  });

  prepareMap.set(prepareId, { promise: preparePromise, createdAt: Date.now() });
  console.log(`[prepare:${prepareId}] started (${(videoFile.size / 1024 / 1024).toFixed(1)}MB)`);

  res.json({ prepareId });
});

app.post("/api/analyze", upload.single("video"), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  const videoFile = req.file;
  const sessionId = req.body.sessionId || null;

  const engine = resolveEngine(req);
  const provider = resolveProvider(engine);
  if (!provider) return res.status(400).json({ error: "invalid_engine", engine });

  // ── 切换为 SSE 流式响应 ──────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no"); // 禁用 nginx 缓冲
  res.flushHeaders();

  const emitProgress = (message) =>
    res.write(`data: ${JSON.stringify({ type: "progress", message })}\n\n`);

  const emitResult = (payload) => {
    res.write(`data: ${JSON.stringify({ type: "result", ...payload })}\n\n`);
    res.end();
  };

  const emitError = (message, debug = {}) => {
    res.write(`data: ${JSON.stringify({ type: "error", message, debug })}\n\n`);
    res.end();
  };

  try {
    const duration = Number(req.body.duration || 0);
    let intent = null;
    try { intent = JSON.parse(req.body.intent || "null"); } catch (_) {}
    const pe = req.body.pe || "";
    const request = req.body.request || "";
    const prompt = req.body.prompt || "";

    // ── 会话记忆：检查是否有已存在的会话 ──────────────────────────
    const existingSession = sessionId ? getSession(sessionId) : null;

    if (existingSession) {
      // 有会话记忆，直接使用缓存的分析结果
      console.log(`[analyze:${requestId}] 使用会话缓存 ${sessionId}`);
      emitProgress("💾 使用已缓存的视频分析结果...");

      // 记录用户请求到对话历史
      addConversation(sessionId, { role: "user", content: request });

      // 如果是纯文本编辑请求（不需要重新分析视频）
      const skipVideoUpload = engine !== "mock" && engine !== "mock-agent" && !needsVideoAnalysis(request);

      if (skipVideoUpload) {
        // 纯文本编辑：基于已有的 features 进行增量编辑
        emitProgress("✏️ 处理编辑指令...");

        const result = await analyzeTextOnly({
          engine,
          duration: existingSession.videoInfo.duration,
          request,
          intent,
          prompt,
          pe,
          onProgress: emitProgress,
        });

        // 更新会话的 features（增量合并）
        if (result.features) {
          const mergedFeatures = {
            ...existingSession.analysisResult.features,
            edits: [
              ...(existingSession.analysisResult.features.edits || []),
              ...(result.features.edits || []),
            ],
          };
          updateSessionFeatures(sessionId, mergedFeatures);
        }

        // 记录 AI 响应
        addConversation(sessionId, { role: "assistant", content: result.summary || "编辑完成" });

        emitResult({
          sessionId,
          source: result.source,
          features: result.features,
          summary: result.summary,
          rawResponse: result.rawResponse,
          debug: { requestId, pe, request, prompt, engine, cached: true },
          debugTimeline: result.debugTimeline || [],
        });
        return;
      } else {
        // 需要重新分析视频（例如"找出所有笑脸"），但可以复用已上传的视频
        emitProgress("🔄 重新分析视频内容...");
        // 这里暂时还是走完整流程，后续可以优化为复用已上传的视频 URI
      }
    }

    // ── 新会话或需要完整分析 ──────────────────────────────────────
    if (!videoFile) return res.status(400).json({ error: "missing_video" });

    const debugTimeline = [{
      time: new Date().toISOString(), role: "system", level: "info",
      message: "收到识别请求",
      data: { name: videoFile.originalname, size: videoFile.size, duration, pe, request, engine },
    }];

    console.log(`[analyze:${requestId}] start`, JSON.stringify({ name: videoFile.originalname, size: videoFile.size, duration, pe, request, engine }, null, 2));
    emitProgress("🎬 收到请求，正在分析意图...");

    // Re-Act 智能路由
    const skipVideoUpload = engine !== "mock" && engine !== "mock-agent" && !needsVideoAnalysis(request);

    // 检查 Gemini 预上传
    const prepareId = req.body.prepareId || null;
    let preloadedFile = null;
    if (prepareId && prepareMap.has(prepareId) && engine !== "mock" && engine !== "mock-agent") {
      const entry = prepareMap.get(prepareId);
      prepareMap.delete(prepareId);
      const prepared = await entry.promise;
      if (prepared?.fileUri) {
        preloadedFile = prepared;
        console.log(`[analyze:${requestId}] 命中预上传缓存`);
      } else {
        console.warn(`[analyze:${requestId}] 预上传失败，回退完整流程`);
        emitProgress("⚠️ 预上传未就绪，重新上传视频...");
      }
    }

    const video = {
      name: videoFile.originalname,
      size: videoFile.size,
      mimeType: videoFile.mimetype,
      buffer: videoFile.buffer,
      path: videoFile.path,
      duration,
    };

    const result = skipVideoUpload
      ? await analyzeTextOnly({ engine, duration, request, intent, prompt, pe, onProgress: emitProgress })
      : await provider({ video, duration, intent, prompt, request, pe, preloadedFile, onProgress: emitProgress });

    if (Array.isArray(result.debugTimeline)) debugTimeline.push(...result.debugTimeline);
    debugTimeline.push({
      time: new Date().toISOString(), role: "system", level: "info", message: "识别完成",
      data: { source: result.source, edits: result.features?.edits?.length || 0 },
    });

    console.log(`[analyze:${requestId}] done`, JSON.stringify({
      source: result.source,
      segmentCount: result.features?.segmentCount,
      events: result.features?.events?.length || 0,
      edits: result.features?.edits?.length || 0,
    }, null, 2));

    // ── 创建新会话并缓存分析结果 ──────────────────────────────────
    const newSessionId = createSession(
      { name: videoFile.originalname, size: videoFile.size, duration, path: videoFile.path },
      { features: result.features, source: result.source, summary: result.summary }
    );

    // 记录初始对话
    addConversation(newSessionId, { role: "user", content: request });
    addConversation(newSessionId, { role: "assistant", content: result.summary || "分析完成" });

    emitResult({
      sessionId: newSessionId,
      source: result.source,
      features: result.features,
      summary: result.summary,
      rawResponse: result.rawResponse,
      debug: { requestId, pe, request, prompt, engine },
      debugTimeline,
    });
  } catch (error) {
    console.error(`[analyze:${requestId}] error`, String(error));
    emitError("识别异常：" + String(error), { requestId });
  } finally {
    if (videoFile?.path && fs.existsSync(videoFile.path)) {
      fs.unlinkSync(videoFile.path);
    }
  }
});

app.post("/api/export", upload.single("video"), async (req, res) => {
  const requestId = `export-${Date.now()}`;
  let tempInputPath = null;
  let tempOutputPath = null;
  let bgmPath = null;

  // ── SSE 设置 ──
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const emitEvt = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const emitProgress = (percent, message) => emitEvt({ type: "progress", percent, message });
  const emitDone = (fileId) => { emitEvt({ type: "done", fileId }); res.end(); };
  const emitExportError = (msg) => { emitEvt({ type: "error", message: msg }); res.end(); };

  try {
    const videoFile = req.file;
    if (!videoFile) { emitExportError("missing_video"); return; }

    const timeline = JSON.parse(req.body.timeline || "{}");
    if (!timeline.clips || timeline.clips.length === 0) { emitExportError("invalid_timeline"); return; }

    const colorAdjust = JSON.parse(req.body.colorAdjust || "null") || {};
    const activeFilter = req.body.activeFilter || "none";
    const exportFormat = req.body.exportFormat || "original";

    emitProgress(2, "准备文件...");

    tempInputPath = videoFile.path || path.join(os.tmpdir(), `${requestId}-input.mp4`);
    tempOutputPath = path.join(os.tmpdir(), `${requestId}-output.mp4`);
    if (!videoFile.path) {
      fs.writeFileSync(tempInputPath, videoFile.buffer);
    }

    // 2. 构建 FFmpeg 滤镜链
    // 目标：为每个片段生成独立的 v/a 链，然后 concat，最后应用文字/淡入淡出
    let filterComplex = "";
    let concatInputs = "";

    timeline.clips.forEach((clip, i) => {
      const rate = clip.playbackRate || 1;
      const vpts = (1 / rate).toFixed(4);

      // 视频处理：trim -> setpts (必须先 PTS-STARTPTS 重置时间戳到 0，否则变速后会出现空隙/静止帧)
      filterComplex += `[0:v]trim=start=${clip.start}:end=${clip.end},setpts=PTS-STARTPTS,setpts=${vpts}*PTS[v${i}];`;

      // 音频处理：atrim -> asetpts -> atempo
      let atempoFilter = "";
      if (rate > 2.0) {
        let tempRate = rate;
        while (tempRate > 2.0) {
          atempoFilter += "atempo=2.0,";
          tempRate /= 2.0;
        }
        atempoFilter += `atempo=${tempRate.toFixed(4)}`;
      } else if (rate < 0.5) {
        let tempRate = rate;
        while (tempRate < 0.5) {
          atempoFilter += "atempo=0.5,";
          tempRate /= 0.5;
        }
        atempoFilter += `atempo=${tempRate.toFixed(4)}`;
      } else {
        atempoFilter = `atempo=${rate.toFixed(4)}`;
      }

      filterComplex += `[0:a]atrim=start=${clip.start}:end=${clip.end},asetpts=PTS-STARTPTS,${atempoFilter}[a${i}];`;
      concatInputs += `[v${i}][a${i}]`;
    });

    // 判断是否需要后处理（文字叠加 / 淡入淡出 / 背景音乐）
    const textEdits = Array.isArray(timeline.textEdits) ? timeline.textEdits.filter(e => e.text) : [];
    const fadeEdits = Array.isArray(timeline.fadeEdits) ? timeline.fadeEdits : [];
    const bgmEdits  = Array.isArray(timeline.bgmEdits)  ? timeline.bgmEdits  : [];
    const needsPost = textEdits.length > 0 || fadeEdits.length > 0 || bgmEdits.length > 0;

    const concatVLabel = needsPost ? "[concatv]" : "[outv]";
    const concatALabel = needsPost ? "[concata]" : "[outa]";

    filterComplex += `${concatInputs}concat=n=${timeline.clips.length}:v=1:a=1${concatVLabel}${concatALabel}`;

    let finalVideoLabel = concatVLabel;
    let finalAudioLabel = concatALabel;

    // 生成文字 PNG 并收集临时文件路径
    const textPngPaths = [];

    if (needsPost) {
      // ── 淡入淡出效果 ──
      fadeEdits.forEach((fade, i) => {
        const st = (fade.timelineStart !== undefined ? fade.timelineStart : fade.start).toFixed(3);
        const dur = Math.max(0.1, (fade.timelineEnd !== undefined ? fade.timelineEnd : fade.end) - parseFloat(st)).toFixed(3);
        const nv = `[vfade${i}]`;
        const na = `[afade${i}]`;
        filterComplex += `;${finalVideoLabel}fade=t=${fade.direction}:st=${st}:d=${dur}${nv}`;
        filterComplex += `;${finalAudioLabel}afade=t=${fade.direction}:st=${st}:d=${dur}${na}`;
        finalVideoLabel = nv;
        finalAudioLabel = na;
      });

      // ── 文字叠加：canvas 生成 PNG + FFmpeg overlay ──
      if (textEdits.length > 0) {
        const { width: vw, height: vh } = await probeVideoSize(tempInputPath);

        textEdits.forEach((edit, i) => {
          const pngPath = path.join(os.tmpdir(), `${requestId}-text${i}.png`);
          generateTextPng(edit.text, edit.position || "bottom", vw, vh, pngPath);
          textPngPaths.push(pngPath);
        });

        // 每张 PNG 作为一路输入，叠加到视频上
        // FFmpeg 额外 -i 会从 index 1 开始（0 是原视频），但我们已经用了 -i tempInput
        // 所以文字 PNG 的 input index 从 1 开始
        textEdits.forEach((edit, i) => {
          const inputIdx = i + 1; // 0 已被视频占用
          const st = (edit.timelineStart !== undefined ? edit.timelineStart : edit.start).toFixed(3);
          const et = (edit.timelineEnd !== undefined ? edit.timelineEnd : edit.end).toFixed(3);
          const nextLabel = i === textEdits.length - 1 ? "[outv]" : `[vtxt${i}]`;
          // loop=1 让静态图片循环，overlay 仅在 between(t,st,et) 时生效
          filterComplex += `;[${inputIdx}:v]setpts=PTS-STARTPTS[txt${i}]`;
          filterComplex += `;${finalVideoLabel}[txt${i}]overlay=0:0:enable='between(t,${st},${et})'${nextLabel}`;
          finalVideoLabel = nextLabel;
        });

      }

      // ── 背景音乐混音 ──────────────────────────────────────────────
      if (bgmEdits.length > 0) {
        const bgmEdit = bgmEdits[0]; // 只取第一条 BGM 指令
        try {
          console.log(`[export:${requestId}] 搜索背景音乐: "${bgmEdit.keywords}"`);
          const bgm = await searchAndDownloadBgm(bgmEdit.keywords, requestId);
          console.log(`[export:${requestId}] BGM: ${bgm.title} - ${bgm.artist}`);
          bgmPath = bgm.path;

          const bgmVol = Math.min(1, Math.max(0, bgmEdit.volume ?? 0.3));
          const totalDurSec = timeline.totalTimelineDuration || 60;
          const fadeOutSt = Math.max(0, totalDurSec - 2).toFixed(2);
          // BGM 输入 index = 1（视频）+ textPngPaths.length
          const bgmIdx = 1 + textPngPaths.length;

          // 对 BGM 单独做音量 + 淡入淡出，再与原声 amix
          filterComplex += `;[${bgmIdx}:a]volume=${bgmVol},afade=t=in:d=1:st=0,afade=t=out:st=${fadeOutSt}:d=2[bgmaudio]`;
          filterComplex += `;${finalAudioLabel}[bgmaudio]amix=inputs=2:duration=first:normalize=0[outa]`;
          finalAudioLabel = "[outa]";
        } catch (e) {
          console.warn(`[export:${requestId}] BGM 获取失败（跳过）: ${e.message}`);
          // BGM 失败不阻断导出，静默跳过
        }
      }

      // 如果视频标签还没落到 [outv]，最终对齐
      if (finalVideoLabel !== "[outv]") {
        filterComplex += `;${finalVideoLabel}null[outv]`;
        finalVideoLabel = "[outv]";
      }
      if (finalAudioLabel !== "[outa]") {
        filterComplex += `;${finalAudioLabel}anull[outa]`;
        finalAudioLabel = "[outa]";
      }
    }

    // ── 调色校正（needsPost 之后统一应用，始终处理）──────────────────
    const br = parseFloat(colorAdjust.brightness || 0);
    const ct = parseFloat(colorAdjust.contrast || 0);
    const sat = parseFloat(colorAdjust.saturation || 0);
    const hue = parseFloat(colorAdjust.hue || 0);
    const sharp = parseFloat(colorAdjust.sharpness || 0);
    if (br !== 0 || ct !== 0 || sat !== 0) {
      filterComplex += `;${finalVideoLabel}eq=brightness=${br}:contrast=${(1 + ct).toFixed(3)}:saturation=${(1 + sat).toFixed(3)}[vcol]`;
      finalVideoLabel = "[vcol]";
    }
    if (hue !== 0) {
      filterComplex += `;${finalVideoLabel}hue=h=${hue}[vhue]`;
      finalVideoLabel = "[vhue]";
    }
    if (sharp > 0) {
      filterComplex += `;${finalVideoLabel}unsharp=5:5:${(sharp * 1.5).toFixed(2)}:5:5:0[vsharp]`;
      finalVideoLabel = "[vsharp]";
    }
    if (activeFilter === "bw") {
      filterComplex += `;${finalVideoLabel}hue=s=0[vfilt]`;
      finalVideoLabel = "[vfilt]";
    } else if (activeFilter === "vintage") {
      filterComplex += `;${finalVideoLabel}curves=preset=vintage[vfilt]`;
      finalVideoLabel = "[vfilt]";
    } else if (activeFilter === "cool") {
      filterComplex += `;${finalVideoLabel}colorbalance=bs=0.08:bm=0.08:bh=0.08:rs=-0.06:rm=-0.06:rh=-0.06[vfilt]`;
      finalVideoLabel = "[vfilt]";
    } else if (activeFilter === "warm") {
      filterComplex += `;${finalVideoLabel}colorbalance=rs=0.08:rm=0.08:rh=0.08:bs=-0.06:bm=-0.06:bh=-0.06[vfilt]`;
      finalVideoLabel = "[vfilt]";
    } else if (activeFilter === "vivid") {
      filterComplex += `;${finalVideoLabel}eq=saturation=1.6:contrast=1.1[vfilt]`;
      finalVideoLabel = "[vfilt]";
    } else if (activeFilter === "cinematic") {
      filterComplex += `;${finalVideoLabel}eq=saturation=0.85:contrast=1.15:brightness=-0.03[vfilt]`;
      finalVideoLabel = "[vfilt]";
    }

    // ── 画幅/比例（黑边 padding）────────────────────────────────────
    let padW = 0, padH = 0;
    if (exportFormat === "16:9") { padW = 1920; padH = 1080; }
    else if (exportFormat === "9:16") { padW = 1080; padH = 1920; }
    else if (exportFormat === "1:1") { padW = 1080; padH = 1080; }
    else if (exportFormat === "4:3") { padW = 1440; padH = 1080; }
    if (padW > 0) {
      console.log(`[export:${requestId}] aspect ratio: ${exportFormat} → ${padW}x${padH}`);
      filterComplex += `;${finalVideoLabel}scale=${padW}:${padH}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${padW}:${padH}:(ow-iw)/2:(oh-ih)/2:color=black[vpad]`;
      finalVideoLabel = "[vpad]";
    }

    // 3. 执行 FFmpeg (使用 Mac 硬件加速编码器 h264_videotoolbox)
    // 文字 PNG 作为额外输入（-loop 1 + -t 限制时长，防止无限循环卡住）
    const totalDur = String(Math.ceil(timeline.totalTimelineDuration || 60) + 1);
    const extraInputs = [];
    textPngPaths.forEach(p => {
      extraInputs.push("-loop", "1", "-t", totalDur, "-i", p);
    });
    // BGM 作为额外音频输入（stream_loop 无限循环，-t 裁剪到视频时长）
    if (bgmPath) {
      extraInputs.push("-stream_loop", "-1", "-t", totalDur, "-i", bgmPath);
    }

    const totalDurLimit = String(timeline.totalTimelineDuration || 60);
    const args = [
      "-y",
      "-progress", "pipe:1",  // 进度输出到 stdout
      "-i", tempInputPath,
      ...extraInputs,
      "-filter_complex", filterComplex,
      "-map", finalVideoLabel,
      "-map", finalAudioLabel,
      "-c:v", "h264_videotoolbox",
      "-b:v", "4000k",
      "-c:a", "aac",
      "-b:a", "128k",
      ...((textPngPaths.length > 0 || bgmPath || padW > 0) ? ["-t", totalDurLimit] : []),
      tempOutputPath
    ];

    console.log(`[export:${requestId}] FFmpeg command: ffmpeg ${args.join(" ")}`);
    emitProgress(5, "开始渲染...");

    const ffmpegProc = spawn("ffmpeg", args);
    const totalSec = parseFloat(timeline.totalTimelineDuration) || 60;

    // 解析 stdout 的 -progress 输出获取进度
    let stdoutBuf = "";
    ffmpegProc.stdout.on("data", (data) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m) {
          const sec = parseInt(m[1]) / 1e6;
          const pct = Math.max(5, Math.min(98, Math.round((sec / totalSec) * 100)));
          emitProgress(pct, `渲染中 ${pct}%...`);
        }
      }
    });

    ffmpegProc.on("close", (code) => {
      const extras = [...textPngPaths, ...(bgmPath ? [bgmPath] : [])];
      if (code === 0) {
        console.log(`[export:${requestId}] Render success`);
        const fileId = `${requestId}-dl`;
        const filename = `${(videoFile.originalname || "output").split(".")[0]}_edited.mp4`;
        exportFileMap.set(fileId, { path: tempOutputPath, filename, createdAt: Date.now() });
        cleanup(tempInputPath, null, extras); // 不删 output，等前端来取
        emitDone(fileId);
      } else {
        console.error(`[export:${requestId}] Render failed code=${code}`);
        cleanup(tempInputPath, tempOutputPath, extras);
        emitExportError(`渲染失败 (code=${code})`);
      }
    });

  } catch (error) {
    console.error(`[export:${requestId}] Error:`, error);
    const extras = [...(bgmPath ? [bgmPath] : [])];
    cleanup(tempInputPath, tempOutputPath, extras);
    emitExportError(error.message || "export_internal_error");
  }
});

const cleanup = (input, output, extras = []) => {
  try {
    if (input && fs.existsSync(input)) fs.unlinkSync(input);
    if (output && fs.existsSync(output)) fs.unlinkSync(output);
    extras.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
  } catch (e) {
    console.error("Cleanup error:", e);
  }
};

// ── 会话管理 API ──────────────────────────────────────────────────
app.get("/api/session/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "session_not_found" });
  }
  res.json({
    sessionId: session.sessionId,
    videoInfo: session.videoInfo,
    features: session.analysisResult.features,
    conversationHistory: session.conversationHistory,
  });
});

app.delete("/api/session/:sessionId", (req, res) => {
  const deleted = deleteSession(req.params.sessionId);
  res.json({ success: deleted });
});

app.get("/api/sessions", (req, res) => {
  res.json(getSessionStats());
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`video-ai server listening on ${port}`);
});
