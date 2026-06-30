// ============================================================
// DeckManager.ts — 牌堆管理器
// ============================================================

import { Card, PlayerState, CardData, EquipmentType } from './types';
import { createCard, cloneCard } from './Card';
import { EventBus } from './EventBus';
import { GameEvent } from './types';

export class DeckManager {
  public drawPile: Card[] = [];
  public discardPile: Card[] = [];
  private cardTemplates: Card[] = [];
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /** 从 CardData 初始化牌堆 */
  init(cardDataList: CardData[]): void {
    this.cardTemplates = cardDataList.map(d => createCard(d));
    this.resetAndShuffle();
  }

  /** 重置并洗牌 */
  resetAndShuffle(): void {
    this.drawPile = this.cardTemplates.map(c => cloneCard(c));
    this.discardPile = [];
    this.shuffle();
  }

  /** Fisher-Yates 洗牌 */
  shuffle(): void {
    const pile = this.drawPile;
    for (let i = pile.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pile[i], pile[j]] = [pile[j], pile[i]];
    }
  }

  /** 从摸牌堆顶发一张牌 */
  dealOneCard(): Card | null {
    if (this.drawPile.length === 0) {
      if (this.discardPile.length === 0) return null;
      // 回收弃牌堆时过滤虚拟牌，强制清除残留标记
      this.drawPile = this.discardPile
        .filter(c => !c.isVirtual)
        .map(c => ({ ...c, cardSource: null, isVirtual: false }));
      this.discardPile = [];
      this.shuffle();
      this.eventBus.emit(GameEvent.Log, { message: '摸牌堆空，已回收弃牌堆并重新洗牌。' });
    }
    return this.drawPile.shift()!;
  }

  /** 查看牌堆顶第一张牌（不移除） */
  peekTopCard(): Card | null {
    if (this.drawPile.length === 0) {
      if (this.discardPile.length === 0) return null;
      this.drawPile = this.discardPile.map(c => ({ ...c, cardSource: null, isVirtual: false }));
      this.discardPile = [];
      this.shuffle();
      this.eventBus.emit(GameEvent.Log, { message: '摸牌堆空，已回收弃牌堆并重新洗牌。' });
    }
    return this.drawPile[0] || null;
  }

  /** 摸多张牌 */
  drawCards(player: PlayerState, count: number): void {
    const drawn: Card[] = [];
    for (let i = 0; i < count; i++) {
      const card = this.dealOneCard();
      if (card) {
        player.handCards.push(card);
        drawn.push(card);
      }
    }
    if (drawn.length > 0) {
      this.eventBus.emit(GameEvent.CardDrawn, {
        playerId: player.id,
        count: drawn.length,
        cards: drawn
      });
    }
  }

  /** 亮出牌堆顶 count 张牌（五谷丰登用） */
  dealToTable(count: number): Card[] {
    const cards: Card[] = [];
    for (let i = 0; i < count; i++) {
      const card = this.dealOneCard();
      if (card) cards.push(card);
    }
    return cards;
  }

  /** 卡牌进入弃牌堆（全场唯一入口，拒绝虚拟牌） */
  sendToDiscard(card: Card): void {
    if (!card || card.isVirtual) return;
    const sourcePlayerId = (card.cardSource as any)?.id ?? undefined;
    card.cardSource = null;
    this.discardPile.push(card);
    this.eventBus.emit(GameEvent.CardDiscarded, {
      card: { ...card },
      playerId: sourcePlayerId,
      discardPileCount: this.discardPile.length
    });
  }

  /** 将牌放回摸牌堆顶（拒绝虚拟牌） */
  returnToDrawPile(cards: Card[]): void {
    for (const c of cards) {
      if (c.isVirtual) continue;
      c.cardSource = null;
      this.drawPile.unshift(c);
    }
  }

  /** 从弃牌堆中回收指定id的牌（甘雨-月海等用），未找到的牌返回null占位 */
  retrieveFromDiscardPile(cardIds: number[]): Card[] {
    const result: Card[] = [];
    for (const id of cardIds) {
      const idx = this.discardPile.findIndex(c => c.id === id);
      if (idx >= 0) {
        const [card] = this.discardPile.splice(idx, 1);
        result.push(card);
      }
    }
    return result;
  }

  /** 获取摸牌堆剩余数量 */
  get drawPileCount(): number {
    return this.drawPile.length;
  }
}
