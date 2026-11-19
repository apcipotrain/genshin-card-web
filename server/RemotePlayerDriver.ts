// ============================================================
// RemotePlayerDriver.ts — 远程玩家的IPlayerDriver（通过Socket.IO通信）
// 服务端控制响应截止时间，结束请求后通知客户端清理交互。
// ============================================================

import type { Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { GameSession } from '../src/core/GameSession.js';
import { CARD_SUITS, type CardSuit, type IPlayerDriver, type PlayerState, type Card, type GameContextSnapshot, type ZoneSelection } from '../src/core/types.js';
import { serializeForPvpViewer } from './PvpVisibility.js';

const TIMEOUT_MS = 10000; // 10秒

export class RemotePlayerDriver implements IPlayerDriver {
  readonly playerId: number;
  private socket: Socket;
  private pendingResolves: Map<string, { resolve: (v: any) => void; defaultValue: any }> = new Map();
  private requestIdCounter = 0;
  private readonly requestPrefix = randomUUID();
  private disposed = false;
  private unregisterSession: () => void;
  private readonly onResponse = (data: { requestId: string; result: any }) => {
    if (!this.disposed && data && typeof data.requestId === 'string') {
      this.pendingResolves.get(data.requestId)?.resolve(data.result);
    }
  };

  constructor(playerId: number, socket: Socket, private session = new GameSession()) {
    this.playerId = playerId;
    this.socket = socket;

    socket.on('prompt_response', this.onResponse);
    this.unregisterSession = session.onDispose(() => this.dispose());
  }

  /** 更新 socket（重连时调用） */
  updateSocket(socket: Socket): void {
    if (this.disposed) return;
    this.socket.off('prompt_response', this.onResponse);
    this.socket = socket;
    socket.on('prompt_response', this.onResponse);
  }

  /** Detach a departing player; remaining players may continue against AI. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.off('prompt_response', this.onResponse);
    this.unregisterSession?.();
    for (const pending of [...this.pendingResolves.values()]) pending.resolve(pending.defaultValue);
    this.pendingResolves.clear();
  }

  private async request(type: string, data: any, defaultValue: any): Promise<any> {
    this.session.assertActive();
    if (this.disposed) return defaultValue;
    const requestId = `${this.requestPrefix}:${++this.requestIdCounter}`;

    return this.session.wait<any>(resolve => {
      const timer = setTimeout(() => {
        this.pendingResolves.delete(requestId);
        console.log(`[RemoteDriver] Player ${this.playerId} timeout on ${type}, defaulting to`, defaultValue);
        resolve(defaultValue);
      }, TIMEOUT_MS);

      this.pendingResolves.set(requestId, { resolve, defaultValue });

      this.socket.emit('prompt', {
        requestId,
        type,
        data,
        timeoutSec: TIMEOUT_MS / 1000,
      });
      return () => {
        clearTimeout(timer);
        this.pendingResolves.delete(requestId);
        this.socket.emit('prompt_closed', { requestId });
      };
    });
  }

  // ---------- IPlayerDriver 实现 ----------

  async promptPlayCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return this.request('playCard', { state: this.sanitizeState(state), ctx: this.sanitizeContext(ctx) }, -1);
  }

  getNextBestCardIndex?(state: PlayerState, ctx: GameContextSnapshot, excludeIds: Set<number>): number {
    // Remote 客户端自行决定，服务器不做 fallback
    return -1;
  }

  async promptTarget(state: PlayerState, validTargets: number[], reason: string, ctx: GameContextSnapshot): Promise<number | null> {
    return this.request('target', {
      state: this.sanitizeState(state),
      validTargets,
      reason,
      ctx: this.sanitizeContext(ctx),
    }, null);
  }

  async promptResponse(state: PlayerState, cardName: string, ctx: GameContextSnapshot): Promise<Card | null> {
    return this.request('response', {
      state: this.sanitizeState(state),
      cardName,
      ctx: this.sanitizeContext(ctx),
    }, null);
  }

  async promptZone(state: PlayerState, targetId: number, ctx: GameContextSnapshot): Promise<ZoneSelection | null> {
    return this.request('zone', {
      state: this.sanitizeState(state),
      targetId,
      ctx: this.sanitizeContext(ctx),
    }, null);
  }

  async promptZhanBa(state: PlayerState, ctx: GameContextSnapshot): Promise<[number, number] | null> {
    return this.request('zhanba', {
      state: this.sanitizeState(state),
      ctx: this.sanitizeContext(ctx),
    }, null);
  }

  async promptDiscard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return this.request('discard', {
      state: this.sanitizeState(state),
      ctx: this.sanitizeContext(ctx),
    }, 0);
  }

  async promptNullification(state: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    return this.request('nullify', {
      state: this.sanitizeState(state),
      ctx: this.sanitizeContext(ctx),
    }, false);
  }

  async promptArmorTrigger(state: PlayerState, armorName: string, ctx: GameContextSnapshot): Promise<boolean> {
    return this.request('armorTrigger', {
      state: this.sanitizeState(state),
      armorName,
      ctx: this.sanitizeContext(ctx),
    }, false);
  }

  async promptWeaponEffect(state: PlayerState, weaponName: string, ctx: GameContextSnapshot): Promise<boolean> {
    return this.request('weaponEffect', {
      state: this.sanitizeState(state),
      weaponName,
      ctx: this.sanitizeContext(ctx),
    }, false);
  }

  async promptIronChainMode(state: PlayerState, ctx: GameContextSnapshot): Promise<'recast' | 'chain'> {
    return this.request('ironChainMode', {
      state: this.sanitizeState(state),
      ctx: this.sanitizeContext(ctx),
    }, 'recast');
  }

  async promptAmazingGrace(state: PlayerState, tableCards: Card[], ctx: GameContextSnapshot): Promise<number> {
    return this.request('amazingGrace', {
      tableCards,
      ctx: this.sanitizeContext(ctx),
    }, 0);
  }

  async promptShowCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return this.request('showCard', {
      state: this.sanitizeState(state),
      ctx: this.sanitizeContext(ctx),
    }, 0);
  }

  async promptGenderWeapon(state: PlayerState, attackerName: string, ctx: GameContextSnapshot): Promise<'discard' | 'draw'> {
    return this.request('genderWeapon', {
      state: this.sanitizeState(state),
      attackerName,
      ctx: this.sanitizeContext(ctx),
    }, 'discard');
  }

  async promptYesNo(question: string): Promise<boolean> {
    return this.request('yesNo', { question }, false);
  }

  async promptSuit(cardNumber: number, totalCards: number): Promise<CardSuit | null> {
    const result: unknown = await this.request('chooseSuit', { cardNumber, totalCards }, null);
    return CARD_SUITS.find(suit => suit === result) ?? null;
  }

  async promptRansackHand?(state: PlayerState, targetId: number, ctx: GameContextSnapshot): Promise<number> {
    return this.request('ransackHand', {
      state: this.sanitizeState(state),
      targetId,
      ctx: this.sanitizeContext(ctx),
    }, -1);
  }

  async promptDiscardMulti?(state: PlayerState, count: number, ctx: GameContextSnapshot): Promise<number[]> {
    return this.request('discardMulti', {
      state: this.sanitizeState(state),
      count,
      ctx: this.sanitizeContext(ctx),
    }, []);
  }

  async promptSelectCard?(state: PlayerState, title: string, filter: (card: Card) => boolean, ctx: GameContextSnapshot): Promise<number> {
    // filter 函数无法序列化，特殊处理：客户端显示所有手牌，服务端校验
    return this.request('selectCard', {
      state: this.sanitizeState(state),
      title,
      filterHint: 'all', // 提示客户端显示所有手牌（filter无法序列化）
      ctx: this.sanitizeContext(ctx),
    }, -1).then((result: number) => {
      // 服务端校验：确保返回的牌符合filter
      if (result >= 0 && result < state.handCards.length) {
        const card = state.handCards[result];
        if (!filter(card)) {
          console.warn(`[RemotePlayerDriver] 客户端选择的牌不符合filter: ${card.name}, 返回-1`);
          return -1;
        }
      }
      return result;
    });
  }

  private sanitizeState(state: PlayerState): any {
    return serializeForPvpViewer(state, this.playerId);
  }

  private sanitizeContext(ctx: GameContextSnapshot): any {
    return serializeForPvpViewer(ctx, this.playerId);
  }
}
