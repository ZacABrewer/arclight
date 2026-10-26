import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@media-tron/shared';

// One in-process bus. Modules publish here; the WebSocket route fans out to clients.
// Keeping it typed on ServerEvent means the web client's union is always the full truth.
export class EventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
