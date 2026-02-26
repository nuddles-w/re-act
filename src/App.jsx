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
    if (!features) return;
    const baseTimeline = buildTimeline(features, intent);
    setTimeline(applyEditsToTimeline(baseTimeline, features.edits || [], duration));
  }, [features, intent, duration]);

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
    endTimeRef.current = clip.end;
    videoRef.current.currentTime = clip.start;
    videoRef.current.playbackRate = clip.playbackRate || 1;
    videoRef.current.play();
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
    
    // 更新轨道上的播放头位置（转换为轨道时间）
    setPlayheadTime(mediaToTimeline(currentTime));
    
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
        if (activeClipId !== currentClip.id) {
          setActiveClipId(currentClip.id);
        }
      } else {
        if (videoRef.current.playbackRate !== 1) {
          videoRef.current.playbackRate = 1;
        }
        setActiveClipId(null);
      }
    }

    if (endTimeRef.current != null && currentTime >= endTimeRef.current - 0.05) {
      videoRef.current.pause();
      setIsPlaying(false);
      videoRef.current.playbackRate = 1;
      endTimeRef.current = null;
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
    setPlayheadTime(targetTimelineTime);
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
    setPlayheadTime(event.start);
  };

  const analyzeVideo = async () => {
    if (!file || !duration) return;
    setAnalysisStatus("analyzing");
    setChatMessages([]);
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

      const response = await fetch(`${apiBase}/api/analyze`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Backend error");

      const data = await response.json();
      if (Array.isArray(data.debugTimeline)) {
        data.debugTimeline.forEach((entry) => {
          appendChatMessage({
            role: "system",
            time: new Date().toLocaleTimeString(),
            message: entry.message,
          });
        });
      }
      
      setFeatures(prev => ({
        ...data.features,
        // 如果新结果里没有片段，保留之前的片段特征
        segments: (data.features.segments && data.features.segments.length > 0) 
          ? data.features.segments 
          : (prev?.segments || [])
      }));
      setAnalysisSource(data.source || "server");
      setAnalysisStatus("done");
      
      // 展示 Agent 的推理过程
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

      if (data.rawResponse) {
        appendChatMessage({
          role: "assistant",
          time: new Date().toLocaleTimeString(),
          message: `模型原始返回：\n${data.rawResponse}`,
        });
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
          ? "⚠️ Gemini API 配额已耗尽（429）。建议勾选下方“Mock 调试模式”继续验证 UI 逻辑。"
          : "识别异常，已切换为本地基础解析。",
      });
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
          <div className="toolbar-left">
            <button className="tool-btn">✂️</button>
            <button className="tool-btn">↶</button>
            <button className="tool-btn">↷</button>
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
          </div>
        </div>
      </footer>
    </div>
  );
}
