import { useState } from 'react';
import type { ChatGPTState } from '../../../packages/shared/chatgpt';
export type AccountAction = 'login' | 'cancel' | 'select' | 'logout' | 'refresh';
export function ChatGPTPanel({ state, enabled, model, onModel, action, openUsage }: {
  state: ChatGPTState; enabled: boolean; model: string; onModel(value: string): void;
  action(kind: AccountAction, id?: string): Promise<void>; openUsage(): Promise<void>;
}) {
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  async function run(kind: AccountAction, id?: string) {
    if (working) return; setWorking(true); setError('');
    try { await action(kind, id); } catch (value) { setError(value instanceof Error ? value.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '账号操作未完成，请重试。'); }
    finally { setWorking(false); }
  }
  const pending = state.status === 'authorizing';
  return <div className="chatgpt-account">
    <p className="account-title">用你的 ChatGPT 订阅看图</p>
    <p className="hint">无需填写 API Key。登录后，在官方页面允许轻读使用订阅额度；声音仍由你选择的朗读服务生成。</p>
    {state.profiles.length > 0 && <><label className="field-label" htmlFor="chatgpt-account">ChatGPT 账号</label><select id="chatgpt-account" value={state.activeProfileId ?? ''} disabled={!enabled || working || pending} onChange={event => void run('select', event.target.value)}>
      {!state.activeProfileId && <option value="">选择已连接账号</option>}{state.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}{profile.connected ? '' : ' · 需要登录'}</option>)}
    </select></>}
    <p className="account-status">{pending ? '正在等待浏览器授权…' : state.sharing ? '已连接 · 使用 ChatGPT 订阅额度' : state.status === 'connected' ? '账号已连接，但尚未允许使用订阅额度' : '尚未连接 ChatGPT'}</p>
    <div className="account-actions">
      {pending ? <button type="button" className="primary" disabled={working} onClick={() => void run('cancel')}>取消登录</button> : <button type="button" className="primary" disabled={!enabled || working} onClick={() => void run('login', state.activeProfileId ?? undefined)}>Continue with ChatGPT</button>}
      {state.activeProfileId && !pending && <button type="button" className="link-button" disabled={!enabled || working} onClick={() => void run('login')}>添加账号</button>}
      {state.status === 'connected' && !pending && <button type="button" className="link-button" disabled={!enabled || working} onClick={() => void run('logout')}>退出当前账号</button>}
    </div>
    <p className="hint">{pending ? '系统浏览器已请求打开。若没有出现登录页，可取消后重新连接。' : '点击上方按钮，在系统浏览器中登录。登录本身不会上传截图或请求语音。'}</p>
    {state.sharing && <><label className="field-label" htmlFor="chatgpt-model">看图模型</label><select id="chatgpt-model" value={model} onChange={event => onModel(event.target.value)} disabled={!enabled || working || pending}>
      <option value="">自动选择当前账号可用模型</option>{state.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}{model && !state.models.some(item => item.id === model) && <option value={model}>原模型暂不可用，请刷新或重新选择</option>}
    </select><button type="button" className="link-button" disabled={!enabled || working || pending} onClick={() => void run('refresh')}>刷新可用模型</button></>}
    <p className="hint">有订阅用量上限。请在官方用量设置中关闭超额使用付费余额；轻读不会自动切换到收费 API。</p>
    <button type="button" className="link-button" disabled={!enabled} onClick={() => void openUsage().catch(() => setError('未能打开用量页面，请稍后重试。'))}>查看 ChatGPT 用量</button>
    {state.message && <p className="feedback" role="status">{state.message}</p>}{error && <p className="warning" role="alert">{error}</p>}
  </div>;
}
