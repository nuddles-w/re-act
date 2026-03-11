# Dev Log — 2026-03-11

## 概述

本次对话完成了三件主要的事：修复了若干 bug、讨论并实现了真正的 Tool-based ReAct 架构、以及一些工程细节优化。

---

## 一、Bug 修复

### 1. 空消息导致 Doubao API 400 错误

**现象**：前端发请求时偶发 `messages: text content blocks must be non-empty` 错误。

**排查过程**：
- 启动服务器，用 node 脚本模拟含空 content 的对话历史，复现问题
- 定位到 `server/utils/buildEditContext.js` 的 `formatHistoryForMessages` 和 `formatHistoryForPrompt` 没有过滤空内容消息

**修复**：两个函数都加 `if (!msg.content?.trim()) continue`

**文件**：`server/utils/buildEditContext.js`

---

### 2. 集锦播放时长超出预期（17s 显示但能播到 28s+）

**现象**：AI 正确返回 9 个片段（共约 17.7s），但播放时能一直播到 28s 甚至更长。

**根本原因**：`handleTimeUpdate` 在两个 clip 之间的间隙时，`findClipByMediaTime` 返回 null，代码只重置了 playbackRate，**没有跳到下一个 clip 的起点**，视频就直接播原始素材的间隙内容了。

**修复**：在 `src/App.jsx` 的 else 分支加跳转逻辑：
```js
if (!videoRef.current.paused && timeline?.clips?.length) {
  const nextClip = timeline.clips.find(c => c.start > currentTime + 0.01);
  if (nextClip) {
    videoRef.current.currentTime = nextClip.start;
  } else {
    videoRef.current.pause();
    setIsPlaying(false);
  }
}
```

**文件**：`src/App.jsx`（handleTimeUpdate，约 399 行）

---

### 3. 压缩视频无法预览（10-bit HDR 问题）

**现象**：压缩后的视频文件 QuickTime Player 无法打开。

**排查**：`ffprobe` 发现输出是 `yuv420p10le`（10-bit），原视频是 HDR（bt2020/HLG），libx264 继承了 10-bit 格式。

**修复**：`server/utils/compressVideo.js` 加 `-pix_fmt yuv420p` 强制转换为 8-bit：
```js
"-c:v", "h264",
"-pix_fmt", "yuv420p",  // 新增
"-preset", "ultrafast",
```

**调试路径补充**：macOS 的 `os.tmpdir()` 返回 `/var/folders/.../T/`，不是 `/tmp`，压缩调试文件实际在 `/var/folders/vl/804_7yys0pl3sjplmmbhcvsh0000gn/T/debug-compressed-latest.mp4`。

---

### 4. 移除 Doubao 引擎选项

用户确认 Doubao key 未配置，统一使用 Gemini。移除前端引擎选择器中的 Doubao 选项，`resolveProvider` 中也去掉了 Doubao 路由。

---

## 二、意图分类的演进讨论

### 阶段 1：正则规则（原始方案）
`server/utils/intentClassifier.js` 用正则关键词判断是否需要上传视频。问题：覆盖不全，需要人工维护规则。

### 阶段 2：LLM 分类（中间方案）
将 `needsVideoAnalysis` 改为异步函数，用 `gemini-2.5-flash` 做一次轻量分类调用。解决了规则维护问题，但引入了额外延迟。

### 阶段 3：Tool-based ReAct（最终方案）
用户提出更优架构思路：**不应该预先判断是否需要视频，而是让模型把视频识别当成一个 tool，在推理过程中自己决定是否调用**。`intentClassifier` 整个概念被废弃。

---

## 三、真正的 Tool-based ReAct 架构实现

### 设计讨论

原来的架构是"伪 ReAct"：单次 LLM 调用，模型自己伪造 Observation，一次性输出完整 JSON。

新架构是真正的多轮工具执行：
```
用户请求
  → Orchestrator（text-only）: 输出 { thought, action }
  → 系统真实执行工具，返回 Observation
  → Orchestrator: 继续推理
  → ... 直到输出 { thought, final_answer, segments, edits }
```

关键设计决策（来自对话）：
- **Observation 格式每轮可以不同**，不同工具返回不同结构，LLM 根据上下文理解即可
- **视频预压缩可以提前做**（接收文件时即开始），但上传推迟到 `analyze_video` 被调用时
- **架构设计要解决所有视频编辑场景**，不要只考虑当前场景

### 新增/修改文件

#### `server/providers/agentLoop.js`（新建）
真实 ReAct 执行引擎，核心逻辑：
- 最多 8 轮
- 解析 action 字符串（如 `analyze_video("find goals")`）
- 工具分两类：
  - `analyze_video`：上传视频 → `analyzeVideoContent` → 返回 events
  - 结构性编辑工具（split/delete/speed/text/fade/bgm）：返回 `{ ok: true }`
- 返回 `uploadedFileUri` 供 session 缓存，follow-up 复用

#### `server/providers/agentProtocol.js`（重写）
从"一次性完整 JSON"改为"per-turn 格式"：
```json
// 调用工具
{ "thought": "...", "action": "tool_name(args)" }

// 任务完成
{ "thought": "...", "final_answer": "...", "segments": [...], "edits": [...] }
```
保留了从文件加载剪辑知识库（`server/knowledge/editing-principles.md`）的逻辑。
新增 `ANALYZE_VIDEO_SYSTEM_PROMPT`（视频内容分析器的专用提示词）。

#### `server/providers/geminiProvider.js`（新增两个函数）
- `runOrchestratorTurn({ messages })`：`gemini-2.5-flash`，text-only，多轮对话
- `analyzeVideoContent({ fileUri, mimeType, query, duration })`：`gemini-2.5-pro`，带视频，返回 `{ description, events }`

#### `server/index.js`（改造）
- 移除 `needsVideoAnalysis`、`analyzeTextOnly`、`analyzeVideoWithDoubaoSeed` 等引用
- 移除 `skipVideoUpload` 逻辑
- 所有真实请求统一走 `runAgentLoop`
- Session 存储 `fileUri` + `fileMimeType`，follow-up 时作为 `cachedFileUri` 传入，避免重复上传
- Existing session 的 features 做增量合并（edits append）

### 典型场景走法

**"裁剪到4分30秒"**（无需视频）：
```
Round 1: thought → action: (直接 final_answer + edits: delete_segment)
全程不上传视频，约 2-3s 完成
```

**"找出白色球员进球片段"**（需要视频）：
```
Round 1: thought → action: analyze_video("white player scoring")
→ 系统上传视频 → analyzeVideoContent → events
Round 2: thought → final_answer + segments
```

---

## 四、Commits

| Hash | 说明 |
|------|------|
| `a508d74` | fix: 修复集锦播放跳过间隙、空消息报错、移除Doubao引擎 |
| `2564135` | feat: 实现真正的 Tool-based ReAct 架构 |

---

## 五、待验证事项

- [ ] 上传新视频，发指令"找出白色球员进球片段"，验证多轮 ReAct 是否正确执行
- [ ] 发指令"裁剪到4分30秒"，验证不触发视频上传
- [ ] Follow-up 指令（已有 session），验证 cachedFileUri 复用
- [ ] 压缩后的视频是否可以正常在 QuickTime 预览
