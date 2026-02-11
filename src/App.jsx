import { useEffect, useMemo, useRef, useState } from "react";
import { defaultIntent } from "./domain/models.js";
import { extractFeaturesFromVideo } from "./domain/featureExtractor.js";
import { buildTimeline } from "./domain/strategyEngine.js";

const formatTime = (value) => {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const buildIntentOptions = () => [
  { value: "balanced", label: "均衡" },
  { value: "fast", label: "节奏快" },
  { value: "slow", label: "节奏慢" },
];

const buildFocusOptions = () => [
  { value: "none", label: "不指定" },
  { value: "face", label: "人物优先" },
  { value: "action", label: "动作优先" },
];

const buildTemplateOptions = () => [
  { value: "general", label: "通用" },
  { value: "vlog", label: "Vlog" },
  { value: "sport", label: "运动" },
  { value: "story", label: "剧情" },
];

export default function App() {
  const videoRef = useRef(null);
  const endTimeRef = useRef(null);
  const [file, setFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const [features, setFeatures] = useState(null);
  const [intent, setIntent] = useState(defaultIntent);
  const [timeline, setTimeline] = useState(null);
  const [activeClipId, setActiveClipId] = useState(null);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(() => {
    if (!features) return;
    setTimeline(buildTimeline(features, intent));
  }, [features, intent]);

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
    setFeatures(extractFeaturesFromVideo(file, nextDuration));
  };

  const handleIntentChange = (field, value) => {
    setIntent((prev) => ({ ...prev, [field]: value }));
  };

  const handleClipPlay = (clip) => {
    if (!videoRef.current) return;
    setActiveClipId(clip.id);
    endTimeRef.current = clip.end;
    videoRef.current.currentTime = clip.start;
    videoRef.current.play();
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current || endTimeRef.current == null) return;
    if (videoRef.current.currentTime >= endTimeRef.current - 0.05) {
      videoRef.current.pause();
      endTimeRef.current = null;
    }
  };

  const intentOptions = useMemo(buildIntentOptions, []);
  const focusOptions = useMemo(buildFocusOptions, []);
  const templateOptions = useMemo(buildTemplateOptions, []);

  const handleExportTimeline = () => {
    if (!timeline || !features) return;
    const payload = {
      intent,
      features: {
        duration: features.duration,
        segmentCount: features.segmentCount,
        rhythmScore: features.rhythmScore,
      },
      timeline,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${file?.name || "video"}-timeline.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>React 视频剪辑架构</h1>
          <p>基于视频特征与用户诉求生成剪辑时间线</p>
        </div>
        <label className="upload">
          上传视频
          <input type="file" accept="video/*" onChange={handleFileChange} />
        </label>
      </header>

      <main className="app__content">
        <section className="panel">
          <h2>预览与诉求</h2>
          <div className="video-card">
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                onLoadedMetadata={handleMetadataLoaded}
                onTimeUpdate={handleTimeUpdate}
              />
            ) : (
              <div className="video-placeholder">请选择一个视频文件</div>
            )}
            <div className="intent">
              <div className="field">
                <label>目标时长（秒）</label>
                <input
                  type="number"
                  min="5"
                  max={Math.ceil(duration || 60)}
                  value={intent.targetDuration}
                  onChange={(event) =>
                    handleIntentChange("targetDuration", Number(event.target.value))
                  }
                />
              </div>
              <div className="field">
                <label>剪辑节奏</label>
                <select
                  value={intent.style}
                  onChange={(event) => handleIntentChange("style", event.target.value)}
                >
                  {intentOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>关注主体</label>
                <select
                  value={intent.focus}
                  onChange={(event) => handleIntentChange("focus", event.target.value)}
                >
                  {focusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>剪辑模板</label>
                <select
                  value={intent.template}
                  onChange={(event) => handleIntentChange("template", event.target.value)}
                >
                  {templateOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={intent.keepStart}
                    onChange={(event) =>
                      handleIntentChange("keepStart", event.target.checked)
                    }
                  />
                  保留开场
                </label>
              </div>
              <div className="field checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={intent.keepEnd}
                    onChange={(event) =>
                      handleIntentChange("keepEnd", event.target.checked)
                    }
                  />
                  保留结尾
                </label>
              </div>
              <div className="field hint">
                {features ? (
                  <span>
                    已解析 {features.segmentCount} 个片段，总时长{" "}
                    {formatTime(features.duration)}
                  </span>
                ) : (
                  <span>等待视频解析</span>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>剪辑时间线</h2>
          {timeline ? (
            <>
              <div className="timeline-summary">
                <span>目标时长：{formatTime(timeline.targetDuration)}</span>
                <span>已选片段：{timeline.clips.length}</span>
                <span>累计时长：{formatTime(timeline.totalDuration)}</span>
                <button type="button" className="action" onClick={handleExportTimeline}>
                  导出剪辑方案
                </button>
              </div>
              <div className="clip-list">
                {timeline.clips.map((clip) => (
                  <button
                    key={clip.id}
                    type="button"
                    className={clip.id === activeClipId ? "clip active" : "clip"}
                    onClick={() => handleClipPlay(clip)}
                  >
                    <div>
                      {formatTime(clip.start)} - {formatTime(clip.end)}
                    </div>
                    <div className="clip-meta">
                      <span>能量 {clip.energy.toFixed(2)}</span>
                      <span>{clip.reason}</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="empty">请上传视频后生成时间线</div>
          )}
        </section>

        <section className="panel">
          <h2>特征概览</h2>
          {features ? (
            <div className="feature-grid">
              <div className="feature-card summary">
                <div className="feature-time">全局特征</div>
                <div className="feature-tags">
                  <span>节奏指数 {features.rhythmScore.toFixed(2)}</span>
                  <span>片段数 {features.segmentCount}</span>
                </div>
              </div>
              {features.segments.map((segment) => (
                <div key={segment.id} className="feature-card">
                  <div className="feature-time">
                    {formatTime(segment.start)} - {formatTime(segment.end)}
                  </div>
                  <div className="feature-tags">
                    <span>能量 {segment.energy.toFixed(2)}</span>
                    <span>{segment.tags.hasFace ? "有人物" : "无人物"}</span>
                    <span>{segment.tags.hasAction ? "有动作" : "无动作"}</span>
                    <span>{segment.tags.hasDialogue ? "有对白" : "无对白"}</span>
                    <span>运动 {segment.tags.motionScore.toFixed(2)}</span>
                    <span>对白密度 {segment.tags.speechDensity.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">等待生成特征</div>
          )}
        </section>
      </main>
    </div>
  );
}
