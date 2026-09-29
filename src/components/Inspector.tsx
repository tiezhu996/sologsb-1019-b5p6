import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { Button, Chip, Divider, Paper, Typography } from '@suid/material';
import type { CoderId, Theme } from '../types';
import { ASSIGNMENT_STATUS_LABEL, useCodingStore } from '../store/coding-store';

type Store = ReturnType<typeof useCodingStore>;

const CODERS: CoderId[] = ['A', 'B'];

export default function Inspector(props: { store: Store }) {
  const [definition, setDefinition] = createSignal('');
  const [memo, setMemo] = createSignal('');
  const [example, setExample] = createSignal('');
  const [segmentNote, setSegmentNote] = createSignal('');
  const [section, setSection] = createSignal<'theme' | 'compare' | 'review' | 'audit'>('theme');

  const theme = createMemo(() => props.store.state.themes.find((item) => item.id === props.store.state.activeThemeId));
  const segment = createMemo(() => props.store.state.segments.find((item) => item.id === props.store.state.activeSegmentId));
  const citations = createMemo(() => {
    const current = theme();
    if (!current) return [];
    return props.store.state.segments.filter((item) => CODERS.some((coder) => item.assignments[coder].some((assignment) => assignment.themeId === current.id)));
  });
  const themeName = (themeId: string) => props.store.state.themes.find((item) => item.id === themeId)?.name ?? '未知主题';
  const coderName = (coder: CoderId) => coder === 'A' ? props.store.state.coderA : props.store.state.coderB;

  const versionHistory = createMemo(() => [...(theme()?.definitionVersions ?? [])].sort((a, b) => b.version - a.version));
  const reviewQueue = createMemo(() => {
    const current = theme();
    if (!current) return [];
    return props.store.state.segments.flatMap((item) => CODERS.flatMap((coder) => (
      item.assignments[coder]
        .filter((assignment) => assignment.themeId === current.id && assignment.status === 'pending')
        .map((assignment) => ({ segment: item, coder, assignment }))
    )));
  });

  createEffect(() => {
    const current = theme();
    setDefinition(current?.definition ?? '');
    setMemo(current?.memo ?? '');
    setExample('');
  });

  createEffect(() => setSegmentNote(segment()?.note ?? ''));

  const saveThemeField = (field: 'definition' | 'memo', value: string) => {
    const current = theme();
    if (!current || current[field] === value) return;
    if (field === 'definition') props.store.publishDefinition(current.id, value);
    else props.store.updateTheme(current.id, { [field]: value } as Partial<Theme>, '研究备忘录');
  };

  const saveNote = () => {
    const current = segment();
    if (!current || current.note === segmentNote()) return;
    props.store.updateSegment(current.id, { speaker: current.speaker, time: current.time, text: current.text, note: segmentNote() });
  };

  const jumpToSegment = (segmentId: string) => {
    props.store.selectSegment(segmentId);
    window.setTimeout(() => document.querySelector('.segment-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  };

  return (
    <Paper class="panel inspector-panel" elevation={0}>
      <div class="panel-heading">
        <div>
          <Typography variant="overline">03 / 研究记录</Typography>
          <Typography variant="h6">主题与判断</Typography>
        </div>
      </div>
      <div class="inspector-tabs">
        <button classList={{ active: section() === 'theme' }} onClick={() => setSection('theme')}>主题</button>
        <button classList={{ active: section() === 'compare' }} onClick={() => setSection('compare')}>双人比较</button>
        <button classList={{ active: section() === 'review' }} onClick={() => setSection('review')}>版本复核{props.store.totalPendingCount() ? ` · ${props.store.totalPendingCount()}` : ''}</button>
        <button classList={{ active: section() === 'audit' }} onClick={() => setSection('audit')}>操作记录</button>
      </div>
      <Divider />

      <Show when={section() === 'theme'}>
        <Show when={theme()} fallback={<div class="empty-state">从中间主题树选择一个主题，添加定义、备忘录和示例。</div>}>
          {(current) => <>
            <div class="selected-theme-title"><span style={{ background: current().color }} /> <strong>{current().name}</strong></div>
            <Show when={segment()}>
              {(activeSegment) => <div class="quote-card">
                <div class="quote-meta">{activeSegment().time} · {activeSegment().speaker}</div>
                <blockquote>“{activeSegment().text}”</blockquote>
                <button class="link-button" onClick={() => document.querySelector('.segment-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>↗ 回到原文位置</button>
              </div>}
            </Show>
            <label class="field-label">操作定义
              <textarea class="native-textarea" value={definition()} onInput={(event) => setDefinition(event.currentTarget.value)} onBlur={() => saveThemeField('definition', definition())} placeholder="说明什么内容应/不应归入该主题" />
            </label>
            <div class="version-hint">
              <span>当前 {props.store.versionLabel(current().id, current().currentVersionId)} · 共 {current().definitionVersions.length} 版；修改后发布为新版本，旧版保留</span>
              <Show when={props.store.themePendingCount(current().id)}>
                <button class="link-button" onClick={() => setSection('review')}>{props.store.themePendingCount(current().id)} 条编码待复核 →</button>
              </Show>
            </div>
            <label class="field-label">研究备忘录
              <textarea class="native-textarea" value={memo()} onInput={(event) => setMemo(event.currentTarget.value)} onBlur={() => saveThemeField('memo', memo())} placeholder="记录判断边界、疑问或编码规则" />
            </label>
            <label class="field-label">添加典型示例
              <div class="inline-input">
                <input class="native-input" value={example()} onInput={(event) => setExample(event.currentTarget.value)} placeholder="输入示例文本" />
                <Button size="small" variant="contained" disabled={!example().trim()} onClick={() => { props.store.addExample(current().id, example()); setExample(''); }}>添加</Button>
              </div>
            </label>
            <Show when={current().examples.length} fallback={<div class="muted">暂无示例</div>}>
              <ul class="example-list"><For each={current().examples}>{(item) => <li>{item}</li>}</For></ul>
            </Show>
            <Show when={citations().length}>
              <div class="citation-heading">回原文引用 <span>{citations().length} 条</span></div>
              <div class="citation-list">
                <For each={citations()}>{(item) => (
                  <button class="citation-link" onClick={() => jumpToSegment(item.id)}>
                    <span>{item.time} · {item.speaker}</span>
                    <p>{item.text}</p>
                  </button>
                )}</For>
              </div>
            </Show>
          </>}
        </Show>
      </Show>

      <Show when={section() === 'compare'}>
        <Show when={segment()} fallback={<div class="empty-state">请先从左侧正文选择片段。</div>}>
          {(activeSegment) => <>
            <div class="compare-intro">比较同一位受访者在同一片段上的主题判断。任何不一致都会保留，直到研究者明确调整。</div>
            <div class="compare-grid">
              <For each={CODERS}>{(coder) => (
                <div class="coder-column">
                  <div class="coder-header"><span class="avatar" classList={{ b: coder === 'B' }}>{coder}</span><strong>{coderName(coder)}</strong></div>
                  <For each={activeSegment().assignments[coder]} fallback={<div class="muted">未编码</div>}>{(assignment) => (
                    <div class="compare-chip">
                      <Chip size="small" label={themeName(assignment.themeId)} />
                      <span class="ver-tag" classList={{ warn: assignment.status !== 'current' }} title={`判断依据：${themeName(assignment.themeId)} 定义 ${props.store.versionLabel(assignment.themeId, assignment.versionId)} · ${ASSIGNMENT_STATUS_LABEL[assignment.status]}`}>
                        {props.store.versionLabel(assignment.themeId, assignment.versionId)}{assignment.status !== 'current' ? `·${ASSIGNMENT_STATUS_LABEL[assignment.status]}` : ''}
                      </span>
                      <button class="icon-text" onClick={() => props.store.toggleAssignment(activeSegment().id, coder, assignment.themeId, false)}>×</button>
                    </div>
                  )}</For>
                  <select class="native-select full" value="" onChange={(event) => event.currentTarget.value && props.store.toggleAssignment(activeSegment().id, coder, event.currentTarget.value, true)}>
                    <option value="">＋ 给编码者 {coder} 添加主题</option>
                    <For each={props.store.orderedThemes()}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                  </select>
                </div>
              )}</For>
            </div>
            <Show when={props.store.isDisagreement(activeSegment())} fallback={<div class="agreement">✓ 当前判断完全一致</div>}>
              <div class="disagreement">⚠ 当前判断存在分歧，导出结果仍会同时保留两位编码者记录。</div>
            </Show>
            <label class="field-label">片段编码备忘
              <textarea class="native-textarea" value={segmentNote()} onInput={(event) => setSegmentNote(event.currentTarget.value)} onBlur={saveNote} placeholder="记录此片段的分歧处理或引文提示" />
            </label>
          </>}
        </Show>
      </Show>

      <Show when={section() === 'review'}>
        <Show when={theme()} fallback={<div class="empty-state">从中间主题树选择一个主题，查看定义版本历史与待复核编码。</div>}>
          {(current) => (
            <div class="review-scroll">
              <div class="citation-heading">定义版本历史 <span>共 {current().definitionVersions.length} 版</span></div>
              <div class="version-list">
                <For each={versionHistory()}>{(version) => (
                  <div class="version-item" classList={{ current: version.id === current().currentVersionId }}>
                    <div class="version-meta">
                      <strong>v{version.version}</strong>
                      <Show when={version.id === current().currentVersionId}><span class="version-badge">当前</span></Show>
                      <time>{new Date(version.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
                    </div>
                    <p>{version.text || '（空定义）'}</p>
                    <Show when={version.note}><small>{version.note}</small></Show>
                  </div>
                )}</For>
              </div>
              <div class="citation-heading">待复核编码 <span>{reviewQueue().length} 条</span></div>
              <Show when={reviewQueue().length} fallback={<div class="muted">没有待复核的编码。发布新版定义后，绑定旧版的编码会保留原判断并列在这里。</div>}>
                <div class="review-batch">
                  <span>批量处理 {reviewQueue().length} 条：</span>
                  <Button size="small" variant="outlined" onClick={() => props.store.reviewThemeAssignments(current().id, 'keep')}>全部沿用旧版</Button>
                  <Button size="small" variant="contained" onClick={() => props.store.reviewThemeAssignments(current().id, 'adopt')}>全部改用新版</Button>
                </div>
                <div class="review-queue">
                  <For each={reviewQueue()}>{(item) => (
                    <div class="review-item">
                      <button class="review-quote" onClick={() => jumpToSegment(item.segment.id)}>
                        <span>{item.segment.time} · {item.segment.speaker} · {coderName(item.coder)}</span>
                        <p>{item.segment.text}</p>
                      </button>
                      <div class="review-bind">
                        判断依据 <strong>{props.store.versionLabel(item.assignment.themeId, item.assignment.versionId)}</strong>
                        <span class="review-arrow">→</span>
                        当前 <strong>{props.store.versionLabel(current().id, current().currentVersionId)}</strong>
                      </div>
                      <div class="review-actions">
                        <button class="mini-button" onClick={() => props.store.reviewAssignment(item.segment.id, item.coder, current().id, 'keep')}>沿用旧版</button>
                        <button class="mini-button primary" onClick={() => props.store.reviewAssignment(item.segment.id, item.coder, current().id, 'adopt')}>改用新版</button>
                      </div>
                    </div>
                  )}</For>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </Show>

      <Show when={section() === 'audit'}>
        <div class="audit-summary">
          <div><strong>{props.store.state.audit.length}</strong><span>次最近操作</span></div>
          <div><strong>{citations().length}</strong><span>条当前主题引用</span></div>
        </div>
        <div class="audit-list">
          <For each={props.store.state.themes.filter((item) => item.definition || item.memo)}>{(item) => (
            <div class="citation" onClick={() => props.store.selectTheme(item.id)}>
              <strong>{item.name}</strong>
              <span>{item.definition ? `定义 ${props.store.versionLabel(item.id, item.currentVersionId)}` : ''}{item.definition && item.memo ? ' · ' : ''}{item.memo ? '含备忘录' : ''}</span>
            </div>
          )}</For>
        </div>
        <Divider />
        <div class="audit-list">
          <For each={props.store.state.audit.slice(0, 14)}>{(entry) => (
            <div class="audit-item"><span>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span><div><strong>{entry.action}</strong><p>{entry.detail}</p></div></div>
          )}</For>
        </div>
      </Show>
    </Paper>
  );
}
