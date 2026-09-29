import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type { CoderId, CodingRef, CodingState, PersistedEnvelope, ReviewStatus, Segment, Theme } from '../types';
import { readEnvelope, writeEnvelope } from '../utils/db';
import { CODING_STATE_VERSION, codingStatus, freshRef, hasTheme, refsFromLegacy } from '../utils/coding';

const STORAGE_KEY = 'sologsb-1019-state-v1';
const TAB_ID = crypto.randomUUID();

/** 旧数据迁移：补全操作定义版本历史，并把字符串编码绑定到当前定义版本。 */
const migrateState = (state: CodingState): CodingState => {
  const next = structuredClone(state);
  next.themes.forEach((theme) => {
    if (typeof theme.definitionVersion !== 'number' || !Array.isArray(theme.definitionHistory) || theme.definitionHistory.length === 0) {
      theme.definitionVersion = 1;
      theme.definitionHistory = [{ version: 1, definition: theme.definition ?? '', publishedAt: next.updatedAt ?? new Date().toISOString() }];
    }
  });
  next.segments.forEach((segment) => {
    (['A', 'B'] as CoderId[]).forEach((coder) => {
      const raw = segment.assignments[coder] as unknown;
      if (Array.isArray(raw) && (raw.length === 0 || typeof raw[0] === 'string')) {
        segment.assignments[coder] = refsFromLegacy(raw as string[], next.themes);
      }
    });
  });
  next.codingStateVersion = CODING_STATE_VERSION;
  return next;
};

const loadLocal = (): CodingState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrateState(JSON.parse(raw) as CodingState);
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

/** 合并后按主题去重，保留状态更新的编码引用。 */
const dedupRefs = (refs: CodingRef[]): CodingRef[] => {
  const rank = (ref: CodingRef) => (ref.reviewStatus === 'current' ? 2 : ref.reviewStatus === 'kept' ? 1 : 0);
  const byTheme = new Map<string, CodingRef>();
  refs.forEach((ref) => {
    const existing = byTheme.get(ref.themeId);
    if (!existing || rank(ref) > rank(existing)) byTheme.set(ref.themeId, ref);
  });
  return [...byTheme.values()];
};

export function useCodingStore() {
  const initialize = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      const stored = await readEnvelope();
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
      const theme = draft.themes.find((item) => item.id === themeId);
      if (!segment || !theme) return;
      const refs = segment.assignments[coder];
      if (enabled) {
        if (!refs.some((ref) => ref.themeId === themeId)) refs.push(freshRef(theme));
      } else {
        segment.assignments[coder] = refs.filter((ref) => ref.themeId !== themeId);
      }
    });
  };

  const batchAssign = (segmentIds: string[], coder: CoderId, themeId: string) => {
    if (!segmentIds.length) return;
    transaction('批量重编码', `将 ${segmentIds.length} 个片段分配给主题`, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (!theme) return;
      draft.segments.forEach((segment) => {
        if (segmentIds.includes(segment.id) && !segment.assignments[coder].some((ref) => ref.themeId === themeId)) {
          segment.assignments[coder].push(freshRef(theme));
        }
      });
    });
  };

  const addTheme = (name: string, parentId: string | null) => {
    const id = `t-${crypto.randomUUID()}`;
    transaction('新建主题', name, (draft) => {
      const nowIso = new Date().toISOString();
      draft.themes.push({
        id,
        name,
        parentId,
        color: parentId ? '#57978c' : '#267365',
        definition: '',
        definitionVersion: 1,
        definitionHistory: [{ version: 1, definition: '', publishedAt: nowIso }],
        memo: '',
        examples: []
      });
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

  /** 发布操作定义新版本：保留旧版，该主题全部旧编码进入待复核，原判断保留。 */
  const publishDefinition = (themeId: string, definition: string) => {
    const trimmed = definition.trim();
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme || theme.definition === trimmed) return;
    transaction('发布操作定义新版', `${theme.name} → v${theme.definitionVersion + 1}`, (draft) => {
      const target = draft.themes.find((item) => item.id === themeId);
      if (!target) return;
      target.definition = trimmed;
      target.definitionVersion += 1;
      target.definitionHistory.push({ version: target.definitionVersion, definition: trimmed, publishedAt: new Date().toISOString() });
      draft.segments.forEach((segment) => {
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          segment.assignments[coder].forEach((ref) => {
            if (ref.themeId === target.id) {
              ref.reviewStatus = ref.definitionVersion === target.definitionVersion ? 'current' : 'pending';
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
        segment.assignments.A = segment.assignments.A.filter((ref) => ref.themeId !== themeId);
        segment.assignments.B = segment.assignments.B.filter((ref) => ref.themeId !== themeId);
      });
      if (draft.activeThemeId === themeId) draft.activeThemeId = draft.themes[0]?.id ?? '';
    });
  };

  const mergeThemes = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    transaction('合并主题', `${state.themes.find((item) => item.id === sourceId)?.name ?? sourceId} → ${state.themes.find((item) => item.id === targetId)?.name ?? targetId}`, (draft) => {
      const target = draft.themes.find((item) => item.id === targetId);
      draft.segments.forEach((segment) => {
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          segment.assignments[coder] = dedupRefs(segment.assignments[coder].map((ref) => {
            if (ref.themeId !== sourceId) return ref;
            // 迁移版本关系：绑定目标主题当前定义，标记待复核
            return { ...ref, themeId: targetId, definitionVersion: target?.definitionVersion ?? 1, reviewStatus: 'pending' as const };
          }));
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
      const nowIso = new Date().toISOString();
      // 新主题从 v1 开始，定义沿用源主题当前定义
      draft.themes.push({
        ...source,
        id: newId,
        name: newName,
        examples: [],
        definitionVersion: 1,
        definitionHistory: [{ version: 1, definition: source.definition, publishedAt: nowIso }]
      });
      draft.segments.forEach((segment) => {
        if (!segmentIds.includes(segment.id)) return;
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          segment.assignments[coder].forEach((ref) => {
            if (ref.themeId === sourceId) {
              ref.themeId = newId;
              ref.definitionVersion = 1;
              ref.reviewStatus = 'pending';
            }
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

  /** 全部编码引用（含有效复核状态），可按主题过滤。 */
  const pendingCodings = (themeId?: string) => {
    const rows: Array<{ segment: Segment; coder: CoderId; theme: Theme; ref: CodingRef; status: ReviewStatus }> = [];
    state.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        segment.assignments[coder].forEach((ref) => {
          const theme = state.themes.find((item) => item.id === ref.themeId);
          if (!theme) return;
          if (themeId && theme.id !== themeId) return;
          rows.push({ segment, coder, theme, ref, status: codingStatus(ref, theme) });
        });
      });
    });
    return rows;
  };

  const pendingCount = () => pendingCodings().filter((row) => row.status === 'pending').length;

  /** 逐条复核：keep 沿用旧版定义，accept 改用新版定义。原判断始终保留。 */
  const reviewCoding = (segmentId: string, coder: CoderId, themeId: string, decision: 'keep' | 'accept') => {
    transaction(decision === 'keep' ? '沿用旧版定义' : '改用新版定义', `片段 ${segmentId}`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      const theme = draft.themes.find((item) => item.id === themeId);
      if (!segment || !theme) return;
      const ref = segment.assignments[coder].find((item) => item.themeId === themeId);
      if (!ref) return;
      if (decision === 'keep') {
        ref.reviewStatus = 'kept';
      } else {
        ref.definitionVersion = theme.definitionVersion;
        ref.reviewStatus = 'current';
      }
    });
  };

  /** 批量复核当前筛选下的待复核编码。 */
  const batchReview = (themeId: string | undefined, decision: 'keep' | 'accept') => {
    const targets = pendingCodings(themeId).filter((row) => row.status === 'pending');
    if (!targets.length) return;
    transaction(decision === 'keep' ? '批量沿用旧版' : '批量改用新版', `${targets.length} 条编码`, (draft) => {
      targets.forEach((row) => {
        const segment = draft.segments.find((item) => item.id === row.segment.id);
        const theme = draft.themes.find((item) => item.id === row.theme.id);
        if (!segment || !theme) return;
        const ref = segment.assignments[row.coder].find((item) => item.themeId === row.theme.id);
        if (!ref) return;
        if (decision === 'keep') ref.reviewStatus = 'kept';
        else {
          ref.definitionVersion = theme.definitionVersion;
          ref.reviewStatus = 'current';
        }
      });
    });
  };

  const exportCoding = (format: 'json' | 'csv') => {
    if (format === 'json') {
      return JSON.stringify({ exportedAt: new Date().toISOString(), codingFormatVersion: 2, ...cloneState(state) }, null, 2);
    }
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [[...['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '定义版本', '复核状态', '备忘录']].map(escape).join(',')];
    state.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? state.coderA : state.coderB;
        const refs = segment.assignments[coder];
        if (!refs.length) {
          rows.push([segment.id, segment.time, segment.speaker, segment.text, name, '未编码', '', '', segment.note].map(escape).join(','));
          return;
        }
        refs.forEach((ref) => {
          const theme = state.themes.find((item) => item.id === ref.themeId);
          const names: string[] = [];
          let current: Theme | undefined = theme;
          while (current) {
            names.unshift(current.name);
            current = current.parentId ? state.themes.find((item) => item.id === current!.parentId) : undefined;
          }
          rows.push([
            segment.id, segment.time, segment.speaker, segment.text, name,
            names.join(' / '),
            theme ? `v${ref.definitionVersion}` : '已删除',
            theme ? (codingStatus(ref, theme) === 'current' ? '当前版本' : codingStatus(ref, theme) === 'pending' ? '待复核' : '已沿用旧版') : '待复核',
            segment.note
          ].map(escape).join(','));
        });
      });
    });
    return `﻿${rows.join('\n')}`;
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
    setState(reconcile(migrateState(remote.state), { merge: false }));
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
    deleteTheme,
    mergeThemes,
    splitTheme,
    updateSegment,
    importTranscript,
    addExample,
    pendingCodings,
    pendingCount,
    reviewCoding,
    batchReview,
    exportCoding,
    downloadExport,
    orderedThemes,
    remoteEnvelope,
    keepLocalVersion,
    applyRemoteVersion,
    storageReady,
    lastSavedAt
  };
}
