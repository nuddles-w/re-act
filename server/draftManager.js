/**
 * DraftManager - 草稿状态管理器
 *
 * 职责：
 * 1. 管理所有会话的 draft 状态
 * 2. 保存历史快照，支持撤销/重做
 * 3. 计算增量变更（diff）
 * 4. 提供 AI 读取接口
 */

import { createEmptyDraft, updateDraftDuration } from "../src/domain/draftModel.js";

class DraftManager {
  constructor() {
    this.drafts = new Map(); // sessionId → draft
    this.history = new Map(); // sessionId → [snapshots]
    this.lastReadVersion = new Map(); // sessionId → version (AI 上次读取的版本)
  }

  /**
   * 获取草稿
   */
  getDraft(sessionId) {
    if (!sessionId) {
      return createEmptyDraft();
    }
    if (!this.drafts.has(sessionId)) {
      this.drafts.set(sessionId, createEmptyDraft());
    }
    return this.drafts.get(sessionId);
  }

  /**
   * 更新草稿（用户操作触发）
   * @param {string} sessionId
   * @param {object} changes - { type, data }
   */
  updateDraft(sessionId, changes) {
    const oldDraft = this.getDraft(sessionId);
    const newDraft = JSON.parse(JSON.stringify(oldDraft)); // deep clone

    // 应用变更
    this.applyChanges(newDraft, changes);

    // 更新版本和时间
    newDraft.version = (oldDraft.version || 0) + 1;
    newDraft.lastModified = Date.now();
    updateDraftDuration(newDraft);

    // 保存快照
    this.saveDraftSnapshot(sessionId, oldDraft, newDraft, changes);

    // 更新当前版本
    this.drafts.set(sessionId, newDraft);

    return newDraft;
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
      case "add_track":
        draft.tracks.push(data.track);
        break;
      case "delete_track":
        draft.tracks = draft.tracks.filter(t => t.id !== data.trackId);
        break;
      case "replace_draft":
        // 完全替换（AI 首次生成）
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
    if (!track) {
      throw new Error(`Track ${trackId} not found`);
    }

    // 检查时间冲突（同一轨道的视频/音频不能重叠）
    if (track.type === "video" || track.type === "audio") {
      const hasConflict = track.segments.some(s =>
        !(segment.timelineStart >= s.timelineStart + s.timelineDuration ||
          segment.timelineStart + segment.timelineDuration <= s.timelineStart)
      );
      if (hasConflict) {
        throw new Error(`Segment overlaps with existing segment in track ${trackId}`);
      }
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
   * AI 读取草稿
   * @param {string} sessionId
   * @param {boolean} includeHistory - 是否包含历史记录
   * @returns {object} { draft, version, lastModified, changesSince, history }
   */
  readDraft(sessionId, includeHistory = false) {
    const draft = this.getDraft(sessionId);
    const lastReadVer = this.lastReadVersion.get(sessionId) || 0;
    const currentVer = draft.version || 0;

    // 计算变更
    const changes = this.getChangesSince(sessionId, lastReadVer);

    // 更新读取版本
    this.lastReadVersion.set(sessionId, currentVer);

    return {
      draft,
      version: currentVer,
      lastModified: draft.lastModified,
      changesSince: changes,
      history: includeHistory ? this.history.get(sessionId) : null,
    };
  }

  /**
   * 获取自指定版本以来的变更
   */
  getChangesSince(sessionId, fromVersion) {
    const history = this.history.get(sessionId) || [];
    const changes = history.filter(h => h.version > fromVersion);

    if (changes.length === 0) {
      return { added: [], modified: [], deleted: [], summary: "" };
    }

    return {
      added: changes.flatMap(c => c.diff?.added || []),
      modified: changes.flatMap(c => c.diff?.modified || []),
      deleted: changes.flatMap(c => c.diff?.deleted || []),
      summary: this.summarizeChanges(changes),
    };
  }

  /**
   * 生成人类可读的变更摘要
   */
  summarizeChanges(changes) {
    const summary = [];

    changes.forEach(change => {
      const { type, data } = change.changes;

      if (type === "add_segment") {
        const seg = data.segment;
        summary.push(
          `在 ${data.trackId} 轨道添加了片段 (${seg.timelineStart.toFixed(1)}s-${(seg.timelineStart + seg.timelineDuration).toFixed(1)}s)`
        );
      } else if (type === "delete_segment") {
        summary.push(`删除了片段 ${data.segmentId}`);
      } else if (type === "modify_segment") {
        const mods = Object.keys(data.modifications).join(", ");
        summary.push(`修改了片段 ${data.segmentId}: ${mods}`);
      } else if (type === "replace_draft") {
        summary.push("AI 生成了新的剪辑方案");
      }
    });

    return summary.join("\n");
  }

  /**
   * 保存快照
   */
  saveDraftSnapshot(sessionId, oldDraft, newDraft, changes) {
    const history = this.history.get(sessionId) || [];

    const snapshot = {
      version: newDraft.version,
      timestamp: Date.now(),
      changes,
      diff: this.computeDiff(oldDraft, newDraft),
    };

    history.push(snapshot);

    // 只保留最近 20 个快照
    if (history.length > 20) {
      history.shift();
    }

    this.history.set(sessionId, history);
  }

  /**
   * 计算 diff
   */
  computeDiff(oldDraft, newDraft) {
    const diff = {
      added: [],
      modified: [],
      deleted: [],
    };

    // 比较 tracks
    const oldTrackIds = new Set(oldDraft.tracks.map(t => t.id));
    const newTrackIds = new Set(newDraft.tracks.map(t => t.id));

    // 新增的 track
    newTrackIds.forEach(id => {
      if (!oldTrackIds.has(id)) {
        diff.added.push({ type: "track", id });
      }
    });

    // 删除的 track
    oldTrackIds.forEach(id => {
      if (!newTrackIds.has(id)) {
        diff.deleted.push({ type: "track", id });
      }
    });

    // 比较 segments
    newDraft.tracks.forEach(newTrack => {
      const oldTrack = oldDraft.tracks.find(t => t.id === newTrack.id);
      if (!oldTrack) return;

      const oldSegIds = new Set(oldTrack.segments.map(s => s.id));
      const newSegIds = new Set(newTrack.segments.map(s => s.id));

      // 新增的 segment
      newSegIds.forEach(id => {
        if (!oldSegIds.has(id)) {
          diff.added.push({ type: "segment", trackId: newTrack.id, id });
        } else {
          // 检查是否修改
          const oldSeg = oldTrack.segments.find(s => s.id === id);
          const newSeg = newTrack.segments.find(s => s.id === id);
          if (JSON.stringify(oldSeg) !== JSON.stringify(newSeg)) {
            diff.modified.push({
              type: "segment",
              trackId: newTrack.id,
              id,
              changes: this.deepDiff(oldSeg, newSeg),
            });
          }
        }
      });

      // 删除的 segment
      oldSegIds.forEach(id => {
        if (!newSegIds.has(id)) {
          diff.deleted.push({ type: "segment", trackId: newTrack.id, id });
        }
      });
    });

    return diff;
  }

  /**
   * 深度 diff（简化版）
   */
  deepDiff(oldObj, newObj) {
    const changes = {};
    for (const key in newObj) {
      if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
        changes[key] = { old: oldObj[key], new: newObj[key] };
      }
    }
    return changes;
  }

  /**
   * 清理会话数据
   */
  clearSession(sessionId) {
    this.drafts.delete(sessionId);
    this.history.delete(sessionId);
    this.lastReadVersion.delete(sessionId);
  }
}

// 单例模式
let draftManagerInstance = null;

export function getDraftManager() {
  if (!draftManagerInstance) {
    draftManagerInstance = new DraftManager();
  }
  return draftManagerInstance;
}

// 单例
const draftManager = new DraftManager();

export default draftManager;
export { DraftManager };
