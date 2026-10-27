export interface ChatGPTModel {
  id: string;
  label: string;
  reasoningEffort?: string;
}
export interface ChatGPTState {
  status: 'disconnected' | 'authorizing' | 'connected';
  profiles: { id: string; label: string; connected: boolean; sharing: boolean }[];
  activeProfileId: string | null;
  sharing: boolean;
  models: ChatGPTModel[];
  message: string;
}
