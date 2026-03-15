import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * 视频缓存管理器
 * 缓存 Gemini 上传后的 fileUri，避免重复上传和处理
 * 持久化到文件系统，服务重启后仍然有效
 */

const CACHE_FILE = path.join(os.tmpdir(), 'video-cache.json');
const CACHE_TTL = 48 * 3600 * 1000; // 48 小时（Gemini 文件过期时间）

// 从文件加载缓存
let cache = new Map();
try {
  if (fs.existsSync(CACHE_FILE)) {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    cache = new Map(Object.entries(data));
    console.log(`[cache] loaded ${cache.size} entries from disk`);
  }
} catch (e) {
  console.warn('[cache] failed to load from disk:', e.message);
}

/**
 * 保存缓存到文件
 */
function saveCacheToDisk() {
  try {
    const data = Object.fromEntries(cache.entries());
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[cache] failed to save to disk:', e.message);
  }
}

/**
 * 计算视频文件的 hash
 */
export function computeVideoHash(videoPath) {
  const buffer = fs.readFileSync(videoPath);
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * 获取缓存的 Gemini 文件信息
 * @returns {{ fileUri, mimeType, fileMetadata, fileManager, uploadTime } | null}
 */
export function getCachedFile(videoHash) {
  const cached = cache.get(videoHash);
  if (!cached) return null;

  // 检查是否过期
  const age = Date.now() - cached.uploadTime;
  if (age >= CACHE_TTL) {
    cache.delete(videoHash);
    console.log(`[cache] expired: ${videoHash} (age: ${(age / 3600000).toFixed(1)}h)`);
    return null;
  }

  console.log(`[cache] hit: ${videoHash} (age: ${(age / 3600000).toFixed(1)}h)`);
  return cached;
}

/**
 * 缓存 Gemini 文件信息
 */
export function setCachedFile(videoHash, fileInfo) {
  cache.set(videoHash, {
    ...fileInfo,
    uploadTime: Date.now(),
  });
  console.log(`[cache] set: ${videoHash} (total: ${cache.size})`);
  saveCacheToDisk();
}

/**
 * 清理过期缓存（定期调用）
 */
export function cleanExpiredCache() {
  const now = Date.now();
  let cleaned = 0;
  for (const [hash, info] of cache.entries()) {
    if (now - info.uploadTime >= CACHE_TTL) {
      cache.delete(hash);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[cache] cleaned ${cleaned} expired entries`);
    saveCacheToDisk();
  }
  return cleaned;
}

/**
 * 清空所有缓存
 */
export function clearCache() {
  const size = cache.size;
  cache.clear();
  console.log(`[cache] cleared all ${size} entries`);
  saveCacheToDisk();
  return size;
}

/**
 * 获取缓存统计
 */
export function getCacheStats() {
  return {
    size: cache.size,
    entries: Array.from(cache.entries()).map(([hash, info]) => ({
      hash: hash.slice(0, 8),
      age: ((Date.now() - info.uploadTime) / 3600000).toFixed(1) + 'h',
      fileUri: info.fileUri,
    })),
  };
}
