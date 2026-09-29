import { For, Show, createMemo, createSignal } from 'solid-js';
import { Button, Chip } from '@suid/material';
import type { CoderId } from '../types';
import type { useCodingStore } from '../store/coding-store';
import { STATUS_LABEL, versionLabel } from '../utils/coding';

type Store = ReturnType<typeof useCodingStore>;

export default function ReviewDialog(props: { store: Store; open: boolean; onClose: () => void }) {
  const [filterTheme, setFilterTheme] = createSignal('');
  const [showKept, setShowKept] = createSignal(false);

  const rows = createMemo(() => props.store.pendingCodings(filterTheme() || undefined));
  const pendingRows = createMemo(() => rows().filter((row) => row.status === 'pending'));
  const keptRows = createMemo(() => rows().filter((row) => row.status === 'kept'));
  const outdatedThemes = createMemo(() => {
    const map = new Map<string, { name: string; current: number; pending: number }>();
    props.store.pendingCodings().forEach((row) => {
      if (row.status !== 'pending') return;
      const entry = map.get(row.theme.id) ?? { name: row.theme.name, current: row.theme.definitionVersion, pending: 0 };
      entry.pending += 1;
      map.set(row.theme.id, entry);
    });
    return [...map.entries()].map(([id, value]) => ({ id, ...value }));
  });

  const coderName = (coder: CoderId) => (coder === 'A' ? props.store.state.coderA : props.store.state.coderB);

  const jumpToSegment = (segmentId: string) => {
    props.store.selectSegment(segmentId);
    props.store.selectTheme(filterTheme() || props.store.state.activeThemeId);
    props.onClose();
    window.setTimeout(() => document.querySelector('.segment-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  };

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={props.onClose}>
      <section class="modal-card wide" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header>
          <div><span class="eyebrow">REVIEW</span><h2>操作定义复核</h2></div>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </header>
        <p class="modal-intro">操作定义发布新版本后，此前完成的编码会逐条进入待复核；<strong>原判断始终保留</strong>，你可以逐条确认沿用旧版或改用新版，也可批量处理。</p>

        <div class="review-summary">
          <div><strong>{pendingRows().length}</strong><span>条待复核</span></div>
          <div><strong>{outdatedThemes().length}</strong><span>个主题定义已更新</span></div>
          <div><strong>{keptRows().length}</strong><span>条已沿用旧版</span></div>
        </div>

        <Show when={outdatedThemes().length > 0}>
          <div class="review-themes">
            <For each={outdatedThemes()}>{(item) => (
              <button class="review-theme-chip" classList={{ active: filterTheme() === item.id }} onClick={() => setFilterTheme((current) => current === item.id ? '' : item.id)}>
                {item.name}<Chip size="small" label={`${item.pending} 条`} />
                <span class="review-versions">{versionLabel(item.current - 1)} → {versionLabel(item.current)}</span>
              </button>
            )}</For>
          </div>
        </Show>

        <div class="review-toolbar">
          <label class="field-label inline">按主题筛选
            <select class="native-select" value={filterTheme()} onChange={(event) => setFilterTheme(event.currentTarget.value)}>
              <option value="">全部主题</option>
              <For each={props.store.orderedThemes()}>{(theme) => <option value={theme.id}>{theme.name}</option>}</For>
            </select>
          </label>
          <div class="button-row">
            <Button size="small" variant="outlined" disabled={!pendingRows().length} onClick={() => props.store.batchReview(filterTheme() || undefined, 'keep')}>批量沿用旧版</Button>
            <Button size="small" variant="contained" disabled={!pendingRows().length} onClick={() => props.store.batchReview(filterTheme() || undefined, 'accept')}>批量改用新版</Button>
          </div>
        </div>

        <div class="review-list">
          <For each={pendingRows()} fallback={<div class="empty-state">没有待复核的编码。所有判断都绑定在当前操作定义版本上。</div>}>{(row) => (
            <div class="review-item">
              <button class="review-main" onClick={() => jumpToSegment(row.segment.id)}>
                <div class="review-meta">
                  <span>{row.segment.time} · {row.segment.speaker}</span>
                  <span class="review-coder">编码者 {row.coder} · {coderName(row.coder)}</span>
                </div>
                <p>{row.segment.text}</p>
                <div class="review-tags">
                  <Chip size="small" label={row.theme.name} />
                  <span class="status-tag pending" title={`绑定${versionLabel(row.ref.definitionVersion)}，当前为${versionLabel(row.theme.definitionVersion)}`}>{STATUS_LABEL.pending} · {versionLabel(row.ref.definitionVersion)} → {versionLabel(row.theme.definitionVersion)}</span>
                </div>
              </button>
              <div class="review-actions">
                <Button size="small" variant="outlined" onClick={() => props.store.reviewCoding(row.segment.id, row.coder, row.theme.id, 'keep')}>沿用旧版</Button>
                <Button size="small" variant="contained" onClick={() => props.store.reviewCoding(row.segment.id, row.coder, row.theme.id, 'accept')}>改用新版</Button>
              </div>
            </div>
          )}</For>
        </div>

        <Show when={keptRows().length > 0}>
          <div class="review-kept-toggle">
            <button class="link-button" onClick={() => setShowKept((value) => !value)}>{showKept() ? '收起已沿用旧版' : `查看已沿用旧版（${keptRows().length}）`}</button>
          </div>
          <Show when={showKept()}>
            <div class="review-list kept">
              <For each={keptRows()}>{(row) => (
                <div class="review-item kept">
                  <div class="review-main">
                    <div class="review-meta">
                      <span>{row.segment.time} · {row.segment.speaker}</span>
                      <span class="review-coder">编码者 {row.coder} · {coderName(row.coder)}</span>
                    </div>
                    <p>{row.segment.text}</p>
                    <div class="review-tags">
                      <Chip size="small" label={row.theme.name} />
                      <span class="status-tag kept">{STATUS_LABEL.kept} · {versionLabel(row.ref.definitionVersion)}</span>
                    </div>
                  </div>
                </div>
              )}</For>
            </div>
          </Show>
        </Show>

        <footer><Button variant="contained" onClick={props.onClose}>完成</Button></footer>
      </section>
    </div>
  );
}
