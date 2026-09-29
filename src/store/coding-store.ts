import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type { Assignment, AssignmentStatus, CoderId, CodingState, DefinitionVersion, PersistedEnvelope, Segment, Theme } from '../types';
import { readEnvelope, writeEnvelope } from '../utils/db';

const STORAGE_KEY = 'sologsb-1019-state-v1';
const TAB_ID = crypto.randomUUID();
const CODERS: CoderId[] = ['A', 'B'];

export const ASSIGNMENT_STATUS_LABEL: Record<AssignmentStatus, string> = {
  current: '当前版',
  pending: '待复核',
  legacy: '沿用旧版'
};

// 旧数据（无定义版本、编码仅为主题 id）首次打开时自动挂到各主题当前定义
const normalizeState = (input: CodingState): CodingState => {
  const state = structuredClone(input);
  const stamp = state.updatedAt || new Date().toISOString();
  state.themes.forEach((theme) => {
    if (!Array.isArray(theme.definitionVersions) || !theme.definitionVersions.length) {
      const version: DefinitionVersion = { id: `dv-${crypto.randomUUID()}`, version: 1, text: theme.definition ?? '', createdAt: stamp, note: '旧数据迁移' };
      theme.definitionVersions = [version];
      theme.currentVersionId = version.id;
    }
    if (!theme.currentVersionId || !theme.definitionVersions.some((version) => version.id === theme.currentVersionId)) {
      theme.currentVersionId = theme.definitionVersions[theme.definitionVersions.length - 1].id;
    }
    theme.definition = theme.definitionVersions.find((version) => version.id === theme.currentVersionId)?.text ?? theme.definition ?? '';
  });
  const currentVersionOf = new Map(state.themes.map((theme) => [theme.id, theme.currentVersionId]));
  const knownVersions = new Map(state.themes.map((theme) => [theme.id, new Set(theme.definitionVersions.map((version) => version.id))]));
  state.segments.forEach((segment) => {
    CODERS.forEach((coder) => {
      const rawList = (segment.assignments?.[coder] ?? []) as Array<Assignment | string>;
      segment.assignments[coder] = rawList.map((item) => {
        const assignment: Assignment = typeof item === 'string'
          ? { themeId: item, versionId: '', status: 'current' }
          : { themeId: item.themeId, versionId: item.versionId ?? '', status: item.status ?? 'current' };
        if (!assignment.versionId || !knownVersions.get(assignment.themeId)?.has(assignment.versionId)) {
          assignment.versionId = currentVersionOf.get(assignment.themeId) ?? '';
          assignment.status = 'current';
        }
        return assignment;
      });
    });
  });
  return state;
};

const loadLocal = (): CodingState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw) as CodingState);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return seedState();
};

const cloneState = (state: CodingState): CodingState => structuredClone(unwrap(state));

const [state, setState] = createStore<CodingState>(loadLocal());
const [undoStack, setUndoStack] = createSignal<CodingState[]>([]);
const [redoStack, setRedoStack] = createSignal<CodingState[]>([]);
const [remoteEnvelope, setRemoteEnvelope] = createSignal<PersistedEnvelope | null>(null);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
let channel: BroadcastChannel | null = null;
let saveTimer: number | undefined;

const persist = (snapshot: CodingState) => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const envelope: PersistedEnvelope = {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      writerId: TAB_ID,
      state: snapshot
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    await writeEnvelope(envelope);
    setLastSavedAt(new Date());
    channel?.postMessage(envelope);
  }, 180);
};

createEffect(() => {
  const snapshot = cloneState(state);
  if (!storageReady()) return;
  persist(snapshot);
});

const transaction = (action: string, detail: string, mutator: (draft: CodingState) => void) => {
  setUndoStack((items) => [...items.slice(-49), cloneState(state)]);
  setRedoStack([]);
  const next = cloneState(state);
  mutator(next);
  next.revision = state.revision + 1;
  next.updatedAt = new Date().toISOString();
  next.audit.unshift({ id: crypto.randomUUID(), at: next.updatedAt, action, detail });
  next.audit = next.audit.slice(0, 250);
  setState(reconcile(next, { merge: false }));
  persist(next);
};

const buildTreeOrder = (themes: Theme[]) => {
  const children = new Map<string | null, Theme[]>();
  themes.forEach((theme) => children.set(theme.parentId, [...(children.get(theme.parentId) ?? []), theme]));
  const result: Theme[] = [];
  const visit = (parentId: string | null, depth: number) => {
    [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach((theme) => {
      result.push({ ...theme, name: `${'　'.repeat(depth)}${theme.name}` });
      visit(theme.id, depth + 1);
    });
  };
  visit(null, 0);
  return result;
};

const parseTranscript = (raw: string, speakerFallback: string): Array<Pick<Segment, 'time' | 'speaker' | 'text'>> => {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[-—])?\s*([^:：]{1,24})[:：]\s*(.+)$/);
    if (timed) return { time: timed[1], speaker: timed[2].trim(), text: timed[3].trim() };
    return { time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`, speaker: index % 2 === 0 ? speakerFallback : '访谈者', text: line };
  });
};

const assignmentKey = (segment: Segment, coder: CoderId) => segment.assignments[coder].map((item) => item.themeId).join('|');

export function useCodingStore() {
  const initialize = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      const stored = await readEnvelope();
      if (stored) stored.state = normalizeState(stored.state);
      const local = cloneState(state);
      if (stored && (stored.revision > local.revision || stored.updatedAt > local.updatedAt)) {
        setRemoteEnvelope(stored);
      }
    } finally {
      setStorageReady(true);
    }

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('sologsb-1019-coding');
      channel.onmessage = (event: MessageEvent<PersistedEnvelope>) => {
        const incoming = event.data;
        if (!incoming || incoming.writerId === TAB_ID) return;
        if (incoming.revision === state.revision && incoming.updatedAt === state.updatedAt) return;
        incoming.state = normalizeState(incoming.state);
        setRemoteEnvelope(incoming);
      };
    }
  };

  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const previous = items[items.length - 1];
    setUndoStack(items.slice(0, -1));
    setRedoStack((redo) => [...redo, cloneState(state)]);
    setState(reconcile(previous, { merge: false }));
    persist(previous);
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const next = items[items.length - 1];
    setRedoStack(items.slice(0, -1));
    setUndoStack((undoItems) => [...undoItems, cloneState(state)]);
    setState(reconcile(next, { merge: false }));
    persist(next);
  };

  const selectSegment = (id: string) => setState('activeSegmentId', id);
  const selectTranscript = (id: string) => setState('activeTranscriptId', id);
  const selectTheme = (id: string) => setState('activeThemeId', id);
  const setCoder = (coder: CoderId, name: string) => {
    if (coder === 'A') setState('coderA', name);
    else setState('coderB', name);
  };

  const toggleAssignment = (segmentId: string, coder: CoderId, themeId: string, enabled: boolean) => {
    transaction('调整编码', `${coder === 'A' ? state.coderA : state.coderB} ${enabled ? '添加' : '移除'}主题`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (!segment) return;
      if (enabled) {
        if (segment.assignments[coder].some((item) => item.themeId === themeId)) return;
        const theme = draft.themes.find((item) => item.id === themeId);
        segment.assignments[coder].push({ themeId, versionId: theme?.currentVersionId ?? '', status: 'current' });
      } else {
        segment.assignments[coder] = segment.assignments[coder].filter((item) => item.themeId !== themeId);
      }
    });
  };

  const batchAssign = (segmentIds: string[], coder: CoderId, themeId: string) => {
    if (!segmentIds.length) return;
    transaction('批量重编码', `将 ${segmentIds.length} 个片段分配给主题`, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      draft.segments.forEach((segment) => {
        if (!segmentIds.includes(segment.id)) return;
        if (!segment.assignments[coder].some((item) => item.themeId === themeId)) {
          segment.assignments[coder].push({ themeId, versionId: theme?.currentVersionId ?? '', status: 'current' });
        }
      });
    });
  };

  const addTheme = (name: string, parentId: string | null) => {
    const id = `t-${crypto.randomUUID()}`;
    transaction('新建主题', name, (draft) => {
      const version: DefinitionVersion = { id: `dv-${crypto.randomUUID()}`, version: 1, text: '', createdAt: new Date().toISOString() };
      draft.themes.push({ id, name, parentId, color: parentId ? '#57978c' : '#267365', definition: '', memo: '', examples: [], currentVersionId: version.id, definitionVersions: [version] });
      draft.activeThemeId = id;
    });
    return id;
  };

  const updateTheme = (themeId: string, patch: Partial<Theme>, fieldLabel: string) => {
    transaction('编辑主题', fieldLabel, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme) Object.assign(theme, patch);
    });
  };

  // 发布定义新版：保留旧版，绑定旧版的“当前版”编码逐条转为待复核，原判断保留
  const publishDefinition = (themeId: string, text: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    const trimmed = text.trim();
    if (!theme || theme.definition === trimmed) return;
    const nextNumber = Math.max(0, ...theme.definitionVersions.map((version) => version.version)) + 1;
    const affected = state.segments.reduce((count, segment) => (
      count + CODERS.reduce((sum, coder) => sum + segment.assignments[coder].filter((item) => item.themeId === themeId && item.status === 'current').length, 0)
    ), 0);
    transaction('发布定义新版', `${theme.name} → v${nextNumber}${affected ? `，${affected} 条编码待复核` : ''}`, (draft) => {
      const target = draft.themes.find((item) => item.id === themeId);
      if (!target) return;
      const version: DefinitionVersion = { id: `dv-${crypto.randomUUID()}`, version: nextNumber, text: trimmed, createdAt: new Date().toISOString() };
      target.definitionVersions.push(version);
      target.currentVersionId = version.id;
      target.definition = trimmed;
      draft.segments.forEach((segment) => {
        CODERS.forEach((coder) => {
          segment.assignments[coder].forEach((assignment) => {
            if (assignment.themeId === themeId && assignment.status === 'current' && assignment.versionId !== version.id) assignment.status = 'pending';
          });
        });
      });
    });
  };

  // 复核单条编码：keep = 沿用旧版（保留原绑定），adopt = 改用新版（绑定到当前定义）
  const reviewAssignment = (segmentId: string, coder: CoderId, themeId: string, mode: 'keep' | 'adopt') => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    transaction(mode === 'keep' ? '复核编码·沿用旧版' : '复核编码·改用新版', theme.name, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      const assignment = segment?.assignments[coder].find((item) => item.themeId === themeId);
      if (!assignment) return;
      if (mode === 'adopt') {
        assignment.versionId = theme.currentVersionId;
        assignment.status = 'current';
      } else {
        assignment.status = 'legacy';
      }
    });
  };

  const reviewThemeAssignments = (themeId: string, mode: 'keep' | 'adopt') => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    const pending = themePendingCount(themeId);
    if (!pending) return;
    transaction(mode === 'keep' ? '批量复核·沿用旧版' : '批量复核·改用新版', `${theme.name} · ${pending} 条`, (draft) => {
      draft.segments.forEach((segment) => {
        CODERS.forEach((coder) => {
          segment.assignments[coder].forEach((assignment) => {
            if (assignment.themeId !== themeId || assignment.status !== 'pending') return;
            if (mode === 'adopt') {
              assignment.versionId = theme.currentVersionId;
              assignment.status = 'current';
            } else {
              assignment.status = 'legacy';
            }
          });
        });
      });
    });
  };

  const deleteTheme = (themeId: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    transaction('删除主题', theme.name, (draft) => {
      draft.themes = draft.themes.filter((item) => item.id !== themeId);
      draft.themes.forEach((item) => { if (item.parentId === themeId) item.parentId = null; });
      draft.segments.forEach((segment) => {
        segment.assignments.A = segment.assignments.A.filter((item) => item.themeId !== themeId);
        segment.assignments.B = segment.assignments.B.filter((item) => item.themeId !== themeId);
      });
      if (draft.activeThemeId === themeId) draft.activeThemeId = draft.themes[0]?.id ?? '';
    });
  };

  const mergeThemes = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    transaction('合并主题', `${state.themes.find((item) => item.id === sourceId)?.name ?? sourceId} → ${state.themes.find((item) => item.id === targetId)?.name ?? targetId}`, (draft) => {
      const source = draft.themes.find((theme) => theme.id === sourceId);
      const target = draft.themes.find((theme) => theme.id === targetId);
      if (!source || !target) return;
      // 来源主题的定义版本整体迁入目标主题，版本号顺延，绑定关系不断裂
      let nextNumber = Math.max(0, ...target.definitionVersions.map((version) => version.version));
      source.definitionVersions.forEach((version) => {
        nextNumber += 1;
        target.definitionVersions.push({ ...version, version: nextNumber, note: `合并自「${source.name}」` });
      });
      const statusRank: Record<AssignmentStatus, number> = { current: 0, pending: 1, legacy: 2 };
      draft.segments.forEach((segment) => {
        CODERS.forEach((coder) => {
          let touched = false;
          segment.assignments[coder].forEach((assignment) => {
            if (assignment.themeId !== sourceId) return;
            assignment.themeId = targetId;
            if (assignment.versionId !== target.currentVersionId && assignment.status === 'current') assignment.status = 'pending';
            touched = true;
          });
          if (!touched) return;
          const best = new Map<string, Assignment>();
          segment.assignments[coder].forEach((assignment) => {
            const existing = best.get(assignment.themeId);
            if (!existing || statusRank[assignment.status] < statusRank[existing.status]) best.set(assignment.themeId, assignment);
          });
          segment.assignments[coder] = [...best.values()];
        });
      });
      draft.themes.forEach((theme) => { if (theme.parentId === sourceId) theme.parentId = targetId; });
      draft.themes = draft.themes.filter((theme) => theme.id !== sourceId);
      draft.activeThemeId = targetId;
    });
  };

  const splitTheme = (sourceId: string, newName: string, segmentIds: string[]) => {
    const newId = `t-${crypto.randomUUID()}`;
    transaction('拆分主题', newName, (draft) => {
      const source = draft.themes.find((theme) => theme.id === sourceId);
      if (!source) return;
      // 新主题克隆完整定义历史，迁入片段的版本绑定按映射同步迁移
      const versionIdMap = new Map<string, string>();
      const clonedVersions = source.definitionVersions.map((version) => {
        const id = `dv-${crypto.randomUUID()}`;
        versionIdMap.set(version.id, id);
        return { ...version, id };
      });
      const newCurrentVersionId = versionIdMap.get(source.currentVersionId) ?? clonedVersions[clonedVersions.length - 1].id;
      draft.themes.push({ ...source, id: newId, name: newName, examples: [], definitionVersions: clonedVersions, currentVersionId: newCurrentVersionId });
      draft.segments.forEach((segment) => {
        if (!segmentIds.includes(segment.id)) return;
        CODERS.forEach((coder) => {
          segment.assignments[coder].forEach((assignment) => {
            if (assignment.themeId !== sourceId) return;
            assignment.themeId = newId;
            assignment.versionId = versionIdMap.get(assignment.versionId) ?? newCurrentVersionId;
          });
        });
      });
      draft.activeThemeId = newId;
    });
    return newId;
  };

  const updateSegment = (segmentId: string, patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>) => {
    transaction('编辑片段', `片段 ${segmentId}`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (segment) Object.assign(segment, patch);
    });
  };

  const importTranscript = (raw: string, title: string, participant: string, sourceName: string) => {
    const transcriptId = `tr-${crypto.randomUUID()}`;
    const rows = parseTranscript(raw, participant);
    transaction('导入转写', `${title}（${rows.length} 个片段）`, (draft) => {
      draft.transcripts.push({ id: transcriptId, title, participant, importedAt: new Date().toISOString(), sourceName });
      const start = draft.segments.length;
      const segments: Segment[] = rows.map((row, index) => ({
        id: `s-${crypto.randomUUID()}`,
        transcriptId,
        order: start + index,
        speaker: row.speaker,
        time: row.time,
        text: row.text,
        assignments: { A: [], B: [] },
        note: ''
      }));
      draft.segments.push(...segments);
      draft.activeTranscriptId = transcriptId;
      draft.activeSegmentId = segments[0]?.id ?? draft.activeSegmentId;
    });
  };

  const addExample = (themeId: string, example: string) => {
    const trimmed = example.trim();
    if (!trimmed) return;
    transaction('添加主题示例', trimmed, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme && !theme.examples.includes(trimmed)) theme.examples.push(trimmed);
    });
  };

  const versionLabel = (themeId: string, versionId: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    const version = theme?.definitionVersions.find((item) => item.id === versionId);
    return version ? `v${version.version}` : '未知版本';
  };

  const themePendingCount = (themeId: string) => state.segments.reduce((count, segment) => (
    count + CODERS.reduce((sum, coder) => sum + segment.assignments[coder].filter((item) => item.themeId === themeId && item.status === 'pending').length, 0)
  ), 0);

  const totalPendingCount = () => state.segments.reduce((count, segment) => (
    count + CODERS.reduce((sum, coder) => sum + segment.assignments[coder].filter((item) => item.status === 'pending').length, 0)
  ), 0);

  const segmentHasPending = (segment: Segment) => CODERS.some((coder) => segment.assignments[coder].some((item) => item.status === 'pending'));

  const isDisagreement = (segment: Segment) => assignmentKey(segment, 'A') !== assignmentKey(segment, 'B');

  const exportCoding = (format: 'json' | 'csv') => {
    const themeMap = new Map(state.themes.map((theme) => [theme.id, theme]));
    if (format === 'json') return JSON.stringify({ exportedAt: new Date().toISOString(), ...cloneState(state) }, null, 2);
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const themePath = (themeId: string) => {
      const names: string[] = [];
      let current = themeMap.get(themeId);
      while (current) {
        names.unshift(current.name);
        current = current.parentId ? themeMap.get(current.parentId) : undefined;
      }
      return names.join(' / ') || '未知主题';
    };
    const rows = [['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '定义版本', '复核状态', '备忘录'].map(escape).join(',')];
    state.segments.forEach((segment) => {
      CODERS.forEach((coder) => {
        const name = coder === 'A' ? state.coderA : state.coderB;
        const list = segment.assignments[coder];
        if (!list.length) {
          rows.push([segment.id, segment.time, segment.speaker, segment.text, name, '未编码', '', '', segment.note].map(escape).join(','));
          return;
        }
        list.forEach((assignment) => {
          rows.push([
            segment.id,
            segment.time,
            segment.speaker,
            segment.text,
            name,
            themePath(assignment.themeId),
            versionLabel(assignment.themeId, assignment.versionId),
            ASSIGNMENT_STATUS_LABEL[assignment.status] ?? assignment.status,
            segment.note
          ].map(escape).join(','));
        });
      });
    });
    return `\uFEFF${rows.join('\n')}`;

  };

  const downloadExport = (format: 'json' | 'csv') => {
    const content = exportCoding(format);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `访谈编码结果-${new Date().toISOString().slice(0, 10)}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const keepLocalVersion = () => {
    setRemoteEnvelope(null);
    transaction('处理多标签冲突', '保留当前标签页版本并生成新修订', () => undefined);
  };

  const applyRemoteVersion = () => {
    const remote = remoteEnvelope();
    if (!remote) return;
    setUndoStack((items) => [...items, cloneState(state)]);
    setRedoStack([]);
    setState(reconcile(normalizeState(remote.state), { merge: false }));
    setRemoteEnvelope(null);
  };

  const orderedThemes = () => buildTreeOrder(state.themes);

  return {
    state,
    initialize,
    undo,
    redo,
    canUndo: () => undoStack().length > 0,
    canRedo: () => redoStack().length > 0,
    selectSegment,
    selectTranscript,
    selectTheme,
    setCoder,
    toggleAssignment,
    batchAssign,
    addTheme,
    updateTheme,
    publishDefinition,
    reviewAssignment,
    reviewThemeAssignments,
    deleteTheme,
    mergeThemes,
    splitTheme,
    updateSegment,
    importTranscript,
    addExample,
    exportCoding,
    downloadExport,
    orderedThemes,
    versionLabel,
    themePendingCount,
    totalPendingCount,
    segmentHasPending,
    isDisagreement,
    remoteEnvelope,
    keepLocalVersion,
    applyRemoteVersion,
    storageReady,
    lastSavedAt
  };
}
