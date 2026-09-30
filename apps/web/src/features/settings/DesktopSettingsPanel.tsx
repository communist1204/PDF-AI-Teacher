import { useEffect, useRef, useState } from 'react';
import type { DesktopPreferences, DesktopSettings, DesktopTeacherBridge } from '../../../../../packages/shared/desktop';
import { DEFAULT_LOCAL_TTS_VOICE, DEFAULT_QWEN_TTS_INSTRUCTIONS, DEFAULT_QWEN_TTS_VOICE, LOCAL_TTS_VOICES, QWEN_TTS_VOICES } from '../../../../../packages/shared/localSpeech';
import './desktopSettings.css';

function preferences(settings: DesktopSettings): DesktopPreferences {
  const { mode, chatModel, visionModel, reasoningEffort, ttsModel, ttsVoice, ttsInstructions } = settings;
  return { mode, chatModel, visionModel, reasoningEffort, ttsModel, ttsVoice, ttsInstructions, ttsEngine: settings.ttsEngine ?? 'local', localTtsVoice: settings.localTtsVoice ?? DEFAULT_LOCAL_TTS_VOICE, qwenTtsVoice: settings.qwenTtsVoice ?? DEFAULT_QWEN_TTS_VOICE, qwenTtsInstructions: settings.qwenTtsInstructions ?? DEFAULT_QWEN_TTS_INSTRUCTIONS };
}

export default function DesktopSettingsPanel({ bridge, onChange, onBeforeAccountChange }: { bridge: DesktopTeacherBridge; onChange: (settings: DesktopSettings) => void; onBeforeAccountChange: () => void }) {
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
        <label>朗读方式<select aria-label="朗读方式" value={draft.ttsEngine ?? 'local'} onChange={event => update('ttsEngine', event.target.value as DesktopPreferences['ttsEngine'])}><option value="local">免费本地 AI 声音（Kokoro）</option><option value="qwen">Qwen3 本地语音（免费·CPU 试用）</option><option value="openai">OpenAI AI 声音（按 API 用量计费）</option><option value="system">系统基本语音（免费）</option></select></label>
        {draft.ttsEngine === 'local' && <><p>免费本地 AI 合成语音：使用 Kokoro 中文模型在电脑 CPU 上生成声音，不需要 API Key、登录或充值，朗读文本留在本机。AI 解题仍使用你选择的账号或演示模式。</p><label>本地中文音色<select aria-label="本地中文音色" value={draft.localTtsVoice ?? DEFAULT_LOCAL_TTS_VOICE} onChange={event => update('localTtsVoice', event.target.value)}>{LOCAL_TTS_VOICES.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {voice.id}</option>)}</select></label><p role="status">{settings.localTtsReady ? '本地语音模型已就绪。' : '本地语音模型尚未就绪；请先安装项目提供的本地语音模型包。不会自动切换到付费语音或系统声音。'}</p><p className="desktop-setting-note">保存并应用后，选一小段原文点「朗读所选」试听。音色编号不代表音质排名，中文听感请实际试听。</p></>}
        {draft.ttsEngine === 'qwen' && <>
          <p>Qwen3 本地 AI 合成语音：免费，在电脑 CPU 上生成，朗读文本留在本机，不需要 API Key、登录或充值。解题仍使用你选择的账号和模型，不受朗读方式影响。</p>
          <label>Qwen3 中文音色<select aria-label="Qwen3 中文音色" value={draft.qwenTtsVoice ?? DEFAULT_QWEN_TTS_VOICE} onChange={event => update('qwenTtsVoice', event.target.value)}>{QWEN_TTS_VOICES.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label>
          <label>Qwen3 朗读语气<textarea aria-label="Qwen3 朗读语气" value={draft.qwenTtsInstructions ?? DEFAULT_QWEN_TTS_INSTRUCTIONS} onChange={event => update('qwenTtsInstructions', event.target.value)} rows={3} maxLength={1000} placeholder="温和自然的中文陪读，按语义停顿，不增改原文。"/></label>
          <p role="status">{settings.qwenTtsReady ? 'Qwen3 语音资源已就绪。' : 'Qwen3 语音资源尚未就绪；请先安装项目提供的 Qwen3 语音模型包。不会自动切换到付费语音或系统声音。'}</p>
          <p className="desktop-setting-note">可用文字描述希望的语气；CPU 生成可能需要等待，语气效果、速度与朗读准确性请实际试听。保存并应用后，选一小段原文点「朗读所选」。合成声音不代表模型理解了教材，也不负责解题。</p>
        </>}
        {draft.ttsEngine === 'system' && <p>系统基本语音：免费，使用 Windows / 浏览器已有声音，音色和自然度受本机系统限制。不会向 OpenAI 请求语音。</p>}
        {draft.ttsEngine === 'openai' && <p>OpenAI AI 合成语音使用独立 API Key 和 API 额度；ChatGPT 登录不包含本应用的 TTS 授权。只有你主动朗读时才请求语音，真实听感需试听。</p>}
      </fieldset>
      <details className="desktop-advanced"><summary>高级 API 配置（可选）</summary><p>仅独立 API 解题或 OpenAI 朗读需要此配置。免费本地朗读与系统语音不使用 API Key。</p><fieldset disabled={busy || !settings.encryptionAvailable}>
        <label>OpenAI API Key<input type="password" aria-label="OpenAI API Key" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={event => { setApiKey(event.target.value); setClearApiKey(false); }} placeholder={settings.hasApiKey ? '已保存；留空保持原 Key' : '只在本机填写，不要发送到聊天'} maxLength={512}/></label>
        <p className="desktop-setting-note">{settings.hasApiKey ? '本机已保存 API Key；不会回显。' : '尚未保存 API Key。'} 保存后输入框清空，凭证由桌面程序加密保管。</p>
        {settings.hasApiKey && <label className="desktop-check"><input type="checkbox" checked={clearApiKey} onChange={event => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(''); }}/>删除本机保存的 API Key（保存后生效）</label>}
        {draft.ttsEngine === 'openai' && <><div className="desktop-fields-row"><label>朗读模型<input aria-label="朗读模型" value={draft.ttsModel} onChange={event => update('ttsModel', event.target.value)} maxLength={120} placeholder="gpt-4o-mini-tts"/></label><label>朗读音色<select aria-label="朗读音色" value={draft.ttsVoice} onChange={event => update('ttsVoice', event.target.value)}>{['marin','cedar','alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse'].map(voice => <option key={voice}>{voice}</option>)}</select></label></div>
        <label>朗读语气<textarea aria-label="朗读语气" value={draft.ttsInstructions} onChange={event => update('ttsInstructions', event.target.value)} rows={3} maxLength={1000} placeholder="温和自然，按句意停顿，避免播音腔。"/></label></>}
      </fieldset><div className="desktop-setting-actions"><button className="text-button" disabled={busy} onClick={() => void run('link', () => bridge.openAccountPage('api-keys'))}>打开官方 API Key 页面</button><button className="text-button" disabled={busy} onClick={() => void run('link', () => bridge.openAccountPage('billing'))}>查看 API 账单</button></div></details>
      {(settings.restartRequired || dirty) && <div className="desktop-restart-notice"><strong>{dirty ? '有待保存的设置' : '设置已保存，等待应用'}</strong><p>应用时会重启软件。已保存的学习记录保留；重启后重新选择同一 PDF 继续。请先保留尚未发送的问题。</p></div>}
      <div className="desktop-setting-actions desktop-save-actions"><button className="secondary-button" disabled={busy || !dirty} onClick={() => void run('save', () => save(false))}>保存设置</button><button className="primary-button" disabled={busy || (!dirty && !settings.restartRequired)} onClick={() => void run('restart', () => save(true))}>{pending === 'restart' ? '正在应用…' : '应用并重启'}</button><button className="text-button" disabled={busy} onClick={() => void run('shortcut', async () => { await bridge.createShortcut(); setNotice('桌面快捷方式已创建，下次双击图标即可打开。'); })}>创建桌面快捷方式</button></div>
      {feedbackTarget === 'settings' && <>{notice && <p className="desktop-setting-notice" role="status">{notice}</p>}{error && <p className="desktop-setting-error" role="alert">{error}</p>}</>}
    </>}
  </section>;
}
