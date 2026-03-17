import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultIntent } from "./domain/models.js";
import { extractFeaturesFromVideo } from "./domain/featureExtractor.js";

const formatTime = (value) => {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export default function App() {
  const videoRef = useRef(null);
  const audioRef = useRef(null); // 新增：音频播放器引用
  const endTimeRef = useRef(null);
  const chatEndRef = useRef(null);
  const [file, setFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const [features, setFeatures] = useState(null);
  const [intent, setIntent] = useState(defaultIntent);
  const [draft, setDraft] = useState(null); // Draft 是唯一数据源
  const [bgmUrl, setBgmUrl] = useState(null); // 新增：BGM 文件 URL
  const [bgmVolume, setBgmVolume] = useState(0.3);
  const [activeClipId, setActiveClipId] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState("idle");
  const [analysisSource, setAnalysisSource] = useState("local");
  const [userRequest, setUserRequest] = useState("");
  const [pe, setPe] = useState("短视频剪辑产品经理（PE）");
  const [chatMessages, setChatMessages] = useState([]);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMock, setIsMock] = useState(false);
  const [engine, setEngine] = useState(import.meta.env.VITE_AI_ENGINE || "auto");
  const [isExporting, setIsExporting] = useState(false);
  const [prepareId, setPrepareId] = useState(null);
  const [prepareStatus, setPrepareStatus] = useState("idle"); // idle | preparing | ready | error
  const [manualEdits, setManualEdits] = useState([]);
  const [activeClipState, setActiveClipState] = useState(null);
  const [fadeOpacity, setFadeOpacity] = useState(1);
  const [sessionId, setSessionId] = useState(null); // 会话 ID，用于记忆上下文
  const playheadTimeRef = useRef(0);
  const playheadRafRef = useRef(null);
  const latestTimeRef = useRef(0);
  const [tooltip, setTooltip] = useState({ visible: false, text: "", x: 0, y: 0 });
  const tooltipRafRef = useRef(null);
  const tooltipTargetRef = useRef(null);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const activeClipRef = useRef(null);
  const fadeOpacityRef = useRef(1);
  const isDraggingRef = useRef(false);
  const scrubMovedRef = useRef(false);   // 区分 drag vs click
  const scrubStartXRef = useRef(0);      // mousedown 起始 X
  const handleTimelineScrubRef = useRef(null);
  const timelineRef = useRef(null);
  const previewContainerRef = useRef(null);
  const [videoArea, setVideoArea] = useState(null); // 视频在预览区的实际渲染位置和尺寸
  const [timelineScale, setTimelineScale] = useState(1);
  const [colorAdjust, setColorAdjust] = useState({ brightness: 0, contrast: 0, saturation: 0, hue: 0, sharpness: 0 });
  const [activeFilter, setActiveFilter] = useState("none");
  const [activeRightPanel, setActiveRightPanel] = useState(null); // 'adjust' | null
  const [exportFormat, setExportFormat] = useState("original"); // 'original' | '16:9' | '9:16' | '1:1'
  const [exportProgress, setExportProgress] = useState({ status: "idle", percent: 0, message: "" });
  const trimDragRef = useRef(null);

  // 计算视频在 preview-container 内的实际渲染区域（考虑 object-fit: contain 的留白）
  const updateVideoArea = useCallback(() => {
    const el = videoRef.current;
    const container = previewContainerRef.current;
    if (!el || !container || !el.videoWidth || !el.videoHeight) return;

    const elW = el.clientWidth;
    const elH = el.clientHeight;
    const vidW = el.videoWidth;
    const vidH = el.videoHeight;
    if (!elW || !elH) return;

    // 计算 object-fit: contain 后视频内容的实际尺寸
    const videoAspect = vidW / vidH;
    const elAspect = elW / elH;
    let renderedW, renderedH;
    if (videoAspect > elAspect) {
      renderedW = elW;
      renderedH = elW / videoAspect;
    } else {
      renderedH = elH;
      renderedW = elH * videoAspect;
    }

    // 视频元素相对于 preview-container 的偏移 + contain 留白偏移
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    setVideoArea({
      width: renderedW,
      height: renderedH,
      left: (elRect.left - containerRect.left) + (elW - renderedW) / 2,
      top: (elRect.top - containerRect.top) + (elH - renderedH) / 2,
    });
  }, []);
  const [thumbnails, setThumbnails] = useState([]);
  const [thumbnailStatus, setThumbnailStatus] = useState("idle");
  const apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";
  // 合并所有编辑（从 Draft 派生 + 手动编辑）
  const combinedEdits = useMemo(
    () => [...effectiveTextEdits, ...effectiveFadeEdits, ...manualEdits],
    [effectiveTextEdits, effectiveFadeEdits, manualEdits]
  );
  // 统一获取时长：优先 Draft，其次 Timeline，最后原始视频
  // 从 Draft 派生所有数据
  const effectiveDuration = useMemo(() => {
    return draft?.settings?.totalDuration || duration;
  }, [draft, duration]);

  // 统一获取视频片段：从 Draft 读取
  const effectiveClips = useMemo(() => {
    if (draft && draft.tracks) {
      const videoTrack = draft.tracks.find(t => t.type === "video");
      if (videoTrack && videoTrack.segments) {
        // 转换 Draft segment 为 clip 格式（兼容现有逻辑）
        const clips = videoTrack.segments.map(seg => ({
          id: seg.id,
          start: seg.sourceStart,
          end: seg.sourceEnd,
          timelineStart: seg.timelineStart,
          displayDuration: seg.timelineDuration,
          playbackRate: seg.playbackRate,
          volume: seg.volume,
          // Draft 特有字段
          sourceStart: seg.sourceStart,
          sourceEnd: seg.sourceEnd,
          timelineDuration: seg.timelineDuration,
        }));
        console.log('[effectiveClips] from Draft:', clips.length, 'clips');
        return clips;
      }
    }
    // 如果没有 Draft，返回完整视频作为单个 clip
    if (duration > 0) {
      console.log('[effectiveClips] fallback to full video');
      return [{
        id: "full-video",
        start: 0,
        end: duration,
        timelineStart: 0,
        displayDuration: duration,
        playbackRate: 1.0,
        volume: 1.0,
        sourceStart: 0,
        sourceEnd: duration,
        timelineDuration: duration,
      }];
    }
    return [];
  }, [draft, duration]);

  // 从 Draft 获取文字编辑
  const effectiveTextEdits = useMemo(() => {
    if (!draft || !draft.tracks) return [];
    const textTrack = draft.tracks.find(t => t.type === "text");
    if (!textTrack || !textTrack.segments) return [];

    return textTrack.segments.map(seg => ({
      type: "text",
      start: seg.timelineStart,
      end: seg.timelineStart + seg.timelineDuration,
      timelineStart: seg.timelineStart,
      timelineEnd: seg.timelineStart + seg.timelineDuration,
      text: seg.content,
      position: seg.style?.position || "bottom",
      style: seg.style,
    }));
  }, [draft]);

  // 从 Draft 获取淡入淡出效果
  const effectiveFadeEdits = useMemo(() => {
    if (!draft || !draft.tracks) return [];
    const effectTrack = draft.tracks.find(t => t.type === "effect");
    if (!effectTrack || !effectTrack.segments) return [];

    return effectTrack.segments
      .filter(seg => seg.effectType === "fade")
      .map(seg => ({
        type: "fade",
        start: seg.timelineStart,
        end: seg.timelineStart + seg.timelineDuration,
        mode: seg.direction, // "in" or "out"
        direction: seg.direction,
      }));
  }, [draft]);

  // 从 Draft 获取 BGM
  const effectiveBgmEdits = useMemo(() => {
    if (!draft || !draft.tracks) return [];
    const audioTrack = draft.tracks.find(t => t.type === "audio");
    if (!audioTrack || !audioTrack.segments) return [];

    return audioTrack.segments.map(seg => ({
      type: "bgm",
      keywords: seg.keywords || "",
      volume: seg.volume || 0.3,
      filePath: seg.filePath,
    }));
  }, [draft]);

  const computedFilter = useMemo(() => {
    const parts = [];
    if (colorAdjust.brightness !== 0) parts.push(`brightness(${1 + colorAdjust.brightness})`);
    if (colorAdjust.contrast !== 0) parts.push(`contrast(${1 + colorAdjust.contrast})`);
    if (colorAdjust.saturation !== 0) parts.push(`saturate(${1 + colorAdjust.saturation})`);
    if (colorAdjust.hue !== 0) parts.push(`hue-rotate(${colorAdjust.hue}deg)`);
    if (activeFilter === "bw") parts.push("grayscale(1)");
    else if (activeFilter === "vintage") parts.push("sepia(0.5) brightness(1.05) contrast(1.1)");
    else if (activeFilter === "cool") parts.push("hue-rotate(20deg) saturate(1.1) brightness(1.05)");
    else if (activeFilter === "warm") parts.push("sepia(0.25) saturate(1.2) brightness(1.05)");
    else if (activeFilter === "vivid") parts.push("saturate(1.6) contrast(1.1)");
    else if (activeFilter === "cinematic") parts.push("sepia(0.15) contrast(1.15) brightness(0.95)");
    return parts.length ? parts.join(" ") : "none";
  }, [colorAdjust, activeFilter]);

  const clipIndex = useMemo(() => {
    if (!effectiveClips?.length) return null;
    const clips = effectiveClips;
    return {
      clips,
      mediaStart: clips.map((c) => c.start),
      mediaEnd: clips.map((c) => c.end),
      timelineStart: clips.map((c) => c.timelineStart),
      timelineEnd: clips.map((c) => c.timelineStart + c.displayDuration),
    };
  }, [effectiveClips]);

  const findClipByMediaTime = (time) => {
    if (!clipIndex) return null;
    let lo = 0;
    let hi = clipIndex.mediaStart.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (time < clipIndex.mediaStart[mid] - 0.01) {
        hi = mid - 1;
      } else if (time > clipIndex.mediaEnd[mid] + 0.01) {
        lo = mid + 1;
      } else {
        return clipIndex.clips[mid];
      }
    }
    return null;
  };

  const findClipByTimelineTime = (time) => {
    if (!clipIndex) return null;
    let lo = 0;
    let hi = clipIndex.timelineStart.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (time < clipIndex.timelineStart[mid] - 0.01) {
        hi = mid - 1;
      } else if (time > clipIndex.timelineEnd[mid] + 0.01) {
        lo = mid + 1;
      } else {
        return clipIndex.clips[mid];
      }
    }
    return null;
  };

  const appendChatMessage = (message) => {
    setChatMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, ...message },
    ]);
  };

  // 获取 Draft
  const fetchDraft = useCallback(async (sid) => {
    if (!sid) return;
    try {
      const response = await fetch(`${apiBase}/api/draft/${sid}`);
      const data = await response.json();
      if (data.success) {
        setDraft(data.draft);
        console.log("[fetchDraft] Draft loaded:", data.draft);
      }
    } catch (error) {
      console.error("[fetchDraft] Error:", error);
    }
  }, [apiBase]);

  // 更新 Draft（本地修改）
  const updateDraftLocally = useCallback(async (changes) => {
    if (!sessionId) return;
    try {
      const response = await fetch(`${apiBase}/api/update-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, changes }),
      });
      const data = await response.json();
      if (data.success) {
        setDraft(data.draft);
        console.log("[updateDraft] Draft updated:", data.draft);
      }
    } catch (error) {
      console.error("[updateDraft] Error:", error);
    }
  }, [sessionId, apiBase]);

  // 处理 Draft 中的 BGM
  useEffect(() => {
    console.log('[BGM useEffect] Draft changed:', draft);

    if (!draft) {
      console.log('[BGM] No draft');
      setBgmUrl(null);
      return;
    }

    // 查找音频轨道
    const audioTrack = draft.tracks?.find(t => t.type === 'audio');
    console.log('[BGM] Audio track:', audioTrack);

    if (!audioTrack || !audioTrack.segments || audioTrack.segments.length === 0) {
      console.log('[BGM] No audio track or segments');
      setBgmUrl(null);
      return;
    }

    // 获取第一个音频片段的文件路径
    const audioSegment = audioTrack.segments[0];
    console.log('[BGM] Audio segment:', audioSegment);

    if (audioSegment.sourceFile) {
      // 构建 API URL 来获取音频文件
      const bgmApiUrl = `${apiBase}/api/audio/${encodeURIComponent(audioSegment.sourceFile)}`;
      setBgmUrl(bgmApiUrl);
      setBgmVolume(audioSegment.volume || 0.3);
      console.log('[BGM] Loading audio from:', bgmApiUrl, 'volume:', audioSegment.volume || 0.3);
    } else {
      console.log('[BGM] No sourceFile in segment');
      setBgmUrl(null);
    }
  }, [draft, apiBase]);

  // 页面加载时，如果有 sessionId，自动获取 Draft
  useEffect(() => {
    if (sessionId && !draft) {
      console.log('[App] Auto-fetching draft for session:', sessionId);
      fetchDraft(sessionId);
    }
  }, [sessionId, draft, fetchDraft]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // 移除旧的 timeline 构建逻辑，Draft 是唯一数据源
  // 旧的 buildTimeline + applyEditsToTimeline 逻辑已删除

  useEffect(() => {
    if (!videoUrl || !duration) {
      setThumbnails([]);
      setThumbnailStatus("idle");
      return;
    }
    let cancelled = false;
    const video = document.createElement("video");
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const captureAt = (time) =>
      new Promise((resolve, reject) => {
        const onSeeked = () => {
          try {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", 0.7));
          } catch (error) {
            reject(error);
          }
        };
        video.currentTime = time;
        video.addEventListener("seeked", onSeeked, { once: true });
      });

    const run = async () => {
      setThumbnailStatus("loading");
      await new Promise((resolve) => {
        if (video.readyState >= 1) {
          resolve();
          return;
        }
        video.addEventListener("loadedmetadata", resolve, { once: true });
      });
      const count =
        duration >= 1800 ? 10 :
        duration >= 900 ? 12 :
        duration >= 300 ? 16 : 25;
      const results = [];
      for (let i = 0; i < count; i += 1) {
        const time = Math.min(duration - 0.05, (duration / count) * i + 0.1);
        try {
          const image = await captureAt(time);
          if (!cancelled) results.push({ time, image });
        } catch (error) {
          if (!cancelled) results.push({ time, image: "" });
        }
        if (typeof requestIdleCallback === "function") {
          await new Promise((resolve) => requestIdleCallback(resolve));
        }
      }
      if (!cancelled) {
        setThumbnails(results);
        setThumbnailStatus("done");
      }
    };

    run();
    return () => { cancelled = true; };
  }, [videoUrl, duration]);

  const handleFileChange = (event) => {
    const nextFile = event.target.files[0];
    if (!nextFile) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(nextFile);
    setVideoUrl(URL.createObjectURL(nextFile));
    setDuration(0);
    setFeatures(null);
    setDraft(null);
    setActiveClipId(null);
    setPrepareId(null);
    setPrepareStatus("idle");
    setManualEdits([]);
    setSessionId(null); // 重置会话 ID
    undoStackRef.current = [];
    redoStackRef.current = [];

    // Gemini 预上传：用户选完文件立刻在后台开始压缩+上传
    const eagerEnabled = import.meta.env.VITE_GEMINI_EAGER_UPLOAD === "true";
    const isGeminiEngine = engine === "gemini" || engine === "auto";
    if (eagerEnabled && isGeminiEngine) {
      setPrepareStatus("preparing");
      const formData = new FormData();
      formData.append("video", nextFile);
      fetch(`${apiBase}/api/prepare`, { method: "POST", body: formData })
        .then((r) => r.ok ? r.json() : Promise.reject(r.status))
        .then(({ prepareId: id }) => {
          setPrepareId(id);
          setPrepareStatus("ready");
        })
        .catch(() => setPrepareStatus("error"));
    }
  };

  const handleMetadataLoaded = () => {
    if (!videoRef.current || !file) return;
    const nextDuration = videoRef.current.duration || 0;
    setDuration(nextDuration);
    requestAnimationFrame(updateVideoArea);
  };

  // 窗口 resize 时重新计算视频渲染区域
  useEffect(() => {
    window.addEventListener("resize", updateVideoArea);
    return () => window.removeEventListener("resize", updateVideoArea);
  }, [updateVideoArea]);

  const handleClipPlay = (clip) => {
    if (!videoRef.current) return;
    setActiveClipId(clip.id);
    setActiveClipState(clip);
    activeClipRef.current = clip;

    // 兼容 Draft segment 和 Timeline clip
    const sourceStart = clip.sourceStart ?? clip.start;
    const sourceEnd = clip.sourceEnd ?? clip.end;

    endTimeRef.current = sourceEnd;
    videoRef.current.currentTime = sourceStart;
    videoRef.current.playbackRate = clip.playbackRate || 1;
    videoRef.current.volume = clip.volume ?? 1;
    videoRef.current.play();

    // 同步播放 BGM
    if (audioRef.current && bgmUrl) {
      audioRef.current.currentTime = clip.timelineStart || 0;
      audioRef.current.play().catch(err => console.warn('[BGM] Play failed:', err));
    }

    playheadTimeRef.current = sourceStart;
    setPlayheadTime(sourceStart);
  };

  // 转换函数：素材时间 -> 轨道时间
  const mediaToTimeline = (mTime) => {
    if (!effectiveClips || !effectiveClips.length) return mTime;
    const clip = findClipByMediaTime(mTime);
    if (!clip) {
      // 如果不在任何 clip 中，返回 effectiveDuration（已播放完毕）
      return effectiveDuration || mTime;
    }
    const offsetInClip = mTime - clip.start;
    return clip.timelineStart + (offsetInClip / (clip.playbackRate || 1));
  };

  // 转换函数：轨道时间 -> 素材时间
  const timelineToMedia = (tTime) => {
    if (!effectiveClips || !effectiveClips.length) return tTime;
    const clip = findClipByTimelineTime(tTime);
    if (!clip) return tTime;
    const offsetInTimeline = tTime - clip.timelineStart;
    return clip.start + (offsetInTimeline * (clip.playbackRate || 1));
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const currentTime = videoRef.current.currentTime;
    latestTimeRef.current = currentTime;

    // 计算当前 timeline 时间
    const currentTimelineTime = mediaToTimeline(currentTime);

    // 检查是否超过有效时长，如果是则停止音频
    if (currentTimelineTime >= effectiveDuration - 0.05) {
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
    }

    // 动态倍率同步逻辑
    if (effectiveClips && effectiveClips.length) {
      const currentClip = findClipByMediaTime(currentTime);

      if (currentClip) {
        const targetRate = currentClip.playbackRate || 1;
        if (videoRef.current.playbackRate !== targetRate) {
          videoRef.current.playbackRate = targetRate;
        }
        const targetVolume = currentClip.volume ?? 1;
        if (videoRef.current.volume !== targetVolume) {
          console.log(`[volume] Setting video volume to ${targetVolume} (clip: ${currentClip.id})`);
          videoRef.current.volume = targetVolume;
        }
        if (activeClipRef.current?.id !== currentClip.id) {
          setActiveClipId(currentClip.id);
          setActiveClipState(currentClip);
          activeClipRef.current = currentClip;
        } else if (activeClipRef.current !== currentClip) {
          setActiveClipState(currentClip);
          activeClipRef.current = currentClip;
        }
      } else {
        if (videoRef.current.playbackRate !== 1) {
          videoRef.current.playbackRate = 1;
        }
        if (videoRef.current.volume !== 1) {
          videoRef.current.volume = 1;
        }
        setActiveClipId(null);
        setActiveClipState(null);
        activeClipRef.current = null;

        // 处于两个 clip 之间的间隙 — 播放中则跳到下一个 clip
        if (!videoRef.current.paused && effectiveClips?.length) {
          const nextClip = effectiveClips.find(c => c.start > currentTime + 0.01);
          if (nextClip) {
            videoRef.current.currentTime = nextClip.start;
          } else {
            // 已过最后一个 clip — 停止
            videoRef.current.pause();
            if (audioRef.current) audioRef.current.pause();
            setIsPlaying(false);
          }
        }
      }
    }

    if (endTimeRef.current != null && currentTime >= endTimeRef.current - 0.05) {
      videoRef.current.pause();
      if (audioRef.current) audioRef.current.pause();
      setIsPlaying(false);
      videoRef.current.playbackRate = 1;
      videoRef.current.volume = 1;
      endTimeRef.current = null;
    }

    if (!playheadRafRef.current) {
      playheadRafRef.current = requestAnimationFrame(() => {
        playheadRafRef.current = null;
        const latestTime = latestTimeRef.current;

        // 拖拽期间由 handleTimelineScrub 独占 playhead，避免异步 timeupdate 覆盖
        if (!isDraggingRef.current) {
          const nextPlayhead = mediaToTimeline(latestTime);
          playheadTimeRef.current = nextPlayhead;
          setPlayheadTime(nextPlayhead);
        }

        const fadeEdit = combinedEdits.find(
          (e) => e.type === "fade" && latestTime >= e.start && latestTime <= e.end
        );
        let nextFadeOpacity = 1;
        if (fadeEdit) {
          const span = Math.max(0.001, fadeEdit.end - fadeEdit.start);
          const progress = (latestTime - fadeEdit.start) / span;
          nextFadeOpacity = fadeEdit.mode === "out" ? Math.max(0, 1 - progress) : Math.min(1, progress);
        }
        if (Math.abs(nextFadeOpacity - fadeOpacityRef.current) > 0.02) {
          fadeOpacityRef.current = nextFadeOpacity;
          setFadeOpacity(nextFadeOpacity);
        }
      });
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      // 同步暂停 BGM
      if (audioRef.current) audioRef.current.pause();
    } else {
      // 检查视频是否已播放到最后
      if (playheadTime >= effectiveDuration - 0.1) {
        // 回到开头
        if (effectiveClips && effectiveClips.length > 0) {
          videoRef.current.currentTime = effectiveClips[0].start;
        } else {
          videoRef.current.currentTime = 0;
        }
        setPlayheadTime(0);
        playheadTimeRef.current = 0;

        // 同步 BGM 到开头
        if (audioRef.current && bgmUrl) {
          audioRef.current.currentTime = 0;
        }
      }

      if (effectiveClips && effectiveClips.length) {
        const currentTime = videoRef.current.currentTime;
        const currentClip = findClipByMediaTime(currentTime);
        if (currentClip) {
          videoRef.current.playbackRate = currentClip.playbackRate || 1;
          videoRef.current.volume = currentClip.volume ?? 1;
        }
      }
      videoRef.current.play();

      // 同步播放 BGM
      if (audioRef.current && bgmUrl) {
        const timelineTime = mediaToTimeline(videoRef.current.currentTime);
        audioRef.current.currentTime = timelineTime;
        audioRef.current.play().catch(err => console.warn('[BGM] Play failed:', err));
      }
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimelineScrub = (e) => {
    if (!timelineRef.current || !videoRef.current) return;
    if (!effectiveDuration) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const scrollLeft = timelineRef.current.scrollLeft;
    const x = e.clientX - rect.left + scrollLeft - 48;
    const totalWidth = rect.width * timelineScale - 48;
    const percentage = Math.max(0, Math.min(1, x / totalWidth));

    const targetTimelineTime = percentage * effectiveDuration;
    const targetMediaTime = timelineToMedia(targetTimelineTime);

    videoRef.current.currentTime = targetMediaTime;

    // 同步 BGM 时间
    if (audioRef.current && bgmUrl) {
      audioRef.current.currentTime = targetTimelineTime;
    }

    playheadTimeRef.current = targetTimelineTime;
    setPlayheadTime(targetTimelineTime);

    const targetClip = findClipByMediaTime(targetMediaTime);
    if (targetClip) {
      setActiveClipId(targetClip.id);
      setActiveClipState(targetClip);
      activeClipRef.current = targetClip;
      videoRef.current.playbackRate = targetClip.playbackRate || 1;
      videoRef.current.volume = targetClip.volume ?? 1;
    } else {
      setActiveClipId(null);
      setActiveClipState(null);
      activeClipRef.current = null;
      videoRef.current.playbackRate = 1;
      videoRef.current.volume = 1;
    }
  };

  // 始终保持 ref 指向最新的 scrub 函数，解决 useEffect stale closure
  handleTimelineScrubRef.current = handleTimelineScrub;

  const handleTimelineMouseDown = (e) => {
    isDraggingRef.current = true;
    scrubMovedRef.current = false;
    scrubStartXRef.current = e.clientX;
    handleTimelineScrub(e);
  };

  const handlePlayheadMouseDown = (e) => {
    e.stopPropagation();
    isDraggingRef.current = true;
    scrubMovedRef.current = false;
    scrubStartXRef.current = e.clientX;
  };

  useEffect(() => {
    const handleGlobalMouseMove = (e) => {
      if (isDraggingRef.current) {
        if (Math.abs(e.clientX - scrubStartXRef.current) > 4) {
          scrubMovedRef.current = true;
        }
        handleTimelineScrubRef.current?.(e);
      }
    };
    const handleGlobalMouseUp = () => {
      isDraggingRef.current = false;
      // scrubMovedRef 在下一帧重置，确保同帧的 onClick 能读到正确值
      requestAnimationFrame(() => { scrubMovedRef.current = false; });
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, []); // 空依赖：通过 ref 拿到最新函数，无需重新注册

  const handleEventPreview = (event) => {
    if (!videoRef.current) return;
    setActiveClipId(null);
    endTimeRef.current = event.end;
    videoRef.current.currentTime = event.start;
    videoRef.current.play();
    playheadTimeRef.current = event.start;
    setPlayheadTime(event.start);
  };

  useEffect(() => {
    return () => {
      if (playheadRafRef.current) {
        cancelAnimationFrame(playheadRafRef.current);
        playheadRafRef.current = null;
      }
      if (tooltipRafRef.current) {
        cancelAnimationFrame(tooltipRafRef.current);
        tooltipRafRef.current = null;
      }
    };
  }, []);

  const analyzeVideo = async () => {
    if (!file || !duration) return;
    setAnalysisStatus("analyzing");

    // 如果有会话 ID，不清空聊天记录（保留历史对话）
    if (!sessionId) {
      setChatMessages([]);
      setManualEdits([]);
      undoStackRef.current = [];
      redoStackRef.current = [];
    }

    appendChatMessage({
      role: "user",
      time: new Date().toLocaleTimeString(),
      message: userRequest,
    });

    setUserRequest("");

    try {
      const formData = new FormData();

      // 如果有会话 ID，只需要传递 sessionId，不需要重新上传视频
      if (sessionId) {
        formData.append("sessionId", sessionId);
        formData.append("duration", String(duration));
        formData.append("request", userRequest);
        formData.append("pe", pe);
        formData.append("engine", engine);
        // 不上传视频文件
      } else {
        // 首次分析，需要上传视频
        formData.append("video", file);
        formData.append("duration", String(duration));
        formData.append("request", userRequest);
        formData.append("pe", pe);
        formData.append("isMock", isMock.toString());
        formData.append("engine", engine);
        if (prepareId) formData.append("prepareId", prepareId);
      }

      const response = await fetch(`${apiBase}/api/analyze`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Backend error");

      // ── 流式读取 SSE 进度事件 ───────────────────────────────────
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // SSE 事件以 \n\n 分隔
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;

          let payload;
          try { payload = JSON.parse(line.slice(6)); } catch (_) { continue; }

          if (payload.type === "progress") {
            // 实时追加进度消息到聊天框
            appendChatMessage({
              role: "system",
              time: new Date().toLocaleTimeString(),
              message: payload.message,
            });

          } else if (payload.type === "result") {
            const data = payload;

            // 保存会话 ID
            if (data.sessionId) {
              setSessionId(data.sessionId);
            }

            // 每次对话完成后都重新获取 Draft（包括多轮对话）
            const targetSessionId = data.sessionId || sessionId;
            if (targetSessionId) {
              fetchDraft(targetSessionId);
            }

            setFeatures(prev => ({
              ...data.features,
              segments: (data.features.segments && data.features.segments.length > 0)
                ? data.features.segments
                : (prev?.segments || [])
            }));
            setAnalysisSource(data.source || "server");
            setAnalysisStatus("done");

            if (data.features?.agentSteps) {
              data.features.agentSteps.forEach((step, index) => {
                appendChatMessage({
                  role: "system",
                  time: new Date().toLocaleTimeString(),
                  message: `[Step ${index + 1}] 思考: ${step.thought}\n执行动作: ${step.action}`,
                });
              });
            }

            const summaryMessage = data.features?.summary
              ? data.features.summary
              : `识别完成！找到 ${data.features?.events?.length || 0} 个事件和 ${data.features?.segments?.length || 0} 个片段。`;

            // 添加性能统计信息
            let performanceInfo = "";
            if (data.features?.performance) {
              const perf = data.features.performance;
              performanceInfo = `\n\n📊 性能统计：\n` +
                `⏱️ 总耗时: ${perf.totalTime}\n` +
                `🔄 推理轮数: ${perf.rounds}\n` +
                `🎯 Token 消耗: ${perf.totalTokens.toLocaleString()} (输入: ${perf.tokensIn.toLocaleString()}, 输出: ${perf.tokensOut.toLocaleString()})\n` +
                `💰 成本: ${perf.cost}\n` +
                `📞 API 调用: Orchestrator ${perf.orchestratorCalls}次, 视频分析 ${perf.videoAnalysisCalls}次`;
            }

            appendChatMessage({
              role: "assistant",
              time: new Date().toLocaleTimeString(),
              message: summaryMessage + performanceInfo,
            });

          } else if (payload.type === "error") {
            // 不要抛出异常，而是设置错误状态并显示消息
            setAnalysisStatus("error");
            appendChatMessage({
              role: "system",
              time: new Date().toLocaleTimeString(),
              message: payload.message || "分析失败",
            });
            return; // 提前退出，不继续处理
          }
        }
      }
    } catch (error) {
      const isQuotaError = error.message?.includes("429") || error.message?.includes("quota");
      const fallback = extractFeaturesFromVideo(file, duration);
      setFeatures(fallback);
      setAnalysisSource("local");
      setAnalysisStatus("error");

      appendChatMessage({
        role: "system",
        time: new Date().toLocaleTimeString(),
        message: isQuotaError
          ? '⚠️ Gemini API 配额已耗尽（429）。建议勾选下方「Mock 调试模式」继续验证 UI 逻辑。'
          : "识别异常，已切换为本地基础解析。",
      });
    }
  };

  const applyManualEdits = (nextEdits) => {
    const prev = manualEdits;
    undoStackRef.current.push({ prev, next: nextEdits });
    redoStackRef.current = [];
    setManualEdits(nextEdits);
  };

  const handleUndo = () => {
    const command = undoStackRef.current.pop();
    if (!command) return;
    redoStackRef.current.push(command);
    setManualEdits(command.prev);
  };

  const handleRedo = () => {
    const command = redoStackRef.current.pop();
    if (!command) return;
    undoStackRef.current.push(command);
    setManualEdits(command.next);
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = e.target.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const isUndo = (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z";
      const isRedo = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "z";
      if (isUndo) { e.preventDefault(); handleUndo(); return; }
      if (isRedo) { e.preventDefault(); handleRedo(); return; }
      if (inInput) return;
      const vid = videoRef.current;
      if (!vid || !videoUrl) return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      if (e.key === "j") { e.preventDefault(); vid.pause(); setIsPlaying(false); vid.currentTime = Math.max(0, vid.currentTime - 10); }
      if (e.key === "k") { e.preventDefault(); vid.pause(); setIsPlaying(false); }
      if (e.key === "l") { e.preventDefault(); vid.currentTime = Math.min(duration, vid.currentTime + 10); vid.play(); setIsPlaying(true); }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const delta = e.metaKey || e.ctrlKey ? 30 : e.shiftKey ? 10 : 5;
        vid.currentTime = Math.max(0, vid.currentTime - delta);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const delta = e.metaKey || e.ctrlKey ? 30 : e.shiftKey ? 10 : 5;
        vid.currentTime = Math.min(duration, vid.currentTime + delta);
      }
      if (e.key === ",") { e.preventDefault(); vid.currentTime = Math.max(0, vid.currentTime - 1 / 30); }
      if (e.key === ".") { e.preventDefault(); vid.currentTime = Math.min(duration, vid.currentTime + 1 / 30); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const getActiveClip = () => {
    if (!effectiveClips?.length) return null;
    const byId = effectiveClips.find((clip) => clip.id === activeClipId);
    if (byId) return byId;
    const time = videoRef.current?.currentTime ?? 0;
    return (
      effectiveClips.find((clip) => time >= clip.start - 0.05 && time <= clip.end + 0.05) ||
      effectiveClips[0] ||
      null
    );
  };

  const replaceEdit = (edits, predicate, nextEdit) => {
    const kept = edits.filter((edit) => !predicate(edit));
    return [...kept, nextEdit];
  };

  const normalizeTime = (value) => Number(value.toFixed(2));

  const updateSpeed = (rate) => {
    const clip = getActiveClip();
    if (!clip) return;
    const nextEdit = {
      type: "speed",
      start: normalizeTime(clip.start),
      end: normalizeTime(clip.end),
      rate,
    };
    const nextEdits = replaceEdit(
      manualEdits,
      (e) =>
        e.type === "speed" &&
        Math.abs(e.start - nextEdit.start) < 0.02 &&
        Math.abs(e.end - nextEdit.end) < 0.02,
      nextEdit
    );
    applyManualEdits(nextEdits);
  };

  const addSplit = () => {
    if (!videoRef.current) return;
    const time = normalizeTime(videoRef.current.currentTime || 0);
    if (!time) return;
    applyManualEdits([...manualEdits, { type: "split", start: time, end: time }]);
  };

  const deleteClip = () => {
    const clip = getActiveClip();
    if (!clip) return;
    const nextEdit = {
      type: "delete",
      start: normalizeTime(clip.start),
      end: normalizeTime(clip.end),
    };
    const nextEdits = replaceEdit(
      manualEdits,
      (e) =>
        e.type === "delete" &&
        Math.abs(e.start - nextEdit.start) < 0.02 &&
        Math.abs(e.end - nextEdit.end) < 0.02,
      nextEdit
    );
    applyManualEdits(nextEdits);
  };

  const trimClip = (direction) => {
    const clip = getActiveClip();
    if (!clip) return;
    const span = Math.max(0.3, Math.min(1, (clip.end - clip.start) * 0.2));
    let start = clip.start;
    let end = clip.end;
    if (direction === "in") {
      end = Math.min(clip.end, clip.start + span);
    } else {
      start = Math.max(clip.start, clip.end - span);
    }
    if (end - start <= 0.05) return;
    const nextEdit = {
      type: "delete",
      start: normalizeTime(start),
      end: normalizeTime(end),
    };
    const nextEdits = replaceEdit(
      manualEdits,
      (e) =>
        e.type === "delete" &&
        Math.abs(e.start - nextEdit.start) < 0.02 &&
        Math.abs(e.end - nextEdit.end) < 0.02,
      nextEdit
    );
    applyManualEdits(nextEdits);
  };

  const addFade = (mode) => {
    const clip = getActiveClip();
    if (!clip) return;
    const window = Math.min(0.6, clip.end - clip.start);
    if (window <= 0.05) return;
    const start = mode === "in" ? clip.start : clip.end - window;
    const end = mode === "in" ? clip.start + window : clip.end;
    const nextEdit = {
      type: "fade",
      start: normalizeTime(start),
      end: normalizeTime(end),
      mode,
    };
    const nextEdits = replaceEdit(
      manualEdits,
      (e) =>
        e.type === "fade" &&
        e.mode === mode &&
        Math.abs(e.start - nextEdit.start) < 0.02 &&
        Math.abs(e.end - nextEdit.end) < 0.02,
      nextEdit
    );
    applyManualEdits(nextEdits);
  };

  const updateVolume = (volume) => {
    const clip = getActiveClip();
    if (!clip) return;
    const nextEdit = {
      type: "volume",
      start: normalizeTime(clip.start),
      end: normalizeTime(clip.end),
      volume: Math.min(1, Math.max(0, volume)),
    };
    const nextEdits = replaceEdit(
      manualEdits,
      (e) =>
        e.type === "volume" &&
        Math.abs(e.start - nextEdit.start) < 0.02 &&
        Math.abs(e.end - nextEdit.end) < 0.02,
      nextEdit
    );
    applyManualEdits(nextEdits);
  };

  const updateTransform = (updater) => {
    const clip = getActiveClip();
    if (!clip) return;
    const existing = manualEdits.find(
      (e) =>
        e.type === "transform" &&
        Math.abs(e.start - clip.start) < 0.02 &&
        Math.abs(e.end - clip.end) < 0.02
    );
    const base = existing?.transform || {};
    const nextTransform = updater(base);
    const nextEdit = {
      type: "transform",
      start: normalizeTime(clip.start),
      end: normalizeTime(clip.end),
      transform: nextTransform,
    };
    const nextEdits = replaceEdit(
      manualEdits,
      (e) =>
        e.type === "transform" &&
        Math.abs(e.start - nextEdit.start) < 0.02 &&
        Math.abs(e.end - nextEdit.end) < 0.02,
      nextEdit
    );
    applyManualEdits(nextEdits);
  };

  const zoomClip = (delta) => {
    updateTransform((base) => ({
      ...base,
      scale: Math.min(3, Math.max(0.5, (base.scale || 1) + delta)),
    }));
  };

  const moveClip = (dx, dy) => {
    updateTransform((base) => ({
      ...base,
      x: (base.x || 0) + dx,
      y: (base.y || 0) + dy,
    }));
  };

  const rotateClip = () => {
    updateTransform((base) => ({
      ...base,
      rotate: ((base.rotate || 0) + 90) % 360,
    }));
  };

  const flipClip = (axis) => {
    updateTransform((base) => ({
      ...base,
      flipX: axis === "x" ? !base.flipX : base.flipX,
      flipY: axis === "y" ? !base.flipY : base.flipY,
    }));
  };

  const resetTransform = () => {
    updateTransform(() => ({
      scale: 1,
      x: 0,
      y: 0,
      rotate: 0,
      flipX: false,
      flipY: false,
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    }));
  };

  // ── 调色 / 滤镜 ──────────────────────────────────────────────────
  const updateColorAdjust = (key, value) => setColorAdjust(prev => ({ ...prev, [key]: value }));
  const resetColorAdjust = () => { setColorAdjust({ brightness: 0, contrast: 0, saturation: 0, hue: 0, sharpness: 0 }); setActiveFilter("none"); };
  const applyPresetFilter = (name) => { setActiveFilter(name); };

  // ── 时间线缩放 ────────────────────────────────────────────────────
  const handleTimelineWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setTimelineScale(prev => Math.max(1, Math.min(30, prev * (e.deltaY > 0 ? 0.85 : 1.18))));
    }
  }, []);

  // ── Trim 把手拖拽 ─────────────────────────────────────────────────
  const handleTrimHandleStart = (e, clip, edge) => {
    e.stopPropagation();
    e.preventDefault();
    trimDragRef.current = { active: true, clip, edge, startX: e.clientX, pendingTime: null };
  };

  useEffect(() => {
    const onMove = (e) => {
      const drag = trimDragRef.current;
      if (!drag?.active || !timelineRef.current) return;
      const contRect = timelineRef.current.getBoundingClientRect();
      const totalPx = contRect.width * timelineScale;
      const totalDur = effectiveDuration || 1;
      const pxPerSec = totalPx / totalDur;
      const deltaSec = (e.clientX - drag.startX) / pxPerSec;
      const { clip, edge } = drag;
      let newTime;
      if (edge === "start") {
        newTime = Math.max(0, Math.min(clip.end - 0.1, clip.start + deltaSec));
      } else {
        newTime = Math.max(clip.start + 0.1, Math.min(duration, clip.end + deltaSec));
      }
      trimDragRef.current.pendingTime = newTime;
      // 强制重绘以预览
      setPlayheadTime(t => t);
    };
    const onUp = () => {
      const drag = trimDragRef.current;
      if (!drag?.active) return;
      trimDragRef.current = null;
      const { clip, edge, pendingTime } = drag;
      if (pendingTime === null) return;
      if (edge === "start" && Math.abs(pendingTime - clip.start) > 0.05) {
        applyManualEdits([...manualEdits, {
          type: "delete",
          start: Math.min(clip.start, pendingTime),
          end: Math.max(clip.start, pendingTime),
        }]);
      } else if (edge === "end" && Math.abs(pendingTime - clip.end) > 0.05) {
        applyManualEdits([...manualEdits, {
          type: "delete",
          start: Math.min(clip.end, pendingTime),
          end: Math.max(clip.end, pendingTime),
        }]);
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [timeline, duration, timelineScale, manualEdits]);

  const cropSquare = () => {
    const el = videoRef.current;
    const aspect = el?.videoWidth && el?.videoHeight ? el.videoWidth / el.videoHeight : 1;
    let crop = { top: 0, right: 0, bottom: 0, left: 0 };
    if (aspect > 1) {
      const inset = (1 - 1 / aspect) / 2;
      crop = { top: 0, bottom: 0, left: inset, right: inset };
    } else if (aspect < 1) {
      const inset = (1 - aspect) / 2;
      crop = { left: 0, right: 0, top: inset, bottom: inset };
    }
    updateTransform((base) => ({
      ...base,
      crop,
    }));
  };

  const handleToolbarMouseMove = (e) => {
    const target = e.target?.closest?.(".tool-btn[data-tooltip]");
    tooltipTargetRef.current = target || null;
    if (tooltipRafRef.current) return;
    tooltipRafRef.current = requestAnimationFrame(() => {
      tooltipRafRef.current = null;
      const current = tooltipTargetRef.current;
      if (!current) {
        if (tooltip.visible) {
          setTooltip((prev) => ({ ...prev, visible: false }));
        }
        return;
      }
      const text = current.getAttribute("data-tooltip") || "";
      if (!text) return;
      const rect = current.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top;
      setTooltip({ visible: true, text, x, y });
    });
  };

  const handleToolbarMouseLeave = () => {
    tooltipTargetRef.current = null;
    if (tooltip.visible) {
      setTooltip((prev) => ({ ...prev, visible: false }));
    }
  };

  const handleExport = async () => {
    if (!draft || !file) return;
    setIsExporting(true);
    setExportProgress({ status: "rendering", percent: 0, message: "准备中..." });

    try {
      const formData = new FormData();
      formData.append("video", file);
      formData.append("draft", JSON.stringify(draft));
      formData.append("sessionId", sessionId || "");
      formData.append("colorAdjust", JSON.stringify(colorAdjust));
      formData.append("activeFilter", activeFilter);
      formData.append("exportFormat", exportFormat);

      const response = await fetch(`${apiBase}/api/export`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Export failed");

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            let evt;
            try { evt = JSON.parse(line.slice(6)); } catch (_) { continue; }
            if (evt.type === "progress") {
              setExportProgress({ status: "rendering", percent: evt.percent, message: evt.message || "" });
            } else if (evt.type === "done") {
              setExportProgress({ status: "done", percent: 100, message: "完成！" });
              const fileResp = await fetch(`${apiBase}/api/export/file/${evt.fileId}`);
              const blob = await fileResp.blob();
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url; a.download = `${file.name.split(".")[0]}_edited.mp4`;
              document.body.appendChild(a); a.click();
              window.URL.revokeObjectURL(url); document.body.removeChild(a);
              appendChatMessage({ role: "assistant", time: new Date().toLocaleTimeString(), message: "✅ 视频导出成功！" });
            } else if (evt.type === "error") {
              throw new Error(evt.message || "渲染失败");
            }
          }
        }
      } else {
        // fallback: direct blob download (legacy)
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `${file.name.split(".")[0]}_edited.mp4`;
        document.body.appendChild(a); a.click();
        window.URL.revokeObjectURL(url); document.body.removeChild(a);
        setExportProgress({ status: "done", percent: 100, message: "" });
        appendChatMessage({ role: "assistant", time: new Date().toLocaleTimeString(), message: "✅ 视频导出成功！" });
      }
    } catch (error) {
      console.error("Export error:", error);
      setExportProgress({ status: "error", percent: 0, message: error.message });
      appendChatMessage({ role: "system", time: new Date().toLocaleTimeString(), message: `❌ 导出失败：${error.message}` });
    } finally {
      setIsExporting(false);
      setTimeout(() => setExportProgress({ status: "idle", percent: 0, message: "" }), 4000);
    }
  };

  return (
    <div className="capcut-editor">
      <header className="editor-header">
        <div className="header-left">
          <div className="app-logo">C</div>
        </div>
        <div className="header-center">
          项目识别 - {file?.name || "未命名"}
        </div>
        <div className="header-right">
          <button 
            className={`btn-export ${isExporting ? 'exporting' : ''}`}
            onClick={handleExport}
            disabled={!draft || isExporting}
          >
            {isExporting ? "Exporting..." : "Export"}
          </button>
          <div className="user-avatar">👤</div>
        </div>
      </header>

      <main className="editor-content">
        <aside className="editor-sidebar">
          <div className="sidebar-top">
            <div className="section-title">Transcript</div>
            <div className="chat-container">
              {chatMessages.map((msg) => (
                <div key={msg.id} className={`chat-message ${msg.role}`}>
                  <div className="msg-header">
                    <span className="msg-role">{msg.role === 'user' ? 'Me' : 'AI'}</span>
                    <span className="msg-time">{msg.time}</span>
                  </div>
                  <div className="msg-content">{msg.message}</div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          </div>

          <div className="sidebar-bottom">
            <div className="debug-mock-mode">
              <label>
                <input 
                  type="checkbox" 
                  checked={isMock} 
                  onChange={(e) => setIsMock(e.target.checked)} 
                />
                Mock 调试模式 (跳过视频处理)
              </label>
            </div>
            <div className="engine-select">
              <label>
                识别引擎
                <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                  <option value="auto">Auto</option>
                  <option value="gemini">Gemini</option>
                  <option value="doubao">Doubao</option>
                </select>
              </label>
              {prepareStatus === "preparing" && <span className="prepare-status preparing">⏳ 预上传中…</span>}
              {prepareStatus === "ready"     && <span className="prepare-status ready">✅ 已就绪</span>}
              {prepareStatus === "error"     && <span className="prepare-status error">⚠️ 预上传失败</span>}
            </div>
            <div className="prompt-input-area">
              <textarea 
                value={userRequest}
                onChange={(e) => setUserRequest(e.target.value)}
                placeholder="Ask Gemini what changes to make..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    analyzeVideo();
                  }
                }}
              />
              <button className="btn-send" onClick={analyzeVideo} disabled={!file || analysisStatus === 'analyzing'}>
                {analysisStatus === 'analyzing' ? '...' : '↑'}
              </button>
            </div>
            <div className="add-video-btn">
              <label className="upload-label">
                + 添加视频
                <input type="file" accept="video/*" onChange={handleFileChange} />
              </label>
            </div>
          </div>
        </aside>

        <section className="editor-preview">
          <div className="preview-container" ref={previewContainerRef}>
            {videoUrl ? (
              <>
                <video
                  ref={videoRef}
                  src={videoUrl}
                  onLoadedMetadata={handleMetadataLoaded}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onClick={togglePlay}
                  style={{
                    opacity: fadeOpacity,
                    transform: (() => {
                      const transform = activeClipState?.transform || {};
                      const scale = transform.scale || 1;
                      const x = transform.x || 0;
                      const y = transform.y || 0;
                      const rotate = transform.rotate || 0;
                      const flipX = transform.flipX ? -1 : 1;
                      const flipY = transform.flipY ? -1 : 1;
                      return `translate(${x}%, ${y}%) scale(${scale * flipX}, ${scale * flipY}) rotate(${rotate}deg)`;
                    })(),
                    clipPath: (() => {
                      const transform = activeClipState?.transform || {};
                      const crop = transform.crop;
                      if (!crop) return "none";
                      const top = Math.max(0, Math.min(1, crop.top || 0));
                      const right = Math.max(0, Math.min(1, crop.right || 0));
                      const bottom = Math.max(0, Math.min(1, crop.bottom || 0));
                      const left = Math.max(0, Math.min(1, crop.left || 0));
                      return `inset(${top * 100}% ${right * 100}% ${bottom * 100}% ${left * 100}%)`;
                    })(),
                    transformOrigin: "center center",
                    filter: computedFilter,
                  }}
                />
                {/* BGM 音频播放器 */}
                {bgmUrl && (
                  <audio
                    ref={audioRef}
                    src={bgmUrl}
                    loop
                    onCanPlay={() => { if (audioRef.current) audioRef.current.volume = bgmVolume; }}
                    style={{ display: 'none' }}
                  />
                )}
                {videoRef.current && videoRef.current.playbackRate !== 1 && (
                  <div className="playback-speed-overlay">
                    {videoRef.current.playbackRate}x
                  </div>
                )}
                {videoArea && effectiveTextEdits?.map((edit, i) => {
                  const isActive = playheadTime >= edit.timelineStart - 0.05 && playheadTime <= edit.timelineEnd + 0.05;
                  if (!isActive) return null;

                  // 与导出完全一致：字体 = 视频高度 * 4%，padding = 字体 * 25%
                  const fontSize = Math.round(videoArea.height * 0.04);
                  const padding = Math.round(fontSize * 0.25);
                  const boxH = fontSize + padding * 2;
                  const pos = edit.position || "bottom";

                  let topPx;
                  if (pos === "top") {
                    topPx = videoArea.top + Math.round(videoArea.height * 0.08);
                  } else if (pos === "center") {
                    topPx = videoArea.top + (videoArea.height - boxH) / 2;
                  } else {
                    topPx = videoArea.top + videoArea.height - boxH - Math.round(videoArea.height * 0.08);
                  }

                  return (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        left: `${Math.round(videoArea.left)}px`,
                        top: `${Math.round(topPx)}px`,
                        width: `${Math.round(videoArea.width)}px`,
                        height: `${boxH}px`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: `${fontSize}px`,
                        fontWeight: "bold",
                        color: "white",
                        textShadow: [
                          "1px 1px 0 rgba(0,0,0,0.9)",
                          "-1px -1px 0 rgba(0,0,0,0.9)",
                          "1px -1px 0 rgba(0,0,0,0.9)",
                          "-1px 1px 0 rgba(0,0,0,0.9)",
                          "0 0 8px rgba(0,0,0,0.8)",
                        ].join(", "),
                        pointerEvents: "none",
                        zIndex: 50,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                      }}
                    >
                      {edit.text}
                    </div>
                  );
                })}
              </>
            ) : (
              <div className="preview-placeholder">上传视频以开始</div>
            )}
          </div>
          <div className="preview-controls">
            <button className="btn-play-pause" onClick={togglePlay} disabled={!videoUrl}>
              {isPlaying ? "⏸" : "▶️"}
            </button>
            <span className="time-display">{formatTime(playheadTime)} / {formatTime(effectiveDuration)}</span>
            <div className="preview-controls-right">
              <select
                className="format-select"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value)}
                title="输出画幅"
              >
                <option value="original">原始比例</option>
                <option value="16:9">16:9 横屏</option>
                <option value="9:16">9:16 竖屏 (抖音)</option>
                <option value="1:1">1:1 方形</option>
                <option value="4:3">4:3 经典</option>
              </select>
              <button
                className={`btn-panel-toggle ${activeRightPanel === "adjust" ? "active" : ""}`}
                onClick={() => setActiveRightPanel(p => p === "adjust" ? null : "adjust")}
                title="调色 / 滤镜"
              >
                🎨
              </button>
            </div>
          </div>

          {exportProgress.status !== "idle" && (
            <div className="export-progress-bar">
              <div className="export-progress-fill" style={{ width: `${exportProgress.percent}%` }} />
              <span className="export-progress-label">
                {exportProgress.status === "done" ? "✅ 导出完成" :
                 exportProgress.status === "error" ? "❌ 导出失败" :
                 `渲染中 ${exportProgress.percent}%`}
              </span>
            </div>
          )}

          {activeRightPanel === "adjust" && (
            <div className="adjust-panel">
              <div className="adjust-panel-header">
                <span>调色 / 滤镜</span>
                <button className="btn-close-panel" onClick={() => setActiveRightPanel(null)}>✕</button>
              </div>
              <div className="adjust-section">
                <div className="adjust-label">滤镜</div>
                <div className="filter-grid">
                  {[["none","无"],["vivid","鲜艳"],["cool","冷调"],["warm","暖调"],["vintage","复古"],["bw","黑白"],["cinematic","电影"]].map(([id,label]) => (
                    <button key={id} className={`filter-chip ${activeFilter === id ? "active" : ""}`} onClick={() => applyPresetFilter(id)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="adjust-section">
                <div className="adjust-label">亮度 <span>{colorAdjust.brightness > 0 ? "+" : ""}{Math.round(colorAdjust.brightness * 100)}</span></div>
                <input type="range" min="-1" max="1" step="0.01" value={colorAdjust.brightness} onChange={e => updateColorAdjust("brightness", parseFloat(e.target.value))} />
              </div>
              <div className="adjust-section">
                <div className="adjust-label">对比度 <span>{colorAdjust.contrast > 0 ? "+" : ""}{Math.round(colorAdjust.contrast * 100)}</span></div>
                <input type="range" min="-1" max="1" step="0.01" value={colorAdjust.contrast} onChange={e => updateColorAdjust("contrast", parseFloat(e.target.value))} />
              </div>
              <div className="adjust-section">
                <div className="adjust-label">饱和度 <span>{colorAdjust.saturation > 0 ? "+" : ""}{Math.round(colorAdjust.saturation * 100)}</span></div>
                <input type="range" min="-1" max="1" step="0.01" value={colorAdjust.saturation} onChange={e => updateColorAdjust("saturation", parseFloat(e.target.value))} />
              </div>
              <div className="adjust-section">
                <div className="adjust-label">色调 <span>{colorAdjust.hue > 0 ? "+" : ""}{colorAdjust.hue}°</span></div>
                <input type="range" min="-180" max="180" step="1" value={colorAdjust.hue} onChange={e => updateColorAdjust("hue", parseInt(e.target.value))} />
              </div>
              <div className="adjust-section">
                <div className="adjust-label">锐度 <span>{Math.round(colorAdjust.sharpness * 100)}</span></div>
                <input type="range" min="0" max="1" step="0.01" value={colorAdjust.sharpness} onChange={e => updateColorAdjust("sharpness", parseFloat(e.target.value))} />
              </div>
              <button className="btn-reset-adjust" onClick={resetColorAdjust}>重置</button>
            </div>
          )}
        </section>

        <aside className="editor-right-panel">
          <div className="section-title">Media</div>
          <div className="media-grid">
            {file ? (
              <div className="media-card">
                <div className="media-preview">
                  {thumbnails[0] ? <img src={thumbnails[0].image} alt="preview" /> : <div className="placeholder" />}
                  <span className="media-duration">{formatTime(duration)}</span>
                </div>
                <div className="media-info">{file.name}</div>
              </div>
            ) : (
              <div className="empty-media">暂无素材</div>
            )}
          </div>

          {/* Draft 信息面板 */}
          {draft && (
            <div className="draft-info-panel">
              <div className="section-title">Draft 状态</div>
              <div className="draft-info-content">
                <div className="draft-info-row">
                  <span className="label">总时长:</span>
                  <span className="value">{draft.settings?.totalDuration?.toFixed(1)}s</span>
                </div>
                <div className="draft-info-row">
                  <span className="label">轨道数:</span>
                  <span className="value">{draft.tracks?.length || 0}</span>
                </div>
                <div className="draft-tracks">
                  {draft.tracks?.map(track => (
                    <div key={track.id} className="draft-track-item">
                      <span className="track-id">{track.id}</span>
                      <span className="track-type">({track.type})</span>
                      <span className="track-segments">{track.segments?.length || 0} 片段</span>
                    </div>
                  ))}
                </div>
                <div className="draft-version">
                  版本: {draft.version || 1}
                </div>
              </div>
            </div>
          )}
        </aside>
      </main>

      <footer className="editor-timeline">
        <div className="timeline-toolbar">
          <div className="toolbar-left" onMouseMove={handleToolbarMouseMove} onMouseLeave={handleToolbarMouseLeave}>
            <button className="tool-btn" onClick={handleUndo} data-tooltip="Undo (⌘Z)" title="Undo (⌘Z)">↶</button>
            <button className="tool-btn" onClick={handleRedo} data-tooltip="Redo (⇧⌘Z)" title="Redo (⇧⌘Z)">↷</button>
            <button className="tool-btn" onClick={addSplit} data-tooltip="Split" title="Split">✂️</button>
            <button className="tool-btn" onClick={deleteClip} data-tooltip="Delete" title="Delete">🗑️</button>
            <button className="tool-btn" onClick={() => trimClip("in")} data-tooltip="Trim In" title="Trim In">⏮️</button>
            <button className="tool-btn" onClick={() => trimClip("out")} data-tooltip="Trim Out" title="Trim Out">⏭️</button>
            <button className="tool-btn" onClick={() => updateSpeed(0.5)} data-tooltip="Speed 0.5x" title="Speed 0.5x">🐢</button>
            <button className="tool-btn" onClick={() => updateSpeed(1)} data-tooltip="Speed 1x" title="Speed 1x">⏺️</button>
            <button className="tool-btn" onClick={() => updateSpeed(2)} data-tooltip="Speed 2x" title="Speed 2x">🐇</button>
            <button className="tool-btn" onClick={() => addFade("in")} data-tooltip="Fade In" title="Fade In">🌅</button>
            <button className="tool-btn" onClick={() => addFade("out")} data-tooltip="Fade Out" title="Fade Out">🌇</button>
            <button className="tool-btn" onClick={() => updateVolume(0)} data-tooltip="Mute" title="Mute">🔇</button>
            <button className="tool-btn" onClick={() => updateVolume(0.5)} data-tooltip="Volume 50%" title="Volume 50%">🔉</button>
            <button className="tool-btn" onClick={() => updateVolume(1)} data-tooltip="Volume 100%" title="Volume 100%">🔊</button>
            <button className="tool-btn" onClick={() => zoomClip(0.1)} data-tooltip="Zoom In" title="Zoom In">🔍➕</button>
            <button className="tool-btn" onClick={() => zoomClip(-0.1)} data-tooltip="Zoom Out" title="Zoom Out">🔍➖</button>
            <button className="tool-btn" onClick={() => moveClip(-5, 0)} data-tooltip="Move Left" title="Move Left">⬅️</button>
            <button className="tool-btn" onClick={() => moveClip(5, 0)} data-tooltip="Move Right" title="Move Right">➡️</button>
            <button className="tool-btn" onClick={() => moveClip(0, -5)} data-tooltip="Move Up" title="Move Up">⬆️</button>
            <button className="tool-btn" onClick={() => moveClip(0, 5)} data-tooltip="Move Down" title="Move Down">⬇️</button>
            <button className="tool-btn" onClick={rotateClip} data-tooltip="Rotate" title="Rotate">🔄</button>
            <button className="tool-btn" onClick={() => flipClip("x")} data-tooltip="Flip Horizontal" title="Flip Horizontal">↔️</button>
            <button className="tool-btn" onClick={() => flipClip("y")} data-tooltip="Flip Vertical" title="Flip Vertical">↕️</button>
            <button className="tool-btn" onClick={cropSquare} data-tooltip="Crop 1:1" title="Crop 1:1">▢</button>
            <button className="tool-btn" onClick={resetTransform} data-tooltip="Reset" title="Reset">♻️</button>
          </div>
          <div className="toolbar-right">
            <button className="tool-btn zoom-btn" onClick={() => setTimelineScale(1)} title="适应" data-tooltip="适应">
              ⊡
            </button>
            <button className="tool-btn zoom-btn" onClick={() => setTimelineScale(prev => Math.max(1, prev / 1.5))} title="缩小时间线" data-tooltip="缩小 (Ctrl+滚轮)">
              −
            </button>
            <span className="zoom-level">{Math.round(timelineScale * 100)}%</span>
            <button className="tool-btn zoom-btn" onClick={() => setTimelineScale(prev => Math.min(30, prev * 1.5))} title="放大时间线" data-tooltip="放大 (Ctrl+滚轮)">
              +
            </button>
          </div>
        </div>

        <div
          className="timeline-container"
          ref={timelineRef}
          onMouseDown={handleTimelineMouseDown}
          onWheel={handleTimelineWheel}
        >
          <div className="timeline-ruler" style={{ width: `${timelineScale * 100}%` }}>
            {(() => {
              const totalDur = effectiveDuration || 1;
              // 根据缩放级别决定间隔粒度
              const approxPx = 800 * timelineScale;
              const rawInterval = totalDur / (approxPx / 80);
              const niceIntervals = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
              const interval = niceIntervals.find(n => n >= rawInterval) || niceIntervals[niceIntervals.length - 1];
              const marks = [];
              for (let t = 0; t <= totalDur + 0.001; t += interval) {
                const pct = (Math.min(t, totalDur) / totalDur) * 100;
                marks.push(
                  <span key={t} className="ruler-mark" style={{ left: `calc(48px + (100% - 48px) * ${Math.min(t, totalDur) / totalDur})` }}>
                    {formatTime(Math.min(t, totalDur))}
                  </span>
                );
              }
              return marks;
            })()}
          </div>

          <div className="timeline-tracks" style={{ width: `${timelineScale * 100}%` }}>
            <div
              className="timeline-playhead-full"
              style={{ left: `calc(48px + (100% - 48px) * ${playheadTime / (effectiveDuration || 1)})` }}
            >
              <div className="playhead-handle" onMouseDown={handlePlayheadMouseDown} />
            </div>
            <div className="track track-v1">
              <div className="track-id">V1</div>
              <div className="track-content">
                {draft && draft.tracks ? (
                  (() => {
                    const videoTrack = draft.tracks.find(t => t.type === "video");
                    if (!videoTrack || !videoTrack.segments) return null;

                    return videoTrack.segments.map((seg, i) => {
                      // Trim preview: check if this segment is being dragged
                      const drag = trimDragRef.current;
                      let displayStart = seg.timelineStart;
                      let displayDur = seg.timelineDuration;
                      if (drag?.active && drag.clip.id === seg.id && drag.pendingTime !== null) {
                        if (drag.edge === "start") {
                          const delta = (drag.pendingTime - seg.sourceStart) / (seg.playbackRate || 1);
                          displayStart = seg.timelineStart + delta;
                          displayDur = seg.timelineDuration - delta;
                        } else {
                          displayDur = (drag.pendingTime - seg.sourceStart) / (seg.playbackRate || 1);
                        }
                      }
                      return (
                      <div
                        key={seg.id}
                        className={`video-clip-segment ${activeClipId === seg.id ? "active" : ""}`}
                        style={{
                          left: `${(displayStart / effectiveDuration) * 100}%`,
                          width: `${(displayDur / effectiveDuration) * 100}%`,
                          opacity: seg.playbackRate !== 1 ? 0.85 : 1,
                        }}
                        onClick={() => { if (!scrubMovedRef.current) handleClipPlay(seg); }}
                      >
                        <div className="trim-handle trim-handle-left" onMouseDown={(e) => handleTrimHandleStart(e, seg, "start")} />
                        <div className="clip-thumb-overlay">
                          {thumbnails.length > 0 ? (
                            thumbnails
                              .filter(t => t.time >= seg.sourceStart - 0.5 && t.time <= seg.sourceEnd + 0.5)
                              .slice(0, 5)
                              .map((t, idx) => <img key={idx} src={t.image} alt="" />)
                          ) : null}
                        </div>
                        {seg.playbackRate && seg.playbackRate !== 1 && (
                          <div className="clip-speed-tag">⚡ {seg.playbackRate}x</div>
                        )}
                        <div className="clip-label">{`Clip ${i + 1}`}</div>
                        <div className="trim-handle trim-handle-right" onMouseDown={(e) => handleTrimHandleStart(e, seg, "end")} />
                      </div>
                      );
                    });
                  })()
                ) : effectiveClips && effectiveClips.length > 0 ? (
                  effectiveClips.map((clip, i) => {
                    // Trim preview: check if this clip is being dragged
                    const drag = trimDragRef.current;
                    let displayStart = clip.timelineStart;
                    let displayDur = clip.displayDuration;
                    if (drag?.active && drag.clip.id === clip.id && drag.pendingTime !== null) {
                      if (drag.edge === "start") {
                        const delta = (drag.pendingTime - drag.clip.start) / (clip.playbackRate || 1);
                        displayStart = clip.timelineStart + delta;
                        displayDur = clip.displayDuration - delta;
                      } else {
                        displayDur = (drag.pendingTime - clip.start) / (clip.playbackRate || 1);
                      }
                    }
                    return (
                    <div
                      key={clip.id}
                      className={`video-clip-segment ${activeClipId === clip.id ? "active" : ""}`}
                      style={{
                        left: `${(displayStart / effectiveDuration) * 100}%`,
                        width: `${(displayDur / effectiveDuration) * 100}%`,
                        opacity: clip.playbackRate !== 1 ? 0.85 : 1,
                      }}
                      onClick={() => { if (!scrubMovedRef.current) handleClipPlay(clip); }}
                    >
                      <div className="trim-handle trim-handle-left" onMouseDown={(e) => handleTrimHandleStart(e, clip, "start")} />
                      <div className="clip-thumb-overlay">
                        {thumbnails.length > 0 ? (
                          thumbnails
                            .filter(t => t.time >= clip.start - 0.5 && t.time <= clip.end + 0.5)
                            .slice(0, 5)
                            .map((t, idx) => <img key={idx} src={t.image} alt="" />)
                        ) : null}
                      </div>
                      {clip.playbackRate && clip.playbackRate !== 1 && (
                        <div className="clip-speed-tag">⚡ {clip.playbackRate}x</div>
                      )}
                      <div className="clip-label">{`Clip ${i + 1}`}</div>
                      <div className="trim-handle trim-handle-right" onMouseDown={(e) => handleTrimHandleStart(e, clip, "end")} />
                    </div>
                    );
                  })
                ) : file ? (
                  <div className="video-clip-bar">
                    <div className="thumb-strip">
                      {thumbnails.map((t, i) => (
                        <img key={i} src={t.image} alt="" />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="track track-a1">
              <div className="track-id">A1</div>
              <div className="track-content">
                <div className="waveform-placeholder" />
                {effectiveBgmEdits?.map((edit, i) => (
                  <div
                    key={i}
                    className="bgm-edit-node"
                    style={{ left: 0, width: "100%" }}
                    title={`BGM: ${edit.keywords || "背景音乐"}`}
                  >
                    🎵 {edit.keywords || "背景音乐"}
                  </div>
                ))}
              </div>
            </div>

            <div className="track track-events">
              <div className="track-id">E1</div>
              <div className="track-content">
                {features?.events?.map((ev, i) => {
                  const tStart = mediaToTimeline(ev.start);
                  const tEnd = mediaToTimeline(ev.end);
                  const tDuration = effectiveDuration;
                  return (
                    <div 
                      key={i} 
                      className="event-node"
                      style={{ 
                        left: `${(tStart / tDuration) * 100}%`,
                        width: `${((tEnd - tStart) / tDuration) * 100}%`
                      }}
                      onClick={() => handleEventPreview(ev)}
                      title={ev.label}
                    >
                      {ev.label}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="track track-t1">
              <div className="track-id">T1</div>
              <div className="track-content">
                {draft && draft.tracks ? (
                  (() => {
                    const textTrack = draft.tracks.find(t => t.type === "text");
                    if (!textTrack || !textTrack.segments) return null;

                    return textTrack.segments.map((seg, i) => (
                      <div
                        key={seg.id}
                        className="text-edit-node"
                        style={{
                          left: `${(seg.timelineStart / effectiveDuration) * 100}%`,
                          width: `${(seg.timelineDuration / effectiveDuration) * 100}%`,
                        }}
                        title={seg.content}
                      >
                        T: {seg.content}
                      </div>
                    ));
                  })()
                ) : effectiveTextEdits?.map((edit, i) => {
                  return (
                    <div
                      key={i}
                      className="text-edit-node"
                      style={{
                        left: `${(edit.timelineStart / effectiveDuration) * 100}%`,
                        width: `${((edit.timelineEnd - edit.timelineStart) / effectiveDuration) * 100}%`,
                      }}
                      title={edit.text}
                    >
                      T: {edit.text}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="track track-fade">
              <div className="track-id">FX</div>
              <div className="track-content">
                {draft && draft.tracks ? (
                  (() => {
                    const effectTrack = draft.tracks.find(t => t.type === "effect");
                    if (!effectTrack || !effectTrack.segments) return null;

                    return effectTrack.segments.map((seg, i) => (
                      <div
                        key={seg.id}
                        className={`fade-edit-node fade-${seg.direction}`}
                        style={{
                          left: `${(seg.timelineStart / effectiveDuration) * 100}%`,
                          width: `${(seg.timelineDuration / effectiveDuration) * 100}%`,
                        }}
                        title={`淡${seg.direction === "in" ? "入" : "出"}`}
                      >
                        {seg.direction === "in" ? "▶ 淡入" : "淡出 ◀"}
                      </div>
                    ));
                  })()
                ) : effectiveFadeEdits?.map((edit, i) => {
                  return (
                    <div
                      key={i}
                      className={`fade-edit-node fade-${edit.direction}`}
                      style={{
                        left: `${(edit.start / effectiveDuration) * 100}%`,
                        width: `${((edit.end - edit.start) / effectiveDuration) * 100}%`,
                      }}
                      title={`淡${edit.direction === "in" ? "入" : "出"}`}
                    >
                      {edit.direction === "in" ? "▶ 淡入" : "淡出 ◀"}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </footer>
      {tooltip.visible && (
        <div className="floating-tooltip" style={{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }}>
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
