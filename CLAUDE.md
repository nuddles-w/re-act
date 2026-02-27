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
- `PORT` — backend port (default 8787)
- `VITE_API_BASE_URL` — frontend points here (default `http://localhost:8787`)

Debug scripts (run standalone):
```bash
npm run debug:analyze          # analyze a local video file without frontend
node server/debug/testParser.js
node server/debug/smokeDeleteEdit.js
```

## Architecture

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
