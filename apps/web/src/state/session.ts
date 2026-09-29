import type { ContextSnapshot, Envelope, PdfTarget } from '../../../../packages/shared/protocol';
import { sameEnvelope } from '../../../../packages/shared/protocol';

export class SessionGuard {
  private generationId = 0;
  private contextRevision = 0;
  constructor(public sessionId: string, generationId = 0, contextRevision = 0) { this.generationId = generationId; this.contextRevision = contextRevision; }
  current(): Envelope { return { sessionId: this.sessionId, generationId: this.generationId, contextRevision: this.contextRevision }; }
  next(targetChanged = false) { this.generationId++; if (targetChanged) this.contextRevision++; return this.current(); }
  accepts(value: Envelope) { return sameEnvelope(this.current(), value); }
}
export function snapshot(target: PdfTarget, selectedBoardText: string | null = null): ContextSnapshot {
  const { imageDataUrl, ...source } = target;
  return structuredClone({ documentId: target.documentId, sources: [source], imageDataUrl: imageDataUrl ?? null, selectedBoardText });
}
