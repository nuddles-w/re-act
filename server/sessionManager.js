/**
 * 会话管理器 - 缓存视频分析结果，支持连续对话式编辑
 *
 * 核心功能：
 * 1. 为每个视频创建唯一会话（sessionId）
 * 2. 缓存视频分析结果（features、segments、events 等）
 * 3. 存储对话历史（用户请求 + AI 响应）
 * 4. 自动清理过期会话（默认 30 分钟）
 */

const sessions = new Map();

// 会话过期时间（毫秒）
const SESSION_TTL = 30 * 60 * 1000; // 30 分钟

/**
 * 创建新会话
 * @param {Object} videoInfo - 视频信息 { name, size, duration, path }
 * @param {Object} analysisResult - 分析结果 { features, source, summary }
 * @returns {string} sessionId
 */
export function createSession(videoInfo, analysisResult) {
  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  sessions.set(sessionId, {
    sessionId,
    videoInfo,
    analysisResult,
    conversationHistory: [],
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  });

  console.log(`[session:${sessionId}] created for video: ${videoInfo.name}`);
  return sessionId;
}

/**
 * 获取会话
 * @param {string} sessionId
 * @returns {Object|null}
 */
export function getSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) {
    return null;
  }

  const session = sessions.get(sessionId);

  // 检查是否过期
  if (Date.now() - session.lastAccessedAt > SESSION_TTL) {
    sessions.delete(sessionId);
    console.log(`[session:${sessionId}] expired and removed`);
    return null;
  }

  // 更新最后访问时间
  session.lastAccessedAt = Date.now();
  return session;
}

/**
 * 更新会话的分析结果（用于增量编辑）
 * @param {string} sessionId
 * @param {Object} newFeatures - 新的 features 对象
 */
export function updateSessionFeatures(sessionId, newFeatures) {
  const session = getSession(sessionId);
  if (!session) return false;

  session.analysisResult.features = {
    ...session.analysisResult.features,
    ...newFeatures,
  };

  console.log(`[session:${sessionId}] features updated`);
  return true;
}

/**
 * 添加对话记录
 * @param {string} sessionId
 * @param {Object} message - { role: 'user'|'assistant', content: string, timestamp: number }
 */
export function addConversation(sessionId, message) {
  const session = getSession(sessionId);
  if (!session) return false;

  session.conversationHistory.push({
    ...message,
    timestamp: Date.now(),
  });

  console.log(`[session:${sessionId}] conversation added (${message.role})`);
  return true;
}

/**
 * 获取对话历史
 * @param {string} sessionId
 * @param {number} limit - 最多返回多少条（默认全部）
 * @returns {Array}
 */
export function getConversationHistory(sessionId, limit = 0) {
  const session = getSession(sessionId);
  if (!session) return [];

  const history = session.conversationHistory;
  return limit > 0 ? history.slice(-limit) : history;
}

/**
 * 删除会话
 * @param {string} sessionId
 */
export function deleteSession(sessionId) {
  if (sessions.has(sessionId)) {
    sessions.delete(sessionId);
    console.log(`[session:${sessionId}] deleted`);
    return true;
  }
  return false;
}

/**
 * 清理所有过期会话（定时任务）
 */
export function cleanupExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccessedAt > SESSION_TTL) {
      sessions.delete(sessionId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[session-cleanup] removed ${cleaned} expired sessions`);
  }

  return cleaned;
}

/**
 * 获取会话统计信息
 */
export function getSessionStats() {
  return {
    totalSessions: sessions.size,
    sessions: Array.from(sessions.values()).map(s => ({
      sessionId: s.sessionId,
      videoName: s.videoInfo.name,
      createdAt: new Date(s.createdAt).toISOString(),
      lastAccessedAt: new Date(s.lastAccessedAt).toISOString(),
      conversationCount: s.conversationHistory.length,
    })),
  };
}

// 启动定时清理任务（每 5 分钟）
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
