import type { ScreenCapture, ScreenRecognition } from './screenReading';

export interface ReaderPreferences {
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
  encryptionAvailable: boolean;
  migrated: boolean;
  shortcutAvailable: boolean;
}
export interface SaveReaderSettings {
  preferences: ReaderPreferences;
  apiKey?: string;
  clearApiKey?: boolean;
}
export interface SpeechRequest { generationId: string; chunkId: number; text: string }
export interface SpeechResult { generationId: string; chunkId: number; audio: Uint8Array }
export type ReaderPanel = 'settings' | 'text' | null;
export interface ReaderBridge {
  getSettings(): Promise<ReaderSettings>;
  saveSettings(value: SaveReaderSettings): Promise<ReaderSettings>;
  capture(): Promise<ScreenCapture | null>;
  recognize(id: string): Promise<ScreenRecognition>;
  beginSpeech(generationId: string): Promise<void>;
  speak(request: SpeechRequest): Promise<SpeechResult>;
  cancel(): Promise<void>;
  setPanel(panel: ReaderPanel): Promise<void>;
  minimize(): Promise<void>;
  quit(): Promise<void>;
  openHelp(): Promise<void>;
  onCaptureRequested(callback: () => void): () => void;
}
declare global { interface Window { reader?: ReaderBridge } }
