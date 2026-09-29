export type CoderId = 'A' | 'B';

/**
 * 复核状态：
 * - current 已绑定当前操作定义版本，无需复核
 * - pending 绑定的操作定义已更新，等待研究者逐条复核（原判断保留）
 * - kept     研究者已复核并明确沿用旧版定义
 */
export type ReviewStatus = 'current' | 'pending' | 'kept';

/** 操作定义的一个历史版本。定义每修改一次即发布一个新版本。 */
export interface DefinitionVersion {
  version: number;
  definition: string;
  publishedAt: string;
}

/** 一条编码引用：把某位编码者在某片段上的判断绑定到当时的操作定义版本。 */
export interface CodingRef {
  themeId: string;
  definitionVersion: number;
  reviewStatus: ReviewStatus;
}

export interface Theme {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  /** 当前版本的操作定义（与 definitionHistory 最后一项同步）。 */
  definition: string;
  /** 当前操作定义版本号，从 1 开始。 */
  definitionVersion: number;
  /** 操作定义历史版本，按版本号递增保存。 */
  definitionHistory: DefinitionVersion[];
  memo: string;
  examples: string[];
}

export interface Segment {
  id: string;
  transcriptId: string;
  order: number;
  speaker: string;
  time: string;
  text: string;
  assignments: Record<CoderId, CodingRef[]>;
  note: string;
}

export interface Transcript {
  id: string;
  title: string;
  participant: string;
  importedAt: string;
  sourceName: string;
}

export interface CodingState {
  /** 状态结构版本，用于旧数据首次打开时迁移到操作定义版本模型。 */
  codingStateVersion: number;
  revision: number;
  updatedAt: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  themes: Theme[];
  audit: Array<{ id: string; at: string; action: string; detail: string }>;
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}
