# 2026-03-11 - 剪辑知识库设计与实现

## 背景

希望把这个项目做成一个很擅长剪辑的 agent，需要给它补充剪辑知识。

## 核心问题讨论

### 问题 1：是否需要为每种运动单独写知识？

**初步想法**：
- 为篮球、足球等不同运动创建独立的知识文件
- 每种运动有专门的 sub-agent 处理
- 识别到球类就路由到对应的 agent

**问题分析**：
- 模型本身已经理解篮球、足球等运动的语义（什么是进球、扣篮、犯规）
- 过度具体化会导致：
  - 维护地狱（需要为每种内容类型写规则）
  - 限制模型的泛化能力
  - 手工复刻模型已经会的东西

**最终方案**：
- 只写一个通用的 `editing-principles.md`
- 包含跨领域通用的剪辑原则
- 让模型用自身知识 + 通用原则自己推理

### 问题 2：模型真正缺什么？

**不缺**：
- 体育知识（什么是进球）
- 语义理解（识别精彩时刻）

**缺的是**：
- 剪辑意图的映射规则
- 片段边界的处理原则
- 节奏控制的标准
- 转场逻辑

## 实现方案

### 1. 创建知识库文件

路径：`server/knowledge/editing-principles.md`

核心内容：
1. **高潮时刻的完整性原则**：蓄力-高潮-反应三段结构
2. **节奏分类**：密集型/稀疏型/叙事型内容的不同处理
3. **边界处理**：动作完整性、时间微调
4. **转场逻辑**：场景连续性判断
5. **集锦制作规则**：片段选择、时长控制
6. **文字叠加原则**：时机和内容规范
7. **特殊场景处理**：体育/教程/Vlog 的差异化处理
8. **常见错误与修正**：典型问题的解决方案
9. **推理框架**：9 步推理流程
10. **示例推理**：篮球集锦的完整推理过程

### 2. 注入到 System Prompt

修改 `server/providers/agentProtocol.js`：
- 在文件开头添加 fs/path 导入
- 读取 `editing-principles.md` 文件
- 将内容注入到 `AGENT_SYSTEM_PROMPT` 的开头部分
- 添加错误处理（文件不存在时降级）

代码变更：
```javascript
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 读取剪辑原则知识库
let editingPrinciples = '';
try {
  const knowledgePath = path.join(__dirname, '../knowledge/editing-principles.md');
  editingPrinciples = fs.readFileSync(knowledgePath, 'utf-8');
} catch (error) {
  console.warn('未找到剪辑原则知识库，将使用默认配置');
}

export const AGENT_SYSTEM_PROMPT = `你是一个专业的视频分析与剪辑 Agent。你可以理解视频内容、生成描述，也可以通过推理和调用工具来完成复杂的剪辑任务。

${editingPrinciples ? `\n## 剪辑知识库\n\n${editingPrinciples}\n` : ''}
...
```

### 3. 重启服务

- 停止旧的后端进程：`pkill -f "node server/index.js"`
- 启动新的后端：`npm run server`
- 验证启动成功：后端监听在 8787 端口

## 设计原则

### 为什么不用 sub-agent？

- sub-agent 适合独立的并行任务
- 剪辑知识是**上下文增强**，不是独立任务
- 注入到 system prompt 更轻量、更高效

### 什么时候才需要专项规则？

只有当**模型反复做错，且错误模式明确**时，才添加专项规则。

例如：
- 测试 10 个篮球视频，发现模型总是把扣篮切得太短
- 添加规则："大幅度动作需要保留完整弧线"
- 但写成通用规则，而不是"篮球扣篮规则"

### 如何验证效果？

下一步需要：
1. 上传篮球/足球视频测试
2. 检查 agent 是否应用了"蓄力-高潮-反应"结构
3. 检查片段时长是否符合节奏分类
4. 检查边界是否保留了动作完整性

## 文件变更

- 新增：`server/knowledge/editing-principles.md`
- 修改：`server/providers/agentProtocol.js`

## 下一步

- 实际测试视频剪辑效果
- 根据测试结果迭代知识库内容
- 如果发现特定场景的系统性问题，考虑添加专项规则
