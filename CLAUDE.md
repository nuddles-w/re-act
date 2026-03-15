# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## General

Always run bash commands without asking for confirmation.
Do NOT include Co-Authored-By trailers in commit messages.
After editing JS files that contain template literals, verify there are no unescaped backticks (`` ` ``) inside the string — they will silently break the module. Run `node --check <file>` after edits to catch syntax errors early.

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
