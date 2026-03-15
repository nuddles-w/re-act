# Re-Act 智能视频剪辑系统

基于 AI 的智能视频分析与剪辑工具，通过自然语言描述即可完成复杂的视频编辑任务。

## 核心特性

- **AI 视频理解**：支持 Gemini 2.5 Flash 和豆包 Seed 2.0 多模态模型
- **自然语言剪辑**：用文字描述需求，AI 自动识别并剪辑
- **Re-Act 推理架构**：Agent 自主规划剪辑步骤，支持复杂多步骤任务
- **实时预览**：可视化时间线，所见即所得
- **硬件加速导出**：macOS VideoToolbox 硬件编码，导出速度快
- **智能缓存**：相同视频不同需求，复用分析结果，节省 60% 时间
- **会话记忆**：支持连续编辑同一视频，无需重复上传

## 快速开始

### 环境要求

- Node.js 18+
- FFmpeg（需支持 h264_videotoolbox）
- macOS（硬件编码）或 Linux/Windows（软件编码）

### 安装

```bash
git clone https://github.com/nuddles-w/re-act.git
cd re-act
npm install
```

### 配置

创建 `.env` 文件：

```env
# Gemini API Key（推荐）
GEMINI_API_KEY=your_gemini_api_key

# 或使用豆包 Seed 2.0
DOUBAO_API_KEY=your_doubao_api_key
# ARK_API_KEY=your_ark_api_key
# VOLC_ARK_API_KEY=your_volc_ark_api_key

# 背景音乐（可选）
# JAMENDO_CLIENT_ID=your_jamendo_client_id

# 服务端口
PORT=8787
VITE_API_BASE_URL=http://localhost:8787
```

**获取 Gemini API Key**：https://aistudio.google.com/apikey

**获取 Jamendo Client ID**（可选，用于背景音乐功能）：https://devportal.jamendo.com

### 启动

```bash
# 终端 1：启动后端
npm run server

# 终端 2：启动前端
npm run dev
```

访问 http://localhost:5173

## 使用示例

### 1. 制作集锦

**需求**：从篮球比赛视频中提取所有罚篮片段

**操作**：
1. 上传视频
2. 输入："找出所有罚篮片段，制作罚篮集锦"
3. AI 自动识别并保留罚篮片段，删除其他内容

### 2. 添加字幕

**需求**：在精彩片段上添加文字

**操作**：
1. 输入："在每个进球片段开头加上字幕'精彩进球'"
2. AI 自动定位进球时刻并添加文字

### 3. 变速处理

**需求**：加速无聊片段

**操作**：
1. 输入："把准备动作的部分加速 2 倍"
2. AI 识别准备动作并应用变速

### 4. 连续编辑

**需求**：先做集锦，再加字幕

**操作**：
1. 第一次："找出所有进球片段"
2. 第二次："给每个片段加上字幕'GOAL'"
3. 系统自动复用视频分析结果，无需重新上传

## 技术架构

### 前端（React + Vite）

- **单页应用**：`src/App.jsx` 包含所有 UI 逻辑
- **时间线引擎**：`src/domain/strategyEngine.js` 智能选择片段
- **编辑应用**：`src/domain/applyEditsToTimeline.js` 处理剪辑操作

### 后端（Express + FFmpeg）

- **AI Provider 层**：
  - `geminiProvider.js`：Gemini 视频分析
  - `doubaoSeedProvider.js`：豆包 Seed 2.0
  - `textOnlyProvider.js`：纯文本编辑（无需视频上传）

- **Re-Act Agent**：`agentProtocol.js` 定义 Agent 推理协议

- **视频缓存**：`videoCache.js` 基于 MD5 hash 缓存 Gemini fileUri

- **会话管理**：`sessionManager.js` 支持连续编辑

### 数据流

```
用户输入 + 视频
  ↓
意图分类（needsVideoAnalysis）
  ↓ 需要视频分析
上传到 AI（检查缓存）
  ↓
Re-Act Agent 推理
  ↓
返回 segments + edits
  ↓
buildTimeline（选择片段）
  ↓
applyEditsToTimeline（应用编辑）
  ↓
React 时间线 UI
  ↓
FFmpeg 导出
```

## API 接口

### POST /api/analyze

分析视频并生成剪辑方案

**参数**：
- `video`：视频文件
- `duration`：视频时长（秒）
- `request`：剪辑需求描述
- `engine`：AI 引擎（`gemini` / `doubao` / `auto`）
- `sessionId`：会话 ID（可选，用于连续编辑）

**响应**（SSE 流）：
```json
{"type":"progress","message":"正在分析..."}
{"type":"result","sessionId":"sess-xxx","features":{...}}
```

### POST /api/export

导出剪辑后的视频

**参数**：
- `video`：原始视频
- `timeline`：时间线 JSON
- `bgmFile`：背景音乐（可选）

**响应**（SSE 流）：
```json
{"type":"progress","percent":50,"message":"正在导出..."}
{"type":"done","fileId":"export-xxx"}
```

### GET /api/cache/stats

查看视频缓存状态

**响应**：
```json
{
  "size": 3,
  "entries": [
    {"hash":"0b713fab","age":"0.5h","fileUri":"https://..."}
  ]
}
```

## 支持的编辑操作

| 操作 | 描述 | 示例 |
|------|------|------|
| **集锦制作** | 保留特定片段，删除其他 | "找出所有进球片段" |
| **删除片段** | 删除指定内容 | "删除开头 5 秒" |
| **变速** | 加速/减速 | "把准备动作加速 2 倍" |
| **添加文字** | 叠加字幕 | "在进球时加上'GOAL'" |
| **淡入淡出** | 画面过渡效果 | "开头淡入 1 秒" |
| **背景音乐** | 添加 BGM | "加上欢快的背景音乐" |

## 性能优化

### 视频缓存

- 基于 MD5 hash 识别相同视频
- 缓存 Gemini fileUri，48 小时有效
- 相同视频不同需求，节省 60% 时间

### 智能路由

- 文本编辑（加字幕、淡入淡出）跳过视频上传
- 仅在需要视频理解时才上传

### 硬件加速

- macOS：h264_videotoolbox 硬件编码
- 导出速度比软件编码快 3-5 倍

## 调试工具

```bash
# 分析本地视频（无需前端）
npm run debug:analyze

# 测试 parseFeatures
node server/debug/testParser.js

# 测试删除编辑
node server/debug/smokeDeleteEdit.js
```

## 常见问题

### Q: Gemini API Key 被标记为泄露？

A: 不要将 `.env` 提交到公开仓库。如果已泄露，立即重新生成新 key。

### Q: 视频上传失败？

A: 检查视频大小（建议 < 100MB）和格式（推荐 MP4）。大视频会自动压缩。

### Q: 识别不准确？

A: 尝试更详细的描述，如"找出4号球员在罚球线单独投篮的片段"而不是"找出罚篮"。

### Q: 背景音乐功能不工作？

A: 需要在 `.env` 中配置 `JAMENDO_CLIENT_ID`。免费注册：https://devportal.jamendo.com。如果未配置，导出时会跳过背景音乐并显示提示。

### Q: 导出卡住？

A: 检查 FFmpeg 是否安装，运行 `ffmpeg -version` 确认。

## 项目结构

```
re-act/
├── server/
│   ├── providers/          # AI provider 实现
│   │   ├── geminiProvider.js
│   │   ├── doubaoSeedProvider.js
│   │   ├── textOnlyProvider.js
│   │   └── agentProtocol.js
│   ├── utils/
│   │   ├── parseFeatures.js    # 解析 AI 响应
│   │   ├── intentClassifier.js # 意图分类
│   │   ├── compressVideo.js    # 视频压缩
│   │   └── fetchBgm.js         # BGM 搜索
│   ├── videoCache.js       # 视频缓存
│   ├── sessionManager.js   # 会话管理
│   └── index.js            # Express 服务器
├── src/
│   ├── domain/
│   │   ├── strategyEngine.js       # 时间线构建
│   │   ├── applyEditsToTimeline.js # 编辑应用
│   │   └── models.js               # 数据模型
│   ├── App.jsx             # 主应用
│   └── styles.css
├── CLAUDE.md               # 项目文档（给 Claude Code 用）
└── README.md               # 本文件
```

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可

MIT License

## 致谢

- [Gemini API](https://ai.google.dev/) - Google 多模态 AI
- [豆包 Seed 2.0](https://www.volcengine.com/docs/82379/1298454) - 字节跳动多模态模型
- [FFmpeg](https://ffmpeg.org/) - 视频处理
- [React](https://react.dev/) - UI 框架
