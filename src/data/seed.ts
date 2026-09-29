import type { CodingRef, CodingState, Theme } from '../types';

const now = new Date().toISOString();

const makeTheme = (
  id: string,
  name: string,
  parentId: string | null,
  color: string,
  definition: string,
  memo: string,
  examples: string[]
): Theme => ({
  id,
  name,
  parentId,
  color,
  definition,
  definitionVersion: 1,
  definitionHistory: [{ version: 1, definition, publishedAt: now }],
  memo,
  examples
});

/** 演示数据中的编码均绑定操作定义第 1 版。 */
const refs = (...themeIds: string[]): CodingRef[] =>
  themeIds.map((themeId) => ({ themeId, definitionVersion: 1, reviewStatus: 'current' as const }));

export const seedState = (): CodingState => {
  const themes = [
    makeTheme('t-education', '1. 教育经历', null, '#267365', '正式或非正式的学习经历、学校与教师记忆。', '注意区分入学选择和家庭影响。', ['小学时老师让我第一次接触地图']),
    makeTheme('t-school-choice', '1.1 学校选择', 't-education', '#4d9b8f', '关于进入哪所学校、为何选择及其决策者的陈述。', '家长和个人的理由要分别编码。', []),
    makeTheme('t-teacher', '1.2 教师影响', 't-education', '#78b7ac', '教师对学习兴趣、职业方向或自我认知的影响。', '', ['他总能把课文讲成故事']),
    makeTheme('t-work', '2. 工作与迁徙', null, '#b65d38', '职业选择、工作变化以及由此产生的地域迁移。', '', []),
    makeTheme('t-migration', '2.1 迁徙决定', 't-work', '#d2845f', '搬家、跨地区工作背后的家庭与经济决策。', '', []),
    makeTheme('t-family', '3. 家庭支持', null, '#3b6f95', '家庭成员在教育、工作和生活转型中的支持。', '', [])
  ];
  const lines = [
    ['00:00:08', '访谈者', '李老师，您小时候是在县城还是乡下长大的？'],
    ['00:00:14', '李岚', '我是在临河镇长大的。小学四年级以前都在村里，后来家里觉得镇上的学校更好，就把我转过去了。'],
    ['00:00:31', '访谈者', '这个转学是谁提出来的？'],
    ['00:00:35', '李岚', '主要是我母亲。她认识镇上学校的王老师，说那边图书室有很多书。我当时其实不太愿意，因为要离开熟悉的朋友。'],
    ['00:00:53', '访谈者', '到了新学校以后，有哪个老师对您影响很大吗？'],
    ['00:00:59', '李岚', '班主任周老师。他没有只盯着成绩，常拿旧地图给我们讲河流和城市。我第一次觉得知识不是背出来的。'],
    ['00:01:20', '访谈者', '后来选择师范专业，也和这段经历有关吗？'],
    ['00:01:26', '李岚', '有关系。我原本想读贸易，是周老师和我母亲一起劝我，说我很适合教书。父亲那时更希望我去厂里上班，家里还争论过。'],
    ['00:01:48', '访谈者', '毕业以后一直留在本市吗？'],
    ['00:01:53', '李岚', '先在县中教了六年，后来丈夫工作调动，我才搬到省城。刚开始很不适应，母亲每周寄菜，也提醒我不要因为调动就放弃进修。'],
    ['00:02:17', '访谈者', '回看这些选择，您觉得家庭支持起了什么作用？'],
    ['00:02:23', '李岚', '不是替我做决定，而是在我犹豫的时候把可能性讲清楚。有时他们的建议并不对，但至少让我知道可以商量。']
  ];
  return {
    codingStateVersion: 2,
    revision: 1,
    updatedAt: now,
    activeTranscriptId: 'tr-001',
    activeSegmentId: 's-001',
    activeThemeId: 't-school-choice',
    coderA: '林研究员',
    coderB: '赵研究员',
    transcripts: [{ id: 'tr-001', title: '李岚访谈：教育与职业选择', participant: '李岚', importedAt: now, sourceName: '示例转写' }],
    segments: lines.map((line, index) => ({
      id: `s-${String(index + 1).padStart(3, '0')}`,
      transcriptId: 'tr-001',
      order: index,
      time: line[0],
      speaker: line[1],
      text: line[2],
      assignments: {
        A: index === 1 ? refs('t-school-choice') : index === 5 ? refs('t-teacher') : index === 7 ? refs('t-teacher', 't-family') : index === 8 ? refs('t-migration') : index === 9 ? refs('t-family') : [],
        B: index === 1 ? refs('t-school-choice', 't-family') : index === 5 ? refs('t-teacher') : index === 7 ? refs('t-teacher') : index === 8 ? refs('t-migration', 't-work') : []
      },
      note: ''
    })),
    themes,
    audit: [{ id: 'a-seed', at: now, action: '初始化', detail: '载入演示访谈与两个编码者的判断' }]
  };
};
