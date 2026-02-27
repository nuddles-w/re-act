## 功能清单（含 Undo/Redo）
- 基础剪辑：分割、删除片段、裁剪入点/出点、片段排序/拼接
- 变速：已支持的区间变速 + 预设倍率按钮
- 画面调整：裁剪框（Crop）、缩放/位置（Scale/Position）
- 转场：淡入淡出（Fade In/Out）
- 音频：静音/音量调整（对片段级别生效）
- 输出：导出当前轨道状态（已实现）
- Undo/Redo：对所有编辑操作生效

## 技术实现方案
### 1) 编辑操作建模（命令模式）
- 将每个编辑操作（split/delete/trim/speed/crop/volume 等）封装成命令对象：
  - `do(state) -> nextState`
  - `undo(state) -> prevState`
- 统一更新 `features.edits` 或 `timeline.clips` 的来源，避免双写。

### 2) Undo/Redo 状态栈
- 新增 `undoStack` 与 `redoStack`
- 每次执行命令时：
  - `undoStack.push(command)`
  - `redoStack.clear()`
- Undo：弹出 `undoStack` 并执行 `command.undo`
- Redo：弹出 `redoStack` 并执行 `command.do`

### 3) UI/交互更新
- 工具栏加入 Undo/Redo 按钮（快捷键：⌘Z / ⇧⌘Z）
- 操作完成后自动刷新轨道与预览

### 4) 兼容现有逻辑
- `applyEditsToTimeline` 继续作为“最终渲染结果”入口
- 命令只产生结构化 edits，轨道仍由统一函数生成

## 验证方式
- 连续执行 3-5 次操作（如分割 -> 变速 -> 删除），依次 Undo 再 Redo，确认轨道和预览完全一致

确认后我将开始实现。