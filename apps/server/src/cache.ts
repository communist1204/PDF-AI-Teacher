import { createHash } from 'node:crypto';

export class AudioCache {
  private entries = new Map<string, { owner: string; audio: Buffer }>();
  private bytes = 0;
  constructor(readonly maxBytes: number) {}
  key(owner: string, values: unknown[]) { return `${owner}:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`; }
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.audio;
  }
  set(owner: string, key: string, audio: Buffer) {
    if (audio.byteLength > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.audio.byteLength;
    this.entries.delete(key);
    while (this.bytes + audio.byteLength > this.maxBytes || this.entries.size >= 256) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.bytes -= oldest[1].audio.byteLength;
      this.entries.delete(oldest[0]);
    }
    this.entries.set(key, { owner, audio });
    this.bytes += audio.byteLength;
  }
  clear(owner: string) {
    for (const [key, entry] of this.entries) if (entry.owner === owner) { this.bytes -= entry.audio.byteLength; this.entries.delete(key); }
  }
  stats(owner: string) {
    const own = [...this.entries.values()].filter(entry => entry.owner === owner);
    return { entries: own.length, bytes: own.reduce((sum, item) => sum + item.audio.byteLength, 0), maxBytes: this.maxBytes };
  }
}
