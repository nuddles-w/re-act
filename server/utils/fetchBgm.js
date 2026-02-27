import fs from "fs";
import path from "path";
import os from "os";

/**
 * 根据关键词从 Jamendo 搜索背景音乐并下载到临时文件。
 * 需要在 .env 中配置 JAMENDO_CLIENT_ID（免费注册：https://devportal.jamendo.com）
 *
 * @param {string} keywords  - 情绪/风格关键词，如 "happy upbeat" / "calm piano"
 * @param {string} requestId - 用于临时文件命名
 * @returns {{ path: string, title: string, artist: string, duration: number }}
 */
export async function searchAndDownloadBgm(keywords, requestId) {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) throw new Error("Missing JAMENDO_CLIENT_ID in .env");

  // 把关键词转为 fuzzytags 格式（空格换成 +）
  const tags = keywords.trim().replace(/\s+/g, "+");

  // 先用 fuzzytags 搜索（按标签匹配），没结果再用 namesearch 兜底
  let track = await searchJamendo(clientId, { fuzzytags: tags, limit: 10 });
  if (!track) {
    track = await searchJamendo(clientId, { namesearch: keywords, limit: 10 });
  }
  if (!track) throw new Error(`No BGM found for keywords: "${keywords}"`);

  // 下载 mp3 到临时文件
  const outPath = path.join(os.tmpdir(), `${requestId}-bgm.mp3`);
  await downloadFile(track.audio, outPath);

  return {
    path: outPath,
    title: track.name,
    artist: track.artist_name,
    duration: Number(track.duration) || 0,
  };
}

async function searchJamendo(clientId, extraParams) {
  const params = new URLSearchParams({
    client_id: clientId,
    format: "json",
    limit: String(extraParams.limit || 10),
    audioformat: "mp32",
    order: "popularity_total",
    ...extraParams,
  });
  delete params.limit; // already set above

  const url = `https://api.jamendo.com/v3.0/tracks/?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Jamendo API error: ${resp.status}`);

  const data = await resp.json();
  if (!Array.isArray(data.results) || data.results.length === 0) return null;

  // 从前几条结果里随机选一首，增加多样性
  const pool = data.results.slice(0, 5);
  return pool[Math.floor(Math.random() * pool.length)];
}

async function downloadFile(url, destPath) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`Failed to download BGM: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}
