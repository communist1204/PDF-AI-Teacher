import { useEffect, useState } from 'react';
import type { AppConfig } from '../../../../../packages/shared/protocol';

const labels: Record<string, string> = {
  missing: '模型尚未安装', idle: '模型已安装，首次朗读时加载', loading: '正在加载本机模型',
  ready: '模型已加载，可开始朗读', error: '模型运行异常，请重试或查看本机服务日志', stopped: '模型已停止，朗读时重新加载',
};

/** Polling status never replaces the main session or restarts its audio owner. */
export default function CosySpeechStatus() {
  const [state, setState] = useState('正在检查本机语音状态…');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const response = await fetch('/api/config', { signal: controller.signal });
        if (!response.ok) throw new Error('status unavailable');
        const config: AppConfig = await response.json();
        if (!controller.signal.aborted) setState(config.speech?.engine === 'cosy' ? labels[config.speech.status ?? ''] ?? '状态尚未确认' : '本次运行未启用 CosyVoice 3，保存并应用后查看状态');
      } catch { if (!controller.signal.aborted) setState('暂时无法读取状态，请确认本机服务已启动'); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 2000); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  return <p className="cosy-speech-status" role="status" data-testid="cosy-speech-status"><strong>本机语音状态：</strong>{state}</p>;
}
