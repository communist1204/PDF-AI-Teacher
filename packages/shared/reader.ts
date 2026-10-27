import type { ChatGPTState } from './chatgpt';
import type { ScreenCapture, ScreenRecognition } from './screenReading';

export interface ReaderPreferences {
  recognitionMode: 'local' | 'smart' | 'chatgpt';
  chatgptModel: string;
  allowVisionCloud: boolean;
  provider: 'doubao' | 'bing';
  allowBingCloud: boolean;
  voice: string;
  instructions: string;
  rate: number;
  alwaysOnTop: boolean;
  allowCloud: boolean;
  skipFormulas: boolean;
}
export interface ReaderSettings {
  preferences: ReaderPreferences;
  hasApiKey: boolean;
  hasVisionKey: boolean;
  encryptionAvailable: boolean;
  migrated: boolean;
  shortcutAvailable: boolean;
}
export interface SaveReaderSettings {
  preferences: ReaderPreferences;
  apiKey?: string;
  clearApiKey?: boolean;
  visionApiKey?: string;
  clearVisionApiKey?: boolean;
}
export interface SpeechRequest { generationId: string; chunkId: number; text: string }
export interface SpeechResult { generationId: string; chunkId: number; audio: Uint8Array; mimeType?: 'audio/wav' | 'audio/mpeg' }
export type ReaderPanel = 'settings' | 'text' | null;
export interface ReaderBridge {
  getSettings(): Promise<ReaderSettings>;
  getChatGPTState(): Promise<ChatGPTState>;
  loginChatGPT(profileId?: string): Promise<ChatGPTState>;
  cancelChatGPTLogin(): Promise<ChatGPTState>;
  selectChatGPTProfile(id: string): Promise<ChatGPTState>;
  logoutChatGPT(): Promise<ChatGPTState>;
  refreshChatGPTModels(): Promise<ChatGPTState>;
  saveSettings(value: SaveReaderSettings): Promise<ReaderSettings>;
  capture(): Promise<ScreenCapture | null>;
  recognize(id: string): Promise<ScreenRecognition>;
  beginSpeech(generationId: string): Promise<void>;
  speak(request: SpeechRequest): Promise<SpeechResult>;
  cancel(): Promise<void>;
  setPanel(panel: ReaderPanel): Promise<void>;
  minimize(): Promise<void>;
  quit(): Promise<void>;
  openHelp(provider?: 'doubao' | 'bing' | 'openai' | 'chatgpt-usage'): Promise<void>;
  onCaptureRequested(callback: () => void): () => void;
}
declare global { interface Window { reader?: ReaderBridge } }

export function speechConfigured(preferences: ReaderPreferences, hasApiKey: boolean): boolean {
  return preferences.provider === 'bing' ? preferences.allowBingCloud : preferences.allowCloud && hasApiKey;
}
