import type { Page } from '@playwright/test';
import { mockSourceSpeech } from './realtimeHarness';

/** Explicit cloud-response/player simulation, never a system voice or real paid request. */
export async function mockCloudSpeech(page: Page) {
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({ json: { ...config, capabilities: { ...config.capabilities, tts: 'supported' }, models: { ...config.models, tts: 'MOCK_DOUBAO_NOT_PAID' }, speech: { engine: 'doubao', ready: true, voice: 'mock-chinese', style: '仅用于测试的云响应', instructionsSupported: true } } });
  });
  await mockSourceSpeech(page);
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = []; let finishRequested = false;
    const state = { texts: [] as string[], speaks: [] as string[], rates: [] as number[], active: 0, maximum: 0, pauses: 0, cancels: 0,
      finish() { const audio = elements.find(item => !item.paused); if (audio) { audio.pause(); audio.dispatchEvent(new Event('ended')); } else finishRequested = true; } };
    for (const name of ['__speech', '__trialSpeech', '__testSpeech']) Object.defineProperty(window, name, { value: state });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      private isPaused = true; private started = false; private speed = 1;
      constructor(src?: string) { super(src); elements.push(this); }
      get paused() { return this.isPaused; }
      get playbackRate() { return this.speed; }
      set playbackRate(value: number) { this.speed = value; state.rates.push(value); }
      async play() {
        if (!this.started) { this.started = true; const text = document.querySelector('[data-testid="reading-subtitle"]')?.textContent ?? ''; state.texts.push(text); state.speaks.push(text); }
        this.isPaused = false; state.active = elements.filter(item => !item.paused).length; state.maximum = Math.max(state.maximum, state.active);
        queueMicrotask(() => { if (!this.isPaused) { this.dispatchEvent(new Event('playing')); if (finishRequested) { finishRequested = false; state.finish(); } } });
      }
      pause() { this.isPaused = true; state.pauses++; state.active = elements.filter(item => !item.paused).length; }
    };
    Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], speak() { throw Error('Retired system speech must never be called'); }, cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} } });
  });
}
