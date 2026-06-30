// ============================================================
// DelayedAIDriver.ts — 带延迟的 AI Driver 包装器（PVE/PVP 共享）
// ============================================================

import type { PlayerState, Card, GameContextSnapshot, ZoneSelection } from '../core/types.js';
import { AIDriver } from './AIDriver.js';

/**
 * 为 AI Driver 的每个决策方法添加固定延迟。
 * PVE 模式：使用客户端的 globalAiDelayMs（可配 1.2s/1.6s 等）
 * PVP 模式：使用服务端固定延迟（默认 1200ms，匹配 1.2 秒中速设定）
 */
export class DelayedAIDriver {
  readonly playerId: number;
  private ai: AIDriver;
  /** getter 函数：每次调用 delay() 时动态读取当前延迟值，PVE 模式下跟随 globalAiDelayMs 变化 */
  private getDelayMs: () => number;

  /**
   * @param playerId 玩家ID
   * @param getDelayMs 返回延迟毫秒数的函数
   *   - PVE: () => globalAiDelayMs（跟随UI设置动态变化）
   *   - PVP: () => 1200（固定值）
   */
  constructor(playerId: number, getDelayMs: () => number) {
    this.playerId = playerId;
    this.getDelayMs = getDelayMs;
    this.ai = new AIDriver(playerId);
  }

  private delay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, this.getDelayMs()));
  }

  async promptPlayCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    await this.delay();
    return this.ai.promptPlayCard(state, ctx);
  }
  async promptTarget(state: PlayerState, validTargets: number[], reason: string, ctx: GameContextSnapshot): Promise<number | null> {
    await this.delay();
    return this.ai.promptTarget(state, validTargets, reason, ctx);
  }
  async promptResponse(state: PlayerState, cardName: string, ctx: GameContextSnapshot): Promise<Card | null> {
    await this.delay();
    return this.ai.promptResponse(state, cardName, ctx);
  }
  async promptZone(state: PlayerState, targetId: number, ctx: GameContextSnapshot): Promise<ZoneSelection | null> {
    await this.delay();
    return this.ai.promptZone(state, targetId, ctx);
  }
  async promptZhanBa(state: PlayerState, ctx: GameContextSnapshot): Promise<[number, number] | null> {
    await this.delay();
    return this.ai.promptZhanBa(state, ctx);
  }
  async promptDiscard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    await this.delay();
    return this.ai.promptDiscard(state, ctx);
  }
  async promptNullification(state: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    await this.delay();
    return this.ai.promptNullification(state, ctx);
  }
  async promptArmorTrigger(state: PlayerState, armorName: string, ctx: GameContextSnapshot): Promise<boolean> {
    await this.delay();
    return this.ai.promptArmorTrigger(state, armorName, ctx);
  }
  async promptWeaponEffect(state: PlayerState, weaponName: string, ctx: GameContextSnapshot): Promise<boolean> {
    await this.delay();
    return this.ai.promptWeaponEffect(state, weaponName, ctx);
  }
  // 兼容两种调用约定
  async promptSelectCard(state: PlayerState, arg2: string | Card[], arg3?: any, arg4?: any): Promise<number> {
    await this.delay();
    if (Array.isArray(arg2)) {
      return (this.ai as any).promptSelectCard(state, arg2 as Card[], arg3 as GameContextSnapshot);
    } else {
      return (this.ai as any).promptSelectCard(state, arg2 as string, arg3, arg4 as GameContextSnapshot);
    }
  }
  async promptIronChainMode(state: PlayerState, ctx: GameContextSnapshot): Promise<'recast' | 'chain'> {
    await this.delay();
    return this.ai.promptIronChainMode(state, ctx);
  }
  async promptAmazingGrace(state: PlayerState, tableCards: Card[], ctx: GameContextSnapshot): Promise<number> {
    await this.delay();
    return this.ai.promptAmazingGrace(state, tableCards, ctx);
  }
  async promptShowCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    await this.delay();
    return this.ai.promptShowCard(state, ctx);
  }
  async promptGenderWeapon(state: PlayerState, attackerName: string, ctx: GameContextSnapshot): Promise<'discard' | 'draw'> {
    await this.delay();
    return this.ai.promptGenderWeapon(state, attackerName, ctx);
  }
  async promptYesNo(question: string): Promise<boolean> {
    await this.delay();
    return this.ai.promptYesNo(question);
  }
  promptActiveSkill(state: PlayerState, availableSkills: { id: string; name: string; description: string }[], ctx: GameContextSnapshot): string | null {
    // 同步调用，不需要delay（与其他AI方法不同，这是内部决策逻辑）
    return this.ai.promptActiveSkill(state, availableSkills, ctx);
  }
  getNextBestCardIndex(state: PlayerState, ctx: GameContextSnapshot, excludeIds: Set<number>): number {
    return this.ai.getNextBestCardIndex(state, ctx, excludeIds);
  }
  isEnemy(me: PlayerState, other: PlayerState): boolean {
    return this.ai.isEnemy(me, other);
  }
  async promptRansackHand(state: PlayerState, targetId: number, ctx: GameContextSnapshot): Promise<number> {
    await this.delay();
    return (this.ai as any).promptRansackHand?.(state, targetId, ctx) ?? -1;
  }
  async promptDiscardMulti(state: PlayerState, count: number, ctx: GameContextSnapshot): Promise<number[]> {
    await this.delay();
    return (this.ai as any).promptDiscardMulti?.(state, count, ctx) ?? [];
  }
}
