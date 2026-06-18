// ============================================================
// EventBus.ts — 事件总线
// ============================================================

import { GameEvent, GameEventData, EventListener } from './types';

export class EventBus {
  private listeners: Map<GameEvent, EventListener[]> = new Map();

  on(event: GameEvent, listener: EventListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }

  off(event: GameEvent, listener: EventListener): void {
    const arr = this.listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  emit(event: GameEvent, data: Record<string, unknown> = {}): void {
    const eventData: GameEventData = { type: event, data };
    const arr = this.listeners.get(event);
    if (arr) {
      for (const listener of arr) {
        listener(eventData);
      }
    }
  }

  /** 清除所有监听器 */
  clear(): void {
    this.listeners.clear();
  }
}
