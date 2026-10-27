import brandIcon from '../../../assets/qingread.svg';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Pause, Play, Settings, Square, AlignLeft, Minus, X, ChevronLeft, SkipBack, SkipForward, RotateCcw } from 'lucide-react';
import { DEFAULT_DOUBAO_TTS_INSTRUCTIONS, DEFAULT_DOUBAO_TTS_VOICE, DOUBAO_TTS_VOICES } from '../../../packages/shared/doubaoSpeech';
import { speechConfigured } from '../../../packages/shared/reader';
import type { ReaderPanel, ReaderPreferences, ReaderSettings, SaveReaderSettings } from '../../../packages/shared/reader';
import { prepareReadingText } from '../../../packages/shared/readingText';
import { ReaderAudio, type AudioState } from './ReaderAudio';

const defaults: ReaderPreferences = { provider: 'doubao', allowBingCloud: false, voice: DEFAULT_DOUBAO_TTS_VOICE, instructions: DEFAULT_DOUBAO_TTS_INSTRUCTIONS, rate: 1, alwaysOnTop: true, allowCloud: false, skipFormulas: true };
const initial: ReaderSettings = { preferences: defaults, hasApiKey: false, encryptionAvailable: false, migrated: false, shortcutAvailable: false };
const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const messageOf = (error: unknown) => (error instanceof Error ? error.message : '操作未完成，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

export function App() {
  const bridge = window.reader;
  const player = useMemo(() => bridge ? new ReaderAudio(bridge) : null, [bridge]);
  const [settings, setSettings] = useState(initial);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const [audio, setAudio] = useState<AudioState>({ phase: 'idle', index: 0, total: 0, message: '' });
  const [work, setWork] = useState<'idle' | 'capturing' | 'recognizing'>('idle');
  const [panel, setPanel] = useState<ReaderPanel>(null);
  const [source, setSource] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const settingsBusy = useRef(false);
  const auditionIntent = useRef(0);
  const sequence = useRef(0), saveSequence = useRef(0), capturing = useRef(false);
  const captureRef = useRef<() => void>(() => {});
  const prepared = useMemo(() => prepareReadingText(source, settings.preferences.skipFormulas), [source, settings.preferences.skipFormulas]);

  useEffect(() => {
    if (!bridge || !player) return;
    let alive = true;
    const unsubscribe = player.subscribe(state => { if (alive) setAudio(state); });
    void bridge.getSettings().then(value => {
      if (!alive) return;
      setSettings(value); player.setRate(value.preferences.rate); setLoaded(true);
    }).catch(error => { if (alive) setError(messageOf(error)); });
    const offCapture = bridge.onCaptureRequested(() => captureRef.current());
    return () => { alive = false; sequence.current++; unsubscribe(); offCapture(); player.dispose(); };
  }, [bridge, player]);

  async function showPanel(next: ReaderPanel) {
    setPanel(next);
    try { await bridge?.setPanel(next); } catch (error) { setError(messageOf(error)); }
  }
  async function stop() {
    auditionIntent.current++; sequence.current++; setWork('idle'); setNotice('已停止');
    try { await player?.stop(); } catch (error) { setError(messageOf(error)); }
  }
  async function readText(text: string, token = sequence.current) {
    if (settingsBusy.current) return;
    const current = settingsRef.current;
    if (!speechConfigured(current.preferences, current.hasApiKey)) {
      setNotice('文字已识别，完成声音设置后即可朗读'); await showPanel('settings'); return;
    }
    const ready = prepareReadingText(text, current.preferences.skipFormulas);
    if (!ready.chunks.length) { setNotice('没有可朗读的正文，请换一块区域'); return; }
    if (token !== sequence.current) return;
    setNotice(ready.skipped ? `已跳过 ${ready.skipped} 处明显公式` : '');
    await player?.start(ready.chunks);
  }
  async function capture() {
    if (!bridge || !player || !loaded || capturing.current || settingsBusy.current) return;
    auditionIntent.current++;
    const token = ++sequence.current; capturing.current = true;
    setError(''); setNotice(''); setWork('capturing'); setSource('');
    try {
      await player.stop(); if (token !== sequence.current) return;
      const image = await bridge.capture(); capturing.current = false;
      if (token !== sequence.current) return;
      if (!image) { setWork('idle'); setNotice('已取消截图'); return; }
      setWork('recognizing');
      const result = await bridge.recognize(image.id);
      if (token !== sequence.current) return;
      setSource(result.text); setWork('idle');
      if (!result.text.trim()) { setNotice('未识别到文字，请框选更清晰的区域'); return; }
      await readText(result.text, token);
    } catch (error) { if (token === sequence.current) { setWork('idle'); setError(messageOf(error)); } }
    finally { capturing.current = false; }
  }
  captureRef.current = () => { void capture(); };

  async function save(value: SaveReaderSettings) {
    if (!bridge) throw Error('请在桌面软件中配置声音。');
    if (settingsBusy.current) throw Error('正在保存设置，请稍等。');
    settingsBusy.current = true; setSavingSettings(true);
    try {
    if (value.clearApiKey || value.preferences.provider !== settingsRef.current.preferences.provider || !speechConfigured(value.preferences, Boolean(value.apiKey?.trim()) || settingsRef.current.hasApiKey)) {
      sequence.current++; setWork('idle');
      await player?.stop();
    }
    const request = ++saveSequence.current;
    const next = await bridge.saveSettings(value);
    if (request === saveSequence.current) { settingsRef.current = next; setSettings(next); player?.setRate(next.preferences.rate); }
    return next;
    } finally { settingsBusy.current = false; setSavingSettings(false); }
  }
  async function changeRate(rate: number) {
    if (settingsBusy.current) return;
    const next = { ...settingsRef.current, preferences: { ...settingsRef.current.preferences, rate } };
    settingsRef.current = next; setSettings(next); player?.setRate(rate);
    try { await save({ preferences: next.preferences }); } catch (error) { setError(messageOf(error)); }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (panel) void showPanel(null); else void stop();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  const navigable = work === 'idle' && !savingSettings && audio.total > 0 && !['idle', 'error'].includes(audio.phase);
  const busy = savingSettings || work !== 'idle' || ['preparing', 'playing', 'paused'].includes(audio.phase);
  const audioStatus = audio.phase === 'preparing' ? '正在准备声音…' : audio.phase === 'playing' ? `正在朗读 · ${audio.index + 1}/${audio.total}` : audio.phase === 'paused' ? `已暂停 · ${audio.index + 1}/${audio.total}` : audio.phase === 'done' ? '朗读完成' : '';
  const status = !bridge ? '界面预览 · 请打开桌面软件截图朗读' : error || (audio.phase === 'error' ? messageOf(new Error(audio.message)) : '') || (savingSettings ? '正在保存声音设置…' : work === 'capturing' ? '拖动框选 · Esc 取消' : work === 'recognizing' ? '正在本机识别文字…' : audioStatus || notice || (speechConfigured(settings.preferences, settings.hasApiKey) ? '框选想听的内容，松开后开始朗读' : '先设置声音，也可以直接截图识字'));
  return <main className="reader-shell">
    <header className="titlebar"><span className="brand"><img className="brand-logo" src={brandIcon} alt="" />轻读<span className="brand-sub">截图朗读</span></span><div className="window-actions"><button aria-label="最小化" title="最小化" onClick={() => void bridge?.minimize()}><Minus size={14}/></button><button aria-label="退出" title="退出软件" onClick={() => void bridge?.quit()}><X size={14}/></button></div></header>
    <div className="toolbar">
      <button className="capture-button" onClick={() => void capture()} disabled={!bridge || !loaded || savingSettings || work === 'capturing'} title={settings.shortcutAvailable ? '截图朗读 · Ctrl+Shift+R' : '截图朗读'}><Camera size={19}/><span>截图朗读</span></button>
      <button className="pause-button" disabled={!['preparing', 'playing', 'paused'].includes(audio.phase)} onClick={() => player?.togglePause()}>{audio.phase === 'paused' ? <Play size={17}/> : <Pause size={17}/>}<span>{audio.phase === 'paused' ? '继续' : '暂停'}</span></button>
      <label className="rate-control"><span className="sr-only">朗读速度</span><select aria-label="朗读速度" value={settings.preferences.rate} disabled={!bridge || !loaded || savingSettings} onChange={event => void changeRate(Number(event.target.value))}>{rates.map(rate => <option key={rate} value={rate}>{rate.toFixed(rate % 1 ? 2 : 1).replace(/0$/, rate % 1 ? '' : '0')}×</option>)}{!rates.includes(settings.preferences.rate) && <option value={settings.preferences.rate}>{settings.preferences.rate}×</option>}</select></label>
      <button className={`icon-button ${panel === 'settings' ? 'selected' : ''}`} aria-label="声音设置" title="声音设置" onClick={() => void showPanel(panel === 'settings' ? null : 'settings')}><Settings size={19}/></button>
    </div>
    <nav className="playback-navigation" aria-label="回听控制">
      <button disabled={!navigable || audio.index === 0} onClick={() => void player?.previous()} title="回到上一段，使用已准备的声音"><SkipBack size={14}/>上一段</button>
      <button disabled={!navigable} onClick={() => void player?.replay()} title="从当前段开头重听"><RotateCcw size={14}/>重听本段</button>
      <button disabled={!navigable || audio.index + 1 >= audio.total} onClick={() => void player?.next()} title="前进到下一段"><SkipForward size={14}/>下一段</button>
      <span className="segment-position">{audio.total ? `${audio.index + 1} / ${audio.total} 段` : '截图后可回听'}</span>
    </nav>
    <div className="statusbar"><span className={`status-dot ${busy ? 'active' : ''} ${error || audio.phase === 'error' ? 'danger' : ''}`}/><span className="status-text" role={error || audio.phase === 'error' ? 'alert' : 'status'} title={status}>{status}</span><button className="tiny-button" aria-label="停止朗读" title="停止 · Esc" disabled={!busy && !audio.total} onClick={() => void stop()}><Square size={11}/></button><button className="tiny-button" aria-label="查看识别文字" title="查看识别文字" onClick={() => void showPanel(panel === 'text' ? null : 'text')}><AlignLeft size={14}/></button></div>
    {panel && <section key={panel} className="panel">
      <div className="panel-heading"><button className="back-button" aria-label="收起面板" onClick={() => void showPanel(null)}><ChevronLeft size={17}/></button><h1>{panel === 'settings' ? '声音与设置' : '这次读什么'}</h1><span>{panel === 'settings' ? '按你的习惯来' : `${prepared.text.length} 字`}</span></div>
      {panel === 'settings' ? <SettingsPanel key={`${loaded}-${settings.migrated}`} settings={settings} enabled={!!bridge && loaded && !savingSettings} save={value => save({ ...value, preferences: { ...value.preferences, rate: settingsRef.current.preferences.rate } })} openHelp={provider => bridge?.openHelp(provider) ?? Promise.resolve()} operationToken={() => auditionIntent.current} audition={async (token, provider) => { if (token !== auditionIntent.current || provider !== settingsRef.current.preferences.provider) return false; const own = ++sequence.current; setError(''); await readText('这是轻读的声音试听。2026年，我们把屏幕上的文字，变成自然的朗读。你可以随时暂停，也可以调整语速，接着往下听。', own); return own === sequence.current; }} onSaved={() => { setNotice('设置已保存，下次朗读使用新声音'); setError(''); }} /> : <div className="text-panel">
        <p className="hint">本机识别后整理断行。公式和图片内容可能识别不全，读前可在这里核对。</p>
        <label className="field-label" htmlFor="recognized-text">识别文字</label><textarea id="recognized-text" className="source-text" value={source} maxLength={12000} onChange={event => setSource(event.target.value)} placeholder="点击上方「截图朗读」，框选电脑上想听的内容。"/>
        <div className="text-meta">{prepared.skipped > 0 ? `已跳过 ${prepared.skipped} 处明显公式。` : '保留正文，合并同一句中的换行。'}{settings.preferences.skipFormulas ? '公式跳过已开启。' : ''}</div>
        <details className="speech-preview"><summary>实际朗读内容</summary><p>{prepared.text || '暂无可朗读正文。'}</p></details>
        <button className="primary wide" disabled={!bridge || !loaded || savingSettings || !prepared.text || work !== 'idle'} onClick={() => { auditionIntent.current++; sequence.current++; setError(''); void readText(source); }}><Play size={15}/>朗读这段文字</button><p className="fine-print">{settings.preferences.provider === 'bing' ? '重新朗读会向微软 Bing 请求声音。' : '重新朗读会重新生成声音，可能使用语音额度。'}截图和文字不写入历史记录。</p>
      </div>}
    </section>}
  </main>;
}

function SettingsPanel({ settings, enabled, save, openHelp, onSaved, audition, operationToken }: { settings: ReaderSettings; enabled: boolean; save(value: SaveReaderSettings): Promise<ReaderSettings>; openHelp(provider: 'doubao' | 'bing'): Promise<void>; onSaved(): void; operationToken(): number; audition(token: number, provider: 'doubao' | 'bing'): Promise<boolean> }) {
  const [draft, setDraft] = useState(settings.preferences), [apiKey, setApiKey] = useState(''), [clearKey, setClearKey] = useState(false), [saving, setSaving] = useState(false), [feedback, setFeedback] = useState('');
  const bing = draft.provider === 'bing';
  function patch(value: Partial<ReaderPreferences>) { setDraft(previous => ({ ...previous, ...value })); }
  async function submit(listen = false) {
    const token = operationToken(), requestedProvider = draft.provider;
    setSaving(true); setFeedback('');
    try {
      const next = await save({ preferences: draft, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearKey ? { clearApiKey: true } : {}) });
      setDraft(next.preferences); setApiKey(''); setClearKey(false); onSaved();
      if (listen) {
        if (!speechConfigured(next.preferences, next.hasApiKey)) { setFeedback('请先勾选当前声音的联网朗读许可；豆包还需要 API Key。'); return; }
        setFeedback('正在准备试听…');
        const started = await audition(token, requestedProvider);
        setFeedback(started ? '已请求试听。可用上方按钮暂停、调速或停止。' : '已取消本次试听。设置仍已保存。');
      } else setFeedback('已保存。设置不会自动请求声音。');
    }
    catch (error) { setFeedback(messageOf(error)); }
    finally { setSaving(false); }
  }
  return <form className="settings-panel" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <fieldset disabled={saving || !enabled}><div className="voice-label"><span className="eyebrow">当前声音</span><span className="voice-tag">{bing ? '微软 Bing · AI 合成声音' : '豆包 2.0 · AI 合成声音'}</span></div>
    <label className="field-label" htmlFor="provider">朗读来源</label><select id="provider" value={draft.provider} onChange={event => patch({ provider: event.target.value as ReaderPreferences['provider'] })}><option value="bing">Bing 翻译朗读 · 无需 Key（实验）</option><option value="doubao">豆包语音 2.0</option></select>
    {bing ? <>
      <label className="field-label" htmlFor="bing-voice">朗读音色</label><select id="bing-voice" value="xiaoxiao" disabled><option value="xiaoxiao">晓晓 · Edge 翻译面板中文音色</option></select>
      <p className="hint">沿用 Edge 翻译面板的「晓晓」音色与语气，语速在上方调整。</p>
      <p className="hint">无需 Key，不消耗豆包额度；实验接入，可能限流或变化，不保证长期免费。</p>
      <label className="check-row cloud"><input type="checkbox" checked={draft.allowBingCloud} onChange={event => patch({ allowBingCloud: event.target.checked })}/><span>允许将我主动截图或编辑后选择朗读的文字发送至微软 Bing 生成声音。<small>仅在你主动朗读或试听时请求，不读取 Edge 登录资料。</small></span></label>
    </> : <>
      <label className="field-label" htmlFor="voice">朗读音色</label><select id="voice" value={draft.voice} onChange={event => patch({ voice: event.target.value })}>{DOUBAO_TTS_VOICES.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select>
      <label className="field-label" htmlFor="voice-style">朗读语气</label><textarea id="voice-style" className="style-input" maxLength={1000} value={draft.instructions} onChange={event => patch({ instructions: event.target.value })}/>
      <label className="field-label" htmlFor="api-key">豆包语音 API Key</label><input id="api-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} maxLength={500} placeholder={settings.hasApiKey ? '已保存；留空则保留原 Key' : '只在本机填写，不要发送到聊天'} onChange={event => { setApiKey(event.target.value); setClearKey(false); }}/>
      <div className="key-state">{settings.hasApiKey ? (settings.migrated ? '已沿用旧软件的豆包 Key。' : 'Key 已加密保存。') : '尚未配置 Key。'}账号权限与额度需在官方控制台确认。</div>
      {settings.hasApiKey && <label className="check-row compact"><input type="checkbox" checked={clearKey} onChange={event => { setClearKey(event.target.checked); setApiKey(''); }}/><span>清除已保存的 Key</span></label>}
      <label className="check-row cloud"><input type="checkbox" checked={draft.allowCloud} onChange={event => patch({ allowCloud: event.target.checked })}/><span>允许将我主动截图或编辑后选择朗读的文字发送至火山引擎生成声音。<small>图片仅在本机识字；朗读可能消耗账号额度。</small></span></label>
    </>}
    <div className="options-row"><label className="check-row"><input type="checkbox" checked={draft.skipFormulas} onChange={event => patch({ skipFormulas: event.target.checked })}/><span>跳过明显公式</span></label><label className="check-row"><input type="checkbox" checked={draft.alwaysOnTop} onChange={event => patch({ alwaysOnTop: event.target.checked })}/><span>悬浮条置顶</span></label></div>
    <p className="hint">{settings.shortcutAvailable ? '快捷键 Ctrl+Shift+R 截图；Esc 取消截图。' : '快捷键当前不可用，可点击截图按钮。'}语速直接在悬浮条调整，播放位置不变。</p>
    {!settings.encryptionAvailable && enabled && <p className="warning">本机凭证加密不可用，暂不能保存设置。</p>}
    {feedback && <p className="feedback" role="status">{feedback}</p>}
    <div className="settings-footer"><button type="button" className="link-button" onClick={() => void openHelp(draft.provider).catch(error => setFeedback(messageOf(error)))}>{bing ? '打开 Bing 翻译' : '官方开通与额度'}</button><div className="settings-actions"><button className="primary" type="submit" disabled={!enabled || saving}>{saving ? '正在保存…' : '保存设置'}</button><button className="primary" type="button" aria-label="保存并试听这段声音" disabled={!enabled || saving} onClick={() => void submit(true)}><Play size={15}/>保存并试听</button></div></div>
    </fieldset>
  </form>;
}
