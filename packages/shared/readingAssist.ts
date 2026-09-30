import { z } from 'zod';
import { ContextSchema, EnvelopeSchema } from './protocol';

export const ReadingAssistRequestSchema = EnvelopeSchema.extend({ context: ContextSchema }).strict();
export type ReadingAssistRequest = z.infer<typeof ReadingAssistRequestSchema>;

const readingFields = {
  readingText: z.string().trim().min(1).max(12000),
  uncertain: z.boolean(),
  warnings: z.array(z.string().trim().min(1).max(500)).max(8),
};
/** Separate from a TeachingPlan: this operation may transcribe/read, never teach or solve. */
export const ReadingAssistDraftSchema = z.object({ contextRevision: z.number().int().nonnegative(), ...readingFields }).strict();
export type ReadingAssistDraft = z.infer<typeof ReadingAssistDraftSchema>;

export const ReadingAssistResponseSchema = EnvelopeSchema.extend({
  ...readingFields,
  usage: z.object({
    requestId: z.string(), model: z.string(), category: z.literal('text'),
    inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
    characters: z.number().int().nonnegative().nullable(), estimatedCost: z.null(), cancelled: z.boolean(),
  }).strict(),
}).strict();
export type ReadingAssistResponse = z.infer<typeof ReadingAssistResponseSchema>;

function hasCorruptGlyph(text: string): boolean {
  return /[\uFFFD\u200B-\u200F]|\p{Co}|\p{Cc}/u.test(text.replace(/[\t\r\n]/gu, ''));
}

/** Structural approval is not semantic proof; callers must still apply the local reading gate. */
export function validateReadingAssist(value: unknown, request: ReadingAssistRequest): ReadingAssistDraft {
  const draft = ReadingAssistDraftSchema.parse(value);
  if (draft.contextRevision !== request.contextRevision) throw new Error('朗读稿上下文版本不匹配');
  const automaticWarnings: string[] = [];
  if (!request.context.imageDataUrl && request.context.sources.some(source => hasCorruptGlyph(source.sourceText))) {
    automaticWarnings.push('原文文本层含乱码或缺失符号，未提供清晰选区图片，不能确认模型是否正确恢复；请框选原文核对。');
  }
  if (hasCorruptGlyph(draft.readingText) || draft.readingText.includes('【无法辨认】')) {
    automaticWarnings.push('朗读稿仍有无法辨认的内容，不能直接播放。');
  }
  const uncertain = draft.uncertain || draft.warnings.length > 0 || automaticWarnings.length > 0;
  const warnings = [...new Set([...automaticWarnings, ...draft.warnings])].slice(0, 8);
  if (uncertain && warnings.length === 0) warnings.push('模型无法可靠确定全部原文或公式读法，请先核对标记的内容。');
  return { ...draft, uncertain, warnings };
}
