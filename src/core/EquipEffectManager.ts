// ============================================================
// EquipEffectManager.ts — 装备效果处理器
// ============================================================

import {
  PlayerState, Card, EquipmentType, SuitType, ColorType, GenderType,
  ElementType, IPlayerDriver, GameContextSnapshot
} from './types';
import { GameEvent } from './types';
import { isSlash, getCardDetail, createVirtualCard, getCardColor } from './Card';
import { DeckManager } from './DeckManager';
import { EventBus } from './EventBus';
import { DamageSystem } from './DamageSystem';

export class EquipEffectManager {
  private deck: DeckManager;
  private eventBus: EventBus;
  private damageSystem: DamageSystem;
  private drivers: Map<number, IPlayerDriver>;
  private allPlayers: PlayerState[];

  constructor(
    deck: DeckManager,
    eventBus: EventBus,
    damageSystem: DamageSystem,
    drivers: Map<number, IPlayerDriver>,
    allPlayers: PlayerState[]
  ) {
    this.deck = deck;
    this.eventBus = eventBus;
    this.damageSystem = damageSystem;
    this.drivers = drivers;
    this.allPlayers = allPlayers;
  }

  // ======================== 装备挂载 ========================

  handleEquipPlay(card: Card, source: PlayerState): boolean {
    const slot = card.equipType;
    if (slot === EquipmentType.None) return false;

    this.eventBus.emit(GameEvent.Log, {
      message: `${source.name} 装备了 ${getCardDetail(card)}`
    });

    // 顶替旧装备
    if (source.equipZone[slot]) {
      const oldEquip = source.equipZone[slot]!;
      this.deck.sendToDiscard(oldEquip);
      // 防具离场效果
      if (slot === EquipmentType.Armor) {
        this.handleArmorOnLose(source, oldEquip);
      }
    }

    source.equipZone[slot] = card;

    this.eventBus.emit(GameEvent.CardEquipped, {
      playerId: source.id,
      card,
      slot
    });

    return true;
  }

  // ======================== 防具：响应前 ========================

  async handleArmorOnResponse(
    target: PlayerState,
    requiredCardName: string,
    sourceCard: Card | null,
    source: PlayerState | null
  ): Promise<boolean> {
    const armor = target.equipZone[EquipmentType.Armor];
    if (!armor) return false;

    // 八卦阵：被索要闪时可判定（玩家主动选择发动）
    if (armor.name === '八卦阵' && requiredCardName === '闪') {
      const driver = this.drivers.get(target.id);
      if (driver) {
        const shouldActivate = await (driver as any).promptYesNo?.('是否发动【八卦阵】？');
        if (!shouldActivate) return false;
      }
      const judgeCard = this.deck.dealOneCard();
      if (!judgeCard) return false;

      const triggered = judgeCard.suit === SuitType.Heart || judgeCard.suit === SuitType.Diamond;

      this.eventBus.emit(GameEvent.Log, {
        message: `${target.name} 的【八卦阵】判定：${getCardDetail(judgeCard)}`
      });

      // 发出判定动画事件（翻牌展示）
      this.eventBus.emit(GameEvent.JudgeResult, {
        playerId: target.id,
        kitName: '八卦阵',
        cardName: judgeCard.name,
        suit: judgeCard.suit,
        number: judgeCard.number,
        triggered,
        judgeIndex: 0,
        totalJudge: 1,
      });

      this.deck.sendToDiscard(judgeCard);

      if (triggered) {
        this.eventBus.emit(GameEvent.ArmorEffect, { name: '八卦阵', playerId: target.id });
        return true;
      }
    }

    // 仁王盾：黑色杀免疫
    if (armor.name === '仁王盾' && requiredCardName === '闪' && sourceCard && isSlash(sourceCard)) {
      if (getCardColor(sourceCard) === ColorType.Black) {
        this.eventBus.emit(GameEvent.ArmorEffect, { name: '仁王盾', playerId: target.id });
        this.eventBus.emit(GameEvent.Log, {
          message: `${target.name} 的【仁王盾】免疫了 ${source?.name ?? '对方'} 的黑色【杀】！`
        });
        return true;
      }
    }

    // 藤甲：免疫普通杀/南蛮/万箭
    if (armor.name === '藤甲' && sourceCard) {
      if (requiredCardName === '闪' && isSlash(sourceCard) && sourceCard.element === ElementType.None) {
        this.eventBus.emit(GameEvent.ArmorEffect, { name: '藤甲', playerId: target.id });
        return true;
      }
      if (requiredCardName === '杀' && sourceCard.name === '南蛮入侵') {
        this.eventBus.emit(GameEvent.ArmorEffect, { name: '藤甲', playerId: target.id });
        return true;
      }
      if (requiredCardName === '闪' && sourceCard.name === '万箭齐发') {
        this.eventBus.emit(GameEvent.ArmorEffect, { name: '藤甲', playerId: target.id });
        return true;
      }
    }

    return false;
  }

  // ======================== 防具：伤害前修正 ========================

  handleArmorBeforeDamage(
    target: PlayerState,
    damageRef: { value: number },
    sourceCard: Card | null
  ): void {
    const armor = target.equipZone[EquipmentType.Armor];
    if (!armor) return;

    // 藤甲：火伤+1 且烧毁
    if (armor.name === '藤甲' && sourceCard?.element === ElementType.Pyro) {
      this.eventBus.emit(GameEvent.Log, { message: '【藤甲】引火烧身！火属性伤害 +1，藤甲被烧毁。' });
      damageRef.value += 1;
      this.deck.sendToDiscard(armor);
      target.equipZone[EquipmentType.Armor] = null;
    }

    // 白银狮子：伤害>1 时限制为1
    if (armor.name === '白银狮子' && damageRef.value > 1) {
      this.eventBus.emit(GameEvent.Log, { message: `【白银狮子】将 ${damageRef.value} 点伤害限制为 1 点！` });
      damageRef.value = 1;
    }

    // 炼金防具（阿贝多）：伤害-1
    if ((armor as any)._albedoAlchemy && damageRef.value > 0) {
      damageRef.value = Math.max(0, damageRef.value - 1);
      this.eventBus.emit(GameEvent.Log, { message: `【炼金防具】减免1点伤害！剩余 ${damageRef.value} 点。` });
      if (damageRef.value <= 0) {
        this.deck.sendToDiscard(armor);
        target.equipZone[EquipmentType.Armor] = null;
        this.eventBus.emit(GameEvent.Log, { message: '【炼金防具】被击碎！' });
      }
    }
  }

  // ======================== 防具：离场 ========================

  handleArmorOnLose(target: PlayerState, oldArmor: Card): void {
    if (oldArmor.name === '白银狮子') {
      target.hp = Math.min(target.maxHp, target.hp + 1);
      this.eventBus.emit(GameEvent.Log, {
        message: `${target.name} 的【白银狮子】离场，回复 1 点体力。当前 HP: ${target.hp}/${target.maxHp}`
      });
    }
  }

  // ======================== 武器：诸葛连弩 ========================

  canSlashUnrestricted(source: PlayerState): boolean {
    const weapon = source.equipZone[EquipmentType.Weapon];
    return weapon?.name === '诸葛连弩';
  }

  // ======================== 武器：朱雀羽扇 ========================

  async modifySlashElementBeforeProcess(source: PlayerState, slashCard: Card): Promise<void> {
    const weapon = source.equipZone[EquipmentType.Weapon];
    if (weapon?.name === '朱雀羽扇' && slashCard.element === ElementType.None) {
      const driver = this.drivers.get(source.id);
      if (driver) {
        const convert = await (driver as any).promptYesNo?.('是否发动【朱雀羽扇】将普通【杀】转为【火杀】？');
        if (convert) {
          this.eventBus.emit(GameEvent.WeaponEffect, { name: '朱雀羽扇', playerId: source.id });
          slashCard.element = ElementType.Pyro;
        }
      }
    }
  }

  // ======================== 武器：青釭剑 ========================

  shouldIgnoreArmor(source: PlayerState): boolean {
    const weapon = source.equipZone[EquipmentType.Weapon];
    return weapon?.name === '青缸剑';
  }

  // ======================== 武器：雌雄双股剑 ========================

  async handleWeaponBeforeDodge(source: PlayerState, target: PlayerState): Promise<void> {
    const weapon = source.equipZone[EquipmentType.Weapon];
    if (!weapon || weapon.name !== '雌雄双股剑') return;
    // 异性才触发效果
    if (source.gender === target.gender || source.gender === GenderType.None || target.gender === GenderType.None) return;

    this.eventBus.emit(GameEvent.WeaponEffect, { name: '雌雄双股剑', playerId: source.id });

    const driver = this.drivers.get(target.id)!;
    const choice = await driver.promptGenderWeapon(target, source.name, this.buildContext(target.id));
    if (choice === 'discard') {
      // 目标弃置一张手牌
      if (target.handCards.length > 0) {
        const discardIdx = await driver.promptDiscard(target, this.buildContext(target.id));
        if (discardIdx >= 0 && discardIdx < target.handCards.length) {
          const card = target.handCards.splice(discardIdx, 1)[0];
          this.deck.sendToDiscard(card);
          this.eventBus.emit(GameEvent.CardDiscarded, { playerId: target.id, cardName: card.name, suit: card.suit, number: card.number });
        }
      }
    } else {
      // 攻击者摸一张牌
      this.deck.drawCards(source, 1);
    }
  }

  // 贯石斧单回合只能发动一次
  private guanShiAxeUsedThisSlash: Map<number, boolean> = new Map();

  // ======================== 武器：贯石斧 & 青龙偃月刀 ========================

  async handleWeaponOnDodgeSuccess(
    source: PlayerState,
    target: PlayerState,
    slashCard: Card
  ): Promise<boolean> {
    const weapon = source.equipZone[EquipmentType.Weapon];
    if (!weapon) return false;

    // 贯石斧：每张杀被闪避后最多发动一次
    if (weapon.name === '贯石斧' && !this.guanShiAxeUsedThisSlash.get(source.id)) {
      const totalAvailable = source.handCards.length +
        Object.values(source.equipZone).filter(v => v && v !== weapon).length;
      if (totalAvailable >= 2) {
        const driver = this.drivers.get(source.id)!;
        const useIt = await driver.promptWeaponEffect(source, '贯石斧', this.buildContext(source.id));
        if (useIt) {
          // 标记已发动，防止死循环
          this.guanShiAxeUsedThisSlash.set(source.id, true);
          this.eventBus.emit(GameEvent.WeaponEffect, { name: '贯石斧', playerId: source.id });
          // 实际弃置2张牌
          await this.discardTwoForWeapon(source, weapon);
          return true; // 强行命中
        }
      }
    }

    // 青龙偃月刀
    if (weapon.name === '青龙偃月刀') {
      const slashesInHand = source.handCards.filter(c => isSlash(c));
      if (slashesInHand.length > 0) {
        const driver = this.drivers.get(source.id)!;
        const useIt = await driver.promptWeaponEffect(source, '青龙偃月刀', this.buildContext(source.id));
        if (useIt) {
          // 让玩家选择一张杀来追击（AI自动选第一张）
          const ctx = this.buildContext(source.id);
          const slashIdx = (driver as any).promptSelectCard
            ? await (driver as any).promptSelectCard(source,
                '青龙偃月刀-选择一张【杀】追加追击',
                (c: Card) => isSlash(c),
                ctx)
            : 0;
          if (slashIdx < 0) return false;
          // promptSelectCard 返回的是 handCards 索引，需要取对应牌
          const nextSlash = source.handCards[slashIdx];
          if (!nextSlash || !isSlash(nextSlash)) return false;
          const handIdx = source.handCards.indexOf(nextSlash);
          source.handCards.splice(handIdx, 1);
          this.deck.sendToDiscard(nextSlash);
          this.eventBus.emit(GameEvent.WeaponEffect, { name: '青龙偃月刀', playerId: source.id });
          this.eventBus.emit(GameEvent.Log, {
            message: `${source.name} 发动【青龙偃月刀】，追加【杀】追击 ${target.name}！`
          });
          // 目标再次响应闪
          const targetDriver = this.drivers.get(target.id)!;
          const dodgeCard = await this.damageSystem.askForResponse(target, '闪', nextSlash, source, targetDriver);
          if (dodgeCard) {
            // 又被闪了，递归检查青龙刀是否继续追击
            this.eventBus.emit(GameEvent.Log, {
              message: `${target.name} 再次打出【闪】闪避！`
            });
            return await this.handleWeaponOnDodgeSuccess(source, target, nextSlash);
          } else {
            // 追击命中
            this.eventBus.emit(GameEvent.Log, {
              message: `${target.name} 已无力闪避，青龙偃月刀追击命中！`
            });
            return true; // 强行命中
          }
        }
      }
    }

    return false;
  }

  /** 为贯石斧弃置2张牌：让玩家主动选择 */
  private async discardTwoForWeapon(source: PlayerState, weapon: Card): Promise<void> {
    const driver = this.drivers.get(source.id)!;
    const handLen = source.handCards.length;
    const equipCards = Object.entries(source.equipZone)
      .filter(([, v]) => v !== null && v !== weapon) as [string, Card][];
    const totalAvailable = handLen + equipCards.length;

    if (totalAvailable < 2) {
      // 不够2张，全弃
      let discarded = 0;
      while (source.handCards.length > 0 && discarded < 2) {
        const card = source.handCards.pop()!;
        this.deck.sendToDiscard(card);
        discarded++;
      }
      for (const [slot, card] of equipCards) {
        if (discarded >= 2) break;
        source.equipZone[slot as any as EquipmentType] = null;
        this.deck.sendToDiscard(card);
        discarded++;
      }
    } else {
      // 让玩家选择2张牌弃置
      const indices = await (driver as any).promptDiscardMulti?.(source, 2,
        this.buildContext(source.id)) ?? [];

      let discarded = 0;
      for (const idx of indices) {
        if (idx < handLen) {
          // 手牌区索引
          const cardIdx = idx;
          if (cardIdx >= 0 && cardIdx < source.handCards.length) {
            const card = source.handCards.splice(cardIdx, 1)[0];
            this.deck.sendToDiscard(card);
            discarded++;
          }
        } else {
          // 装备区索引 = idx - handLen
          const equipIdx = idx - handLen;
          if (equipIdx >= 0 && equipIdx < equipCards.length) {
            const [slot, card] = equipCards[equipIdx];
            source.equipZone[slot as any as EquipmentType] = null;
            this.deck.sendToDiscard(card);
            discarded++;
          }
        }
      }

      // 如果玩家取消或选了不足2张，补足
      if (discarded < 2) {
        while (discarded < 2 && source.handCards.length > 0) {
          const card = source.handCards.pop()!;
          this.deck.sendToDiscard(card);
          discarded++;
        }
        const remainEquip = Object.entries(source.equipZone)
          .filter(([, v]) => v !== null && v !== weapon) as [string, Card][];
        for (const [slot, card] of remainEquip) {
          if (discarded >= 2) break;
          source.equipZone[slot as any as EquipmentType] = null;
          this.deck.sendToDiscard(card);
          discarded++;
        }
      }
    }

    this.eventBus.emit(GameEvent.Log, {
      message: `${source.name} 为发动【贯石斧】弃置了2张牌。`
    });
  }

  /** 重置贯石斧状态（新杀开始时调用） */
  resetGuanShiAxeForNewSlash(sourceId: number): void {
    this.guanShiAxeUsedThisSlash.delete(sourceId);
  }

  // ======================== 武器：古锭刀 & 寒冰剑 ========================

  async handleWeaponOnHitBeforeDamage(
    source: PlayerState,
    target: PlayerState,
    damageRef: { value: number }
  ): Promise<boolean> {
    const weapon = source.equipZone[EquipmentType.Weapon];
    if (!weapon) return false;

    // 古锭刀
    if (weapon.name === '古锭刀' && target.handCards.length === 0) {
      this.eventBus.emit(GameEvent.WeaponEffect, { name: '古锭刀', playerId: source.id });
      damageRef.value += 1;
    }

    // 寒冰剑
    if (weapon.name === '寒冰剑') {
      const targetTotal = target.handCards.length +
        Object.values(target.equipZone).filter(v => v !== null).length +
        target.judgeZone.length;
      if (targetTotal > 0) {
        const driver = this.drivers.get(source.id)!;
        const useIt = await driver.promptWeaponEffect(source, '寒冰剑', this.buildContext(source.id));
        if (useIt) {
          this.eventBus.emit(GameEvent.WeaponEffect, { name: '寒冰剑', playerId: source.id });
          return true; // 拦截伤害，改为弃牌
        }
      }
    }

    return false;
  }

  // ======================== 武器：麒麟弓 ========================

  handleWeaponAfterDamageEffect(source: PlayerState, target: PlayerState): void {
    const weapon = source.equipZone[EquipmentType.Weapon];
    if (weapon?.name !== '麒麟弓') return;

    // 检查是否有坐骑可射
    const horseSlots: EquipmentType[] = [];
    if (target.equipZone[EquipmentType.DefensiveHorse]) horseSlots.push(EquipmentType.DefensiveHorse);
    if (target.equipZone[EquipmentType.OffensiveHorse]) horseSlots.push(EquipmentType.OffensiveHorse);

    if (horseSlots.length > 0) {
      this.eventBus.emit(GameEvent.WeaponEffect, { name: '麒麟弓', playerId: source.id });
      // AI 简化：射下第一个坐骑
      const slot = horseSlots[0];
      const horse = target.equipZone[slot]!;
      this.deck.sendToDiscard(horse);
      target.equipZone[slot] = null;
      this.eventBus.emit(GameEvent.Log, {
        message: `${source.name} 的【麒麟弓】射下了 ${target.name} 的坐骑！`
      });
    }
  }

  // ======================== 丈八蛇矛 ========================

  tryZhanBaTransform(source: PlayerState): Card | null {
    const weapon = source.equipZone[EquipmentType.Weapon];
    if (!weapon || weapon.name !== '丈八蛇矛' || source.handCards.length < 2) return null;

    const driver = this.drivers.get(source.id)!;
    // 简化：选前两张手牌合成
    const card1 = source.handCards[0];
    const card2 = source.handCards[1];

    let finalSuit: SuitType = SuitType.None;
    const color1 = getCardColor(card1);
    const color2 = getCardColor(card2);
    if (color1 === color2 && color1 !== ColorType.None) {
      finalSuit = color1 === ColorType.Black ? SuitType.Spade : SuitType.Heart;
    }

    source.handCards.splice(0, 2);
    this.deck.sendToDiscard(card1);
    this.deck.sendToDiscard(card2);

    const virtualSlash = createVirtualCard('杀', 'Basic' as any, finalSuit);
    this.eventBus.emit(GameEvent.Log, {
      message: `${source.name} 将两张牌合成为虚拟【杀】！`
    });

    return virtualSlash;
  }

  /** 丈八蛇矛：让玩家选择两张手牌合成，返回虚拟杀+被消耗的实体牌（调用方负责弃置或返还） */
  async tryZhanBaTransformInteractive(source: PlayerState): Promise<{ virtualSlash: Card; physicalCards: Card[] } | null> {
    const weapon = source.equipZone[EquipmentType.Weapon];
    if (!weapon || weapon.name !== '丈八蛇矛' || source.handCards.length < 2) return null;

    const driver = this.drivers.get(source.id)!;
    const indices = await (driver as any).promptZhanBa?.(source, this.buildContext(source.id));
    if (!indices || indices[0] < 0 || indices[0] >= source.handCards.length ||
        indices[1] < 0 || indices[1] >= source.handCards.length ||
        indices[0] === indices[1]) {
      return null; // 用户取消或无效选择
    }

    // 从手牌中取牌（注意：先取高索引再取低索引，防止索引错位）
    const idxA = Math.min(indices[0], indices[1]);
    const idxB = Math.max(indices[0], indices[1]);
    const card2 = source.handCards[idxB];
    const card1 = source.handCards[idxA];
    source.handCards.splice(idxB, 1);
    source.handCards.splice(idxA, 1);

    let finalSuit: SuitType = SuitType.None;
    const color1 = getCardColor(card1);
    const color2 = getCardColor(card2);
    if (color1 === color2 && color1 !== ColorType.None) {
      finalSuit = color1 === ColorType.Black ? SuitType.Spade : SuitType.Heart;
    }

    // 不在此弃牌！由调用方根据 handleActivePlay 结果决定是弃置还是返还
    const virtualSlash = createVirtualCard('杀', 'Basic' as any, finalSuit);
    this.eventBus.emit(GameEvent.Log, {
      message: `${source.name} 将 ${getCardDetail(card1)} 和 ${getCardDetail(card2)} 合成为虚拟【杀】！`
    });

    return { virtualSlash, physicalCards: [card1, card2] };
  }

  // ======================== 辅助方法 ========================

  private buildContext(currentPlayerId: number): GameContextSnapshot {
    return {
      players: this.allPlayers,
      roundCount: 0,
      currentTurn: 0,
      currentPlayerId,
      gameOverWinner: null,
      drawPileCount: this.deck.drawPileCount,
      discardPileCount: this.deck.discardPile.length,
    };
  }
}
