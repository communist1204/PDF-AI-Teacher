import type { SpeechEngine } from './localSpeech';

import type { CosyVoiceId } from './cosySpeech';

export type DesktopMode = 'demo' | 'chatgpt' | 'api';

/** Preferences contain no credential material. Persisted by the desktop main process. */
export interface DesktopPreferences {
  mode: DesktopMode;
  chatModel: string;
  visionModel: string;
  reasoningEffort: string;
  ttsEngine?: SpeechEngine;
  cosyTtsVoice?: CosyVoiceId;
  localTtsVoice?: string;
  qwenTtsVoice?: string;
  qwenTtsDevice?: 'cpu' | 'cuda';
  doubaoTtsVoice?: string;
  doubaoTtsInstructions?: string;
  qwenTtsInstructions?: string;
  ttsModel: string;
  ttsVoice: string;
  ttsInstructions: string;
}

/** Safe public state exposed by preload; OAuth tokens and saved API keys never return to the renderer. */
export interface DesktopSettings extends DesktopPreferences {
  localTtsReady?: boolean;
  qwenTtsReady?: boolean;
  qwenCudaReady?: boolean;
  hasApiKey: boolean;
  hasDoubaoApiKey?: boolean;
  encryptionAvailable: boolean;
  auth: {
    status: 'signed_out' | 'signed_in' | 'expired';
    email?: string;
    message?: string;
    accounts: Array<{ id: string; label: string; email?: string; status: 'signed_in' | 'expired' | 'signed_out' }>;
    activeAccountId?: string;
  };
  models: Array<{ id: string; name: string }>;
  restartRequired: boolean;
}

export interface DesktopTeacherBridge {
  getSettings(): Promise<DesktopSettings>;
  saveSettings(input: DesktopPreferences & { apiKey?: string; clearApiKey?: boolean; doubaoApiKey?: string; clearDoubaoApiKey?: boolean }): Promise<DesktopSettings>;
  login(accountId?: string): Promise<DesktopSettings>;
  selectAccount(accountId: string): Promise<DesktopSettings>;
  cancelLogin(): Promise<void>;
  logout(): Promise<DesktopSettings>;
  restart(): Promise<void>;
  openAccountPage(page: 'api-keys' | 'billing' | 'chatgpt' | 'doubao-guide' | 'doubao-console'): Promise<void>;
  createShortcut(): Promise<{ path: string }>;
}

declare global {
  interface Window {
    desktopTeacher?: DesktopTeacherBridge;
  }
}
