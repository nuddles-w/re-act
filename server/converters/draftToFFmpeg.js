/**
 * Draft 转换为 FFmpeg 命令
 *
 * 将 Draft 多轨道结构转换为 FFmpeg filter_complex
 */

/**
 * 主函数：Draft → FFmpeg 命令
 * @param {object} draft
 * @param {string} inputPath - 输入视频路径
 * @param {string} outputPath - 输出视频路径
 * @param {object} options - { colorAdjust, activeFilter, exportFormat }
 * @returns {object} { args, textPngPaths, bgmPath }
 */
export function draftToFFmpegCommand(draft, inputPath, outputPath, options = {}) {
  const { colorAdjust = {}, activeFilter = "none", exportFormat = "original" } = options;

  if (!draft || !draft.tracks || draft.tracks.length === 0) {
    throw new Error("Invalid draft: no tracks");
  }

  const videoTrack = draft.tracks.find(t => t.type === "video");
  if (!videoTrack || videoTrack.segments.length === 0) {
    throw new Error("Invalid draft: no video segments");
  }

  const textTrack = draft.tracks.find(t => t.type === "text");
  const effectTrack = draft.tracks.find(t => t.type === "effect");
  const audioTrack = draft.tracks.find(t => t.type === "audio");

  let filterComplex = "";
  let concatInputs = "";
  const textPngPaths = [];
  let bgmPath = null;

  // ── 1. 处理视频轨道（分段 + 变速 + concat）──────────────────────
  videoTrack.segments.forEach((seg, i) => {
    const rate = seg.playbackRate || 1.0;
    const vpts = (1 / rate).toFixed(4);

    // 视频：trim -> setpts (重置时间戳) -> setpts (变速)
    filterComplex += `[0:v]trim=start=${seg.sourceStart}:end=${seg.sourceEnd},setpts=PTS-STARTPTS,setpts=${vpts}*PTS[v${i}];`;

    // 音频：atrim -> asetpts -> atempo
    let atempoFilter = buildAtempoFilter(rate);
    filterComplex += `[0:a]atrim=start=${seg.sourceStart}:end=${seg.sourceEnd},asetpts=PTS-STARTPTS,${atempoFilter}[a${i}];`;

    concatInputs += `[v${i}][a${i}]`;
  });

  // ── 2. Concat 视频片段 ──────────────────────────────────────────
  const needsPost = (textTrack?.segments.length > 0) || (effectTrack?.segments.length > 0) || (audioTrack?.segments.length > 0);
  const concatVLabel = needsPost ? "[concatv]" : "[outv]";
  const concatALabel = needsPost ? "[concata]" : "[outa]";

  filterComplex += `${concatInputs}concat=n=${videoTrack.segments.length}:v=1:a=1${concatVLabel}${concatALabel}`;

  if (!needsPost) {
    // 没有后处理，直接输出
    return {
      args: buildFFmpegArgs(inputPath, outputPath, filterComplex, [], null, colorAdjust, activeFilter, exportFormat),
      textPngPaths: [],
      bgmPath: null,
    };
  }

  // ── 3. 后处理：文字/效果/BGM ────────────────────────────────────
  let finalVideoLabel = concatVLabel;
  let finalAudioLabel = concatALabel;

  // 3.1 淡入淡出效果
  if (effectTrack && effectTrack.segments.length > 0) {
    const fadeSegments = effectTrack.segments.filter(s => s.effectType === "fade");
    fadeSegments.forEach((fade, i) => {
      const st = fade.timelineStart.toFixed(3);
      const dur = fade.timelineDuration.toFixed(3);
      const nv = `[vfade${i}]`;
      const na = `[afade${i}]`;

      filterComplex += `;${finalVideoLabel}fade=t=${fade.direction}:st=${st}:d=${dur}${nv}`;
      filterComplex += `;${finalAudioLabel}afade=t=${fade.direction}:st=${st}:d=${dur}${na}`;

      finalVideoLabel = nv;
      finalAudioLabel = na;
    });
  }

  // 3.2 文字叠加（需要生成 PNG，这里返回文字信息，由调用方生成）
  const textSegments = textTrack?.segments || [];

  // 3.3 背景音乐（需要下载，这里返回关键词，由调用方处理）
  const bgmSegments = audioTrack?.segments.filter(s => s.type === "bgm") || [];

  return {
    filterComplex,
    finalVideoLabel,
    finalAudioLabel,
    textSegments,
    bgmSegments,
    videoTrack,
    needsTextOverlay: textSegments.length > 0,
    needsBgm: bgmSegments.length > 0,
  };
}

/**
 * 构建 atempo 滤镜（处理 >2x 或 <0.5x 的速度）
 */
function buildAtempoFilter(rate) {
  if (rate > 2.0) {
    let tempRate = rate;
    let filter = "";
    while (tempRate > 2.0) {
      filter += "atempo=2.0,";
      tempRate /= 2.0;
    }
    filter += `atempo=${tempRate.toFixed(4)}`;
    return filter;
  } else if (rate < 0.5) {
    let tempRate = rate;
    let filter = "";
    while (tempRate < 0.5) {
      filter += "atempo=0.5,";
      tempRate /= 0.5;
    }
    filter += `atempo=${tempRate.toFixed(4)}`;
    return filter;
  } else {
    return `atempo=${rate.toFixed(4)}`;
  }
}

/**
 * 添加文字叠加到 filter_complex
 */
export function addTextOverlayToFilter(filterComplex, finalVideoLabel, textSegments, textPngPaths, totalDuration) {
  let currentLabel = finalVideoLabel;

  textSegments.forEach((seg, i) => {
    const inputIdx = i + 1; // PNG 输入从 index 1 开始
    const st = seg.timelineStart.toFixed(3);
    const et = (seg.timelineStart + seg.timelineDuration).toFixed(3);
    const nextLabel = i === textSegments.length - 1 ? "[outv]" : `[vtxt${i}]`;

    filterComplex += `;[${inputIdx}:v]setpts=PTS-STARTPTS[txt${i}]`;
    filterComplex += `;${currentLabel}[txt${i}]overlay=0:0:enable='between(t,${st},${et})'${nextLabel}`;

    currentLabel = nextLabel;
  });

  return filterComplex;
}

/**
 * 添加背景音乐到 filter_complex
 */
export function addBgmToFilter(filterComplex, finalAudioLabel, bgmPath, totalDuration, volume = 0.3) {
  const bgmIdx = 1; // BGM 作为额外输入
  const fadeOutSt = Math.max(0, totalDuration - 2).toFixed(2);

  filterComplex += `;[${bgmIdx}:a]volume=${volume},afade=t=in:d=1:st=0,afade=t=out:st=${fadeOutSt}:d=2[bgmaudio]`;
  filterComplex += `;${finalAudioLabel}[bgmaudio]amix=inputs=2:duration=first[outa]`;

  return filterComplex;
}

/**
 * 构建完整的 FFmpeg 参数
 */
function buildFFmpegArgs(inputPath, outputPath, filterComplex, textPngPaths, bgmPath, colorAdjust, activeFilter, exportFormat) {
  const args = ["-y", "-i", inputPath];

  // 添加文字 PNG 输入
  textPngPaths.forEach(pngPath => {
    args.push("-loop", "1", "-i", pngPath);
  });

  // 添加 BGM 输入
  if (bgmPath) {
    args.push("-i", bgmPath);
  }

  // filter_complex
  args.push("-filter_complex", filterComplex);

  // 映射输出
  args.push("-map", "[outv]", "-map", "[outa]");

  // 编码设置
  args.push(
    "-c:v", "h264_videotoolbox",
    "-b:v", "5M",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart"
  );

  // 输出路径
  args.push(outputPath);

  return args;
}
;

  return args;
}
