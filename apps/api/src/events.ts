import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@arclight/shared';

// One in-process bus. Modules publish here; the WebSocket route fans out to clients.
// Keeping it typed on ServerEvent means the web client's union is always the full truth.
export class EventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    // Every module (and each WebSocket client) subscribes; more than 10 listeners is normal here.
    this.emitter.setMaxListeners(0);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
