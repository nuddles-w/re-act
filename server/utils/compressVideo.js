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
export function compressVideoForUpload(inputPath, outputPath) {
  const t0 = Date.now();
  const inputSize = fs.statSync(inputPath).size;

  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", inputPath,
      // 按比例缩小到 720p 以内，不放大小视频
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease",
      "-r", "2",               // 2fps，AI 理解足够
      "-c:v", "h264",
      "-preset", "ultrafast",  // 最快压缩速度
      "-crf", "28",            // 允许质量损失，换取文件更小
      "-c:a", "aac",
      "-b:a", "64k",
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
