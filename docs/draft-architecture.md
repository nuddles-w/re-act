# Draft 架构详细文档

## 概述

Draft 架构是一个专业的多轨道视频编辑数据模型，灵感来自 Premiere Pro 和 Final Cut Pro。它支持多轮对话、增量更新和复杂的编辑操作。

## 核心概念

### Draft（草稿）

Draft 是剪辑项目的完整状态，包含：

```javascript
{
  version: 1,                    // 版本号，每次修改 +1
  lastModified: 1773393050803,   // 最后修改时间戳
  sources: {                     // 源素材库
    "video-001": {
      type: "video",
      path: "/path/to/video.mp4",
      duration: 30.0,
      metadata: { width: 1920, height: 1080, fps: 30 }
    }
  },
  tracks: [                      // 多轨道
    { id: "V1", type: "video", segments: [...] },
    { id: "T1", type: "text", segments: [...] },
    { id: "FX1", type: "effect", segments: [...] },
    { id: "A1", type: "audio", segments: [...] }
  ],
  settings: {
    totalDuration: 15.0,
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    aspectRatio: "16:9"
  }
}
```

### Track（轨道）

轨道是 segments 的容器，有四种类型：

1. **video** - 视频轨道
2. **audio** - 音频轨道
3. **text** - 文字轨道
4. **effect** - 效果轨道（淡入淡出、滤镜等）

```javascript
{
  id: "V1",
  type: "video",
  enabled: true,
  locked: false,
  segments: [...]
}
```

### Segment（片段）

Segment 是轨道上的基本单元，不同类型有不同的字段：

#### 视频 Segment
```javascript
{
  id: "seg-v-001",
  type: "video",
  sourceId: "video-001",

  // Timeline 维度
  timelineStart: 0,
  timelineDuration: 5.0,

  // Source 维度
  sourceStart: 10.0,
  sourceEnd: 20.0,

  // 变换
  playbackRate: 2.0,
  volume: 1.0,
  transform: {
    scale: 1.0,
    x: 0, y: 0,
    rotate: 0,
    crop: { top: 0, right: 0, bottom: 0, left: 0 }
  },
  filters: {
    brightness: 0,
    contrast: 0,
    saturation: 0
  }
}
```

#### 文字 Segment
```javascript
{
  id: "seg-t-001",
  type: "text",
  timelineStart: 2.0,
  timelineDuration: 3.0,
  content: "Hello World",
  style: {
    fontSize: 48,
    color: "#ffffff",
    position: "bottom",
    fontFamily: "Arial"
  }
}
```

#### 效果 Segment
```javascript
{
  id: "seg-fx-001",
  type: "fade",
  effectType: "fade",
  timelineStart: 0,
  timelineDuration: 1.0,
  direction: "in",
  targetTrack: "V1"
}
```

## DraftManager

DraftManager 是单例状态管理器，负责：

### 核心功能

1. **状态管理**
   - `getDraft(sessionId)` - 获取草稿
   - `updateDraft(sessionId, changes)` - 更新草稿
   - `readDraft(sessionId, includeHistory)` - AI 读取草稿

2. **变更追踪**
   - 每次修改保存快照
   - 计算 diff（added, modified, deleted）
   - 生成人类可读的变更摘要

3. **历史管理**
   - 保留最近 20 个快照
   - 支持撤销/重做（预留）

### 使用示例

```javascript
import { getDraftManager } from "./draftManager.js";

const draftManager = getDraftManager();

// 获取草稿
const draft = draftManager.getDraft("session-001");

// 更新草稿
draftManager.updateDraft("session-001", {
  type: "add_segment",
  data: {
    trackId: "V1",
    segment: createVideoSegment({...})
  }
});

// AI 读取草稿
const { draft, changesSince } = draftManager.readDraft("session-001");
console.log(changesSince.summary); // "在 V1 轨道添加了片段 (0.0s-5.0s)"
```

## AI 工具集成

### 工具列表

#### 1. read_draft
读取当前草稿状态。

**何时使用：**
- ✅ 相对指令（"再快一点"）
- ✅ 指代词（"刚才那个"）
- ✅ 批量操作（"所有文字"）
- ✅ 修改现有内容

**何时不用：**
- ❌ 首次分析视频
- ❌ 添加全新元素

**示例：**
```javascript
// AI 调用
read_draft("summary")

// 返回
{
  summary: {
    totalDuration: 15.0,
    tracks: [
      { id: "V1", type: "video", segmentCount: 3 },
      { id: "T1", type: "text", segmentCount: 1 }
    ]
  },
  changesSince: {
    summary: "修改了片段 seg-v-001: playbackRate"
  }
}
```

#### 2. add_segment
添加片段到轨道。

```javascript
// AI 调用
add_segment("T1", {
  timelineStart: 5.0,
  timelineDuration: 3.0,
  content: "Hello World",
  style: { position: "bottom" }
})

// 返回
{
  ok: true,
  segment_id: "seg-t-001"
}
```

#### 3. modify_segment
修改现有片段。

```javascript
// AI 调用
modify_segment("seg-v-001", { playbackRate: 3.0 })

// 返回
{
  ok: true,
  modifications: ["playbackRate"]
}
```

#### 4. delete_segment
删除片段。

```javascript
// AI 调用
delete_segment("seg-t-001")

// 返回
{
  ok: true
}
```

#### 5. split_segment
分割片段。

```javascript
// AI 调用
split_segment("seg-v-001", 2.5)

// 返回
{
  ok: true,
  new_segments: ["seg-v-001-1", "seg-v-001-2"]
}
```

#### 6. move_segment
移动片段。

```javascript
// AI 调用
move_segment("seg-t-001", 10.0)

// 返回
{
  ok: true
}
```

### 智能引导

系统会根据用户指令自动提示 AI 是否需要读取 Draft：

```javascript
// 检测相对指令
if (/再|更|继续/.test(request)) {
  提示: "⚠️ 此指令可能需要当前草稿的详细信息，建议先调用 read_draft()"
}
```

## 多轮对话流程

### 场景 1: 首次分析

```
User: "识别鸡蛋被捣碎的片段并加速到 2x"

AI Round 1:
  Thought: 需要分析视频内容
  Action: analyze_video("鸡蛋被捣碎")
  Observation: { events: [...], 鸡蛋捣碎在 2.9s-8.5s }

AI Round 2:
  Thought: 应用 2x 速度
  Final Answer: "已将鸡蛋捣碎片段加速到 2 倍"
  Edits: [{ type: "speed", start: 2.9, end: 8.5, rate: 2.0 }]

→ aiOutputToDraft() 转换为 Draft
→ DraftManager 保存
→ 前端显示 Draft 状态
```

### 场景 2: 相对指令

```
User: "再快一点"

[系统自动注入]
草稿概览:
- 总时长: 13.0s
- 视频片段: 3 个
💡 如需详细信息，使用 read_draft() 工具

⚠️ 提示：此指令可能需要当前草稿的详细信息

AI Round 1:
  Thought: "再快一点"是相对指令，需要知道当前速度
  Action: read_draft()
  Observation: {
    tracks: [
      { id: "V1", segments: [
        { id: "seg-v-002", playbackRate: 2.0, ... }
      ]}
    ]
  }

AI Round 2:
  Thought: 当前是 2x，改为 3x
  Action: modify_segment("seg-v-002", { playbackRate: 3.0 })
  Observation: { ok: true }

AI Round 3:
  Final Answer: "已将速度提升到 3 倍"

→ DraftManager 更新
→ 版本号 +1
→ 变更历史记录
```

### 场景 3: 指代消解

```
User: "把刚才那个删掉"

AI Round 1:
  Thought: "刚才那个"需要查看 Draft 找到最近添加的
  Action: read_draft()
  Observation: {
    tracks: [
      { id: "T1", segments: [
        { id: "seg-t-001", addedAt: 1773393050803 },
        { id: "seg-t-002", addedAt: 1773393060123 }  ← 最新
      ]}
    ]
  }

AI Round 2:
  Thought: "刚才那个"指的是 seg-t-002
  Action: delete_segment("seg-t-002")
  Observation: { ok: true }

AI Round 3:
  Final Answer: "已删除文字"
```

## 转换层

### AI 输出 → Draft

`aiOutputToDraft()` 将 AI 的 segments 和 edits 转换为 Draft 结构：

```javascript
// AI 输出
{
  segments: [
    { start: 0, end: 5, energy: 0.8 },
    { start: 10, end: 15, energy: 0.9 }
  ],
  edits: [
    { type: "speed", start: 0, end: 5, rate: 2.0 },
    { type: "text", start: 2, end: 5, text: "Hello" },
    { type: "fade", start: 0, end: 1, direction: "in" }
  ]
}

// 转换为 Draft
{
  tracks: [
    {
      id: "V1",
      type: "video",
      segments: [
        { timelineStart: 0, timelineDuration: 2.5, sourceStart: 0, sourceEnd: 5, playbackRate: 2.0 },
        { timelineStart: 2.5, timelineDuration: 5.0, sourceStart: 10, sourceEnd: 15, playbackRate: 1.0 }
      ]
    },
    {
      id: "T1",
      type: "text",
      segments: [
        { timelineStart: 2, timelineDuration: 3, content: "Hello" }
      ]
    },
    {
      id: "FX1",
      type: "effect",
      segments: [
        { timelineStart: 0, timelineDuration: 1, effectType: "fade", direction: "in" }
      ]
    }
  ]
}
```

### Draft → Timeline（向后兼容）

`draftToTimeline()` 将 Draft 转换为旧的 Timeline 格式，保证现有前端代码继续工作：

```javascript
// Draft
{
  tracks: [
    { id: "V1", type: "video", segments: [...] },
    { id: "T1", type: "text", segments: [...] }
  ]
}

// Timeline
{
  clips: [...],           // 从 V1 轨道转换
  textEdits: [...],       // 从 T1 轨道转换
  fadeEdits: [...],       // 从 FX1 轨道转换
  totalDuration: 15.0
}
```

## API 端点

### GET /api/draft/:sessionId
获取指定会话的 Draft。

**响应：**
```json
{
  "success": true,
  "draft": { ... }
}
```

### POST /api/update-draft
更新 Draft。

**请求：**
```json
{
  "sessionId": "session-001",
  "changes": {
    "type": "modify_segment",
    "data": {
      "segmentId": "seg-v-001",
      "modifications": { "playbackRate": 3.0 }
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

## 性能考虑

### Token 优化
- 轻量级上下文提示（不是完整 Draft）
- AI 按需读取，避免每轮都注入
- summary 模式返回简化版本

### 查询效率
- 使用 Map 存储 drafts（O(1) 查找）
- Segment 查找使用 find（小数据量可接受）
- 大量 segments 时考虑索引优化

### 内存管理
- 只保留最近 20 个快照
- 定期清理过期会话
- 考虑持久化到数据库（未来）

## 扩展性

Draft 架构为未来功能扩展提供了基础：

1. **画中画** - 添加多个 video 轨道
2. **多视频叠加** - V1, V2, V3 轨道
3. **复杂特效** - 扩展 effect 轨道类型
4. **音频混音** - 多个 audio 轨道
5. **关键帧动画** - 在 segment 中添加 keyframes 字段
6. **协作编辑** - 基于 diff 的冲突解决

## 最佳实践

1. **始终通过 DraftManager 操作 Draft**
   - 不要直接修改 draft 对象
   - 使用 updateDraft() 确保变更追踪

2. **合理使用 read_draft**
   - 首次分析不需要读取
   - 相对指令必须读取
   - 批量操作必须读取

3. **保持 segment ID 唯一**
   - 使用时间戳 + 随机数
   - 不要重用已删除的 ID

4. **及时更新 totalDuration**
   - 每次修改后调用 updateDraftDuration()
   - 确保时间轴长度正确

5. **处理边界情况**
   - timelineStart 不能为负
   - timelineDuration 必须 > 0
   - sourceStart < sourceEnd

## 故障排查

### Draft 未生成
- 检查 sessionId 是否传递
- 检查 aiOutputToDraft 是否被调用
- 查看后端日志：`[analyze] draft created`

### 变更未追踪
- 确认使用 updateDraft() 而非直接修改
- 检查 changes 对象格式是否正确
- 查看 DraftManager 日志

### AI 未读取 Draft
- 检查智能引导是否生效
- 查看系统提示词是否包含 read_draft 说明
- 验证 AI 的 thought 是否提到需要读取

## 参考资料

- `docs/draft-implementation-summary.md` - 实施总结
- `docs/draft-e2e-testing.md` - 端到端测试
- `server/tests/draftTest.js` - 单元测试
- `src/domain/draftModel.js` - 数据模型源码
- `server/draftManager.js` - 状态管理器源码
