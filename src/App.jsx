import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultIntent } from "./domain/models.js";
import { extractFeaturesFromVideo } from "./domain/featureExtractor.js";
import { buildTimeline } from "./domain/strategyEngine.js";
import { applyEditsToTimeline } from "./domain/applyEditsToTimeline.js";

const formatTime = (value) => {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export default function App() {
  const videoRef = useRef(null);
  const endTimeRef = useRef(null);
  const chatEndRef = useRef(null);
  const [file, setFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const [features, setFeatures] = useState(null);
  const [intent, setIntent] = useState(defaultIntent);
  const [timeline, setTimeline] = useState(null);
  const [activeClipId, setActiveClipId] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState("idle");
  const [analysisSource, setAnalysisSource] = useState("local");
  const [userRequest, setUserRequest] = useState("识别视频中鸡蛋被捣碎的时间起始点");
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
  const timelineRef = useRef(null);
  const previewContainerRef = useRef(null);
  const [videoArea, setVideoArea] = useState(null); // 视频在预览区的实际渲染位置和尺寸

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
  const combinedEdits = useMemo(
    () => [...(features?.edits || []), ...manualEdits],
    [features, manualEdits]
  );

  const appendChatMessage = (message) => {
    setChatMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, ...message },
    ]);
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(() => {
    if (!duration) return;
    const baseFeatures = features || extractFeaturesFromVideo(file, duration);
    const baseTimeline = buildTimeline(baseFeatures, intent);
    setTimeline(applyEditsToTimeline(baseTimeline, combinedEdits, duration));
  }, [features, intent, duration, combinedEdits, file]);

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
      const count = 25;
      const results = [];
      for (let i = 0; i < count; i += 1) {
        const time = Math.min(duration - 0.05, (duration / count) * i + 0.1);
        try {
          const image = await captureAt(time);
          if (!cancelled) results.push({ time, image });
        } catch (error) {
          if (!cancelled) results.push({ time, image: "" });
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
    setTimeline(null);
    setActiveClipId(null);
    setPrepareId(null);
    setPrepareStatus("idle");
    setManualEdits([]);
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
    endTimeRef.current = clip.end;
    videoRef.current.currentTime = clip.start;
    videoRef.current.playbackRate = clip.playbackRate || 1;
    videoRef.current.volume = clip.volume ?? 1;
    videoRef.current.play();
    playheadTimeRef.current = clip.start;
    setPlayheadTime(clip.start);
  };

  // 转换函数：素材时间 -> 轨道时间
  const mediaToTimeline = (mTime) => {
    if (!timeline || !timeline.clips) return mTime;
    const clip = timeline.clips.find(c => mTime >= c.start - 0.01 && mTime <= c.end + 0.01);
    if (!clip) return mTime;
    const offsetInClip = mTime - clip.start;
    return clip.timelineStart + (offsetInClip / (clip.playbackRate || 1));
  };

  // 转换函数：轨道时间 -> 素材时间
  const timelineToMedia = (tTime) => {
    if (!timeline || !timeline.clips) return tTime;
    const clip = timeline.clips.find(c => tTime >= c.timelineStart - 0.01 && tTime <= c.timelineStart + c.displayDuration + 0.01);
    if (!clip) return tTime;
    const offsetInTimeline = tTime - clip.timelineStart;
    return clip.start + (offsetInTimeline * (clip.playbackRate || 1));
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const currentTime = videoRef.current.currentTime;
    latestTimeRef.current = currentTime;
    
    // 动态倍率同步逻辑
    if (timeline && timeline.clips) {
      const currentClip = timeline.clips.find(
        clip => currentTime >= clip.start - 0.05 && currentTime <= clip.end + 0.05
      );
      
      if (currentClip) {
        const targetRate = currentClip.playbackRate || 1;
        if (videoRef.current.playbackRate !== targetRate) {
          videoRef.current.playbackRate = targetRate;
        }
        const targetVolume = currentClip.volume ?? 1;
        if (videoRef.current.volume !== targetVolume) {
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
      }
    }

    if (endTimeRef.current != null && currentTime >= endTimeRef.current - 0.05) {
      videoRef.current.pause();
      setIsPlaying(false);
      videoRef.current.playbackRate = 1;
      videoRef.current.volume = 1;
      endTimeRef.current = null;
    }

    if (!playheadRafRef.current) {
      playheadRafRef.current = requestAnimationFrame(() => {
        playheadRafRef.current = null;
        const latestTime = latestTimeRef.current;
        const nextPlayhead = mediaToTimeline(latestTime);
        if (Math.abs(nextPlayhead - playheadTimeRef.current) > 0.02) {
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
    } else {
      // 开始播放前预设正确的倍率
      if (timeline && timeline.clips) {
        const currentTime = videoRef.current.currentTime;
        const currentClip = timeline.clips.find(
          clip => currentTime >= clip.start - 0.05 && currentTime <= clip.end + 0.05
        );
        if (currentClip) {
          videoRef.current.playbackRate = currentClip.playbackRate || 1;
        }
      }
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimelineScrub = (e) => {
    if (!timeline || !timeline.totalTimelineDuration || !timelineRef.current || !videoRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    
    const targetTimelineTime = percentage * timeline.totalTimelineDuration;
    const targetMediaTime = timelineToMedia(targetTimelineTime);
    
    videoRef.current.currentTime = targetMediaTime;
    playheadTimeRef.current = targetTimelineTime;
    setPlayheadTime(targetTimelineTime);

    const targetClip = timeline.clips.find(
      (clip) => targetMediaTime >= clip.start - 0.05 && targetMediaTime <= clip.end + 0.05
    );
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

  const handleTimelineMouseDown = (e) => {
    isDraggingRef.current = true;
    handleTimelineScrub(e);
  };

  useEffect(() => {
    const handleGlobalMouseMove = (e) => {
      if (isDraggingRef.current) {
        handleTimelineScrub(e);
      }
    };
    const handleGlobalMouseUp = () => {
      isDraggingRef.current = false;
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [duration]);

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
    setChatMessages([]);
    setManualEdits([]);
    undoStackRef.current = [];
    redoStackRef.current = [];
    appendChatMessage({
      role: "user",
      time: new Date().toLocaleTimeString(),
      message: userRequest,
    });
    
    try {
      const formData = new FormData();
      formData.append("video", file);
      formData.append("duration", String(duration));
      formData.append("request", userRequest);
      formData.append("pe", pe);
      formData.append("isMock", isMock.toString());
      formData.append("engine", engine);
      if (prepareId) formData.append("prepareId", prepareId);

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

            appendChatMessage({
              role: "assistant",
              time: new Date().toLocaleTimeString(),
              message: summaryMessage,
            });

          } else if (payload.type === "error") {
            throw new Error(payload.message || "分析失败");
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
      const isUndo = (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z";
      const isRedo = (e.metaKey || e.ctrlKey) && (e.shiftKey && e.key.toLowerCase() === "z");
      if (isUndo) {
        e.preventDefault();
        handleUndo();
      }
      if (isRedo) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const getActiveClip = () => {
    if (!timeline?.clips?.length) return null;
    const byId = timeline.clips.find((clip) => clip.id === activeClipId);
    if (byId) return byId;
    const time = videoRef.current?.currentTime ?? 0;
    return (
      timeline.clips.find((clip) => time >= clip.start - 0.05 && time <= clip.end + 0.05) ||
      timeline.clips[0] ||
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
    if (!timeline || !file) return;
    setIsExporting(true);
    
    try {
      const formData = new FormData();
      formData.append("video", file);
      formData.append("timeline", JSON.stringify(timeline));

      const response = await fetch(`${apiBase}/api/export`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Export failed");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${file.name.split('.')[0]}_edited.mp4`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      appendChatMessage({
        role: "assistant",
        time: new Date().toLocaleTimeString(),
        message: "✅ 视频导出成功！已利用 Mac 硬件加速完成渲染。",
      });
    } catch (error) {
      console.error("Export error:", error);
      appendChatMessage({
        role: "system",
        time: new Date().toLocaleTimeString(),
        message: "❌ 导出失败，请检查后端 FFmpeg 配置。",
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="capcut-editor">
      <header className="editor-header">
        <div className="header-left">
          <div className="app-logo">C</div>
          <nav className="header-nav">
            <span>Transcript</span>
            <span className="active">Media</span>
          </nav>
        </div>
        <div className="header-center">
          项目识别 - {file?.name || "未命名"}
        </div>
        <div className="header-right">
          <button 
            className={`btn-export ${isExporting ? 'exporting' : ''}`} 
            onClick={handleExport} 
            disabled={!timeline || isExporting}
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

          <div className="sidebar-middle">
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
          </div>

          <div className="sidebar-bottom">
            <div className="pe-input-area">
              <input 
                type="text" 
                value={pe} 
                onChange={(e) => setPe(e.target.value)} 
                placeholder="Persona/PE: 剪辑产品经理..."
              />
            </div>
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
                  <option value="doubao">Doubao Seed 2.0</option>
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
                  }}
                />
                {videoRef.current && videoRef.current.playbackRate !== 1 && (
                  <div className="playback-speed-overlay">
                    {videoRef.current.playbackRate}x
                  </div>
                )}
                {videoArea && timeline?.textEdits?.map((edit, i) => {
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
            <span className="time-display">{formatTime(playheadTime)} / {formatTime(timeline?.totalTimelineDuration || duration)}</span>
          </div>
        </section>
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
            <span>100%</span>
          </div>
        </div>

        <div 
          className="timeline-container" 
          ref={timelineRef}
          onMouseDown={handleTimelineMouseDown}
        >
          <div className="timeline-ruler">
            {/* Simple ruler markers */}
            {Array.from({ length: 10 }).map((_, i) => (
              <span key={i} className="ruler-mark" style={{ left: `${i * 10}%` }}>
                {formatTime(((timeline?.totalTimelineDuration || duration) / 10) * i)}
              </span>
            ))}
            <div 
              className="timeline-playhead" 
              style={{ left: `${(playheadTime / (timeline?.totalTimelineDuration || duration || 1)) * 100}%` }}
            />
          </div>

          <div className="timeline-tracks">
            <div className="track track-v1">
              <div className="track-id">V1</div>
              <div className="track-content">
                {timeline && timeline.clips && timeline.clips.length > 0 ? (
                  timeline.clips.map((clip, i) => (
                    <div 
                      key={clip.id}
                      className={`video-clip-segment ${activeClipId === clip.id ? 'active' : ''}`}
                      style={{ 
                        left: `${(clip.timelineStart / timeline.totalTimelineDuration) * 100}%`,
                        width: `${(clip.displayDuration / timeline.totalTimelineDuration) * 100}%`,
                        opacity: clip.playbackRate !== 1 ? 0.8 : 1
                      }}
                      onClick={() => handleClipPlay(clip)}
                    >
                      <div className="clip-thumb-overlay">
                        {thumbnails.length > 0 ? (
                          thumbnails
                            .filter(t => t.time >= clip.start - 0.5 && t.time <= clip.end + 0.5)
                            .slice(0, 5) // 限制每个片段显示的缩略图数量，避免性能问题
                            .map((t, idx) => (
                              <img key={idx} src={t.image} alt="" />
                            ))
                        ) : null}
                      </div>
                      {clip.playbackRate && clip.playbackRate !== 1 && (
                        <div className="clip-speed-tag">⚡ {clip.playbackRate}x</div>
                      )}
                      <div className="clip-label">{`Clip ${i+1}`}</div>
                      {clip.edit && <div className="clip-edit-reason">{clip.edit.type}</div>}
                    </div>
                  ))
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

            <div className="track track-events">
              <div className="track-id">E1</div>
              <div className="track-content">
                {features?.events?.map((ev, i) => {
                  const tStart = mediaToTimeline(ev.start);
                  const tEnd = mediaToTimeline(ev.end);
                  const tDuration = timeline?.totalTimelineDuration || duration;
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
                {timeline?.textEdits?.map((edit, i) => {
                  const tDuration = timeline.totalTimelineDuration || duration;
                  return (
                    <div
                      key={i}
                      className="text-edit-node"
                      style={{
                        left: `${(edit.timelineStart / tDuration) * 100}%`,
                        width: `${((edit.timelineEnd - edit.timelineStart) / tDuration) * 100}%`,
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
                {timeline?.fadeEdits?.map((edit, i) => {
                  const tDuration = timeline.totalTimelineDuration || duration;
                  return (
                    <div
                      key={i}
                      className={`fade-edit-node fade-${edit.direction}`}
                      style={{
                        left: `${(edit.timelineStart / tDuration) * 100}%`,
                        width: `${((edit.timelineEnd - edit.timelineStart) / tDuration) * 100}%`,
                      }}
                      title={`淡${edit.direction === "in" ? "入" : "出"}`}
                    >
                      {edit.direction === "in" ? "▶ 淡入" : "淡出 ◀"}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="track track-a1">
              <div className="track-id">A1</div>
              <div className="track-content">
                <div className="waveform-placeholder" />
              </div>
            </div>

            {timeline?.bgmEdits?.length > 0 && (
              <div className="track track-bgm">
                <div className="track-id">B1</div>
                <div className="track-content">
                  {timeline.bgmEdits.map((edit, i) => (
                    <div
                      key={i}
                      className="bgm-edit-node"
                      style={{ left: 0, width: "100%" }}
                      title={`BGM: ${edit.keywords} (vol: ${edit.volume ?? 0.3})`}
                    >
                      <span className="bgm-label">♪ {edit.keywords}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
