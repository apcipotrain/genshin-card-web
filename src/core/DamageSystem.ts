// ============================================================
// DamageSystem.ts — 伤害/濒死/阵亡/奖惩系统
// ============================================================

import {
  PlayerState, Card, RoleType, EquipmentType, IPlayerDriver, GameContextSnapshot
} from './types';
import { GameEvent } from './types';
import { isSlash } from './Card';
import { getRoleChineseName } from './Player';
import { DeckManager } from './DeckManager';
import { EventBus } from './EventBus';
import { VoiceManager } from '../audio/VoiceManager';

export class DamageSystem {
  private deck: DeckManager;
  private eventBus: EventBus;
  private drivers: Map<number, IPlayerDriver>;
  private allPlayers: PlayerState[];
  private gameOverCallback: ((winner: string | null) => void) | null = null;

  // 外部依赖注入
  public equipBeforeDamageHandler: ((target: PlayerState, damage: { value: number }, sourceCard: Card | null) => void) | null = null;
  public equipOnResponseHandler: ((target: PlayerState, cardName: string, sourceCard: Card | null, source: PlayerState | null) => Promise<boolean>) | null = null;
  public shouldIgnoreArmorHandler: ((source: PlayerState) => boolean) | null = null;
  public zhanBaHandler: ((player: PlayerState, isActive: boolean) => Card | null) | null = null;
  /** 娜维娅-刺玫：伤害恒为1 */
  public naviaRoseHandler: ((target: PlayerState, damageRef: { value: number }) => void) | null = null;
  /** 铁索连环传导回调：在造成属性伤害后触发 */
  public onTransmitChain: ((target: PlayerState, damage: number, sourceCard: Card | null, source: PlayerState | null) => Promise<void>) | null = null;
  /** 击杀回调：用于经验统计 */
  public onKill: ((killer: PlayerState, victim: PlayerState) => void) | null = null;

  // SkillManager 注入
  public skillManager: {
    onAfterDamaged: (player: PlayerState, damage: number, sourceCard: Card | null, source: PlayerState | null) => Promise<void>;
    onHpChanged: (player: PlayerState, delta: number) => Promise<void>;
    onDying: (player: PlayerState) => Promise<{ intercepted: boolean; data?: any }>;
    onPlayerDeath: (deadPlayer: PlayerState) => void;
    onLeaderProtect: (player: PlayerState, damage: number) => number;
    onHolyFireDamage: (source: PlayerState) => void;
    onKinichAjaw: (source: PlayerState, target: PlayerState) => void;
    getFireDamageBonus: (source: PlayerState) => number;
    onJadeProtect: (player: PlayerState, damage: number) => number;
    onDehyaMercenaryProtect: (target: PlayerState, damage: number) => { protect: boolean; damage: number };
    onDealingDamage: (source: PlayerState, target: PlayerState, damage: number, sourceCard: Card | null) => Promise<{ intercepted: boolean; data?: any }>;
    tryUseMarkerAsWine: (playerId: number) => boolean;
    onHealthLoss: (player: PlayerState, amount: number, sourceName: string) => void;
    isYelanDamageHealthLoss: (source: PlayerState) => boolean;
    getFrostMoonOwner: () => PlayerState | null;
    onFrostMoonRedirect: (target: PlayerState, damage: number, source: PlayerState | null) => { redirected: boolean; newTarget: PlayerState };
    onAfterCardPlay: (player: PlayerState, card?: Card) => Promise<void>;
    checkFrostMark: (target: PlayerState, sourceCard: Card | null) => number;
    isImmuneToFire: (player: PlayerState) => boolean;
  } | null = null;

  constructor(
    deck: DeckManager,
    eventBus: EventBus,
    drivers: Map<number, IPlayerDriver>,
    allPlayers: PlayerState[]
  ) {
    this.deck = deck;
    this.eventBus = eventBus;
    this.drivers = drivers;
    this.allPlayers = allPlayers;
  }

  setGameOverCallback(cb: (winner: string | null) => void): void {
    this.gameOverCallback = cb;
  }

  // ======================== 血量变化 ========================

  async applyHpChange(
    target: PlayerState,
    amount: number,
    sourceCard: Card | null = null,
    source: PlayerState | null = null,
    isChainedTransmission: boolean = false
  ): Promise<void> {
    if (amount < 0) {
      // 夜兰-络命：造成伤害视为体力流失
      if (source && this.skillManager && this.skillManager.isYelanDamageHealthLoss(source)) {
        VoiceManager.getInstance().playSkillVoice('yelan', '络命', source.id);
        await this.applyHealthLoss(target, Math.abs(amount), source.name);
        return;
      }

      let positiveDamage = Math.abs(amount);

      // 宵宫-琉金：免疫火属性伤害
      if (sourceCard && sourceCard.element === 'Pyro' && this.skillManager?.isImmuneToFire(target)) {
        this.eventBus.emit(GameEvent.Log, {
          message: `【琉金】${target.name} 免疫火属性伤害！`
        });
        VoiceManager.getInstance().playSkillVoice('yoimiya', '琉金', target.id);
        return; // 不受到火属性伤害
      }

      // 火属性伤害加成（玛薇卡-战争）
      if (sourceCard && sourceCard.element === 'Pyro' && source && this.skillManager) {
        const fireBonus = this.skillManager.getFireDamageBonus(source);
        if (fireBonus > 0) {
          positiveDamage += fireBonus;
          this.eventBus.emit(GameEvent.Log, {
            message: `【战争】火属性伤害+${fireBonus}！`
          });
        }
      }

      // 冰寒标记：受到火属性伤害+1并移除标记（神里绫华-霜灭/甘雨-霜华/申鹤-鹤归）
      if (sourceCard && sourceCard.element === 'Pyro' && this.skillManager) {
        const frostBonus = this.skillManager.checkFrostMark(target, sourceCard);
        if (frostBonus > 0) {
          positiveDamage += frostBonus;
        }
      }

      // 伤害计算钩子（胡桃-幽蝶, 雷电将军-无想等）
      if (source && this.skillManager) {
        const dealResult = await this.skillManager.onDealingDamage(source, target, positiveDamage, sourceCard);
        if (dealResult.intercepted) return; // 防止伤害（如无想蓄力）
        if (dealResult.data?.damage !== undefined) {
          positiveDamage = dealResult.data.damage;
        }
      }

      // 玉璋标记抵消伤害（钟离）
      if (this.skillManager) {
        positiveDamage = this.skillManager.onJadeProtect(target, positiveDamage);
        if (positiveDamage <= 0) return; // 全部被抵消
      }

      // 领袖减伤（玛薇卡-领袖）
      if (this.skillManager) {
        positiveDamage = this.skillManager.onLeaderProtect(target, positiveDamage);
        if (positiveDamage <= 0) return; // 全部被减免
      }

      // 佣兵承伤（迪希雅-佣兵）
      if (this.skillManager) {
        const mercResult = this.skillManager.onDehyaMercenaryProtect(target, positiveDamage);
        if (mercResult.protect) {
          // 伤害已被转移，不再对原目标造成伤害
          return;
        }
      }

      // 霜月重定向（菈乌玛-灵使）
      if (this.skillManager) {
        const fmResult = this.skillManager.onFrostMoonRedirect(target, positiveDamage, source);
        if (fmResult.redirected) {
          // 伤害被重定向到另一目标
          await this.applyHpChange(fmResult.newTarget, -positiveDamage, sourceCard, source, isChainedTransmission);
          return;
        }
      }

      // 娜维娅-刺玫：受到的伤害恒为1
      if (this.naviaRoseHandler && target.heroId === 'navia') {
        const damageRef = { value: positiveDamage };
        this.naviaRoseHandler(target, damageRef);
        positiveDamage = damageRef.value;
      }

      // 防具前置修正（藤甲/白银狮子）
      if (this.equipBeforeDamageHandler) {
        const damageRef = { value: positiveDamage };
        this.equipBeforeDamageHandler(target, damageRef, sourceCard);
        positiveDamage = damageRef.value;
      }

      amount = -positiveDamage;
      const finalDamage = positiveDamage;

      const oldHp = target.hp;
      target.hp += amount;
      if (target.hp > target.maxHp) target.hp = target.maxHp;

      this.eventBus.emit(GameEvent.HpChanged, {
        playerId: target.id,
        newHp: target.hp,
        maxHp: target.maxHp,
        delta: amount,
        isDamage: true
      });

      this.eventBus.emit(GameEvent.Log, {
        message: `${target.name} 失去了 ${finalDamage} 点生命值，当前 HP: ${target.hp}/${target.maxHp}`
      });

      // 玛薇卡-圣火：火杀造成伤害后回血
      if (sourceCard && sourceCard.element === 'Pyro' && source && this.skillManager) {
        this.skillManager.onHolyFireDamage(source);
      }

      // 赛诺-风纪：杀造成伤害后可弃置目标装备区一张牌
      if (source && isChainedTransmission === false && sourceCard && isSlash(sourceCard) && (this.skillManager as any)?.cynoDisciplineOnDamage) {
        await (this.skillManager as any).cynoDisciplineOnDamage(source, target);
      }

      // 基尼奇-阿乔：造成火属性伤害后可令角色进入连环
      if (sourceCard && sourceCard.element === 'Pyro' && source && this.skillManager) {
        this.skillManager.onKinichAjaw(source, target);
      }

      // 温迪特殊处理：若濒死，先吟游自救再高天补牌
      const isVentiDying = target.heroId === 'venti' && target.hp <= 0;

      // 技能钩子：受到伤害后（温迪濒死时延迟到濒死处理之后）
      if (this.skillManager && !isVentiDying) {
        await this.skillManager.onAfterDamaged(target, finalDamage, sourceCard, source);
      }

      // 技能钩子：体力值变化后（芙宁娜-歌颂）
      if (this.skillManager && oldHp !== target.hp) {
        await this.skillManager.onHpChanged(target, target.hp - oldHp);
      }

      // 濒死检测
      if (target.hp <= 0) {
        await this.handleDyingStatus(target, sourceCard, source);
      }

      // 温迪：濒死处理完后才补牌（高天），确保先吟游自救再摸牌
      if (isVentiDying && this.skillManager && !target.isDead && target.hp > 0) {
        await this.skillManager.onAfterDamaged(target, finalDamage, sourceCard, source);
      }

      // 铁索连环传导回调
      if (this.onTransmitChain && !isChainedTransmission) {
        await this.onTransmitChain(target, finalDamage, sourceCard, source);
      }
    } else {
      const oldHp = target.hp;
      target.hp += amount;
      if (target.hp > target.maxHp) target.hp = target.maxHp;
      this.eventBus.emit(GameEvent.HpChanged, {
        playerId: target.id,
        newHp: target.hp,
        maxHp: target.maxHp,
        delta: amount,
        isDamage: false
      });
      this.eventBus.emit(GameEvent.Log, {
        message: `${target.name} 回复了 ${amount} 点生命值。`
      });

      // 技能钩子：体力值变化后（芙宁娜-歌颂）
      if (this.skillManager && oldHp !== target.hp) {
        await this.skillManager.onHpChanged(target, target.hp - oldHp);
      }
    }
  }

  // ======================== 体力流失 ========================

  /**
   * 体力流失：直接扣除HP，不触发伤害相关钩子
   * 无伤害来源（source=null），不触发玉璋/领袖/佣兵/防具/铁索传导
   * 触发 onHpChanged 和 onHealthLoss 钩子
   */
  async applyHealthLoss(target: PlayerState, amount: number, sourceName: string = ''): Promise<void> {
    if (amount <= 0) return;
    if (target.isDead) return;

    const oldHp = target.hp;
    target.hp = Math.max(0, target.hp - amount);

    this.eventBus.emit(GameEvent.HpChanged, {
      playerId: target.id,
      newHp: target.hp,
      maxHp: target.maxHp,
      delta: -amount,
      isDamage: false
    });

    this.eventBus.emit(GameEvent.Log, {
      message: `${target.name} 流失了 ${amount} 点体力，当前 HP: ${target.hp}/${target.maxHp}`
    });

    // 技能钩子：体力值变化后（芙宁娜-歌颂）
    if (this.skillManager && oldHp !== target.hp) {
      await this.skillManager.onHpChanged(target, target.hp - oldHp);
    }

    // 技能钩子：体力流失（奈芙尔-北网等）
    if (this.skillManager && sourceName) {
      this.skillManager.onHealthLoss(target, amount, sourceName);
    }

    // 濒死检测：体力流失也可能导致死亡
    if (target.hp <= 0) {
      await this.handleDyingStatus(target, null, null);
    }
  }

  // ======================== 濒死求桃 ========================

  private async handleDyingStatus(
    dyingPlayer: PlayerState,
    sourceCard: Card | null,
    source: PlayerState | null
  ): Promise<void> {
    this.eventBus.emit(GameEvent.PlayerDying, { playerId: dyingPlayer.id });

    // 菲林斯-灯妖：若source有灯妖激活，濒死立即阵亡（跳过求桃）
    if (source && (this.skillManager as any)?.isPhilinsLanternActive?.(source)) {
      this.eventBus.emit(GameEvent.Log, { message: `【灯妖】${source.name} 使 ${dyingPlayer.name} 立即阵亡（跳过求桃）！` });
      VoiceManager.getInstance().playSkillVoice('philins', '灯妖', source.id);
      this.executeDeath(dyingPlayer, source);
      return;
    }

    this.eventBus.emit(GameEvent.Log, { message: `[濒死] ${dyingPlayer.name} 正在寻求救援...` });

    // 技能钩子：濒死触发（芙宁娜-罪舞、胡桃-往生）
    if (this.skillManager) {
      const dyingResult = await this.skillManager.onDying(dyingPlayer);
      if (dyingResult.intercepted) {
        // 罪舞已处理（回复3点或造成3点伤害），检查是否脱离濒死
        if (dyingPlayer.hp > 0) {
          this.eventBus.emit(GameEvent.PlayerRescued, { playerId: dyingPlayer.id });
          return;
        }
      }
    }

    const startIndex = this.allPlayers.indexOf(dyingPlayer);
    const total = this.allPlayers.length;

    for (let i = 0; i < total; i++) {
      const currentIndex = (startIndex + i) % total;
      const rescuer = this.allPlayers[currentIndex];
      if (rescuer.isDead) continue;

      while (dyingPlayer.hp <= 0) {
        const driver = this.drivers.get(rescuer.id)!;

        if (rescuer === dyingPlayer) {
          // 自救：可用酒或桃
          // 温迪-吟游：主动选择是否将所有手牌当酒（确定/取消）
          if (rescuer.heroId === 'venti' && rescuer.handCards.length > 0) {
            const useBard = await (driver as any).promptYesNo?.(
              `【吟游】将所有手牌(${rescuer.handCards.length}张)当【酒】自救？`
            ) ?? false;
            if (useBard) {
              const cardCount = rescuer.handCards.length;
              const cards = [...rescuer.handCards];
              rescuer.handCards = [];
              for (const c of cards) {
                this.deck.sendToDiscard(c);
              }
              dyingPlayer.hp++;
              this.eventBus.emit(GameEvent.Log, {
                message: `${dyingPlayer.name} 发动【吟游】，将 ${cardCount} 张手牌当【酒】自救！`
              });
              continue;
            }
          }
          // 凯亚午后/迪卢克晨曦：尝试用标记当酒自救
          if (this.skillManager?.tryUseMarkerAsWine(rescuer.id)) {
            dyingPlayer.hp++;
            this.eventBus.emit(GameEvent.Log, { message: `${dyingPlayer.name} 使用标记当【酒】自救，当前 HP: ${dyingPlayer.hp}` });
            continue;
          }
          const wineCard = await this.askForResponse(rescuer, '酒', sourceCard, source, driver, { dyingPlayerId: dyingPlayer.id });
          if (wineCard) {
            dyingPlayer.hp++;
            this.eventBus.emit(GameEvent.Log, { message: `${dyingPlayer.name} 使用【酒】自救，当前 HP: ${dyingPlayer.hp}` });
            continue;
          }
          const peachCard = await this.askForResponse(rescuer, '桃', sourceCard, source, driver, { dyingPlayerId: dyingPlayer.id });
          if (peachCard) {
            dyingPlayer.hp++;
            this.eventBus.emit(GameEvent.Log, { message: `${dyingPlayer.name} 使用【桃】自救，当前 HP: ${dyingPlayer.hp}` });
            continue;
          }
          break;
        } else {
          // 他救：只能用桃
          const peachCard = await this.askForResponse(rescuer, '桃', sourceCard, source, driver, { dyingPlayerId: dyingPlayer.id });
          if (peachCard) {
            dyingPlayer.hp++;
            this.eventBus.emit(GameEvent.Log, { message: `${rescuer.name} 对 ${dyingPlayer.name} 使用【桃】，当前 HP: ${dyingPlayer.hp}` });
            continue;
          }
          break;
        }
      }

      if (dyingPlayer.hp > 0) {
        this.eventBus.emit(GameEvent.PlayerRescued, { playerId: dyingPlayer.id });
        return;
      }
    }

    // 救不回来，处理阵亡
    this.executeDeath(dyingPlayer, source);
  }

  // ======================== 阵亡处理 ========================

  executeDeath(victim: PlayerState, killer: PlayerState | null): void {
    // 技能钩子：角色死亡（胡桃-往生拿装备、夜兰-幽客）
    if (this.skillManager) {
      this.skillManager.onPlayerDeath(victim);
    }

    victim.isDead = true;

    // 击杀统计
    if (killer && killer !== victim && this.onKill) {
      this.onKill(killer, victim);
    }

    // 菲林斯-长茔：角色死亡时额外摸2张牌
    for (const p of this.allPlayers) {
      if (!p.isDead && p.heroId === 'philins' && p !== victim) {
        (this.skillManager as any)?.philinsGraveOnDeath?.(p);
      }
    }

    this.eventBus.emit(GameEvent.PlayerDied, {
      playerId: victim.id,
      role: victim.role
    });
    this.eventBus.emit(GameEvent.Log, {
      message: `💥 玩家 ${victim.name} (${getRoleChineseName(victim.role)}) 已经阵亡！`
    });

    // 回收所有卡牌
    let totalCleared = 0;

    // 手牌
    const handCards = [...victim.handCards];
    victim.handCards = [];
    for (const card of handCards) {
      this.deck.sendToDiscard(card);
      totalCleared++;
    }

    // 装备
    for (const slot of Object.values(EquipmentType)) {
      if (slot === EquipmentType.None) continue;
      const equip = victim.equipZone[slot];
      if (equip) {
        this.deck.sendToDiscard(equip);
        victim.equipZone[slot] = null;
        totalCleared++;
      }
    }

    // 判定区
    const judgeCards = [...victim.judgeZone];
    victim.judgeZone = [];
    for (const card of judgeCards) {
      this.deck.sendToDiscard(card);
      totalCleared++;
    }

    this.eventBus.emit(GameEvent.Log, {
      message: `${victim.name} 的 ${totalCleared} 张牌已被全部回收。`
    });

    // 奖惩机制
    if (killer && killer !== victim) {
      // 主公杀忠臣：弃置所有牌
      if (victim.role === RoleType.Minister && killer.role === RoleType.Monarch) {
        this.eventBus.emit(GameEvent.Log, { message: `🔴 主公 ${killer.name} 误杀了忠臣 ${victim.name}！惩罚：弃置所有牌！` });

        const kHandCards = [...killer.handCards];
        killer.handCards = [];
        for (const card of kHandCards) {
          this.deck.sendToDiscard(card);
        }

        for (const slot of Object.values(EquipmentType)) {
          if (slot === EquipmentType.None) continue;
          const equip = killer.equipZone[slot];
          if (equip) {
            this.deck.sendToDiscard(equip);
            killer.equipZone[slot] = null;
          }
        }
      }

      // 杀反贼：摸3张牌
      if (victim.role === RoleType.Rebel) {
        this.eventBus.emit(GameEvent.Log, { message: `🟢 ${killer.name} 击杀了反贼 ${victim.name}！奖励：摸3张牌！` });
        this.deck.drawCards(killer, 3);
      }

      // PVE模式：击杀任何敌方/友方角色均摸3张牌（无身份奖惩区分）
      const kFaction = (killer as any).faction as string | undefined;
      const vFaction = (victim as any).faction as string | undefined;
      if (kFaction && vFaction && victim.role === RoleType.None) {
        this.eventBus.emit(GameEvent.Log, { message: `🟢 ${killer.name} 击杀了 ${victim.name}！奖励：摸3张牌！` });
        this.deck.drawCards(killer, 3);
      }
    }

    // 检查游戏胜负
    const winner = this.checkGameOver();
    if (winner && this.gameOverCallback) {
      this.gameOverCallback(winner);
    }
  }

  // ======================== 响应索要 ========================

  async askForResponse(
    target: PlayerState,
    cardName: string,
    sourceCard: Card | null,
    source: PlayerState | null,
    driver: IPlayerDriver,
    extraCtx?: Partial<{ dyingPlayerId: number }>
  ): Promise<Card | null> {
    // 青釭剑无视防具检查
    const ignoreArmor = source && cardName === '闪' && this.shouldIgnoreArmorHandler?.(source);

    if (!ignoreArmor) {
      if (await this.equipOnResponseHandler?.(target, cardName, sourceCard, source)) {
        return null; // 防具已代替响应（返回null因为不需要选牌，上层用true判断）
      }
    }

    // 丈八蛇矛被动注入
    const targetWeapon = target.equipZone[EquipmentType.Weapon];
    const canZhanBa = cardName === '杀' && targetWeapon?.name === '丈八蛇矛' && target.handCards.length >= 2;

    // 通过 driver 让玩家/AI 选择
    // 妮露水环/水月：ctx里传递当前stance供promptResponse使用
    const nilouData = this.skillManager?.getData?.(target.id);
    const response = await driver.promptResponse(target, cardName, {
      players: this.allPlayers,
      roundCount: 0,
      currentTurn: 0,
      currentPlayerId: target.id,
      gameOverWinner: null,
      nilouStance: nilouData?.nilouStance || undefined,
      drawPileCount: this.deck.drawPileCount,
      discardPileCount: this.deck.discardPile.length,
      dyingPlayerId: extraCtx?.dyingPlayerId,
    });

    if (response) {
      // 从手牌移除并弃置（用 id 比较，PVP JSON 序列化后对象引用不同）
      const idx = target.handCards.findIndex(c => c.id === response.id);
      if (idx >= 0) {
        target.handCards.splice(idx, 1);
      }
      response.cardSource = target;
      this.deck.sendToDiscard(response);

      // 播报被动出牌（含花色点数）
      const suitMap: Record<string, string> = { Spade: '♠', Heart: '♥', Club: '♣', Diamond: '♦' };
      const numMap: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
      const suitSym = suitMap[response.suit] || '';
      const numText = numMap[response.number] || String(response.number);
      this.eventBus.emit(GameEvent.Log, {
        message: `${target.name} 打出了【${response.name}】${suitSym}${numText}`
      });

      // 妮露-水环：黑色牌当闪使用时触发语音
      if (target.heroId === 'nilou' && cardName === '闪' &&
          (response.suit === 'Spade' || response.suit === 'Club')) {
        VoiceManager.getInstance().playSkillVoice('nilou', '水环', target.id);
      }

      this.eventBus.emit(GameEvent.CardResponded, {
        playerId: target.id,
        card: response,
        cardName
      });
      // 被动出牌后技能钩子（神里绫华-白鹭等）
      if (!response.isVirtual && this.skillManager) {
        await this.skillManager.onAfterCardPlay(target);
      }
      return response;
    }

    // 手牌中没有对应牌，但有丈八蛇矛：尝试合成
    if (canZhanBa && this.zhanBaHandler) {
      const virtualSlash = this.zhanBaHandler(target, false);
      if (virtualSlash) {
        virtualSlash.cardSource = target;
        this.eventBus.emit(GameEvent.Log, {
          message: `${target.name} 用【丈八蛇矛】将两张手牌合成为【杀】！`
        });
        this.eventBus.emit(GameEvent.CardResponded, {
          playerId: target.id,
          card: virtualSlash,
          cardName
        });
        // 被动合成杀后技能钩子（白鹭）
        if (this.skillManager) {
          await this.skillManager.onAfterCardPlay(target);
        }
        return virtualSlash;
      }
    }

    return null;
  }

  /** 索要花色的牌（火攻用） */
  async askForSuitResponse(
    target: PlayerState,
    requiredSuit: string,
    sourceCard: Card | null,
    source: PlayerState | null,
    driver: IPlayerDriver
  ): Promise<Card | null> {
    const validCards = target.handCards.filter(c => c.suit === requiredSuit);
    if (validCards.length === 0) return null;

    // 花色符号映射（用于UI显示）
    const suitSymbols: Record<string, string> = { Heart: '♥', Diamond: '♦', Spade: '♠', Club: '♣', None: '' };
    const suitDisplay = suitSymbols[requiredSuit] || requiredSuit;
    // 格式：花色:显示符号:原始花色（客户端解析时取第3段作为过滤suit）
    const response = await driver.promptResponse(target, `花色:${suitDisplay}:${requiredSuit}`, {
      players: this.allPlayers,
      roundCount: 0,
      currentTurn: 0,
      currentPlayerId: target.id,
      gameOverWinner: null,
      drawPileCount: this.deck.drawPileCount,
      discardPileCount: this.deck.discardPile.length,
    });

    if (response) {
      const idx = target.handCards.findIndex(c => c.id === response.id);
      if (idx >= 0) target.handCards.splice(idx, 1);
      this.deck.sendToDiscard(response);
      return response;
    }
    return null;
  }

  // ======================== 胜负判定 ========================

  checkGameOver(): string | null {
    // 安全检查：如果没有玩家被分配角色，说明游戏尚未真正开始，不判定胜负
    const anyRoleAssigned = this.allPlayers.some(p => p.role !== RoleType.None);
    if (!anyRoleAssigned) {
      // PVE 模式：使用阵营判定胜负
      return this.checkPVEGameOver();
    }

    const isMonarchAlive = this.allPlayers.some(p => p.role === RoleType.Monarch && !p.isDead);
    const aliveRebels = this.allPlayers.filter(p => p.role === RoleType.Rebel && !p.isDead).length;
    const aliveTraitors = this.allPlayers.filter(p => p.role === RoleType.Traitor && !p.isDead).length;
    const totalAlive = this.allPlayers.filter(p => !p.isDead).length;

    if (!isMonarchAlive) {
      if (totalAlive === 1 && aliveTraitors === 1) return '内奸阵营（独赢）';
      return '反贼阵营';
    }
    if (aliveRebels === 0 && aliveTraitors === 0) return '主忠阵营';
    return null;
  }

  /** PVE模式：基于阵营的胜负判定 */
  private checkPVEGameOver(): string | null {
    const enemiesAlive = this.allPlayers.filter(p => !p.isDead && (p as any).faction === 'Enemy');
    const alliesAlive = this.allPlayers.filter(p => !p.isDead && (p as any).faction === 'Ally');
    // 敌方全员阵亡 → 友方胜利
    if (enemiesAlive.length === 0) return '友方阵营';
    // 友方全员阵亡 → 敌方胜利
    if (alliesAlive.length === 0) return '敌方阵营';
    return null;
  }
}
