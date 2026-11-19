import { RoleType, type PlayerState } from '../src/core/types.js';

export function serializeForPvpViewer(data: unknown, viewerPlayerId: number): any {
  return JSON.parse(JSON.stringify(data, (key, value) => {
    // Cards can refer back to their owner, whose hand or equipment contains the card.
    if (key === 'cardSource') return null;
    if (!value || typeof value !== 'object'
        || typeof value.id !== 'number' || typeof value.heroId !== 'string'
        || !Array.isArray(value.handCards)) return value;

    const player = value as PlayerState;
    if (player.id === viewerPlayerId || player.isDead || player.role === RoleType.Monarch) return value;
    return { ...value, role: 'Unknown' };
  }));
}
