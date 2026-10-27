import { z } from 'zod';

// eslint-disable-next-line no-control-regex
const plain = z.string().max(12000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
export const ReadingPlanSchema = z.object({
  blocks: z.array(z.object({
    kind: z.enum(['prose', 'table', 'image', 'formula']),
    text: plain,
    headers: z.array(z.string().max(120)).max(16),
    rows: z.array(z.array(z.string().max(1500)).max(16)).max(120),
  }).strict()).max(120),
  warnings: z.array(z.string().trim().min(1).max(300)).max(12),
  omitted: z.array(z.enum(['source_badges', 'navigation', 'figure_labels', 'formulas', 'decoration'])).max(5),
}).strict().superRefine((plan, context) => {
  for (const block of plan.blocks) {
    if (block.kind === 'table') {
      if (!block.headers.length || !block.rows.length || block.rows.some(row => row.length !== block.headers.length)) context.addIssue({ code: 'custom', message: '表格行列没有对齐。' });
    } else if (block.rows.length || block.headers.length || !block.text.trim()) context.addIssue({ code: 'custom', message: '内容结构无效。' });
  }
  if (JSON.stringify(plan).length > 24000) context.addIssue({ code: 'custom', message: '朗读稿过长。' });
});
export type ReadingPlan = z.infer<typeof ReadingPlanSchema>;

export const readingPlanJsonSchema = {
  type: 'object', additionalProperties: false, required: ['blocks', 'warnings', 'omitted'],
  properties: {
    blocks: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['kind', 'text', 'headers', 'rows'],
      properties: {
        kind: { type: 'string', enum: ['prose', 'table', 'image', 'formula'] },
        text: { type: 'string' },
        headers: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      },
    } },
    warnings: { type: 'array', items: { type: 'string' } },
    omitted: { type: 'array', items: { type: 'string', enum: ['source_badges', 'navigation', 'figure_labels', 'formulas', 'decoration'] } },
  },
} as const;

/** Row-major narration is constructed here, not left to the speech engine. */
export function renderReadingPlan(input: unknown, skipFormulas: boolean): { text: string; plan: ReadingPlan } {
  const plan = ReadingPlanSchema.parse(input);
  const sentence = (value: string) => /[。！？.!?]$/.test(value.trim()) ? value.trim() : value.trim() + '。';
  const text = plan.blocks.flatMap(block => {
    if (block.kind === 'formula' && skipFormulas) return [];
    if (block.kind !== 'table') return [sentence(block.text)];
    return [
      block.text.trim() ? sentence(block.text) : '下面是表格，按行朗读。',
      ...block.rows.map((row, index) => sentence('第' + (index + 1) + '行，' + row.map((cell, column) => (block.headers[column].trim() || '第' + (column + 1) + '列') + '：' + (cell.trim() || '空白')).join('；'))),
    ];
  }).join('\n\n');
  if (text.length > 12000) throw Error('整理后的文字超过一次朗读范围，请缩小截图。');
  return { text, plan };
}
