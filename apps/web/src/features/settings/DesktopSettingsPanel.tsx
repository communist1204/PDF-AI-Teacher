import { useEffect, useRef, useState } from 'react';
import type { DesktopPreferences, DesktopSettings, DesktopTeacherBridge } from '../../../../../packages/shared/desktop';
import { normalizeSpeechEngine } from '../../../../../packages/shared/localSpeech';
import { DEFAULT_DOUBAO_TTS_INSTRUCTIONS, DEFAULT_DOUBAO_TTS_VOICE } from '../../../../../packages/shared/doubaoSpeech';
import { COSY_TTS_VOICES, DEFAULT_COSY_TTS_VOICE, isCosyVoice, type CosyVoiceId } from '../../../../../packages/shared/cosySpeech';
import { COSY_AUDITION_TEXT, type CosyAuditionState } from '../voice/CosyVoiceAudition';
import './desktopSettings.css';

function preferences(settings: DesktopSettings): DesktopPreferences {
  const { mode, chatModel, visionModel, reasoningEffort, ttsModel, ttsVoice, ttsInstructions } = settings;
  return { mode, chatModel, visionModel, reasoningEffort, ttsModel, ttsVoice, ttsInstructions, ttsEngine: settings.ttsEngine === 'doubao' || settings.ttsEngine === 'openai' ? 'cosy' : normalizeSpeechEngine(settings.ttsEngine), cosyTtsVoice: isCosyVoice(settings.cosyTtsVoice) ? settings.cosyTtsVoice : DEFAULT_COSY_TTS_VOICE, doubaoTtsVoice: settings.doubaoTtsVoice ?? DEFAULT_DOUBAO_TTS_VOICE, doubaoTtsInstructions: settings.doubaoTtsInstructions ?? DEFAULT_DOUBAO_TTS_INSTRUCTIONS };
}

type Props = { bridge: DesktopTeacherBridge; onChange: (settings: DesktopSettings) => void; onBeforeAccountChange: () => void; auditionAvailable: boolean; auditionState: CosyAuditionState; onAudition: (voice: CosyVoiceId) => void; onStopAudition: () => void };
export default function DesktopSettingsPanel({ bridge, onChange, onBeforeAccountChange, auditionAvailable, auditionState, onAudition, onStopAudition }: Props) {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [draft, setDraft] = useState<DesktopPreferences | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [feedbackTarget, setFeedbackTarget] = useState<'account' | 'settings'>('settings');
  const accountFeedback = useRef<HTMLDivElement>(null);
  const operation = useRef(0);
  const mounted = useRef(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    mounted.current = true;
    void bridge.getSettings().then(value => {
      if (!mounted.current) return;
      setSettings(value); setDraft(preferences(value)); onChangeRef.current(value);
    }).catch(() => { if (mounted.current) setError('未能读取桌面设置，请关闭设置后重试。'); });
    return () => { mounted.current = false; operation.current++; void bridge.cancelLogin().catch(() => {}); };
  }, [bridge]);

  useEffect(() => {
    if (feedbackTarget === 'account' && (pending || error || notice)) accountFeedback.current?.scrollIntoView({ block: 'nearest' });
  }, [feedbackTarget, pending, error, notice]);

  const accept = (value: DesktopSettings) => {
    setSettings(value); setDraft(preferences(value)); onChangeRef.current(value);
  };
  const run = async (kind: string, action: () => Promise<void>) => {
    if (pending) return;
    const id = ++operation.current;
    setFeedbackTarget(['login', 'account', 'logout'].includes(kind) ? 'account' : 'settings');
    setPending(kind); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { if (mounted.current && operation.current === id) setError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); }
    finally { if (mounted.current && operation.current === id) setPending(''); }
  };
  const login = (accountId?: string) => void run('login', async () => {
    const id = operation.current;
    onBeforeAccountChange();
    const value = await bridge.login(accountId);
    if (!mounted.current || id !== operation.current) return;
    accept(value); setNotice(value.auth.status === 'signed_in' ? '账号已登录。核对解题模型后，点击「应用并重启」启用。' : value.auth.message || '登录尚未完成。');
  });
  const cancelLogin = async () => {
    const id = ++operation.current;
    setFeedbackTarget('account'); setPending('cancel'); setError(''); setNotice('');
    try { await bridge.cancelLogin(); if (mounted.current && id === operation.current) setNotice('已取消本次登录，可以继续使用本地阅读功能。'); }
    catch { if (mounted.current && id === operation.current) setError('未能确认登录取消，请关闭官方登录页面。'); }
    finally { if (mounted.current && id === operation.current) setPending(''); }
  };
  const save = async (restart: boolean) => {
    if (!draft || !settings) return;
    if (draft.mode === 'chatgpt' && settings.auth.status !== 'signed_in') throw new Error('请先登录 ChatGPT 账号，或选择本地演示。');
    if (draft.mode === 'chatgpt' && settings.models.length && [draft.chatModel, draft.visionModel].some(id => !settings.models.some(model => model.id === id))) throw new Error('请从此账号返回的模型列表中选择文字和看图解题模型。');
    if (draft.mode === 'api' && !apiKey.trim() && (!settings.hasApiKey || clearApiKey)) throw new Error('API 模式需要填写本机 API Key。也可以使用 ChatGPT 登录或本地演示。');
    const key = apiKey.trim();
    setApiKey('');
    const value = await bridge.saveSettings({ ...draft, ...(key ? { apiKey: key } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) });
    setApiKey(''); setClearApiKey(false);
    if (!mounted.current) return;
    accept(value);
    if (restart) { onBeforeAccountChange(); await bridge.restart(); }
    else setNotice('设置已保存在本机，点击「应用并重启」后生效。');
  };
  const update = <K extends keyof DesktopPreferences>(field: K, value: DesktopPreferences[K]) => setDraft(current => current ? { ...current, [field]: value } : current);
  const dirty = !!draft && !!settings && (JSON.stringify(draft) !== JSON.stringify(preferences(settings)) || !!apiKey || clearApiKey);
  const account = settings?.auth;
  const busy = !!pending;
  const modelInput = (field: 'chatModel' | 'visionModel', label: string) => draft && <label>{label}{draft.mode === 'chatgpt' && settings?.models.length ? <select aria-label={label} value={draft[field]} onChange={event => update(field, event.target.value)}>{!settings.models.some(model => model.id === draft[field]) && <option value={draft[field]}>请选择账号可用模型</option>}{settings.models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select> : <input aria-label={label} value={draft[field]} onChange={event => update(field, event.target.value)} maxLength={120} placeholder="例如 gpt-6-astra"/>}</label>;

  return <section className="desktop-settings" aria-label="桌面账号与模型设置">
    <div className="desktop-settings-heading"><span className="eyebrow">DESKTOP / ACCOUNT</span><h3>登录 ChatGPT，开始问书</h3><p>在系统浏览器中完成官方授权，软件会保留你的阅读窗口。登录凭证只由本机桌面程序管理。</p></div>
    {!settings || !draft ? <p role="status">{error || '正在读取本机设置…'}</p> : <>
      <div className="desktop-account-card">
        <div><strong>{account?.status === 'signed_in' ? 'ChatGPT 已登录' : account?.status === 'expired' ? 'ChatGPT 登录已过期' : '尚未登录 ChatGPT'}</strong>{account?.email && <span className="desktop-account-email">{account.email}</span>}</div>
        {account?.message && <p>{account.message}</p>}
        {account?.accounts.length ? <label>本机账号<select aria-label="本机 ChatGPT 账号" value={account.activeAccountId || ''} disabled={busy} onChange={event => void run('account', async () => { onBeforeAccountChange(); accept(await bridge.selectAccount(event.target.value)); setNotice('账号已切换，点击「应用并重启」启用。'); })}><option value="" disabled>选择账号</option>{account.accounts.map(item => <option key={item.id} value={item.id}>{item.label}{item.status === 'expired' ? '（需重新登录）' : item.status === 'signed_out' ? '（已退出）' : ''}</option>)}</select></label> : null}
        <div className="desktop-setting-actions">{pending === 'login' || pending === 'cancel' ? <><button className="secondary-button" disabled={pending === 'cancel'} onClick={() => void cancelLogin()}>取消登录</button></> : <><button className="primary-button" disabled={busy || !settings.encryptionAvailable} onClick={() => login(account?.activeAccountId)}>{account?.status === 'signed_in' ? '重新授权 ChatGPT' : '使用 ChatGPT 登录'}</button>{!!account?.accounts.length && <button className="secondary-button" disabled={busy || !settings.encryptionAvailable} onClick={() => login()}>添加另一个账号</button>}{account?.status === 'signed_in' && <button className="text-button" disabled={busy} onClick={() => void run('logout', async () => { onBeforeAccountChange(); accept(await bridge.logout()); setNotice('已退出当前账号，点击「应用并重启」更新当前会话。'); })}>退出当前账号</button>}</>}</div>
        <div className="desktop-account-feedback" ref={accountFeedback} aria-live="polite" aria-atomic="true">
          {feedbackTarget === 'account' && <>{(pending === 'login' || pending === 'cancel') && <p className="desktop-account-pending" role="status">{pending === 'cancel' ? '正在取消登录…' : '正在连接官方登录服务；授权页面打开后，请在浏览器中继续。'}</p>}{error && <p className="desktop-setting-error" role="alert">{error}</p>}{notice && <p className="desktop-setting-notice" role="status">{notice}</p>}</>}
        </div>
        <p className="desktop-setting-note">登录用于文字与看图解题，使用范围和额度由你的 ChatGPT 计划决定。模型以账号实际返回的列表为准，登录成功不代表专业解答已验证。</p>
      </div>
      {!settings.encryptionAvailable && <p className="desktop-setting-error" role="alert">本机安全加密不可用，无法保存登录或 API 凭证。可以继续使用本地演示。</p>}
      <fieldset disabled={busy} className="desktop-model-fields"><legend>解题设置</legend>
        <label>使用方式<select aria-label="使用方式" value={draft.mode} onChange={event => update('mode', event.target.value as DesktopPreferences['mode'])}><option value="chatgpt">ChatGPT 账号</option><option value="demo">本地演示（不调用模型）</option><option value="api">独立 API Key</option></select></label>
        <div className="desktop-fields-row">{modelInput('chatModel', '文字解题模型')}{modelInput('visionModel', '看图解题模型')}</div>
        <label>推理强度<select aria-label="推理强度" value={draft.reasoningEffort} onChange={event => update('reasoningEffort', event.target.value)}><option value="">模型默认</option>{['low','medium','high','xhigh','max'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <p className="desktop-setting-note">复杂理论可优先选择账号可用的高能力模型；不会为了朗读方便更换解题模型。GPT-6 Astra / xhigh 是配置建议，权限、推理强度支持及真实解题质量需验证。{draft.mode === 'chatgpt' && !settings.models.length && ' 账号模型列表尚未取得。'}</p>
      </fieldset>
      <fieldset disabled={busy} className="desktop-model-fields desktop-speech-fields"><legend>朗读声音</legend>
        <label>朗读方式<select aria-label="朗读方式" value={draft.ttsEngine ?? 'none'} onChange={event => { onStopAudition(); update('ttsEngine', event.target.value as DesktopPreferences['ttsEngine']); }}><option value="none">关闭朗读（稍后配置）</option><option value="cosy">CosyVoice 3（本机 GPU · 六种参考音色）</option></select></label>
        {draft.ttsEngine === 'none' && <p>朗读已关闭。阅读 PDF、文字问答和板书可继续使用；选择并配置声音后再试听。</p>}
        {draft.ttsEngine === 'cosy' && <div className="desktop-cosy-fields">
          <p>CosyVoice 3 在本机显卡生成 AI 合成声音，不需要 API Key，不上传朗读文字。这里是你选定六种声音的本地参考版，参考官方公开样音近似生成，不等同于官方云端原版。</p>
          <label>CosyVoice 中文音色<select aria-label="CosyVoice 中文音色" value={draft.cosyTtsVoice ?? DEFAULT_COSY_TTS_VOICE} onChange={event => { onStopAudition(); update('cosyTtsVoice', event.target.value as CosyVoiceId); }}>{COSY_TTS_VOICES.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</select></label>
          <p className="desktop-setting-note cosy-voice-description">{COSY_TTS_VOICES.find(voice => voice.id === (draft.cosyTtsVoice ?? DEFAULT_COSY_TTS_VOICE))?.description}</p>
          <p className="cosy-reference-id">参考音色参数：<code>{(draft.cosyTtsVoice ?? DEFAULT_COSY_TTS_VOICE).replace(/^local_/, '')}</code></p>
          <div className="cosy-audition-card">
            <span className="eyebrow">本机生成 · 同文试听 · 1× 语速</span><p>{COSY_AUDITION_TEXT}</p>
            <div className="desktop-setting-actions"><button className="primary-button" disabled={!auditionAvailable} onClick={() => onAudition(draft.cosyTtsVoice ?? DEFAULT_COSY_TTS_VOICE)}>试听这个音色</button><button className="secondary-button" disabled={!['loading','playing'].includes(auditionState.status)} onClick={onStopAudition}>停止试听</button></div>
            <p className="cosy-audition-status" role={auditionState.status === 'error' ? 'alert' : 'status'}>{!auditionAvailable ? '本次运行尚未启用可用的 CosyVoice 3。请先保存并应用本机朗读方式，再试听；不会调用在线声音。' : auditionState.status === 'loading' ? '正在准备试听…首次加载需要稍等，可随时停止。' : auditionState.status === 'playing' ? '正在试听 AI 合成声音。' : auditionState.status === 'finished' ? '试听结束。喜欢这个音色的话，保存并应用即可用于 PDF 朗读。' : auditionState.status === 'error' ? `试听未完成：${auditionState.message}` : '点击才会发声。试听会停止当前朗读并保留阅读位置，不影响正在生成的文字解答。'}</p>
          </div>
          <p className="desktop-setting-note">安装好本机模型后，保存并「应用并重启」。首次朗读需要加载模型，后续复用；声音一边生成一边播放。暂停、续读和 0.25–3× 调速仍使用底部播放器。</p>
          <p className="desktop-setting-note">试听可使用尚未保存的音色；选择和保存不会自动发声。保存并应用后，PDF 朗读使用所选音色。关闭设置会停止试听，原文由你点击继续。运行状态见下方「本机语音状态」。</p>
        </div>}
      </fieldset>
      <details className="desktop-advanced"><summary>高级 API 配置（可选）</summary><p>仅独立 API 解题需要此配置。使用 ChatGPT 账号解题或本机语音朗读，都不需要在这里填写 Key；专业解题模型保持上方选择。</p><fieldset disabled={busy || !settings.encryptionAvailable}>
        <label>OpenAI API Key<input type="password" aria-label="OpenAI API Key" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={event => { setApiKey(event.target.value); setClearApiKey(false); }} placeholder={settings.hasApiKey ? '已保存；留空保持原 Key' : '只在本机填写，不要发送到聊天'} maxLength={512}/></label>
        <p className="desktop-setting-note">{settings.hasApiKey ? '本机已保存 API Key；不会回显。' : '尚未保存 API Key。'} 保存后输入框清空，凭证由桌面程序加密保管。</p>
        {settings.hasApiKey && <label className="desktop-check"><input type="checkbox" checked={clearApiKey} onChange={event => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(''); }}/>删除本机保存的 API Key（保存后生效）</label>}
      </fieldset><div className="desktop-setting-actions"><button className="text-button" disabled={busy} onClick={() => void run('link', () => bridge.openAccountPage('api-keys'))}>打开官方 API Key 页面</button><button className="text-button" disabled={busy} onClick={() => void run('link', () => bridge.openAccountPage('billing'))}>查看 API 账单</button></div></details>
      {(settings.restartRequired || dirty) && <div className="desktop-restart-notice"><strong>{dirty ? '有待保存的设置' : '设置已保存，等待应用'}</strong><p>应用时会重启软件。已保存的学习记录保留；重启后重新选择同一 PDF 继续。请先保留尚未发送的问题。</p></div>}
      <div className="desktop-setting-actions desktop-save-actions"><button className="secondary-button" disabled={busy || !dirty} onClick={() => void run('save', () => save(false))}>保存设置</button><button className="primary-button" disabled={busy || (!dirty && !settings.restartRequired)} onClick={() => void run('restart', () => save(true))}>{pending === 'restart' ? '正在应用…' : '应用并重启'}</button><button className="text-button" disabled={busy} onClick={() => void run('shortcut', async () => { await bridge.createShortcut(); setNotice('桌面快捷方式已创建，下次双击图标即可打开。'); })}>创建桌面快捷方式</button></div>
      {feedbackTarget === 'settings' && <>{notice && <p className="desktop-setting-notice" role="status">{notice}</p>}{error && <p className="desktop-setting-error" role="alert">{error}</p>}</>}
    </>}
  </section>;
}
