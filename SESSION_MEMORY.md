# 会话记忆功能说明

## 功能概述

新增的会话记忆功能允许用户连续编辑同一个视频，无需每次都重新上传和分析。系统会自动缓存视频分析结果和对话历史。

## 工作原理

### 1. 首次分析
- 用户上传视频并发送第一个请求（例如："识别视频中鸡蛋被捣碎的时间起始点"）
- 后端分析视频，生成 `sessionId`
- 分析结果（features、segments、events 等）被缓存到会话中
- 前端保存 `sessionId`

### 2. 后续编辑
- 用户发送新的编辑请求（例如："在开头添加淡入效果"）
- 前端携带 `sessionId` 发送请求，**无需重新上传视频**
- 后端检测到 `sessionId`，直接使用缓存的分析结果
- 对于纯文本编辑（添加文字、淡入淡出等），走快速路径（`analyzeTextOnly`）
- 编辑结果增量合并到会话的 features 中

### 3. 会话管理
- 会话默认有效期：30 分钟（最后访问时间起算）
- 每 5 分钟自动清理过期会话
- 用户切换视频时，会话 ID 自动重置

## 使用示例

### 场景 1：连续编辑同一视频

```
用户操作流程：
1. 上传视频 video.mp4
2. 发送："识别视频中的精彩片段" → 系统分析视频，返回 sessionId
3. 发送："在开头添加文字'精彩回顾'" → 使用缓存，快速响应
4. 发送："给第一个片段添加淡入效果" → 使用缓存，快速响应
5. 发送："删除 10-15 秒的内容" → 使用缓存，快速响应
```

### 场景 2：智能路由

系统会自动判断请求类型：

**需要视频分析的请求**（会上传视频）：
- "识别视频中的笑脸"
- "找出所有运动场景"
- "检测视频中的文字"

**纯文本编辑请求**（不上传视频，使用缓存）：
- "在开头添加文字"
- "给片段添加淡入淡出"
- "删除某个时间段"
- "调整播放速度"

## API 接口

### POST /api/analyze

**首次分析（无 sessionId）**：
```javascript
FormData {
  video: File,
  duration: "60.5",
  request: "识别视频中的精彩片段",
  pe: "短视频剪辑产品经理",
  engine: "auto"
}

// 响应
{
  type: "result",
  sessionId: "sess-1234567890-abc123",  // 新生成的会话 ID
  features: { ... },
  summary: "分析完成"
}
```

**后续编辑（有 sessionId）**：
```javascript
FormData {
  sessionId: "sess-1234567890-abc123",  // 携带会话 ID
  duration: "60.5",
  request: "在开头添加文字'精彩回顾'",
  pe: "短视频剪辑产品经理",
  engine: "auto"
  // 注意：不需要上传 video 文件
}

// 响应
{
  type: "result",
  sessionId: "sess-1234567890-abc123",  // 返回相同的会话 ID
  features: { edits: [...] },  // 增量编辑结果
  summary: "编辑完成"
}
```

### GET /api/session/:sessionId

获取会话详情：
```javascript
GET /api/session/sess-1234567890-abc123

// 响应
{
  sessionId: "sess-1234567890-abc123",
  videoInfo: {
    name: "video.mp4",
    size: 10485760,
    duration: 60.5
  },
  features: { ... },
  conversationHistory: [
    { role: "user", content: "识别视频中的精彩片段", timestamp: 1234567890 },
    { role: "assistant", content: "分析完成", timestamp: 1234567891 }
  ]
}
```

### DELETE /api/session/:sessionId

删除会话：
```javascript
DELETE /api/session/sess-1234567890-abc123

// 响应
{ success: true }
```

### GET /api/sessions

获取所有会话统计：
```javascript
GET /api/sessions

// 响应
{
  totalSessions: 3,
  sessions: [
    {
      sessionId: "sess-1234567890-abc123",
      videoName: "video.mp4",
      createdAt: "2026-03-03T10:00:00.000Z",
      lastAccessedAt: "2026-03-03T10:15:00.000Z",
      conversationCount: 5
    }
  ]
}
```

## 前端集成

前端已自动集成会话记忆功能，无需额外配置：

1. **状态管理**：新增 `sessionId` state
2. **自动保存**：首次分析后自动保存 sessionId
3. **自动携带**：后续请求自动携带 sessionId
4. **自动重置**：切换视频时自动清空 sessionId
5. **历史保留**：有会话时不清空聊天记录，保持对话连续性

## 性能优化

### 1. 避免重复上传
- 首次分析：上传视频（可能几十 MB）
- 后续编辑：只传递 sessionId（几十字节）
- **节省带宽：99%+**

### 2. 避免重复分析
- 首次分析：调用 AI 模型分析视频（可能 10-30 秒）
- 后续编辑：直接使用缓存结果（毫秒级响应）
- **节省时间：95%+**

### 3. 智能路由
- 纯文本编辑：走 `analyzeTextOnly` 快速路径
- 视频分析：走完整 AI 分析流程
- **自动选择最优路径**

## 注意事项

1. **会话过期**：30 分钟未访问的会话会被自动清理
2. **内存占用**：会话数据存储在内存中，重启服务器会丢失
3. **视频文件**：会话只缓存分析结果，不缓存视频文件本身
4. **并发限制**：同一会话不支持并发编辑（后端无锁机制）

## 未来优化方向

1. **持久化存储**：将会话数据存储到 Redis/数据库
2. **视频 URI 缓存**：复用已上传到 AI 服务的视频 URI
3. **增量更新**：更智能的 features 合并策略
4. **会话恢复**：支持跨设备/跨浏览器恢复会话
