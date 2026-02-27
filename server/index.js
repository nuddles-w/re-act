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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
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
  if (!videoFile) return res.status(400).json({ error: "missing_video" });

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

    emitResult({
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
  }
});

app.post("/api/export", upload.single("video"), async (req, res) => {
  const requestId = `export-${Date.now()}`;
  let tempInputPath = null;
  let tempOutputPath = null;

  try {
    const videoFile = req.file;
    if (!videoFile) {
      return res.status(400).json({ error: "missing_video" });
    }

    const timeline = JSON.parse(req.body.timeline || "{}");
    if (!timeline.clips || timeline.clips.length === 0) {
      return res.status(400).json({ error: "invalid_timeline" });
    }

    // 1. 准备临时文件
    tempInputPath = path.join(os.tmpdir(), `${requestId}-input.mp4`);
    tempOutputPath = path.join(os.tmpdir(), `${requestId}-output.mp4`);
    fs.writeFileSync(tempInputPath, videoFile.buffer);

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

    // 判断是否需要后处理（文字叠加 / 淡入淡出）
    const textEdits = Array.isArray(timeline.textEdits) ? timeline.textEdits.filter(e => e.text) : [];
    const fadeEdits = Array.isArray(timeline.fadeEdits) ? timeline.fadeEdits : [];
    const needsPost = textEdits.length > 0 || fadeEdits.length > 0;

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

        finalAudioLabel = finalAudioLabel; // 音频不变
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

    // 3. 执行 FFmpeg (使用 Mac 硬件加速编码器 h264_videotoolbox)
    // 文字 PNG 作为额外输入（-loop 1 + -t 限制时长，防止无限循环卡住）
    const totalDur = String(Math.ceil(timeline.totalTimelineDuration || 60) + 1);
    const extraInputs = [];
    textPngPaths.forEach(p => {
      extraInputs.push("-loop", "1", "-t", totalDur, "-i", p);
    });

    const args = [
      "-y",
      "-i", tempInputPath,
      ...extraInputs,
      "-filter_complex", filterComplex,
      "-map", finalVideoLabel,
      "-map", finalAudioLabel,
      "-c:v", "h264_videotoolbox", // 关键：使用 Mac 硬件加速
      "-b:v", "4000k",             // 码率
      "-c:a", "aac",
      "-b:a", "128k",
      // 若有文字叠加，需显式限制输出时长（PNG loop 会延长输出）
      ...(textPngPaths.length > 0 ? ["-t", String(timeline.totalTimelineDuration)] : []),
      tempOutputPath
    ];

    console.log(`[export:${requestId}] FFmpeg command: ffmpeg ${args.join(" ")}`);

    const ffmpeg = spawn("ffmpeg", args);

    ffmpeg.stderr.on("data", (data) => {
      // ffmpeg 输出日志到 stderr
      // console.log(`[export:ffmpeg:stderr] ${data}`);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log(`[export:${requestId}] Render success`);
        res.download(tempOutputPath, `${videoFile.originalname.split('.')[0]}_edited.mp4`, () => {
          cleanup(tempInputPath, tempOutputPath, textPngPaths);
        });
      } else {
        console.error(`[export:${requestId}] Render failed with code ${code}`);
        res.status(500).json({ error: "render_failed", code });
        cleanup(tempInputPath, tempOutputPath, textPngPaths);
      }
    });

  } catch (error) {
    console.error(`[export:${requestId}] Error:`, error);
    res.status(500).json({ error: "export_internal_error", message: error.message });
    cleanup(tempInputPath, tempOutputPath, textPngPaths);
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

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`video-ai server listening on ${port}`);
});
