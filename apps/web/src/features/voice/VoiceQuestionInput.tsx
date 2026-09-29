import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square, X } from 'lucide-react';
import type { AppConfig, Envelope } from '../../../../../packages/shared/protocol';
import { apiClient } from '../../services/api';
import { QuestionRecorder, recordingBase64, type RecordedQuestion, type RecorderState } from './recorder';
import './voice.css';

export interface VoiceQuestionInputProps {
  config: AppConfig | null;
  onStart: () => Envelope;
  onTranscript: (text: string, envelope: Envelope) => void;
  onError: (message: string) => void;
  resetRevision: number;
  disabled?: boolean;
}
export function VoiceQuestionInput(props: VoiceQuestionInputProps) {
  const latest = useRef(props); latest.current = props;
  const recorder = useRef<QuestionRecorder | null>(null);
  const operation = useRef(0);
  const envelope = useRef<Envelope | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [state, setState] = useState<RecorderState | 'transcribing'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState('');
  const cancel = useCallback(() => {
    operation.current += 1;
    pending.current?.abort(); pending.current = null;
    recorder.current?.cancel();
    const previous = envelope.current; envelope.current = null;
    if (previous && latest.current.config) void apiClient(latest.current.config).cancel(previous);
    setState('idle'); setSeconds(0);
  }, []);

  useEffect(() => {
    let mounted = true;
    const complete = async (recording: RecordedQuestion) => {
      const config = latest.current.config;
      const captured = envelope.current;
      const id = operation.current;
      if (!config || !captured) return;
      if (config.mode === 'demo') { envelope.current = null; setNotice('演示录音已结束并丢弃；未上传、未转写。可直接输入问题。'); return; }
      setState('transcribing'); setNotice('正在转写；完成后先检查文字，再发送问题。');
      const controller = new AbortController(); pending.current = controller;
      const timeout = setTimeout(() => {
        if (operation.current !== id) return;
        cancel(); latest.current.onError('转写等待超时，已取消。请重新录音或直接输入文字；可能已有服务用量。');
      }, 130000);
      try {
        const audioBase64 = await recordingBase64(recording.blob);
        if (!mounted || operation.current !== id || controller.signal.aborted) return;
        const result = await apiClient(config).transcribe({ ...captured, mimeType: recording.mimeType, durationMs: recording.durationMs, audioBase64 }, controller.signal);
        if (!mounted || operation.current !== id || controller.signal.aborted) return;
        envelope.current = null;
        latest.current.onTranscript(result.text, result);
        setNotice('转写已填入问题草稿。请检查 beta、theta 等术语，再点击发送。');
      } catch (error) {
        if (mounted && operation.current === id && !controller.signal.aborted) latest.current.onError(error instanceof Error ? error.message : '语音转写失败，请重新录音或直接输入文字。');
      } finally {
        clearTimeout(timeout);
        if (mounted && operation.current === id) { pending.current = null; envelope.current = null; setState('idle'); }
      }
    };
    recorder.current = new QuestionRecorder({
      onState: (next, elapsed) => { if (mounted) { setState(next); setSeconds(elapsed); } },
      onComplete: recording => { if (mounted) void complete(recording); },
      onError: message => { if (mounted) { envelope.current = null; latest.current.onError(message); } },
    });
    const hidden = () => { if (document.hidden) cancel(); };
    const blur = () => { if (recorder.current?.currentState === 'recording' || pending.current) { cancel(); setNotice('已离开录音窗口，麦克风已关闭，本次录音或转写已取消。'); } };
    const offline = () => { cancel(); if (mounted) setNotice('网络已断开，麦克风已关闭；可直接编辑文字问题。'); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', blur); window.addEventListener('offline', offline); window.addEventListener('pagehide', cancel);
    return () => {
      mounted = false; operation.current += 1; pending.current?.abort(); pending.current = null;
      recorder.current?.cancel(); recorder.current = null;
      const previous = envelope.current; envelope.current = null;
      if (previous && latest.current.config) void apiClient(latest.current.config).cancel(previous);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('blur', blur); window.removeEventListener('offline', offline); window.removeEventListener('pagehide', cancel);
    };
  }, [cancel]);
  useEffect(() => { cancel(); setNotice(''); }, [props.resetRevision, cancel]);
  useEffect(() => { if (props.disabled) cancel(); }, [props.disabled, cancel]);

  const demo = props.config?.mode === 'demo';
  const configured = !!props.config && (demo || ['untested', 'supported', 'error'].includes(props.config.capabilities.transcription));
  const active = state !== 'idle';
  const start = () => {
    if (!configured || props.disabled || active) return;
    setNotice(''); operation.current += 1;
    envelope.current = latest.current.onStart();
    void recorder.current?.start();
  };
  return <div className="voice-question-input">
    <div className="voice-question-controls">
      {state === 'recording' ? <button type="button" className="secondary-button voice-recording" onClick={() => recorder.current?.finish()}><Square size={14}/>{demo ? '结束录音' : '结束并转写'} · {seconds} / 60 秒</button>
        : <button type="button" className="secondary-button" disabled={!configured || props.disabled || active} onClick={start}><Mic size={15}/>{state === 'requesting' ? '等待麦克风权限…' : state === 'transcribing' ? '正在转写…' : state === 'stopping' ? '正在结束录音…' : '语音转文字提问'}</button>}
      {active && <button type="button" className="voice-cancel" onClick={() => { cancel(); setNotice('已取消，麦克风已关闭。阅读书签保留。'); }}><X size={14}/>{state === 'transcribing' ? '取消转写' : '取消录音'}</button>}
    </div>
    <p className="voice-question-hint" role="status">{state === 'recording' ? '麦克风正在录音，再点一次结束；最长 60 秒。' : notice || (demo ? '演示模式：可体验本机录音，不上传、不自动转写。' : configured ? '结束后将录音发给已配置的转写服务，可能产生 API 费用；检查文字后再发送。不保存原始录音。' : '转写未配置，请在本机设置 TRANSCRIPTION_MODEL；仍可直接输入文字。')}</p>
  </div>;
}

export default VoiceQuestionInput;
