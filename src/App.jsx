import { useEffect, useMemo, useRef, useState } from "react";
import { defaultIntent } from "./domain/models.js";
import { extractFeaturesFromVideo } from "./domain/featureExtractor.js";
import { buildTimeline } from "./domain/strategyEngine.js";

const formatTime = (value) => {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const applyEditsToTimeline = (timeline, edits) => {
  if (!timeline) return timeline;
  if (!edits || edits.length === 0) return timeline;
  const clips = timeline.clips.map((clip) => {
    const edit = edits.find(
      (entry) => entry.start < clip.end && entry.end > clip.start
    );
    if (!edit) return { ...clip, playbackRate: 1 };
    return {
      ...clip,
      playbackRate: edit.rate || 1,
      edit,
    };
  });
  return {
    ...timeline,
    clips,
  };
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
  const isDraggingRef = useRef(false);
  const timelineRef = useRef(null);
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
    setTimeline(applyEditsToTimeline(baseTimeline, features.edits || []));
  }, [features, intent]);

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
  };

  const handleClipPlay = (clip) => {
    if (!videoRef.current) return;
    setActiveClipId(clip.id);
    endTimeRef.current = clip.end;
    videoRef.current.currentTime = clip.start;
    videoRef.current.playbackRate = clip.playbackRate || 1;
    videoRef.current.play();
    setPlayheadTime(clip.start);
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    setPlayheadTime(videoRef.current.currentTime);
    
    if (endTimeRef.current != null && videoRef.current.currentTime >= endTimeRef.current - 0.05) {
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
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimelineScrub = (e) => {
    if (!duration || !timelineRef.current || !videoRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    const newTime = percentage * duration;
    videoRef.current.currentTime = newTime;
    setPlayheadTime(newTime);
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
      
      setFeatures(data.features);
      setAnalysisSource(data.source || "server");
      setAnalysisStatus("done");
      
      appendChatMessage({
        role: "assistant",
        time: new Date().toLocaleTimeString(),
        message: `识别完成！找到 ${data.features?.events?.length || 0} 个事件和 ${data.features?.segments?.length || 0} 个片段。`,
      });
    } catch (error) {
      const fallback = extractFeaturesFromVideo(file, duration);
      setFeatures(fallback);
      setAnalysisSource("local");
      setAnalysisStatus("error");
      appendChatMessage({
        role: "system",
        time: new Date().toLocaleTimeString(),
        message: "识别异常，已切换为本地基础解析。",
      });
    }
  };

  const handleExport = () => {
    if (!timeline) return;
    const blob = new Blob([JSON.stringify({ timeline, features }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "timeline-export.json";
    link.click();
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
          <button className="btn-export" onClick={handleExport} disabled={!timeline}>Export</button>
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
          <div className="preview-container">
            {videoUrl ? (
              <video 
                ref={videoRef} 
                src={videoUrl} 
                onLoadedMetadata={handleMetadataLoaded}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />
            ) : (
              <div className="preview-placeholder">上传视频以开始</div>
            )}
          </div>
          <div className="preview-controls">
            <button className="btn-play-pause" onClick={togglePlay} disabled={!videoUrl}>
              {isPlaying ? "⏸" : "▶️"}
            </button>
            <span className="time-display">{formatTime(playheadTime)} / {formatTime(duration)}</span>
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
                {formatTime((duration / 10) * i)}
              </span>
            ))}
            <div 
              className="timeline-playhead" 
              style={{ left: `${(playheadTime / (duration || 1)) * 100}%` }}
            />
          </div>

          <div className="timeline-tracks">
            <div className="track track-v1">
              <div className="track-id">V1</div>
              <div className="track-content">
                {file && (
                  <div className="video-clip-bar">
                    <div className="thumb-strip">
                      {thumbnails.map((t, i) => (
                        <img key={i} src={t.image} alt="" />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="track track-events">
              <div className="track-id">E1</div>
              <div className="track-content">
                {features?.events?.map((ev, i) => (
                  <div 
                    key={i} 
                    className="event-node"
                    style={{ 
                      left: `${(ev.start / duration) * 100}%`,
                      width: `${((ev.end - ev.start) / duration) * 100}%`
                    }}
                    onClick={() => handleEventPreview(ev)}
                    title={ev.label}
                  >
                    {ev.label}
                  </div>
                ))}
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
