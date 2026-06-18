// ============================================================
// RemotePlayerDriver.ts — 远程玩家的IPlayerDriver（通过Socket.IO通信）
// 15秒超时自动pass
// ============================================================

import type { Socket } from 'socket.io';
import type { IPlayerDriver, PlayerState, Card, GameContextSnapshot, ZoneSelection } from '../src/core/types.js';

const TIMEOUT_MS = 15000; // 15秒

export class RemotePlayerDriver implements IPlayerDriver {
  readonly playerId: number;
  private socket: Socket;
  private pendingResolves: Map<string, { resolve: (v: any) => void; timer: NodeJS.Timeout }> = new Map();
  private requestIdCounter = 0;

  constructor(playerId: number, socket: Socket) {
    this.playerId = playerId;
    this.socket = socket;

    // 监听客户端的响应
    socket.on('prompt_response', (data: { requestId: string; result: any }) => {
      const pending = this.pendingResolves.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingResolves.delete(data.requestId);
        pending.resolve(data.result);
      }
    });
  }

  /** 更新 socket（重连时调用） */
  updateSocket(socket: Socket): void {
    this.socket = socket;
    socket.on('prompt_response', (data: { requestId: string; result: any }) => {
      const pending = this.pendingResolves.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingResolves.delete(data.requestId);
        pending.resolve(data.result);
      }
    });
  }

  private async request(type: string, data: any, defaultValue: any): Promise<any> {
    const requestId = String(++this.requestIdCounter);

    return new Promise<any>(resolve => {
      const timer = setTimeout(() => {
        this.pendingResolves.delete(requestId);
        console.log(`[RemoteDriver] Player ${this.playerId} timeout on ${type}, defaulting to`, defaultValue);
        resolve(defaultValue);
      }, TIMEOUT_MS);

      this.pendingResolves.set(requestId, { resolve, timer });

      this.socket.emit('prompt', {
        requestId,
        type,
        data,
        timeoutSec: TIMEOUT_MS / 1000,
      });
    });
  }

  // ---------- IPlayerDriver 实现 ----------

  async promptPlayCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return this.request('playCard', { state: this.sanitizeState(state), ctx: this.sanitizeContext(ctx) }, -1);
  }

  getNextBestCardIndex?(state: PlayerState, ctx: GameContextSnapshot, excludeName: string): number {
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
    // filter 函数无法序列化，特殊处理
    return this.request('selectCard', {
      state: this.sanitizeState(state),
      title,
      ctx: this.sanitizeContext(ctx),
    }, -1);
  }

  // ---------- 状态脱敏（循环引用 + 身份隐藏） ----------
  // Card.cardSource → Player，Player.handCards/equipZone → Card 形成闭环，
  // 必须用 JSON.stringify replacer 移除 cardSource 才能序列化通过 socket.emit 发送。
  // 与 GameHost.sanitizeEventForPlayer 保持一致。
  private sanitizeState(state: PlayerState): any {
    return JSON.parse(JSON.stringify(state, (key, value) => {
      if (key === 'cardSource') return null;
      return value;
    }));
  }

  private sanitizeContext(ctx: GameContextSnapshot): any {
    return JSON.parse(JSON.stringify(ctx, (key, value) => {
      if (key === 'cardSource') return null;
      return value;
    }));
  }
}
