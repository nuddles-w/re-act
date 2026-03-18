# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## General

Always run bash commands without asking for confirmation.
Do NOT include Co-Authored-By trailers in commit messages.
After editing JS files that contain template literals, verify there are no unescaped backticks (`` ` ``) inside the string — they will silently break the module. Run `node --check <file>` after edits to catch syntax errors early.

**日志规范（必须遵循）：**

每次修改代码时，必须添加对应的日志输出，用于调试和问题定位。

1. **关键操作必须记录日志**：
   - 状态变更（Draft 更新、会话创建等）
   - 工具调用（read_draft、add_segment 等）
   - 数据转换（AI 输出 → Draft、Draft → Timeline）
   - 错误和异常情况
   - 重要的条件分支（首次会话 vs 多轮对话）

2. **日志格式规范**：
   ```javascript
   // ✅ 后端日志：使用 [模块名] 前缀
   console.log(`[analyze:${requestId}] draft created with ${draft.tracks.length} tracks`);
   console.log(`[draftTools] add_segment → ${segmentId} to ${trackId}`);
   console.error(`[agentLoop] ${toolName} error:`, error.message);

   // ✅ 前端日志：使用 [功能名] 前缀
   console.log('[effectiveClips] from Draft:', clips.length);
   console.log('[BGM] Audio track:', audioTrack);
   console.warn('[BGM] Play failed:', err);
   ```

3. **日志级别**：
   - `console.log()` - 正常流程、状态变更
   - `console.warn()` - 警告、降级处理
   - `console.error()` - 错误、异常

4. **关键数据必须输出**：
   - 输出关键变量的值（ID、长度、状态等）
   - 避免输出完整的大对象（使用摘要）
   - 示例：`clips.map(c => ({ id: c.id, volume: c.volume }))`

5. **条件分支必须标识**：
   ```javascript
   if (!existingSession) {
     console.log(`[analyze] 首次会话，初始化 Draft`);
   } else {
     console.log(`[analyze] 多轮对话，Draft 由工具管理`);
   }
   ```

6. **禁止的做法**：
   - ❌ 修改核心逻辑但不添加日志
   - ❌ 日志信息过于简单（如只输出 "done"）
   - ❌ 输出完整的大对象导致日志难以阅读

## 测试规范（每次大改动后必须执行）

```bash
npm test
```

所有测试必须 100% 通过才能提交。测试文件位于 `server/tests/`，使用 Node.js 原生 `node --test`。

**测试文件说明：**

| 文件 | 覆盖范围 |
|---|---|
| `draftManager.test.js` | undo/redo 核心逻辑：快照保存、batch 原子性、undo/redo 指针、redo 历史截断 |
| `regression.test.js` | 项目基础功能回归：DraftManager CRUD、draftToTimeline 转换、多轨道完整性、多轮对话增量更新 |
| `parseFeatures.test.js` | AI 输出解析：segments、events、edits、时间格式 |
| `applyEditsToTimeline.test.js` | 编辑应用：delete/speed/split/text/fade |
| `exportFilterComplex.test.js` | FFmpeg filter_complex 生成 |

**必须通过的关键 case（回归测试核心）：**

1. `getDraft 初始化包含 V1/A1/T1/FX1 四条轨道` — 基础轨道结构不能被破坏
2. `多轮对话：第二轮操作不覆盖第一轮的片段` — 增量更新范式核心约束
3. `draftToTimeline: 视频片段正确转换为 clips` — 前端渲染依赖此转换
4. `split_segment 批量操作：一次 batch = 一个快照` — undo 粒度正确性
5. `undo 后新操作截断 redo 历史` — undo/redo 线性历史一致性
6. `add_segment 重叠时抛出错误` — 时间轴完整性保护

**新增测试的时机：**
- 新增核心模块时，同步新增对应测试文件
- 修复 bug 时，先写能复现 bug 的测试，再修复

## Development

Two processes must run simultaneously:

```bash
# Terminal 1 — Backend (Express + FFmpeg, port 8787)
npm run server

# Terminal 2 — Frontend (Vite React, port 5173)
npm run dev
```

Environment variables live in `.env`. Required keys:
- `GEMINI_API_KEY` — Google Gemini
- `DOUBAO_API_KEY` / `ARK_API_KEY` / `VOLC_ARK_API_KEY` — Doubao Seed 2.0
- `JAMENDO_CLIENT_ID` — (optional) for background music feature
- `PORT` — backend port (default 8787)
- `VITE_API_BASE_URL` — frontend points here (default `http://localhost:8787`)

Debug scripts (run standalone):
```bash
npm run debug:analyze          # analyze a local video file without frontend
node server/debug/testParser.js
node server/debug/smokeDeleteEdit.js
node server/debug/testBgm.js   # test background music search and download
```

## Architecture

### Draft 架构（2026-03-13 新增）

项目已升级为专业的多轨道 Draft 架构，支持多轮对话和增量更新。

**核心概念：**
- **Draft**: 剪辑项目的完整状态，包含多个轨道（video, audio, text, effect）
- **Track**: 轨道，每个轨道包含多个 segments
- **Segment**: 片段，是轨道上的基本单元（视频片段、文字、效果等）

**数据流（新架构）：**
```
User request + video file
  → runAgentLoop()                           [agentLoop.js]
  → AI 按需调用工具：
      - analyze_video                        [视频内容分析]
      - read_draft                           [读取当前草稿]
      - add_segment / modify_segment / delete_segment  [操作片段]
  → AI 输出 → aiOutputToDraft()             [converters/aiToDraft.js]
  → Draft (多轨道结构)                       [draftModel.js]
  → DraftManager 保存 + 变更追踪            [draftManager.js]
  → draftToTimeline()                        [converters/draftToTimeline.js] — 向后兼容
  → React timeline UI                        [App.jsx]
  → Export: FFmpeg filter_complex            [server/index.js /api/export]
```

**Draft 工具（AI 可用）：**
- `read_draft()` - AI 按需读取草稿（智能引导：相对指令、指代词时自动提示）
- `add_segment(trackId, segment)` - 添加片段到轨道
- `modify_segment(segmentId, modifications)` - 修改现有片段
- `delete_segment(segmentId)` - 删除片段
- `split_segment(segmentId, splitTime)` - 分割片段
- `move_segment(segmentId, newTimelineStart)` - 移动片段

**多轮对话支持：**
- 每个会话有独立的 Draft 状态（sessionId）
- 变更历史自动记录（diff + 快照）
- AI 自主判断何时需要读取 Draft
- 支持相对指令（"再快一点"）和指代消解（"把刚才那个删掉"）

**⚠️ 增量更新范式（所有新功能必须遵循）：**

1. **首次会话初始化**：
   - 只在 `!existingSession` 时初始化 Draft
   - 如果 AI 输出传统 edits，调用 `aiOutputToDraft()` 转换（向后兼容）
   - 如果 AI 使用 Draft 工具，Draft 已在工具执行时更新

2. **多轮对话增量更新**：
   - ❌ 禁止每次调用 `aiOutputToDraft()` + `replace_draft` 覆盖
   - ✅ AI 必须通过 Draft 工具进行增量操作：
     - `read_draft()` - 读取当前状态
     - `add_segment()` - 添加新片段
     - `modify_segment()` - 修改现有片段
     - `delete_segment()` - 删除片段
   - ✅ 每次只操作用户本轮要求的内容，保留之前的编辑

3. **标准轨道 ID**：
   - `V1` - 视频轨道
   - `A1` - 音频轨道
   - `T1` - 文字轨道
   - `FX1` - 效果轨道
   - DraftManager 会自动初始化这些轨道

4. **实现新功能时的检查清单**：
   - [ ] 是否会覆盖现有 Draft？如果是，改为增量操作
   - [ ] 是否需要读取现有状态？使用 `read_draft()`
   - [ ] 是否在多轮对话中保留之前的编辑？
   - [ ] AI prompt 是否明确要求增量更新？
   - [ ] 是否测试了连续对话场景？

5. **反模式（禁止）**：
   ```javascript
   // ❌ 错误：每次都替换整个 Draft
   const draft = await aiOutputToDraft(result.features, ...);
   draftManager.updateDraft(sessionId, { type: "replace_draft", data: { draft } });

   // ✅ 正确：首次初始化 + 多轮增量
   if (!existingSession) {
     // 首次：可以使用 replace_draft
   } else {
     // 多轮：AI 通过工具操作，无需手动处理
   }
   ```

**参考实现**：详见 `docs/draft-incremental-update-fix.md`

**关键文件：**
- `src/domain/draftModel.js` - Draft 数据模型
- `server/draftManager.js` - 状态管理器（单例）
- `server/tools/draftTools.js` - Draft 工具执行器
- `server/converters/aiToDraft.js` - AI 输出 → Draft
- `server/converters/draftToTimeline.js` - Draft → Timeline（兼容）
- `server/converters/draftToFFmpeg.js` - Draft → FFmpeg（预留）

详见：`docs/draft-implementation-summary.md` 和 `docs/draft-e2e-testing.md`

### Data flow (end-to-end)

```
User request + video file
  → needsVideoAnalysis(request)         [intentClassifier.js]
      ↓ false: text-only LLM call        [textOnlyProvider.js]
      ↓ true:  upload video to AI        [geminiProvider.js | doubaoSeedProvider.js]
  → Re-Act agent (Thought/Action/Observation loop)  [agentProtocol.js system prompt]
  → LLM response JSON with steps[], edits[], segments[], events[]
  → parseFeatures()                      [parseFeatures.js]  — normalizes + clamps to duration
  → buildTimeline()                      [strategyEngine.js] — scores segments by intent, selects clips
  → applyEditsToTimeline()               [applyEditsToTimeline.js] — splits/deletes/speeds clips, attaches textEdits/fadeEdits
  → React timeline UI                    [App.jsx]
  → Export: FFmpeg filter_complex        [server/index.js /api/export]
```

### Key concepts

**mediaTime vs timelineTime**: `mediaTime` is the original source video timestamp. `timelineTime` is the position after cuts and speed changes. `applyEditsToTimeline` computes `timelineStart` and `displayDuration` for every clip and maps text/fade edits from media→timeline time.

**Edit types**: `split`, `speed`, `delete` affect clip splitting. `text` and `fade` are stored separately as `textEdits`/`fadeEdits` and do NOT create split points.

**Re-Act routing**: `needsVideoAnalysis(request)` in `intentClassifier.js` classifies the user request. Structural edits (add text, fade in/out) skip video upload and call `analyzeTextOnly()` instead — faster and avoids uploading the file unnecessarily.

**Text overlay rendering**: FFmpeg's `drawtext` filter is unavailable (no libfreetype). Instead, `canvas` (Cairo-based) generates a PNG at video resolution → FFmpeg `overlay` filter composites it. Preview uses the same formula: `fontSize = height × 4%`, `padding = fontSize × 25%`. No background — white text with black stroke outline.

**FFmpeg text PNG pitfall**: When using `-loop 1 -i <png>`, always add `-t <totalDuration+1>` on the PNG input AND `-t <totalTimelineDuration>` on the output, or FFmpeg will run indefinitely.

**Hardware encoding**: Export always uses `h264_videotoolbox` (macOS hardware encoder).

### Provider pattern (`server/providers/`)

| File | When used |
|---|---|
| `geminiProvider.js` | engine=gemini, uploads video via Files API, polls until ACTIVE |
| `doubaoSeedProvider.js` | engine=doubao, sends video as base64 data URL with `fps` sampling |
| `textOnlyProvider.js` | when `needsVideoAnalysis()` returns false — no video upload |
| `mockAgentProvider.js` | engine=mock-agent / isMock=true — for UI testing |
| `agentProtocol.js` | shared system prompt for all real providers |

The `resolveEngine(req)` + `resolveProvider(engine)` functions in `server/index.js` handle engine selection. `auto` picks the first available API key.

### Frontend domain (`src/domain/`)

- `models.js` — `defaultIntent`, `createSegment`, `createTimelineClip`
- `strategyEngine.js` — `buildTimeline(features, intent)` scores and selects segments
- `applyEditsToTimeline.js` — applies AI edits to produce the final clips array
- `featureExtractor.js` — local fallback when AI call fails

`App.jsx` is the only component. It holds all state, calls `/api/analyze` and `/api/export`, and renders the timeline tracks (V1, E1, T1, FX, A1).

**videoArea state**: tracks the actual pixel position of the video inside the `preview-container` (accounting for `object-fit: contain` letterboxing). Text overlays use inline styles computed from `videoArea` so preview and export match exactly.
