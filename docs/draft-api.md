# Draft API 文档

## REST API

### GET /api/draft/:sessionId

获取指定会话的 Draft 状态。

**请求：**
```http
GET /api/draft/session-001
```

**响应：**
```json
{
  "success": true,
  "draft": {
    "version": 3,
    "lastModified": 1773393050803,
    "sources": { ... },
    "tracks": [ ... ],
    "settings": { ... }
  }
}
```

**错误：**
```json
{
  "success": false,
  "error": "Session not found"
}
```

---

### POST /api/update-draft

更新 Draft 状态。

**请求：**
```http
POST /api/update-draft
Content-Type: application/json

{
  "sessionId": "session-001",
  "changes": {
    "type": "add_segment",
    "data": {
      "trackId": "T1",
      "segment": {
        "timelineStart": 5.0,
        "timelineDuration": 3.0,
        "content": "Hello World",
        "style": { "position": "bottom" }
      }
    }
  }
}
```

**响应：**
```json
{
  "success": true,
  "draft": { ... }
}
```

**Changes 类型：**

#### add_segment
```json
{
  "type": "add_segment",
  "data": {
    "trackId": "V1",
    "segment": { ... }
  }
}
```

#### modify_segment
```json
{
  "type": "modify_segment",
  "data": {
    "segmentId": "seg-v-001",
    "modifications": {
      "playbackRate": 3.0,
      "volume": 0.8
    }
  }
}
```

#### delete_segment
```json
{
  "type": "delete_segment",
  "data": {
    "segmentId": "seg-t-001"
  }
}
```

#### replace_draft
```json
{
  "type": "replace_draft",
  "data": {
    "draft": { ... }
  }
}
```

---

### POST /api/analyze

分析视频并生成 Draft（自动）。

**请求：**
```http
POST /api/analyze
Content-Type: multipart/form-data

video: <file>
duration: 15.766667
request: "识别鸡蛋被捣碎的片段并加速到 2x"
pe: "短视频剪辑产品经理（PE）"
engine: "gemini"
sessionId: "session-001"  // 可选，用于多轮对话
```

**响应（SSE 流）：**
```
data: {"type":"progress","message":"🎬 收到请求，开始 ReAct 推理..."}

data: {"type":"progress","message":"🔍 分析视频内容..."}

data: {"type":"result","sessionId":"session-001","features":{...},"performance":{...}}
```

**Result 数据：**
```json
{
  "type": "result",
  "sessionId": "session-001",
  "source": "agent-loop",
  "features": {
    "duration": 15.766667,
    "segments": [ ... ],
    "events": [ ... ],
    "edits": [ ... ],
    "summary": "已将鸡蛋捣碎片段加速到 2 倍",
    "performance": {
      "totalTime": "25.3s",
      "rounds": 2,
      "tokensIn": 52874,
      "tokensOut": 575,
      "totalTokens": 53449,
      "cost": "$0.0712",
      "orchestratorCalls": 2,
      "videoAnalysisCalls": 1
    }
  }
}
```

**注意：** Draft 会自动生成并保存到 DraftManager，前端可通过 `GET /api/draft/:sessionId` 获取。

---

### POST /api/export

导出视频（支持 Draft 和 Timeline）。

**请求：**
```http
POST /api/export
Content-Type: multipart/form-data

video: <file>
sessionId: "session-001"  // 优先使用 Draft
timeline: {...}           // 兼容模式
colorAdjust: {...}
activeFilter: "none"
exportFormat: "original"
```

**响应（SSE 流）：**
```
data: {"type":"progress","percent":2,"message":"准备文件..."}

data: {"type":"progress","percent":20,"message":"开始视频编码..."}

data: {"type":"done","fileId":"export-1773393050803"}
```

---

## JavaScript API

### DraftManager

```javascript
import { getDraftManager } from "./server/draftManager.js";

const draftManager = getDraftManager();
```

#### getDraft(sessionId)

获取草稿。

```javascript
const draft = draftManager.getDraft("session-001");
```

#### updateDraft(sessionId, changes)

更新草稿。

```javascript
const draft = draftManager.updateDraft("session-001", {
  type: "add_segment",
  data: {
    trackId: "T1",
    segment: createTextSegment({
      timelineStart: 5.0,
      timelineDuration: 3.0,
      content: "Hello World"
    })
  }
});
```

#### readDraft(sessionId, includeHistory)

AI 读取草稿（带变更追踪）。

```javascript
const { draft, changesSince } = draftManager.readDraft("session-001");

console.log(changesSince.summary);
// "在 T1 轨道添加了片段 (5.0s-8.0s)"
```

#### clearSession(sessionId)

清理会话数据。

```javascript
draftManager.clearSession("session-001");
```

---

### Draft 工具（AI 使用）

这些工具由 AI 在 ReAct 循环中调用。

#### executeDraftTool(toolName, args, sessionId)

```javascript
import { executeDraftTool } from "./server/tools/draftTools.js";

// read_draft
const result = await executeDraftTool("read_draft", ["summary"], "session-001");

// add_segment
const result = await executeDraftTool("add_segment", [
  "T1",
  {
    timelineStart: 5.0,
    timelineDuration: 3.0,
    content: "Hello"
  }
], "session-001");

// modify_segment
const result = await executeDraftTool("modify_segment", [
  "seg-v-001",
  { playbackRate: 3.0 }
], "session-001");

// delete_segment
const result = await executeDraftTool("delete_segment", [
  "seg-t-001"
], "session-001");
```

---

### 数据模型工厂函数

```javascript
import {
  createEmptyDraft,
  createTrack,
  createVideoSegment,
  createTextSegment,
  createFadeSegment,
  createAudioSegment,
  addVideoSource,
  updateDraftDuration,
  TrackType,
  SegmentType
} from "./src/domain/draftModel.js";
```

#### createEmptyDraft()

```javascript
const draft = createEmptyDraft();
// { version: 1, sources: {}, tracks: [], settings: {...} }
```

#### createTrack(type, id)

```javascript
const videoTrack = createTrack(TrackType.VIDEO, "V1");
const textTrack = createTrack(TrackType.TEXT, "T1");
```

#### createVideoSegment(options)

```javascript
const segment = createVideoSegment({
  sourceId: "video-001",
  timelineStart: 0,
  timelineDuration: 5.0,
  sourceStart: 10.0,
  sourceEnd: 20.0,
  playbackRate: 2.0,
  volume: 1.0
});
```

#### createTextSegment(options)

```javascript
const segment = createTextSegment({
  timelineStart: 2.0,
  timelineDuration: 3.0,
  content: "Hello World",
  style: {
    fontSize: 48,
    color: "#ffffff",
    position: "bottom"
  }
});
```

#### createFadeSegment(options)

```javascript
const segment = createFadeSegment({
  timelineStart: 0,
  timelineDuration: 1.0,
  direction: "in",
  targetTrack: "V1"
});
```

#### addVideoSource(draft, videoFile)

```javascript
const sourceId = addVideoSource(draft, {
  name: "video.mp4",
  path: "/path/to/video.mp4",
  duration: 30.0,
  width: 1920,
  height: 1080,
  fps: 30
});
// 返回: "video-1773393050803"
```

#### updateDraftDuration(draft)

```javascript
updateDraftDuration(draft);
// 自动计算并更新 draft.settings.totalDuration
```

---

### 转换函数

#### aiOutputToDraft(aiOutput, videoSource, sessionId)

将 AI 输出转换为 Draft。

```javascript
import { aiOutputToDraft } from "./server/converters/aiToDraft.js";

const draft = aiOutputToDraft(
  {
    segments: [...],
    edits: [...]
  },
  {
    name: "video.mp4",
    path: "/path/to/video.mp4",
    duration: 30.0,
    width: 1920,
    height: 1080,
    fps: 30
  },
  "session-001"
);
```

#### draftToTimeline(draft)

将 Draft 转换为 Timeline（向后兼容）。

```javascript
import { draftToTimeline } from "./server/converters/draftToTimeline.js";

const timeline = draftToTimeline(draft);
// { clips: [...], textEdits: [...], fadeEdits: [...], bgmEdits: [...] }
```

#### draftToFFmpegCommand(draft, inputPath, outputPath, options)

将 Draft 转换为 FFmpeg 命令（预留）。

```javascript
import { draftToFFmpegCommand } from "./server/converters/draftToFFmpeg.js";

const result = draftToFFmpegCommand(
  draft,
  "/tmp/input.mp4",
  "/tmp/output.mp4",
  {
    colorAdjust: { brightness: 0, contrast: 0 },
    activeFilter: "none",
    exportFormat: "original"
  }
);
```

---

## 前端 API

### React Hooks

```javascript
// App.jsx
const [draft, setDraft] = useState(null);
const [sessionId, setSessionId] = useState(null);

// 获取 Draft
const fetchDraft = useCallback(async (sid) => {
  const response = await fetch(`${apiBase}/api/draft/${sid}`);
  const data = await response.json();
  if (data.success) {
    setDraft(data.draft);
  }
}, [apiBase]);

// 更新 Draft
const updateDraftLocally = useCallback(async (changes) => {
  const response = await fetch(`${apiBase}/api/update-draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, changes }),
  });
  const data = await response.json();
  if (data.success) {
    setDraft(data.draft);
  }
}, [sessionId, apiBase]);
```

### 使用示例

```javascript
// 分析完成后自动获取 Draft
if (data.sessionId) {
  setSessionId(data.sessionId);
  fetchDraft(data.sessionId);
}

// 手动修改 Draft
updateDraftLocally({
  type: "modify_segment",
  data: {
    segmentId: "seg-v-001",
    modifications: { playbackRate: 3.0 }
  }
});
```

---

## 错误处理

### 常见错误

#### Track not found
```json
{
  "error": "Track V1 not found"
}
```

**解决方案：** 确保 trackId 存在于 draft.tracks 中。

#### Segment overlaps
```json
{
  "error": "Segment overlaps with existing segment in track V1"
}
```

**解决方案：** 视频/音频轨道不允许片段重叠，调整 timelineStart 或 timelineDuration。

#### Segment not found
```json
{
  "error": "Segment seg-v-001 not found"
}
```

**解决方案：** 确保 segmentId 存在，可先调用 read_draft 查看所有 segments。

---

## 性能考虑

### Token 消耗

- **首次视频分析**: ~50000 tokens (input) + 500 tokens (output) ≈ $0.07
- **相对指令**: ~3000-4000 tokens per round ≈ $0.001-0.002
- **read_draft**: ~2000-3000 tokens (取决于 Draft 大小)

### 优化建议

1. **使用 summary 模式**: `read_draft("summary")` 比 `read_draft("full")` 节省 token
2. **批量操作**: 一次修改多个 segments 比多次单独修改更高效
3. **会话缓存**: 复用 sessionId 避免重复上传视频

---

## 示例代码

完整示例见：
- `server/tests/draftTest.js` - 单元测试
- `docs/draft-e2e-testing.md` - 端到端测试场景
- `docs/draft-architecture.md` - 架构详解
