/**
 * DraftManager - 草稿状态管理器
 *
 * 职责：
 * 1. 管理所有会话的 draft 状态
 * 2. 保存历史快照，支持撤销/重做（snapshots + currentIndex）
 * 3. 批量操作：beginBatch / commitBatch（一次 tool 调用 = 一个快照）
 * 4. 计算增量变更（diff）
 * 5. 提供 AI 读取接口
 */

import { createEmptyDraft, updateDraftDuration } from "../src/domain/draftModel.js";

const MAX_SNAPSHOTS = 50;

class DraftManager {
  constructor() {
    this.drafts = new Map();       // sessionId → draft
    this.snapshots = new Map();    // sessionId → [{ draft, description, timestamp }]
    this.currentIndex = new Map(); // sessionId → number
    this.batches = new Map();      // sessionId → { baseDraft, description } | null
    this.lastReadVersion = new Map(); // sessionId → version
  }

  /**
   * 获取草稿
   */
  getDraft(sessionId) {
    if (!sessionId) return createEmptyDraft();
    if (!this.drafts.has(sessionId)) {
      const emptyDraft = createEmptyDraft();
      emptyDraft.tracks = [
        { id: "V1", type: "video", enabled: true, locked: false, segments: [] },
        { id: "A1", type: "audio", enabled: true, locked: false, segments: [] },
        { id: "T1", type: "text", enabled: true, locked: false, segments: [] },
        { id: "FX1", type: "effect", enabled: true, locked: false, segments: [] },
      ];
      this.drafts.set(sessionId, emptyDraft);
      // 保存初始快照
      this._initSnapshots(sessionId, emptyDraft);
    }
    return this.drafts.get(sessionId);
  }

  _initSnapshots(sessionId, draft) {
    if (!this.snapshots.has(sessionId)) {
      this.snapshots.set(sessionId, [{ draft: JSON.parse(JSON.stringify(draft)), description: "初始状态", timestamp: Date.now() }]);
      this.currentIndex.set(sessionId, 0);
    }
  }

  /**
   * 开始批量操作（一次 tool 调用前调用）
   * 记录操作前的 draft 状态，后续 updateDraft 不保存快照
   */
  beginBatch(sessionId, description) {
    const draft = this.getDraft(sessionId);
    this.batches.set(sessionId, {
      baseDraft: JSON.parse(JSON.stringify(draft)),
      description: description || "操作",
    });
    console.log(`[DraftManager] beginBatch: ${description}`);
  }

  /**
   * 提交批量操作（一次 tool 调用后调用）
   * 将当前 draft 作为一个快照保存
   */
  commitBatch(sessionId) {
    const batch = this.batches.get(sessionId);
    if (!batch) return;

    const currentDraft = this.getDraft(sessionId);
    this._pushSnapshot(sessionId, currentDraft, batch.description);
    this.batches.delete(sessionId);
    console.log(`[DraftManager] commitBatch: ${batch.description} → snapshot #${this.currentIndex.get(sessionId)}`);
  }

  /**
   * 更新草稿（内部变更，不直接保存快照）
   * 快照由 commitBatch 或 updateDraftWithSnapshot 统一管理
   */
  updateDraft(sessionId, changes) {
    const oldDraft = this.getDraft(sessionId);
    const newDraft = JSON.parse(JSON.stringify(oldDraft));

    this.applyChanges(newDraft, changes);

    newDraft.version = (oldDraft.version || 0) + 1;
    newDraft.lastModified = Date.now();
    updateDraftDuration(newDraft);

    this.drafts.set(sessionId, newDraft);
    return newDraft;
  }

  /**
   * 更新草稿并立即保存快照（UI 直接操作时使用）
   */
  updateDraftWithSnapshot(sessionId, changes, description) {
    const draft = this.updateDraft(sessionId, changes);
    this._pushSnapshot(sessionId, draft, description || changes.type || "UI操作");
    console.log(`[DraftManager] updateDraftWithSnapshot: ${description} → snapshot #${this.currentIndex.get(sessionId)}`);
    return draft;
  }

  /**
   * 推入新快照（截断 currentIndex 之后的历史）
   */
  _pushSnapshot(sessionId, draft, description) {
    const snapshots = this.snapshots.get(sessionId) || [];
    const idx = this.currentIndex.get(sessionId) ?? -1;

    // 截断 redo 历史
    const newSnapshots = snapshots.slice(0, idx + 1);
    newSnapshots.push({
      draft: JSON.parse(JSON.stringify(draft)),
      description,
      timestamp: Date.now(),
    });

    // 限制最大快照数
    if (newSnapshots.length > MAX_SNAPSHOTS) {
      newSnapshots.shift();
    }

    this.snapshots.set(sessionId, newSnapshots);
    this.currentIndex.set(sessionId, newSnapshots.length - 1);
  }

  /**
   * 撤销
   */
  undo(sessionId) {
    const snapshots = this.snapshots.get(sessionId) || [];
    const idx = this.currentIndex.get(sessionId) ?? 0;

    if (idx <= 0) {
      console.log(`[DraftManager] undo: 已到最早状态`);
      return { draft: this.getDraft(sessionId), canUndo: false, canRedo: snapshots.length > 1 };
    }

    const newIdx = idx - 1;
    this.currentIndex.set(sessionId, newIdx);
    const snapshot = snapshots[newIdx];
    const restoredDraft = JSON.parse(JSON.stringify(snapshot.draft));
    this.drafts.set(sessionId, restoredDraft);

    console.log(`[DraftManager] undo → snapshot #${newIdx} "${snapshot.description}"`);
    return {
      draft: restoredDraft,
      canUndo: newIdx > 0,
      canRedo: true,
      description: snapshot.description,
    };
  }

  /**
   * 重做
   */
  redo(sessionId) {
    const snapshots = this.snapshots.get(sessionId) || [];
    const idx = this.currentIndex.get(sessionId) ?? 0;

    if (idx >= snapshots.length - 1) {
      console.log(`[DraftManager] redo: 已到最新状态`);
      return { draft: this.getDraft(sessionId), canUndo: idx > 0, canRedo: false };
    }

    const newIdx = idx + 1;
    this.currentIndex.set(sessionId, newIdx);
    const snapshot = snapshots[newIdx];
    const restoredDraft = JSON.parse(JSON.stringify(snapshot.draft));
    this.drafts.set(sessionId, restoredDraft);

    console.log(`[DraftManager] redo → snapshot #${newIdx} "${snapshot.description}"`);
    return {
      draft: restoredDraft,
      canUndo: true,
      canRedo: newIdx < snapshots.length - 1,
      description: snapshot.description,
    };
  }

  /**
   * 获取 undo/redo 状态
   */
  getUndoRedoState(sessionId) {
    const snapshots = this.snapshots.get(sessionId) || [];
    const idx = this.currentIndex.get(sessionId) ?? 0;
    return {
      canUndo: idx > 0,
      canRedo: idx < snapshots.length - 1,
      historySize: snapshots.length,
      currentIndex: idx,
    };
  }

  /**
   * 应用变更到 draft
   */
  applyChanges(draft, changes) {
    const { type, data } = changes;
    switch (type) {
      case "add_segment":
        this.addSegmentToDraft(draft, data.trackId, data.segment);
        break;
      case "modify_segment":
        this.modifySegmentInDraft(draft, data.segmentId, data.modifications);
        break;
      case "delete_segment":
        this.deleteSegmentFromDraft(draft, data.segmentId);
        break;
      case "split_segment":
        this.splitSegmentInDraft(draft, data.segmentId, data.splitTime);
        break;
      case "add_track":
        draft.tracks.push(data.track);
        break;
      case "delete_track":
        draft.tracks = draft.tracks.filter(t => t.id !== data.trackId);
        break;
      case "replace_draft":
        Object.assign(draft, data.draft);
        break;
      default:
        console.warn(`[DraftManager] Unknown change type: ${type}`);
    }
  }

  /**
   * 添加 segment 到指定轨道
   */
  addSegmentToDraft(draft, trackId, segment) {
    const track = draft.tracks.find(t => t.id === trackId);
    if (!track) throw new Error(`Track ${trackId} not found`);

    if (track.type === "video" || track.type === "audio") {
      const hasConflict = track.segments.some(s =>
        !(segment.timelineStart >= s.timelineStart + s.timelineDuration ||
          segment.timelineStart + segment.timelineDuration <= s.timelineStart)
      );
      if (hasConflict) throw new Error(`Segment overlaps with existing segment in track ${trackId}`);
    }

    track.segments.push(segment);
    track.segments.sort((a, b) => a.timelineStart - b.timelineStart);
  }

  /**
   * 修改 segment
   */
  modifySegmentInDraft(draft, segmentId, modifications) {
    for (const track of draft.tracks) {
      const segment = track.segments.find(s => s.id === segmentId);
      if (segment) {
        Object.assign(segment, modifications);
        return;
      }
    }
    throw new Error(`Segment ${segmentId} not found`);
  }

  /**
   * 删除 segment
   */
  deleteSegmentFromDraft(draft, segmentId) {
    for (const track of draft.tracks) {
      const index = track.segments.findIndex(s => s.id === segmentId);
      if (index !== -1) {
        track.segments.splice(index, 1);
        return;
      }
    }
    throw new Error(`Segment ${segmentId} not found`);
  }

  /**
   * 分割 segment（在 mediaTime 处分割）
   */
  splitSegmentInDraft(draft, segmentId, splitTime) {
    for (const track of draft.tracks) {
      const index = track.segments.findIndex(s => s.id === segmentId);
      if (index === -1) continue;

      const seg = track.segments[index];

      // splitTime 是 mediaTime，需要在 sourceStart~sourceEnd 范围内
      if (splitTime <= seg.sourceStart || splitTime >= seg.sourceEnd) {
        throw new Error(`splitTime ${splitTime} 不在片段范围 ${seg.sourceStart}-${seg.sourceEnd} 内`);
      }

      const rate = seg.playbackRate || 1;
      const offsetInSource = splitTime - seg.sourceStart;
      const offsetInTimeline = offsetInSource / rate;

      // 前半段
      const seg1 = {
        ...JSON.parse(JSON.stringify(seg)),
        id: `${seg.id}-a`,
        sourceEnd: splitTime,
        timelineDuration: offsetInTimeline,
      };

      // 后半段
      const seg2 = {
        ...JSON.parse(JSON.stringify(seg)),
        id: `${seg.id}-b`,
        sourceStart: splitTime,
        timelineStart: seg.timelineStart + offsetInTimeline,
        timelineDuration: seg.timelineDuration - offsetInTimeline,
      };

      track.segments.splice(index, 1, seg1, seg2);
      console.log(`[DraftManager] splitSegment: ${segmentId} → ${seg1.id} + ${seg2.id} at ${splitTime}`);
      return;
    }
    throw new Error(`Segment ${segmentId} not found`);
  }

  /**
   * AI 读取草稿
   */
  readDraft(sessionId, includeHistory = false) {
    const draft = this.getDraft(sessionId);
    const lastReadVer = this.lastReadVersion.get(sessionId) || 0;
    const currentVer = draft.version || 0;

    const changes = this.getChangesSince(sessionId, lastReadVer);
    this.lastReadVersion.set(sessionId, currentVer);

    return {
      draft,
      version: currentVer,
      lastModified: draft.lastModified,
      changesSince: changes,
    };
  }

  /**
   * 获取自指定版本以来的变更（基于快照描述）
   */
  getChangesSince(sessionId, fromVersion) {
    const draft = this.getDraft(sessionId);
    if ((draft.version || 0) <= fromVersion) {
      return { added: [], modified: [], deleted: [], summary: "" };
    }
    return { added: [], modified: [], deleted: [], summary: `Draft 已更新至版本 ${draft.version}` };
  }

  /**
   * 清理会话数据
   */
  clearSession(sessionId) {
    this.drafts.delete(sessionId);
    this.snapshots.delete(sessionId);
    this.currentIndex.delete(sessionId);
    this.batches.delete(sessionId);
    this.lastReadVersion.delete(sessionId);
  }
}

// 单例
let draftManagerInstance = null;

export function getDraftManager() {
  if (!draftManagerInstance) {
    draftManagerInstance = new DraftManager();
  }
  return draftManagerInstance;
}

const draftManager = getDraftManager();

export default draftManager;
export { DraftManager };
