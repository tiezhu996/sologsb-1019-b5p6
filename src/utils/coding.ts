import type { CoderId, CodingRef, ReviewStatus, Theme } from '../types';

export const CODING_STATE_VERSION = 2;

export const themeIdsOf = (refs: CodingRef[]): string[] => refs.map((ref) => ref.themeId);

export const hasTheme = (refs: CodingRef[], themeId: string): boolean => refs.some((ref) => ref.themeId === themeId);

/** 比较两位编码者的主题判断集合是否一致（只比主题，不比定义版本）。 */
export const setsEqual = (a: CodingRef[], b: CodingRef[]): boolean => {
  const aIds = new Set(themeIdsOf(a));
  const bIds = new Set(themeIdsOf(b));
  return aIds.size === bIds.size && [...aIds].every((id) => bIds.has(id));
};

/**
 * 一条编码引用的有效复核状态：
 * - 已绑定当前版本 → current
 * - 绑定旧版本且研究者已沿用 → kept
 * - 绑定旧版本且未复核 → pending
 */
export const codingStatus = (ref: CodingRef, theme: Theme | undefined): ReviewStatus => {
  if (!theme) return 'pending';
  if (ref.definitionVersion >= theme.definitionVersion) return 'current';
  return ref.reviewStatus === 'kept' ? 'kept' : 'pending';
};

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  current: '当前版本',
  pending: '待复核',
  kept: '已沿用旧版'
};

export const STATUS_SHORT: Record<ReviewStatus, string> = {
  current: '当前',
  pending: '待复核',
  kept: '已沿用'
};

export const versionLabel = (version: number): string => `v${version}`;

/** 旧数据迁移：把字符串数组形式的编码转换为绑定当前定义版本的 CodingRef。 */
export const refsFromLegacy = (themeIds: string[], themes: Theme[]): CodingRef[] =>
  themeIds.map((themeId) => ({
    themeId,
    definitionVersion: themes.find((theme) => theme.id === themeId)?.definitionVersion ?? 1,
    reviewStatus: 'current' as const
  }));

/** 为新建编码构造引用：绑定主题当前定义版本。 */
export const freshRef = (theme: Theme): CodingRef => ({
  themeId: theme.id,
  definitionVersion: theme.definitionVersion,
  reviewStatus: 'current'
});

export const isCoder = (value: string): value is CoderId => value === 'A' || value === 'B';
