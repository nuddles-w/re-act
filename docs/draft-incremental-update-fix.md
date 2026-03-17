# Draft 增量更新修复

## 问题描述

**症状**：用户进行完一轮对话后，再进行对话时会重新开始，且之前添加的效果都会被抹除。

**根本原因**：每次对话都会调用 `aiOutputToDraft()` 生成全新的 Draft，然后通过 `replace_draft` 完全覆盖现有 Draft，导致之前的编辑丢失。

## 修复方案

采用**混合方案**：让 AI 通过 Draft Tools 进行增量操作，同时保留向后兼容。

### 核心改动

#### 1. `server/index.js` - 修改 Draft 初始化逻辑

**之前**：
```javascript
// 每次都转换 AI 输出为 Draft 并替换
if (result.features && newSessionId) {
  const draft = await aiOutputToDraft(result.features, videoSource, newSessionId, emitProgress);
  draftManager.updateDraft(newSessionId, {
    type: "replace_draft",
    data: { draft },
  });
}
```

**之后**：
```javascript
// 仅首次会话初始化 Draft
if (!existingSession && newSessionId) {
  // 如果 AI 输出了传统 edits，转换为 Draft（向后兼容）
  if (result.features && (result.features.edits?.length > 0 || result.features.segments?.length > 0)) {
    const draft = await aiOutputToDraft(result.features, videoSource, newSessionId, emitProgress);
    draftManager.updateDraft(newSessionId, { type: "replace_draft", data: { draft } });
  }
  // 否则 AI 已通过工具操作 Draft
} else if (existingSession) {
  // 多轮对话：Draft 由 AI 通过工具直接操作
}
```

**关键变化**：
- 只在首次会话时初始化 Draft
- 多轮对话时，Draft 由 AI 通过 `add_segment`/`modify_segment`/`delete_segment` 工具直接操作
- 保留向后兼容：如果 AI 输出传统 edits，仍然转换

#### 2. `server/draftManager.js` - 初始化基础轨道

**改动**：
```javascript
getDraft(sessionId) {
  if (!this.drafts.has(sessionId)) {
    const emptyDraft = createEmptyDraft();
    // 初始化基础轨道
    emptyDraft.tracks = [
      { id: "V1", type: "video", enabled: true, locked: false, segments: [] },
      { id: "A1", type: "audio", enabled: true, locked: false, segments: [] },
      { id: "T1", type: "text", enabled: true, locked: false, segments: [] },
      { id: "FX1", type: "effect", enabled: true, locked: false, segments: [] },
    ];
    this.drafts.set(sessionId, emptyDraft);
  }
  return this.drafts.get(sessionId);
}
```

**目的**：确保每个会话都有标准的轨道结构，AI 可以直接使用 `V1`/`A1`/`T1`/`FX1` 轨道 ID。

#### 3. `server/providers/agentProtocol.js` - 优化 AI Prompt

**新增提示**：
```
**多轮对话重要提示**：
- ✅ 用户的每次请求都是在现有编辑基础上的增量修改
- ✅ 使用 read_draft 查看当前状态，然后只修改/添加用户要求的部分
- ❌ 不要重新生成完整的 segments/edits，这会覆盖之前的所有编辑
```

**目的**：明确告知 AI 要进行增量操作，而不是每次生成完整方案。

#### 4. `server/tools/draftTools.js` - 增强 segment 类型推断

**改动**：
```javascript
// 确保 segment 有 type 字段
if (!segment.type) {
  const trackType = trackId.charAt(0).toLowerCase();
  if (trackType === 'v') segment.type = 'video';
  else if (trackType === 'a') segment.type = 'audio';
  else if (trackType === 't') segment.type = 'text';
  else if (trackType === 'f') segment.type = 'fade';
}
```

**目的**：如果 AI 没有指定 segment.type，根据 trackId 自动推断。

## 工作流程

### 首次对话

```
用户: "加快节奏"
  ↓
AI 调用: add_segment("V1", { timelineStart: 0, timelineDuration: 10, playbackRate: 1.5 })
  ↓
DraftManager: 添加片段到 V1 轨道
  ↓
Draft: { tracks: [{ id: "V1", segments: [{ playbackRate: 1.5, ... }] }] }
```

### 第二轮对话（增量更新）

```
用户: "添加字幕"
  ↓
AI 调用: read_draft() → 读取现有 Draft（包含加速片段）
  ↓
AI 调用: add_segment("T1", { timelineStart: 5, timelineDuration: 5, content: "标题" })
  ↓
DraftManager: 添加片段到 T1 轨道
  ↓
Draft: {
  tracks: [
    { id: "V1", segments: [{ playbackRate: 1.5, ... }] },  // 保留
    { id: "T1", segments: [{ content: "标题", ... }] }      // 新增
  ]
}
```

**关键**：第二轮对话不会覆盖第一轮的加速效果。

## 向后兼容

如果 AI 仍然输出传统的 `edits` 数组（首次对话），系统会自动调用 `aiOutputToDraft()` 转换为 Draft。

```javascript
// 传统方式（仍然支持）
{
  "final_answer": "已加快节奏",
  "edits": [
    { "type": "speed", "start": 0, "end": 10, "rate": 1.5 }
  ]
}
```

## 测试场景

### 场景 1：连续添加效果

1. 用户上传视频，说"加快节奏"
   - 预期：Draft 包含加速片段
2. 用户继续说"添加字幕"
   - 预期：Draft 同时包含加速片段和字幕
3. 用户继续说"淡入淡出"
   - 预期：Draft 包含加速、字幕、淡入淡出

### 场景 2：修改现有效果

1. 用户上传视频，说"加快节奏"
2. 用户说"再快一点"
   - AI 应该调用 `read_draft()` 读取现有片段
   - AI 调用 `modify_segment(segmentId, { playbackRate: 2.0 })`
   - 预期：加速效果从 1.5x 变为 2.0x

### 场景 3：删除效果

1. 用户上传视频，添加多个效果
2. 用户说"删除字幕"
   - AI 调用 `read_draft()` 找到字幕片段
   - AI 调用 `delete_segment(segmentId)`
   - 预期：字幕消失，其他效果保留

## 注意事项

1. **AI 必须主动调用 `read_draft`**：在多轮对话中，AI 需要先读取当前状态才能进行增量修改
2. **轨道 ID 固定**：V1/A1/T1/FX1 是标准轨道 ID，AI 应该使用这些 ID
3. **时间冲突检测**：DraftManager 会检测视频/音频轨道的时间冲突，防止片段重叠
4. **前端兼容**：Draft 通过 `draftToTimeline()` 转换为旧的 timeline 格式，前端无需修改

## 相关文件

- `server/index.js` - 主入口，Draft 初始化逻辑
- `server/draftManager.js` - Draft 状态管理
- `server/tools/draftTools.js` - Draft 工具执行器
- `server/providers/agentProtocol.js` - AI 系统提示词
- `server/providers/agentLoop.js` - ReAct 循环（已支持 Draft 工具）
- `server/converters/aiToDraft.js` - 传统 edits → Draft 转换（向后兼容）
- `server/converters/draftToTimeline.js` - Draft → Timeline 转换（前端兼容）

## 日期

2026-03-17
