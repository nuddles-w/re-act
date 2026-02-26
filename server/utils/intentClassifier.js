/**
 * 判断用户请求是否需要理解视频内容（上传视频给 AI 分析）。
 * 返回 true  → 需要视频内容理解（AI 需要看到视频画面）
 * 返回 false → 纯文本编辑（添加字幕、淡入淡出、指定时间操作等），无需上传视频
 */

// 强烈暗示需要分析视频内容的关键词
const VIDEO_ANALYSIS_PATTERNS = [
  // 中文 - 内容理解类
  /识别/, /检测/, /找到/, /找出/, /定位/, /分析视频/, /视频内容/,
  /精彩/, /高光/, /无聊/, /重要时刻/, /关键帧/,
  /场景/, /镜头切换/, /人物动作/, /这段/, /那段/,
  /什么时候/, /哪个时间/, /发生.*时/, /.*的片段/,
  // 英文 - 内容理解类
  /\bfind\b/i, /\bdetect\b/i, /\bidentify\b/i, /\blocate\b/i,
  /\banalyze\b/i, /\bscene\b/i, /\bhighlight\b/i,
  /\bboring\b/i, /\bexciting\b/i, /\bwhen does\b/i, /\bwhat happens\b/i,
];

// 明确是结构性编辑（无需看视频内容）的关键词
const TEXT_ONLY_PATTERNS = [
  // 中文 - 文字/时间类操作
  /添加.*文字/, /加.*文字/, /写.*文字/, /加.*字幕/, /添加字幕/, /加字幕/,
  /添加.*标题/, /加.*标题/, /加.*文本/,
  /淡入/, /淡出/,
  /开头加/, /结尾加/, /片头/, /片尾/,
  /整个视频/, /全程/,
  // 英文 - 文字/时间类操作
  /add.*(text|title|subtitle|caption)/i,
  /fade.*(in|out)/i,
  /\boverlay\b/i,
];

/**
 * @param {string} request - 用户的自然语言请求
 * @returns {boolean} - 是否需要上传视频进行内容理解
 */
export function needsVideoAnalysis(request) {
  if (!request || !request.trim()) return false;

  const hasVideoKeyword = VIDEO_ANALYSIS_PATTERNS.some((p) => p.test(request));
  const isTextOnly = TEXT_ONLY_PATTERNS.some((p) => p.test(request));

  // 如果明确需要视频理解 → 需要上传
  if (hasVideoKeyword) return true;

  // 如果明确是文字/结构编辑 → 不需要上传
  if (isTextOnly) return false;

  // 默认：上传视频（保守策略，确保结果质量）
  return true;
}
