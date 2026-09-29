import { z } from 'zod';
import { EnvelopeSchema, type Envelope } from './protocol';

export const MAX_REALTIME_SDP_BYTES = 64 * 1024;
export const REALTIME_IDLE_SECONDS = 30;
export const REALTIME_MAX_SESSION_SECONDS = 10 * 60;
export const RealtimeSdpSchema = z.string().min(5).max(MAX_REALTIME_SDP_BYTES)
  .refine(sdp => sdp.startsWith('v=0') && !sdp.includes('\0') && new TextEncoder().encode(sdp).length <= MAX_REALTIME_SDP_BYTES);
export const RealtimeConnectRequestSchema = EnvelopeSchema.extend({ sdp: RealtimeSdpSchema }).strict();
export type RealtimeConnectRequest = z.infer<typeof RealtimeConnectRequestSchema>;
export type RealtimeConnectResponse = Envelope & { connectionId: string; sdp: string; expiresAt: number };
export const RealtimeConnectionRequestSchema = EnvelopeSchema.extend({ connectionId: z.string().uuid() }).strict();
export type RealtimeConnectionRequest = z.infer<typeof RealtimeConnectionRequestSchema>;
export type RealtimeHeartbeatResponse = Envelope & { connectionId: string; active: boolean; expiresAt: number | null };
export type RealtimeDisconnectResponse = Envelope & { connectionId: string; active: false; upstreamCancellation: 'confirmed' | 'unconfirmed' | 'not_found' };
