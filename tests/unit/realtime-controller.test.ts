import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialRealtime, RealtimeController, type RealtimeOptions, type RealtimeState } from '../../apps/web/src/features/realtime/RealtimeController';
import type { RealtimeContext } from '../../apps/web/src/features/realtime/tools';
import type { AppConfig, Envelope, PdfTarget, TeachingPlan } from '../../packages/shared/protocol';

const source: PdfTarget = { documentId: 'doc', sourceId: 'doc:source', blockId: 'block', pageIndex: 0, pageLabel: null, rect: null, sourceText: '原文第一句。原文第二句。' };
function plan(revision: number, prefix = 'a'): TeachingPlan {
  return { schemaVersion: '1', contextRevision: revision, answer: '逐步解释。', needsClarification: false, clarificationQuestion: null, checkQuestion: '理解了吗？', steps: [1, 2].map(index => ({ stepId: `${prefix}${index}`, title: `步骤${index}`, speechText: `${prefix} 的第 ${index} 步。`, explanationMarkdown: '解释。', boardBlocks: [], sourceIds: [source.sourceId], exampleOrigin: 'none' })) };
}
type SentEvent = { type: string; response_id?: string; session?: { type: string; audio: { output: { speed: number } } }; response?: { metadata: Record<string, string>; output_modalities: string[]; instructions: string; audio?: { output: { speed: number } } }; item?: { type: string; call_id?: string; output?: string; content?: Array<{ type: string; text?: string }> } };
// Inject a connected transport only: all turns, tools and playback transitions use public methods.
type TestConnection = { state: RealtimeState; channel: RTCDataChannel | null; remote: HTMLAudioElement | null; remotePlaying: boolean };
const controllers: RealtimeController[] = [];
function setup(rate = 0.9, autoAcknowledgeSpeed = true) {
  let envelope: Envelope = { sessionId: 'session', generationId: 0, contextRevision: 0 };
  const sent: SentEvent[] = []; const trace: string[] = [];
  const context: RealtimeContext = { context: { documentId: source.documentId, sources: [source], selectedBoardText: null, imageDataUrl: null }, board: [{ entryId: 'entry-b', stepId: 'b2', title: '步骤2', number: 2, summary: '解释。', sourceIds: [source.sourceId] }] };
  const config = { mode: 'live', sessionId: 'session', generationId: 0, contextRevision: 0, csrfToken: 'mock-only', models: { chat: '', vision: '', tts: '', realtime: 'mock-realtime' }, capabilities: { realtimeAudio: 'untested' }, maxRequests: 100 } as AppConfig;
  const begin = vi.fn(() => envelope = { ...envelope, generationId: envelope.generationId + 1 });
  const present = vi.fn(async (_plan: TeachingPlan, valid: () => boolean) => { if (!valid()) throw Error('stale'); trace.push('board'); return { entryId: 'entry-a' }; });
  const focus = vi.fn(async (_entryId: string, _stepId: string, valid: () => boolean) => { if (!valid()) throw Error('stale'); trace.push('focus'); const focused = plan(envelope.contextRevision, 'b'); return { speechText: focused.steps[1].speechText, stepIndex: 1, plan: focused }; });
  const control = vi.fn(async () => {});
  const showStep = vi.fn(async () => {}); const onStepComplete = vi.fn(); const onMessage = vi.fn();
  const options: RealtimeOptions = { config, current: () => envelope, begin, context: () => structuredClone(context), onChange: vi.fn(), pauseLocal: vi.fn(), onMessage, tools: { present, focus, control }, showStep, rate: () => rate, volume: () => 0.8, onStepComplete,
    claimOutput: stop => { let current = true; return { isCurrent: () => current, release: () => { if (current) { current = false; stop(); } } }; },
  };
  const controller = new RealtimeController(options);
  const internal = controller as unknown as TestConnection;
  const channel = { readyState: 'open', send: vi.fn((raw: string) => { const event = JSON.parse(raw) as SentEvent; sent.push(event); if (autoAcknowledgeSpeed && event.type === 'session.update') queueMicrotask(() => { void controller.receive({ type: 'session.updated', session: event.session }); }); trace.push(event.type === 'conversation.item.create' && event.item?.type === 'function_call_output' ? 'ack' : event.type === 'response.create' ? `request:${event.response?.output_modalities[0]}` : event.type); }), close: vi.fn() };
  const audio = { muted: true, srcObject: null, pause: vi.fn() };
  const connect = () => { internal.state = { ...initialRealtime, connection: 'connected', input: 'listening' }; internal.channel = channel as unknown as RTCDataChannel; internal.remote = audio as unknown as HTMLAudioElement; internal.remotePlaying = true; };
  connect();
  const latestResponse = () => { const event = sent.filter(item => item.type === 'response.create').at(-1); if (!event?.response) throw Error('No response request'); return event.response; };
  const accept = async (id: string, modality: 'text' | 'audio') => { const response = latestResponse(); expect(response.output_modalities).toEqual([modality]); await controller.receive({ type: 'response.created', response: { id, metadata: response.metadata } }); };
  const prepareTeaching = async () => {
    await controller.ask('解释原文'); await accept('tools-a', 'text');
    const handling = controller.receive({ type: 'response.done', response: { id: 'tools-a', status: 'completed', output: [{ type: 'function_call', name: 'present_teaching_plan', call_id: 'call-a', arguments: JSON.stringify({ opId: 'present-a', plan: plan(envelope.contextRevision) }) }] } });
    return { handling };
  };
  const waitForSpeedUpdate = async () => { await vi.waitFor(() => expect(sent.some(event => event.type === 'session.update')).toBe(true)); };
  const acknowledgeSpeed = async (speed: number) => { await controller.receive({ type: 'session.updated', session: { type: 'realtime', audio: { output: { speed } } } }); };
  const teach = async () => {
    const { handling } = await prepareTeaching();
    await handling;
    await accept('audio-a', 'audio');
    await controller.receive({ type: 'output_audio_buffer.started', response_id: 'audio-a' });
    await controller.receive({ type: 'response.output_audio_transcript.delta', response_id: 'audio-a', delta: '已经开始讲解。' });
  };
  const fixture = { controller, sent, trace, options, begin, present, focus, showStep, onMessage, onStepComplete, accept, teach, prepareTeaching, waitForSpeedUpdate, acknowledgeSpeed, latestResponse, connect, channel, audio };
  controllers.push(controller); return fixture;
}
afterEach(() => { controllers.splice(0).forEach(controller => controller.stop()); vi.unstubAllGlobals(); vi.useRealTimers(); });

// Protocol simulation only: no provider request, WebRTC network or real microphone.
describe('Realtime controller protocol regressions', () => {
  it('limits a 3x reader preference to confirmed 1.5x realtime speed and explains the difference', async () => {
    const f = setup(3); await f.teach();
    expect(f.sent.filter(event => event.type === 'session.update').map(event => event.session?.audio.output.speed)).toEqual([1.5]);
    expect(f.controller.getSnapshot().notice).toContain('本次按 1.5× 播放');
    expect(f.controller.getSnapshot().notice).toContain('原文朗读仍使用 3×');
    expect(f.options.rate()).toBe(3);
  });
  it.each(['before', 'after'])('retains the same input when local VAD fires %s server VAD', async order => {
    const f = setup();
    if (order === 'before') f.controller.interrupt('tentative local VAD', false);
    await f.controller.receive({ type: 'input_audio_buffer.speech_started', item_id: 'input-1' });
    if (order === 'after') f.controller.interrupt('tentative local VAD', false);
    await f.controller.receive({ type: 'input_audio_buffer.speech_started', item_id: 'input-1' }); // duplicate event
    await f.controller.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'input-1', transcript: '为什么 beta 要取 t 次方？' });
    expect(f.onMessage).toHaveBeenCalledExactlyOnceWith('user', '为什么 beta 要取 t 次方？', 'text');
    expect(f.latestResponse().output_modalities).toEqual(['text']); expect(f.begin).toHaveBeenCalledOnce();
  });

  it('discards a late input transcript after the user explicitly interrupts', async () => {
    const f = setup(); await f.controller.receive({ type: 'input_audio_buffer.speech_started', item_id: 'old-input' });
    f.controller.interrupt('用户正在输入新问题');
    await f.controller.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-input', transcript: '旧语音问题' });
    expect(f.onMessage).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled();
  });

  it.each(['incomplete', 'cancelled', 'failed'])('does not confirm a %s response when its audio buffer subsequently stops', async status => {
    const f = setup(); await f.teach();
    await f.controller.receive({ type: 'response.done', response: { id: 'audio-a', status } });
    await f.controller.receive({ type: 'output_audio_buffer.stopped', response_id: 'audio-a' });
    expect(f.onStepComplete).not.toHaveBeenCalled(); expect(f.audio.muted).toBe(true);
    expect(f.onMessage).toHaveBeenCalledWith('assistant', '已经开始讲解。', 'interrupted');
    expect(f.controller.getSnapshot().clearPending).toBe(true);
    await f.controller.receive({ type: 'output_audio_buffer.cleared', response_id: 'audio-a' });
    expect(f.controller.getSnapshot().clearPending).toBe(false);
  });

  it('renders and acknowledges a tool before requesting matching speech, and completes only after playback stops', async () => {
    const f = setup(0.75); await f.teach();
    expect(f.trace.indexOf('board')).toBeLessThan(f.trace.indexOf('ack'));
    expect(f.trace.indexOf('ack')).toBeLessThan(f.trace.indexOf('request:audio'));
    expect(f.latestResponse().instructions).toContain('a 的第 1 步。');
    expect(f.sent.find(event => event.type === 'session.update')?.session?.audio.output.speed).toBe(0.75);
    expect(f.latestResponse().audio).toBeUndefined();
    await f.controller.receive({ type: 'response.done', response: { id: 'audio-a', status: 'completed' } });
    expect(f.onStepComplete).not.toHaveBeenCalled();
    await f.controller.receive({ type: 'output_audio_buffer.stopped', response_id: 'audio-a' });
    expect(f.onStepComplete).toHaveBeenCalledExactlyOnceWith('entry-a', 0);
  });

  it('clears the old teaching plan when stopping and cannot revive it in another connection', async () => {
    const f = setup(); await f.teach(); f.controller.stop();
    expect(f.channel.close).toHaveBeenCalled(); expect(f.audio.pause).toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'off', input: 'off', canContinue: false });
    f.connect(); f.controller.interrupt(); await f.controller.continueTeaching();
    expect(f.controller.getSnapshot().canContinue).toBe(false); expect(f.begin).toHaveBeenCalledOnce(); expect(f.showStep).not.toHaveBeenCalled();
  });

  it('does not let a waiting continue action supersede a new question after the clear barrier opens', async () => {
    const f = setup(); await f.teach();
    const continuing = f.controller.continueTeaching(); expect(f.controller.getSnapshot().clearPending).toBe(true);
    const asking = f.controller.ask('换一个数字例子');
    await f.controller.receive({ type: 'output_audio_buffer.cleared', response_id: 'unrelated-response' });
    expect(f.begin).toHaveBeenCalledOnce(); expect(f.controller.getSnapshot().clearPending).toBe(true);
    await f.controller.receive({ type: 'output_audio_buffer.cleared', response_id: 'audio-a' });
    await Promise.all([continuing, asking]);
    expect(f.begin).toHaveBeenCalledTimes(2); expect(f.showStep).not.toHaveBeenCalled();
    expect(f.latestResponse().output_modalities).toEqual(['text']);
    expect(f.onMessage).toHaveBeenLastCalledWith('user', '换一个数字例子', 'text');
    expect(f.sent.filter(event => event.type === 'response.create' && event.response?.output_modalities[0] === 'audio')).toHaveLength(1);
  });

  it('binds focused board playback and completion to the focused entry and step', async () => {
    const f = setup(); await f.teach();
    await f.controller.receive({ type: 'response.done', response: { id: 'audio-a', status: 'completed' } });
    await f.controller.receive({ type: 'output_audio_buffer.stopped', response_id: 'audio-a' }); f.onStepComplete.mockClear();
    await f.controller.ask('解释黑板第二行'); await f.accept('tools-b', 'text');
    await f.controller.receive({ type: 'response.done', response: { id: 'tools-b', status: 'completed', output: [{ type: 'function_call', name: 'focus_board_step', call_id: 'call-b', arguments: JSON.stringify({ opId: 'focus-b', entryId: 'entry-b', stepId: 'b2' }) }] } });
    expect(f.focus).toHaveBeenCalledWith('entry-b', 'b2', expect.any(Function));
    expect(f.latestResponse().instructions).toContain('b 的第 2 步。');
    await f.accept('audio-b', 'audio'); await f.controller.receive({ type: 'output_audio_buffer.started', response_id: 'audio-b' });
    await f.controller.receive({ type: 'response.done', response: { id: 'audio-b', status: 'completed' } });
    await f.controller.receive({ type: 'output_audio_buffer.stopped', response_id: 'audio-b' });
    expect(f.onStepComplete).toHaveBeenCalledExactlyOnceWith('entry-b', 1);
  });

  it('does not execute a cancelled tool even if it carries complete-looking function arguments', async () => {
    const f = setup(); await f.controller.ask('解释原文'); await f.accept('cancelled-tools', 'text');
    const call = { type: 'function_call', name: 'present_teaching_plan', call_id: 'cancelled-call', arguments: JSON.stringify({ opId: 'cancelled-op', plan: plan(0) }) };
    await f.controller.receive({ ...call, type: 'response.function_call_arguments.done', response_id: 'cancelled-tools' });
    await f.controller.receive({ type: 'response.done', response: { id: 'cancelled-tools', status: 'cancelled', output: [call] } });
    expect(f.present).not.toHaveBeenCalled(); expect(f.sent.filter(event => event.item?.type === 'function_call_output')).toHaveLength(0);
  });

  it('closes locally after an unacknowledged clear instead of reviving stale audio', async () => {
    vi.useFakeTimers(); const f = setup(); await f.teach(); f.controller.interrupt();
    await vi.advanceTimersByTimeAsync(2501);
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'error', input: 'off', output: 'silent' });
    expect(f.audio.muted).toBe(true); expect(f.channel.close).toHaveBeenCalled(); expect(f.onStepComplete).not.toHaveBeenCalled();
  });
});


describe('Realtime output speed acknowledgment gate', () => {
  const audioRequests = (events: SentEvent[]) => events.filter(event => event.type === 'response.create' && event.response?.output_modalities[0] === 'audio');

  it.each([0.25, 0.35, 0.5, 0.75])('waits for the matching %sx session speed acknowledgment before creating audio', async speed => {
    const f = setup(speed, false); const { handling } = await f.prepareTeaching(); await f.waitForSpeedUpdate();
    expect(f.sent.find(event => event.type === 'session.update')?.session).toEqual({ type: 'realtime', audio: { output: { speed } } });
    expect(audioRequests(f.sent)).toHaveLength(0); expect(f.audio.muted).toBe(true);
    await f.acknowledgeSpeed(1);
    expect(audioRequests(f.sent)).toHaveLength(0);
    await f.acknowledgeSpeed(speed); await handling;
    expect(audioRequests(f.sent)).toHaveLength(1); expect(f.latestResponse().audio).toBeUndefined();
    expect(f.trace.indexOf('ack')).toBeLessThan(f.trace.indexOf('session.update'));
    expect(f.trace.indexOf('session.update')).toBeLessThan(f.trace.indexOf('request:audio'));
  });

  it('cancels a pending speed acknowledgment on stop and ignores a late acknowledgment', async () => {
    const f = setup(0.75, false); const { handling } = await f.prepareTeaching(); await f.waitForSpeedUpdate();
    f.controller.stop(); await handling; await f.acknowledgeSpeed(0.75);
    expect(audioRequests(f.sent)).toHaveLength(0); expect(f.channel.close).toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'off', input: 'off', output: 'silent' });
  });

  it('keeps a new question current when an old speed acknowledgment arrives', async () => {
    const f = setup(0.75, false); const { handling } = await f.prepareTeaching(); await f.waitForSpeedUpdate();
    await f.controller.ask('先解释 beta 的含义'); await handling; await f.acknowledgeSpeed(0.75);
    expect(audioRequests(f.sent)).toHaveLength(0); expect(f.begin).toHaveBeenCalledTimes(2);
    expect(f.latestResponse().output_modalities).toEqual(['text']);
    expect(f.onMessage).toHaveBeenLastCalledWith('user', '先解释 beta 的含义', 'text');
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'connected', output: 'thinking' });
  });

  it('closes the connection when the speed update remains unacknowledged', async () => {
    vi.useFakeTimers(); const f = setup(0.75, false); const { handling } = await f.prepareTeaching(); await f.waitForSpeedUpdate();
    await vi.advanceTimersByTimeAsync(5000); await handling;
    expect(audioRequests(f.sent)).toHaveLength(0); expect(f.audio.muted).toBe(true); expect(f.channel.close).toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'error', input: 'off', output: 'silent', error: expect.stringContaining('未确认语速') });
    await f.acknowledgeSpeed(0.75); expect(audioRequests(f.sent)).toHaveLength(0);
  });
});

describe('Realtime permission lifecycle with mock devices', () => {
  it.each(['pagehide', 'blur', 'offline', 'visibilitychange'])('releases a late permission result after %s without connecting', async eventName => {
    const f = setup(); f.controller.stop();
    const windowTarget = new EventTarget(); const documentTarget = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('window', windowTarget); vi.stubGlobal('document', documentTarget);
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    let resolve!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(done => { resolve = done; }));
    const forbiddenFetch = vi.fn(() => { throw Error('No provider or local network permitted in this test'); });
    const meter = vi.fn(() => { throw Error('A late permission result must not create a meter'); });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } }); vi.stubGlobal('fetch', forbiddenFetch); vi.stubGlobal('AudioContext', meter);
    const starting = f.controller.start('local'); expect(f.controller.getSnapshot().connection).toBe('connecting');
    if (eventName === 'visibilitychange') { documentTarget.hidden = true; documentTarget.dispatchEvent(new Event(eventName)); }
    else windowTarget.dispatchEvent(new Event(eventName));
    expect(f.controller.getSnapshot().connection).toBe('off'); resolve(stream); await starting;
    expect(track.stop).toHaveBeenCalled(); expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(meter).not.toHaveBeenCalled(); expect(forbiddenFetch).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'off', input: 'off' });
  });
});
describe('Realtime remote audio callbacks across reconnection', () => {
  it.each(['play rejection', 'onplaying', 'onerror'])('ignores an old %s after stop and a fresh start', async lateEvent => {
    vi.useFakeTimers();
    const f = setup(); f.controller.stop();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    const tracks: Array<EventTarget & { stop: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => {
      const track = Object.assign(new EventTarget(), { stop: vi.fn() }); tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    }) } });
    class FakeMeter {
      createMediaStreamSource() { return { connect: vi.fn() }; }
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (data: Float32Array) => data.fill(0) }; }
      close = vi.fn(async () => {});
    }
    vi.stubGlobal('AudioContext', FakeMeter);
    const outputs: FakeAudio[] = [];
    class FakeAudio {
      autoplay = false; muted = false; volume = 1; srcObject: unknown = null;
      onplaying: (() => void) | null = null; onerror: (() => void) | null = null;
      rejectPlay!: (error: Error) => void;
      playback = new Promise<void>((_resolve, reject) => { this.rejectPlay = reject; });
      play = vi.fn(() => this.playback); pause = vi.fn();
      constructor() { outputs.push(this); }
    }
    vi.stubGlobal('Audio', FakeAudio);
    const peers: FakePeer[] = [];
    class FakePeer {
      connectionState = 'connected';
      ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      senders: Array<{ track: MediaStreamTrack }> = [];
      channel = { readyState: 'open', send: f.channel.send, onmessage: null as ((event: { data: string }) => void) | null, onclose: null as (() => void) | null, onerror: null as (() => void) | null, close: vi.fn() };
      createDataChannel() { return this.channel; }
      addTrack(track: MediaStreamTrack) { this.senders.push({ track }); }
      createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'mock-offer' }));
      setLocalDescription = vi.fn(async () => {});
      setRemoteDescription = vi.fn(async () => {});
      getSenders() { return this.senders; }
      getReceivers() { return []; }
      close = vi.fn(() => { this.connectionState = 'closed'; });
      constructor() { peers.push(this); }
    }
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    let connection = 0;
    const request = vi.fn(async (path: string, init: RequestInit) => {
      if (path === '/api/realtime/connect') {
        const body = JSON.parse(String(init.body)) as Envelope;
        return { ok: true, json: async () => ({ ...body, sdp: 'mock-answer', connectionId: `mock-connection-${++connection}` }) };
      }
      if (path === '/api/realtime/disconnect') return { ok: true, json: async () => ({ upstreamCancellation: 'confirmed' }) };
      throw Error('Unexpected network path: ' + path);
    });
    vi.stubGlobal('fetch', request);
    const start = async () => {
      await f.controller.start('live');
      const peer = peers.at(-1)!;
      peer.channel.onmessage?.({ data: JSON.stringify({ type: 'session.created' }) });
      expect(f.controller.getSnapshot().connection).toBe('connected');
      const track = tracks.at(-1)! as unknown as MediaStreamTrack;
      peer.ontrack?.({ track, streams: [{ getTracks: () => [track] } as unknown as MediaStream] });
      expect(outputs.at(-1)!.play).toHaveBeenCalledOnce();
    };
    await start();
    const oldAudio = outputs[0]; const oldPlaying = oldAudio.onplaying; const oldError = oldAudio.onerror;
    expect(oldPlaying).toBeTypeOf('function'); expect(oldError).toBeTypeOf('function');
    f.controller.stop();
    expect(oldAudio.onplaying).toBeNull(); expect(oldAudio.onerror).toBeNull(); expect(tracks[0].stop).toHaveBeenCalled();
    await start();
    if (lateEvent === 'play rejection') oldAudio.rejectPlay(Error('late autoplay rejection'));
    else if (lateEvent === 'onplaying') oldPlaying?.();
    else oldError?.();
    await Promise.resolve(); await Promise.resolve();
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'connected', input: 'listening', error: '' });
    expect(peers[1].close).not.toHaveBeenCalled(); expect(tracks[1].stop).not.toHaveBeenCalled();
    // The new audio has not emitted onplaying: the old callback must not make its playback confirmed.
    await f.teach();
    await f.controller.receive({ type: 'response.done', response: { id: 'audio-a', status: 'completed' } });
    await f.controller.receive({ type: 'output_audio_buffer.stopped', response_id: 'audio-a' });
    expect(f.onStepComplete).not.toHaveBeenCalled();
    expect(f.onMessage).toHaveBeenCalledWith('assistant', '已经开始讲解。', 'unconfirmed');
    expect(request.mock.calls.every(([path]) => path.startsWith('/api/realtime/'))).toBe(true);
  });
});

describe('Realtime slow playback watchdog (simulated transport)', () => {
  it.each([0.25, 0.5])('does not cut an active %sx step at two minutes but still closes a stalled playback', async speed => {
    vi.useFakeTimers(); const f = setup(speed); await f.teach();
    await f.controller.receive({ type: 'response.done', response: { id: 'audio-a', status: 'completed' } });
    await vi.advanceTimersByTimeAsync(120001);
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'connected', output: 'speaking' });
    expect(f.onStepComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120000 / speed - 120001);
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'error', input: 'off', output: 'silent' });
    expect(f.audio.muted).toBe(true); expect(f.channel.close).toHaveBeenCalled();
    expect(f.onStepComplete).not.toHaveBeenCalled();
  });

  it('keeps the first-audio deadline unchanged at 0.25x when no playback starts', async () => {
    vi.useFakeTimers(); const f = setup(0.25); const { handling } = await f.prepareTeaching(); await handling;
    await f.accept('silent-audio', 'audio'); await vi.advanceTimersByTimeAsync(120000);
    expect(f.controller.getSnapshot()).toMatchObject({ connection: 'error', input: 'off', output: 'silent' });
    expect(f.audio.muted).toBe(true); expect(f.onStepComplete).not.toHaveBeenCalled();
  });
});
