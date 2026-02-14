import "dotenv/config";
import express from "express";
import multer from "multer";
import { analyzeVideoWithGemini } from "./providers/geminiProvider.js";
import { analyzeWithMockAgent } from "./providers/mockAgentProvider.js";
import { analyzeWithMock } from "./providers/mockProvider.js";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

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

const resolveProvider = () => {
  if (process.env.GEMINI_API_KEY) {
    return analyzeVideoWithGemini;
  }
  console.warn("[analyze] GEMINI_API_KEY missing, fallback to mock");
  return analyzeWithMock;
};

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/analyze", upload.single("video"), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const videoFile = req.file;
    if (!videoFile) {
      res.status(400).json({ error: "missing_video" });
      return;
    }

    const duration = Number(req.body.duration || 0);
    const isMock = req.body.isMock === 'true';
    
    let provider = resolveProvider();
    if (isMock) {
      provider = analyzeWithMockAgent;
    }

    let intent = null;
    if (req.body.intent) {
      try {
        intent = JSON.parse(req.body.intent);
      } catch (error) {
        intent = null;
      }
    }

    const pe = req.body.pe || "";
    const request = req.body.request || "";
    const prompt = req.body.prompt || "";
    const debugTimeline = [
      {
        time: new Date().toISOString(),
        role: "system",
        level: "info",
        message: "收到识别请求",
        data: {
          name: videoFile.originalname,
          size: videoFile.size,
          duration,
          pe,
          request,
        },
      },
    ];
    console.log(
      `[analyze:${requestId}] start`,
      JSON.stringify(
        {
          name: videoFile.originalname,
          size: videoFile.size,
          duration,
          pe,
          request,
        },
        null,
        2
      )
    );

    const result = await provider({
      video: {
        name: videoFile.originalname,
        size: videoFile.size,
        mimeType: videoFile.mimetype,
        buffer: videoFile.buffer,
      },
      duration,
      intent,
      prompt,
      request,
      pe,
    });
    if (Array.isArray(result.debugTimeline)) {
      debugTimeline.push(...result.debugTimeline);
    }
    debugTimeline.push({
      time: new Date().toISOString(),
      role: "system",
      level: "info",
      message: "识别完成",
      data: {
        source: result.source,
        segmentCount: result.features?.segmentCount,
        events: result.features?.events?.length || 0,
        edits: result.features?.edits?.length || 0,
      },
    });

    console.log(
      `[analyze:${requestId}] done`,
      JSON.stringify(
        {
          source: result.source,
          segmentCount: result.features?.segmentCount,
          events: result.features?.events?.length || 0,
          edits: result.features?.edits?.length || 0,
        },
        null,
        2
      )
    );

    res.json({
      source: result.source,
      features: result.features,
      summary: result.summary,
      rawResponse: result.rawResponse,
      debug: {
        requestId,
        pe,
        request,
        prompt,
      },
      debugTimeline,
    });
  } catch (error) {
    console.error(
      `[analyze:${requestId}] error`,
      JSON.stringify({ message: String(error) }, null, 2)
    );
    res.status(500).json({
      error: "analysis_failed",
      debug: { requestId, message: String(error) },
      debugTimeline: [
        {
          time: new Date().toISOString(),
          role: "system",
          level: "error",
          message: "识别异常",
          data: { requestId, error: String(error) },
        },
      ],
    });
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
    // 目标：为每个片段生成独立的 v/a 链，然后 concat
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

    filterComplex += `${concatInputs}concat=n=${timeline.clips.length}:v=1:a=1[outv][outa]`;

    // 3. 执行 FFmpeg (使用 Mac 硬件加速编码器 h264_videotoolbox)
    const args = [
      "-y",
      "-i", tempInputPath,
      "-filter_complex", filterComplex,
      "-map", "[outv]",
      "-map", "[outa]",
      "-c:v", "h264_videotoolbox", // 关键：使用 Mac 硬件加速
      "-b:v", "4000k",             // 码率
      "-c:a", "aac",
      "-b:a", "128k",
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
          // 下载完成后清理
          cleanup(tempInputPath, tempOutputPath);
        });
      } else {
        console.error(`[export:${requestId}] Render failed with code ${code}`);
        res.status(500).json({ error: "render_failed", code });
        cleanup(tempInputPath, tempOutputPath);
      }
    });

  } catch (error) {
    console.error(`[export:${requestId}] Error:`, error);
    res.status(500).json({ error: "export_internal_error", message: error.message });
    cleanup(tempInputPath, tempOutputPath);
  }
});

const cleanup = (input, output) => {
  try {
    if (input && fs.existsSync(input)) fs.unlinkSync(input);
    if (output && fs.existsSync(output)) fs.unlinkSync(output);
  } catch (e) {
    console.error("Cleanup error:", e);
  }
};

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`video-ai server listening on ${port}`);
});
