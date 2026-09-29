import { z } from 'zod';
import { ContextSchema, SourceSchema, TeachingPlanSchema } from './protocol';

export const LEARNING_FORMAT = 'pdf-ai-teacher.learning' as const;
export const LEARNING_VERSION = 1 as const;
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_SAVED_BOOKS = 50;
export const DocumentIdSchema = z.string().regex(/^sha256-[a-f0-9]{64}$/, '文档指纹无效');
export const DocumentRecordSchema = z.object({
  documentId: DocumentIdSchema,
  fileName: z.string().min(1).max(512),
  pageCount: z.number().int().min(1).max(20000),
  pageLabels: z.array(z.string().max(200)).max(20000).nullable(),
  extractionVersion: z.string().min(1).max(100),
}).strict();
export const SavedTargetSchema = SourceSchema.extend({
  sourceId: z.string().min(1).max(200),
  blockId: z.string().min(1).max(200),
  pageLabel: z.string().max(200).nullable(),
  imageDataUrl: z.string().max(3000000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).optional(),
}).strict();
export const ReadingBookmarkSchema = z.object({
  target: SavedTargetSchema,
  cursor: z.object({
    documentId: DocumentIdSchema,
    pageIndex: z.number().int().nonnegative(),
    blockId: z.string().min(1).max(200),
    sentenceId: z.string().min(1).max(200),
    textVersion: z.string().min(1).max(200),
    sentenceIndex: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export const LearningPreferencesSchema = z.object({
  mode: z.enum(['read', 'read-explain', 'explain']),
  unit: z.enum(['sentence', 'paragraph', 'selection']),
  autoResume: z.boolean(),
}).strict();
export const TeachingProgressSchema = z.object({
  entryId: z.string().min(1).max(200).nullable(),
  stepIndex: z.number().int().nonnegative(),
  completedStepIds: z.array(z.string().min(1).max(200)).max(12),
  interrupted: z.boolean(),
  units: z.array(SavedTargetSchema).min(1).max(100),
  unitIndex: z.number().int().nonnegative(),
  mode: z.enum(['read', 'read-explain', 'explain']),
  phase: z.enum(['reading', 'generating', 'explaining', 'waiting']),
}).strict();
export const LearningRecordSchema = z.object({
  format: z.literal(LEARNING_FORMAT),
  version: z.literal(LEARNING_VERSION),
  document: DocumentRecordSchema,
  pageIndex: z.number().int().nonnegative(),
  target: SavedTargetSchema.nullable(),
  messages: z.array(z.object({ id: z.string().min(1).max(200), role: z.enum(['user', 'assistant']), text: z.string().max(24000), demo: z.boolean().optional(), delivery:z.enum(['text','spoken','interrupted','unconfirmed']).optional() }).strict()).max(500),
  entries: z.array(z.object({ id: z.string().min(1).max(200), plan: TeachingPlanSchema, context: ContextSchema, mode: z.enum(['demo', 'live']) }).strict()).max(200),
  activeStep: z.number().int().nonnegative(),
  activeEntryId: z.string().min(1).max(200).nullable().optional(),
  note: z.string().max(100000),
  readingBookmark: ReadingBookmarkSchema.nullable(),
  teachingProgress: TeachingProgressSchema.nullable(),
  preferences: LearningPreferencesSchema,
  updatedAt: z.iso.datetime(),
}).strict();
export type LearningRecord = z.infer<typeof LearningRecordSchema>;
export type ReadingBookmark = z.infer<typeof ReadingBookmarkSchema>;
export type LearningPreferences = z.infer<typeof LearningPreferencesSchema>;
export type TeachingProgress = z.infer<typeof TeachingProgressSchema>;
export type BookMetadata = {
  documentId: string;
  fileName: string;
  pageCount: number;
  pageIndex: number;
  updatedAt: string;
  messageCount: number;
  entryCount: number;
  hasBookmark: boolean;
};
