import { z } from 'zod';
import { MAX_SPEECH_RATE, MIN_SPEECH_RATE } from './speechRate';

export const EnvelopeSchema = z.object({ sessionId: z.string().min(1).max(100), generationId: z.number().int().nonnegative(), contextRevision: z.number().int().nonnegative() });
export type Envelope = z.infer<typeof EnvelopeSchema>;
export const RectSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
export const SourceSchema = z.object({ sourceId: z.string().max(200), documentId: z.string().max(200), pageIndex: z.number().int().nonnegative(), pageLabel: z.string().nullable(), blockId: z.string().max(200), rect: RectSchema.nullable(), sourceText: z.string().max(12000) });
export type SourceRef = z.infer<typeof SourceSchema>;
export type PdfTarget = SourceRef & { imageDataUrl?: string };
export type DocumentRecord = { documentId: string; fileName: string; pageCount: number; pageLabels: string[] | null; extractionVersion: string };
export const ContextSchema = z.object({ documentId: z.string(), sources: z.array(SourceSchema).min(1).max(8), selectedBoardText: z.string().max(4000).nullable(), imageDataUrl: z.string().max(3000000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).nullable() });
export type ContextSnapshot = z.infer<typeof ContextSchema>;
export const DiagramSchema = z.object({ id:z.string(), type:z.literal('diagram'), nodes:z.array(z.object({id:z.string().min(1).max(40),label:z.string().min(1).max(80)})).min(1).max(8), edges:z.array(z.object({from:z.string().max(40),to:z.string().max(40),label:z.string().max(60).nullable()})).max(12) });
export const BoardBlockSchema = z.discriminatedUnion('type', [
  DiagramSchema,
  z.object({ id: z.string(), type: z.literal('text'), markdown: z.string().max(5000) }),
  z.object({ id: z.string(), type: z.literal('math'), latex: z.string().max(2000), label: z.string().nullable() }),
  z.object({ id: z.string(), type: z.literal('table'), headers: z.array(z.string()).max(8), rows: z.array(z.array(z.string())).max(30) }),
  z.object({ id: z.string(), type: z.literal('callout'), text: z.string().max(4000), tone: z.enum(['note', 'warning']) })
]);
export const TeachingStepSchema = z.object({ stepId: z.string(), title: z.string().max(200), explanationMarkdown: z.string().max(5000), speechText: z.string().max(4000), boardBlocks: z.array(BoardBlockSchema).max(12), sourceIds: z.array(z.string()).max(8), exampleOrigin: z.enum(['book', 'teacher_created', 'none']) });
export const TeachingPlanSchema = z.object({ schemaVersion: z.literal('1'), contextRevision: z.number().int(), answer: z.string().max(16000), needsClarification: z.boolean(), clarificationQuestion: z.string().nullable(), steps: z.array(TeachingStepSchema).max(12), checkQuestion: z.string().nullable() });
export type TeachingPlan = z.infer<typeof TeachingPlanSchema>;
export type TeachingStep = z.infer<typeof TeachingStepSchema>;
export const AskRequestSchema = EnvelopeSchema.extend({ question: z.string().trim().min(1).max(2000), context: ContextSchema, history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) })).max(6) });
export type AskRequest = z.infer<typeof AskRequestSchema>;
export type AskResponse = Envelope & { plan: TeachingPlan; mode: 'demo' | 'live'; usage: UsageRecord };
export type UsageRecord = { requestId: string; model: string; category: 'text' | 'tts' | 'transcription' | 'realtime'; connectionSeconds?: number | null; upstreamCancellation?: 'confirmed' | 'unconfirmed'; audioSeconds?: number | null; inputTokens: number | null; outputTokens: number | null; characters: number | null; estimatedCost: null; local?: boolean; cancelled: boolean };
export const TtsRequestSchema = EnvelopeSchema.extend({ text: z.string().min(1).max(1600), speed: z.number().min(MIN_SPEECH_RATE).max(MAX_SPEECH_RATE) });
export const MAX_RECORDING_BYTES = 4 * 1024 * 1024;
export const MAX_RECORDING_MS = 60000;
export const AudioMimeSchema = z.enum(['audio/webm', 'audio/ogg', 'audio/mp4']);
export type AudioMime = z.infer<typeof AudioMimeSchema>;
export const TranscriptionRequestSchema = EnvelopeSchema.extend({
  mimeType: AudioMimeSchema,
  audioBase64: z.string().min(4).max(Math.ceil(MAX_RECORDING_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  durationMs: z.number().int().min(300).max(MAX_RECORDING_MS),
});
export type TranscriptionRequest = z.infer<typeof TranscriptionRequestSchema>;
export const TranscriptionResponseSchema = EnvelopeSchema.extend({ text: z.string().trim().min(1).max(2000), mode: z.literal('live') });
export type TranscriptionResponse = z.infer<typeof TranscriptionResponseSchema> & { usage: UsageRecord };
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type TeachingReasoningEffort = typeof REASONING_EFFORTS[number];
export type TeachingConfiguration = { chatReasoningEffort: TeachingReasoningEffort | null; visionReasoningEffort: TeachingReasoningEffort | null; maxOutputTokens: number; timeoutMs: number };
export type CapabilityState = 'unconfigured' | 'untested' | 'supported' | 'unsupported' | 'error';
export type AppConfig = { authMode?: 'api_key' | 'chatgpt'; mode: 'demo' | 'live' | 'unconfigured'; sessionId: string; generationId: number; contextRevision: number; csrfToken: string; capabilities: Record<'text' | 'vision' | 'structuredOutput' | 'tts' | 'transcription' | 'realtimeAudio' | 'realtimeTools' | 'interruption', CapabilityState>; models: { chat: string; vision: string; tts: string; transcription?: string; realtime?: string }; realtime?: { provider: 'openai-realtime'; voice: string; maxSessionSeconds: number; idleSeconds: number; inputTranscriptionModel: string }; speech?: { engine?: 'local' | 'qwen' | 'doubao' | 'openai' | 'system'; ready?: boolean; device?: 'cpu' | 'cuda'; voice: string; style: string; instructionsSupported: boolean }; teaching?: TeachingConfiguration; maxRequests: number };
export type ReadingCursor = { documentId: string; pageIndex: number; blockId: string; sentenceId: string; textVersion: string; sentenceIndex: number };
export type Sentence = { sentenceId: string; sourceText: string; speechText: string };
export function sameEnvelope(a: Envelope, b: Envelope) { return a.sessionId === b.sessionId && a.generationId === b.generationId && a.contextRevision === b.contextRevision; }
export function validatePlan(value: unknown, context: ContextSnapshot, revision: number): TeachingPlan {
  const plan = TeachingPlanSchema.parse(value);
  if (plan.contextRevision !== revision) throw new Error('上下文版本不匹配');
  const allowed = new Set(context.sources.map(s => s.sourceId));
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.stepId) || step.sourceIds.some(id => !allowed.has(id))) throw new Error('板书步骤或来源无效');
    ids.add(step.stepId);
    const blockIds = new Set<string>();
    for (const block of step.boardBlocks) {
      if (blockIds.has(block.id)) throw new Error('板书块重复'); blockIds.add(block.id);
      if(block.type==='diagram'){
        const nodes=new Set(block.nodes.map(node=>node.id));
        if(nodes.size!==block.nodes.length||block.edges.some(edge=>!nodes.has(edge.from)||!nodes.has(edge.to)))throw new Error('图示节点或连线无效');
      }
    }
  }
  return plan;
}
