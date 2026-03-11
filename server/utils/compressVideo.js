import { spawn } from "child_process";
import fs from "fs";

/**
 * 用 FFmpeg 把视频压缩为适合 AI 理解的小尺寸 mp4：
 *   - 分辨率限制在 720p 以内（保持宽高比，不放大）
 *   - 帧率降到 2fps（内容理解足够，文件大幅缩小）
 *   - ultrafast 预设降低压缩耗时
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<{ inputSize: number, outputSize: number, durationMs: number }>}
 */
export function compressVideoForUpload(inputPath, outputPath, options = {}) {
  const t0 = Date.now();
  const inputSize = fs.statSync(inputPath).size;
  const maxWidth = options.maxWidth || 1280;
  const maxHeight = options.maxHeight || 720;
  const fps = options.fps || 2;
  const audioBitrate = options.audioBitrate || "64k";

  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", inputPath,
      "-vf", `scale=${maxWidth}:${maxHeight}:force_original_aspect_ratio=decrease`,
      "-r", String(fps),
      "-c:v", "h264",
      "-pix_fmt", "yuv420p",
      "-preset", "ultrafast",
      "-crf", "28",
      "-c:a", "aac",
      "-b:a", audioBitrate,
      "-movflags", "+faststart",
      outputPath,
    ];

    const proc = spawn("ffmpeg", args);
    proc.stderr.on("data", () => {}); // suppress ffmpeg stderr

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg compress exited with code ${code}`));
        return;
      }
      const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      resolve({ inputSize, outputSize, durationMs: Date.now() - t0 });
    });
  });
}
