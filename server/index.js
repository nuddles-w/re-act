import "dotenv/config";
import express from "express";
import multer from "multer";
import { analyzeVideoWithGemini } from "./providers/geminiProvider.js";
import { analyzeWithMock } from "./providers/mockProvider.js";

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
    const provider = resolveProvider();
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

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`video-ai server listening on ${port}`);
});
