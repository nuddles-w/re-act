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

  console.log(`[compressVideo] Starting compression:`);
  console.log(`  Input: ${inputPath}`);
  console.log(`  Output: ${outputPath}`);
  console.log(`  Resolution: ${maxWidth}x${maxHeight}`);
  console.log(`  FPS: ${fps}`);
  console.log(`  Audio bitrate: ${audioBitrate}`);
  console.log(`  Input size: ${(inputSize / 1024 / 1024).toFixed(2)} MB`);

  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", inputPath,
      "-vf", `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
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

    console.log(`[compressVideo] FFmpeg command: ffmpeg ${args.join(' ')}`);

    const proc = spawn("ffmpeg", args);
    let stderrOutput = '';
    proc.stderr.on("data", (data) => {
      stderrOutput += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[compressVideo] FFmpeg failed with code ${code}`);
        console.error(`[compressVideo] stderr:`, stderrOutput);
        reject(new Error(`FFmpeg compress exited with code ${code}`));
        return;
      }
      const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      const ratio = ((1 - outputSize / inputSize) * 100).toFixed(0);
      console.log(`[compressVideo] Success: ${(outputSize / 1024 / 1024).toFixed(2)} MB (-${ratio}%), took ${Date.now() - t0}ms`);
      resolve({ inputSize, outputSize, durationMs: Date.now() - t0 });
    });
  });
}
