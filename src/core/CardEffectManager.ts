// ============================================================
// CardEffectManager.ts — 卡牌效果处理器（主动出牌入口）
// ============================================================

import {
  PlayerState, Card, CardType, EquipmentType, ElementType, SuitType,
  IPlayerDriver, GameContextSnapshot
} from './types';
import { GameEvent } from './types';
import { isSlash, getCardDetail, getMagicSubType, MagicTimeType, cloneCard, createVirtualCard } from './Card';
import { getRoleChineseName, getWeaponRange } from './Player';
import { getDistance, isInRange, getAlivePlayers, findNextAlivePlayer } from './DistanceCalc';
import { DeckManager } from './DeckManager';
import { EventBus } from './EventBus';
import { DamageSystem } from './DamageSystem';
import { EquipEffectManager } from './EquipEffectManager';
import { VoiceManager } from '../audio/VoiceManager';

export class CardEffectManager {
  private deck: DeckManager;
  private eventBus: EventBus;
  private damageSystem: DamageSystem;
  private equipManager: EquipEffectManager;
  private drivers: Map<number, IPlayerDriver>;
  private allPlayers: PlayerState[];

  // 用于铁索传导的外部回调
  public onTransmitChainedDamage: ((target: PlayerState, damage: number, sourceCard: Card | null, source: PlayerState | null, isTransmission: boolean) => void) | null = null;

  // SkillManager 注入
  public skillManager: {
    onMagicUsed: (player: PlayerState, card: Card) => Promise<boolean>;
    onMagicTargeted: (player: PlayerState, card: Card) => Promise<{ intercepted: boolean; data?: any }>;
    onBeforeSlashTarget: (target: PlayerState, source: PlayerState) => { intercepted: boolean; data?: any };
    canDelayKitAffect: (player: PlayerState, kitName: string) => boolean;
    isSuitSealed: (suit: string) => boolean;
    onDealingDamage: (source: PlayerState, target: PlayerState, damage: number, sourceCard?: Card | null) => Promise<{ intercepted: boolean; data?: any }>;
    onAfterCardPlay: (player: PlayerState, card?: Card) => Promise<void>;
    getFireDamageBonus: (source: PlayerState) => number;
    isAlhaithamMagicImmune: (source: PlayerState) => boolean;
    hasAlhaithamKnowledge: (player: PlayerState) => boolean;
    useAlhaithamKnowledge: (player: PlayerState) => boolean;
    onFireworkExplosion: (player: PlayerState) => Promise<boolean>;
    isYelanDamageHealthLoss: (source: PlayerState) => boolean;
    getEulaSlashDamage: (source: PlayerState, target: PlayerState, baseDamage: number) => number;
    getSlashRangeBonus: (source: PlayerState) => number;
    getAnalepticDamageBonus: (source: PlayerState) => number;
    getPeachHealBonus: (source: PlayerState) => number;
    isImmuneToFire: (player: PlayerState) => boolean;
    getEulaDistanceBonus: (target: PlayerState, source: PlayerState) => number;
    getEulaDistanceReduction: (source: PlayerState, target: PlayerState) => number;
    getNilouStanceConvert: (player: PlayerState, card: Card) => string | null;
    isXiaoGoldenwingActive: (target: PlayerState) => boolean;
    onXiaoGoldenwingSlash: (target: PlayerState, source: PlayerState, slashCard: Card) => Promise<{ intercepted: boolean; data?: any }>;
    isKinichPriceActive: (target: PlayerState) => boolean;
    onKinichPriceSlash: (target: PlayerState, source: PlayerState, slashCard: Card) => Promise<{ intercepted: boolean; data?: any }>;
    onDoubleNullify: (magicCard: Card, target: PlayerState) => Promise<boolean>;
    onKokomiPeachGarden: (source: PlayerState, totalHealed: number) => void;
    getSpringMarker: (playerId: number) => Card | null;
    removeSpringMarker: (playerId: number) => Card | null;
    isKaeyaCavalryActive: (source: PlayerState) => boolean;
    isDilucOwlActive: (source: PlayerState) => boolean;
    shouldConvertDilucFireSlash: (source: PlayerState) => boolean;
    tryUseMarkerAsWine: (playerId: number) => boolean;
    isJeanBreezeActive: (player: PlayerState) => boolean;
    jeanBreezeSkip: (player: PlayerState) => void;
    checkNefurSecretOnUse: (player: PlayerState, usedCard: Card) => Promise<void>;
    checkNefurSecretOnDiscard: (player: PlayerState, discardedCard: Card) => Promise<void>;
    onSlashHit?: (source: PlayerState, target: PlayerState, card: Card) => Promise<void>;
    applyShenheIceFeather: (source: PlayerState, target: PlayerState) => void;
    hasIceFeather: (player: PlayerState) => boolean;
    applyFrostMark: (target: PlayerState, sourceName: string, skillName: string) => void;
    isGanyuKylinActive: (source: PlayerState) => boolean;
    getZibaiGraceBonus?: () => number;
    isSigewinneTempActive?: (player: PlayerState) => boolean;
    getClorindeDuelConvert?: (player: PlayerState, card: Card) => boolean;
  } | null = null;

  constructor(
    deck: DeckManager,
    eventBus: EventBus,
    damageSystem: DamageSystem,
    equipManager: EquipEffectManager,
    drivers: Map<number, IPlayerDriver>,
    allPlayers: PlayerState[]
  ) {
    this.deck = deck;
    this.eventBus = eventBus;
    this.damageSystem = damageSystem;
    this.equipManager = equipManager;
    this.drivers = drivers;
    this.allPlayers = allPlayers;
  }

  // ======================== 总入口 ========================

  async handleActivePlay(card: Card, source: PlayerState): Promise<boolean> {
    card.cardSource = source;
    // 出牌语音（根据牌名和角色性别播放）
    VoiceManager.getInstance().playCardVoice(source.gender, card.name);

    // 魈-降魔：检查花色是否被封印（不能主动使用该花色的牌）
    if (this.skillManager && this.skillManager.isSuitSealed(card.suit)) {
      this.eventBus.emit(GameEvent.Log, {
        message: `【降魔】${card.suit}花色已被封印，${source.name} 无法主动使用 ${getCardDetail(card)}！`
      });
      return false;
    }

    // 恰斯卡-超越：记录本回合使用了杀/决斗
    (this.skillManager as any)?.chascaTrackSlashOrDuel?.(source);

    // 法尔伽-北风：使用杀时可弃牌令其不计次数（在处理杀逻辑之前）
    if (isSlash(card) && (this.skillManager as any)?.varkaNorthwindPrompt) {
      const northwindUsed = await (this.skillManager as any).varkaNorthwindPrompt(source);
      if (northwindUsed) {
        // 北风已弃牌，此杀不计次数（在executeSlashLogic中不增加slashUsedCount）
        (card as any)._varkaNorthwind = true;
      }
    }

    // 装备牌
    if (card.type === CardType.Equipment) {
      return this.equipManager.handleEquipPlay(card, source);
    }

    // 非延时锦囊：纳西妲-囚笼（双发）
    if (card.type === CardType.Magic && this.skillManager) {
      const magicType = getMagicSubType(card);
      if (magicType !== MagicTimeType.Delay) {
        const doubleCast = await this.skillManager.onMagicUsed(source, card);
        if (doubleCast) {
          // 先执行第一次
          const firstResult = await this.executeMagicCard(card, source);
          // 再执行第二次（生效两次）
          if (firstResult) {
            this.eventBus.emit(GameEvent.Log, {
              message: `【囚笼】锦囊生效两次！`
            });
            await this.executeMagicCard(card, source);
          }
          return firstResult;
        }
      }
    }

    // 妮露-水月：红色手牌当杀
    if (this.skillManager?.getNilouStanceConvert?.(source, card) === '杀') {
      VoiceManager.getInstance().playSkillVoice('nilou', '水月', source.id);
      return this.executeSlashLogic(card, source);
    }

    // 克洛琳德-决斗：高点数手牌当决斗打出
    if (this.skillManager?.getClorindeDuelConvert?.(source, card)) {
      VoiceManager.getInstance().playSkillVoice('clorinde', '决斗', source.id);
      return await this.executeDuel(card, source);
    }

    // 基本牌和锦囊
    switch (card.name) {
      case '杀':
      case '火杀':
      case '雷杀':
        return this.executeSlashLogic(card, source);
      case '桃':
        return await this.executePeachLogic(card, source);
      case '酒':
        return this.executeAnalepticLogic(card, source);
      case '南蛮入侵':
      case '万箭齐发':
      case '桃园结义':
      case '五谷丰登':
      case '无中生有':
      case '过河拆桥':
      case '顺手牵羊':
      case '决斗':
      case '火攻':
      case '借刀杀人':
      case '铁索连环':
        return await this.executeMagicCard(card, source);
      case '乐不思蜀':
      case '兵粮寸断':
        return await this.executeTimeDelayedKit(card, source, card.name);
      case '闪电':
        return this.executeLightning(card, source);
      default:
        return false;
    }
  }

  /** 通过牌名创建虚拟牌并执行锦囊效果（供技能系统调用）。
   *  走 handleActivePlay 而非 executeMagicCard，确保纳西妲-囚笼等技能钩子能正常触发。 */
  async executeMagicByName(cardName: string, source: PlayerState): Promise<boolean> {
    const virtual = createVirtualCard(cardName, CardType.Magic, SuitType.None, ElementType.None);
    virtual.cardSource = source;
    return this.handleActivePlay(virtual, source);
  }

  /** 统一处理非延时锦囊分发 */
  private async executeMagicCard(card: Card, source: PlayerState): Promise<boolean> {
    switch (card.name) {
      case '南蛮入侵':
        await this.executeMassiveAOE(card, source, '杀', '受到【南蛮入侵】的影响');
        return true;
      case '万箭齐发':
        await this.executeMassiveAOE(card, source, '闪', '受到【万箭齐发】的影响');
        return true;
      case '桃园结义':
        await this.executePeachGarden(card, source);
        return true;
      case '五谷丰登':
        await this.executeAmazingGrace(card, source);
        return true;
      case '无中生有':
        await this.executeExNihilo(card, source);
        return true;
      case '过河拆桥':
        return await this.executeDismantle(card, source);
      case '顺手牵羊':
        return await this.executeSnatch(card, source);
      case '决斗':
        return await this.executeDuel(card, source);
      case '火攻':
        return await this.executeFireAttack(card, source);
      case '借刀杀人':
        return await this.executeBorrowWeapon(card, source);
      case '铁索连环':
        return await this.executeIronChain(card, source);
      default:
        return false;
    }
  }

  // ======================== 杀 ========================

  private async executeSlashLogic(card: Card, source: PlayerState): Promise<boolean> {
    // 刻晴-玉衡（锁定技）：雷杀不计入出杀次数
    const isKeqingThunder = source.heroId === 'keqing' && card.element === ElementType.Electro;
    // 夜枭 / 诸葛连弩检查：无限杀
    const isOwlUnrestricted = this.skillManager?.isDilucOwlActive(source) ?? false;
    // 恰斯卡-超越：下回合出杀次数+2
    const chascaBeyondActive = (this.skillManager as any)?.getData?.(source.id)?.chascaBeyondActive ?? false;
    const maxSlashCount = chascaBeyondActive ? 3 : 1; // +2 → 总共3次
    if (!isKeqingThunder && !isOwlUnrestricted && !this.equipManager.canSlashUnrestricted(source)) {
      if (source.slashUsedCount >= maxSlashCount) {
        this.eventBus.emit(GameEvent.Log, { message: '本回合使用【杀】的次数已达上限。' });
        return false;
      }
    }

    // 扫描合法目标
    const validTargets = this.allPlayers.filter(t =>
      !t.isDead && t !== source &&
      getWeaponRange(source) >= getDistance(source, t, this.allPlayers)
    );

    // 法尔伽-写信：写信目标无视距离加入可选目标
    const varkaLetterId = (this.skillManager as any)?.getVarkaLetterTarget?.(source.id);
    if (varkaLetterId !== null && varkaLetterId !== undefined) {
      const letterTarget = this.allPlayers.find(p => p.id === varkaLetterId && !p.isDead && p !== source);
      if (letterTarget && !validTargets.includes(letterTarget)) {
        validTargets.push(letterTarget);
      }
    }

    // 技能钩子：排除不能成为杀的目标（雷电将军-永恒）
    if (this.skillManager) {
      for (let i = validTargets.length - 1; i >= 0; i--) {
        const result = this.skillManager.onBeforeSlashTarget(validTargets[i], source);
        if (result.intercepted) {
          validTargets.splice(i, 1);
        }
      }
    }

    if (validTargets.length === 0) {
      this.eventBus.emit(GameEvent.Log, { message: '范围内没有可攻击的目标。' });
      return false;
    }

    // 骑队（凯亚）：最后一张手牌，额外指定至多距离1的3个目标
    const isCavalry = this.skillManager?.isKaeyaCavalryActive(source) ?? false;
    // 方天画戟（非凯亚时）：最后一张手牌
    const weapon = source.equipZone[EquipmentType.Weapon];
    const isFangTian = !isCavalry && weapon?.name === '方天画戟' && source.handCards.length === 0;
    let selectedTargets: PlayerState[] = [];

    if (isCavalry) {
      // 骑队：武器射程内的目标（贯石斧等武器会增加射程）
      const sourceRange = getWeaponRange(source);
      const distanceTargets = validTargets.filter(t => getDistance(source, t, this.allPlayers) <= sourceRange);
      const driver = this.drivers.get(source.id)!;
      // 先选主目标
      const primaryId = await driver.promptTarget(source, distanceTargets.map(t => t.id),
        '骑队-选择【杀】的主目标', this.buildContext(source.id));
      if (primaryId === null) return false;
      const primaryTarget = distanceTargets.find(t => t.id === primaryId);
      if (!primaryTarget) return false;
      selectedTargets.push(primaryTarget);

      // 再选额外目标（最多3个额外 = 总计4个）
      const remaining = distanceTargets.filter(t => t.id !== primaryId);
      for (let i = 0; i < 3 && remaining.length > 0; i++) {
        const extraId = await driver.promptTarget(source, remaining.map(t => t.id),
          `骑队-选择额外目标${i + 1}/3（可取消）`, this.buildContext(source.id));
        if (extraId === null) break;
        const extraTarget = remaining.find(t => t.id === extraId);
        if (!extraTarget) break;
        selectedTargets.push(extraTarget);
        const idx = remaining.indexOf(extraTarget);
        if (idx >= 0) remaining.splice(idx, 1);
      }
      // 骑队伤害 = (4 - 目标数) + 酒加成（酒效果不被覆盖）
      const cavalryDamage = Math.max(1, 4 - selectedTargets.length + source.nextSlashDamageBonus);
      this.eventBus.emit(GameEvent.Log, {
        message: `【骑队】${source.name} 对 ${selectedTargets.map(t => t.name).join('、')} 使用【杀】！伤害=${cavalryDamage}点。`
      });
      VoiceManager.getInstance().playSkillVoice('kaeya', '骑队', source.id);
      if (!(card as any)._varkaNorthwind) source.slashUsedCount++;
      await this.processSlashTargets(card, source, selectedTargets, cavalryDamage);
      return true;
    }

    if (isFangTian) {
      selectedTargets = validTargets.slice(0, Math.min(3, validTargets.length));
      this.eventBus.emit(GameEvent.WeaponEffect, { name: '方天画戟', playerId: source.id });
    } else {
      const driver = this.drivers.get(source.id)!;
      const targetId = await driver.promptTarget(source, validTargets.map(t => t.id), card.name, this.buildContext(source.id));
      if (targetId === null) return false;
      const target = validTargets.find(t => t.id === targetId);
      if (!target) return false;
      selectedTargets = [target];
    }

    if (selectedTargets.length === 0) return false;

    // 刻晴-玉衡：雷杀不计入出杀次数；法尔伽-北风：已弃牌不计次数
    if (!isKeqingThunder && !(card as any)._varkaNorthwind) {
      source.slashUsedCount++;
    }
    await this.processSlashTargets(card, source, selectedTargets);
    return true;
  }

  private async processSlashTargets(card: Card, source: PlayerState, targets: PlayerState[], overrideDamage?: number): Promise<void> {
    const baseDamage = overrideDamage !== undefined ? overrideDamage : (1 + source.nextSlashDamageBonus);
    source.nextSlashDamageBonus = 0;

    for (const target of targets) {
      if (target.isDead) continue;

      // 重置贯石斧状态（每个目标独立）
      this.equipManager.resetGuanShiAxeForNewSlash(source.id);

      // 创建卡牌副本
      const cardCopy = cloneCard(card);
      cardCopy.cardSource = source;

      // 夜枭（迪卢克）：所有杀均视为火杀
      if (this.skillManager?.shouldConvertDilucFireSlash(source)) {
        cardCopy.element = ElementType.Pyro;
      }
      // 朱雀羽扇（需await用户确认）
      await this.equipManager.modifySlashElementBeforeProcess(source, cardCopy);
      // 雌雄双股剑
      await this.equipManager.handleWeaponBeforeDodge(source, target);

      await this.processSingleSlash(cardCopy, source, target, baseDamage);
    }
  }

  private async processSingleSlash(card: Card, source: PlayerState, target: PlayerState, damage: number): Promise<void> {
    // 优菈-浪花（锁定技）：【杀】造成的伤害等于目标对你的距离
    if (source.heroId === 'eula') {
      const dist = getDistance(target, source, this.allPlayers);
      damage = Math.max(1, dist);
      VoiceManager.getInstance().playSkillVoice('eula', '浪花', source.id);
    }

    // 申鹤-劈观：使用杀指定目标后可给冰翎标记（在索要闪之前触发）
    if (this.skillManager) {
      await this.skillManager.applyShenheIceFeather(source, target);
    }

    // 法尔伽-远征：杀指定距离>1的目标时摸1张牌
    if (this.skillManager && (this.skillManager as any).varkaExpeditionCheck) {
      (this.skillManager as any).varkaExpeditionCheck(source, target);
    }

    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 对 ${target.name} 使用了 ${getCardDetail(card)}！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: target.id, cardName: card.name });

    // 刻晴-玉衡：打出雷杀时触发语音
    if (source.heroId === 'keqing') {
      VoiceManager.getInstance().playSkillVoice('keqing', '玉衡', source.id);
    }

    // 技能钩子：金鹏（魈）- 被杀时需来源出花色不同的额外杀
    if (this.skillManager && this.skillManager.isXiaoGoldenwingActive(target)) {
      const gwResult = await this.skillManager.onXiaoGoldenwingSlash(target, source, card);
      if (gwResult.intercepted) return; // 杀无效
    }

    // 技能钩子：价格（基尼奇）- 被杀时需来源出额外杀
    let dodgeForced = false;
    if (this.skillManager && this.skillManager.isKinichPriceActive(target)) {
      const priceResult = await this.skillManager.onKinichPriceSlash(target, source, card);
      if (priceResult.intercepted) return; // 杀无效
      if (priceResult.data?.dodgeForced) {
        dodgeForced = true; // 不可闪避
      }
    }

    // 索要闪
    const driver = this.drivers.get(target.id)!;
    let dodgeSuccess = false;
    let armorDodged = false;

    if (!dodgeForced) {
      // 青釭剑 / 刻晴-玉衡（雷杀无视防具）
      const ignoreArmor = this.equipManager.shouldIgnoreArmor(source) ||
        (source.heroId === 'keqing' && card.element === ElementType.Electro);
      if (!ignoreArmor) {
        armorDodged = await this.equipManager.handleArmorOnResponse(target, '闪', card, source);
        dodgeSuccess = armorDodged;
      } else {
        if (source.heroId === 'keqing') {
          this.eventBus.emit(GameEvent.Log, { message: `${source.name} 的【玉衡】（雷杀）无视了 ${target.name} 的防具！` });
        } else {
          this.eventBus.emit(GameEvent.Log, { message: `${source.name} 的【青釭剑】无视了 ${target.name} 的防具！` });
        }
      }

      if (!dodgeSuccess) {
        // 赛诺-素论：武器距离≥4不可闪避，≥2需双闪
        const cynoReq = (this.skillManager as any)?.getCynoDodgeRequirement?.(source) ?? 1;
        if (cynoReq === 0) {
          // 不可闪避
        } else if (cynoReq === 2) {
          this.eventBus.emit(GameEvent.Log, { message: `【素论】${source.name} 武器距离≥2，${target.name} 需要使用两张【闪】才能抵消！` });
          VoiceManager.getInstance().playSkillVoice('cyno', '素论', source.id);
          const fc1 = await this.damageSystem.askForResponse(target, '闪', card, source, driver);
          if (fc1) { const fc2 = await this.damageSystem.askForResponse(target, '闪', card, source, driver); dodgeSuccess = !!fc2; }
          else { dodgeSuccess = false; }
        } else {
          // 申鹤-冰翎：需使用两张闪
          const needDoubleDodge = this.skillManager?.hasIceFeather(target) ?? false;
          if (needDoubleDodge) {
            this.eventBus.emit(GameEvent.Log, { message: `【冰翎】${target.name} 需要使用两张【闪】才能抵消！` });
            const flashCard1 = await this.damageSystem.askForResponse(target, '闪', card, source, driver);
            if (flashCard1) {
              const flashCard2 = await this.damageSystem.askForResponse(target, '闪', card, source, driver);
              dodgeSuccess = !!flashCard2;
            } else {
              dodgeSuccess = false;
            }
          } else {
            const flashCard = await this.damageSystem.askForResponse(target, '闪', card, source, driver);
            dodgeSuccess = !!flashCard;
          }
        }
      }

      // 贯石斧/青龙刀补救（仅对方真正用闪闪避时触发，藤甲/仁王盾等防具免疫不算）
      if (dodgeSuccess && !armorDodged) {
        const weaponHit = await this.equipManager.handleWeaponOnDodgeSuccess(source, target, card);
        if (weaponHit) dodgeSuccess = false;
      }
    }

    if (!dodgeSuccess) {
      // 古锭刀/寒冰剑
      const damageRef = { value: damage };
      const intercepted = await this.equipManager.handleWeaponOnHitBeforeDamage(source, target, damageRef);
      if (intercepted) return;

      // 奈芙尔-蛇蝎：借刀杀人的伤害视为体力流失
      if ((card as any)._nefurSnakeHealthLoss) {
        await this.damageSystem.applyHealthLoss(target, damageRef.value, source.name);
      } else {
        await this.damageSystem.applyHpChange(target, -damageRef.value, card, source);
      }

      // 申鹤-鹤归：杀造成伤害后给目标添加冰寒标记
      if (!target.isDead && source.heroId === 'shenhe' && this.skillManager) {
        this.skillManager.applyFrostMark(target, source.name, '鹤归');
        VoiceManager.getInstance().playSkillVoice('shenhe', '鹤归', source.id);
      }

      // 麒麟弓 / 甘雨-麟迹
      if (!target.isDead) {
        this.equipManager.handleWeaponAfterDamageEffect(source, target);
        // 甘雨-麟迹：没有武器时默认拥有麒麟弓效果
        if (this.skillManager?.isGanyuKylinActive(source)) {
          this.eventBus.emit(GameEvent.Log, {
            message: `【麟迹】${source.name} 发动麟迹，默认拥有麒麟弓效果！`
          });
          VoiceManager.getInstance().playSkillVoice('ganyu', '麟迹', source.id);
          // 复用麒麟弓逻辑：弃置目标的坐骑
          const horseSlots: EquipmentType[] = [];
          if (target.equipZone[EquipmentType.DefensiveHorse]) horseSlots.push(EquipmentType.DefensiveHorse);
          if (target.equipZone[EquipmentType.OffensiveHorse]) horseSlots.push(EquipmentType.OffensiveHorse);
          if (horseSlots.length > 0) {
            const ganyuDriver = this.drivers.get(source.id);
            if (ganyuDriver) {
              const slot = await (ganyuDriver as any).promptChoice?.(
                source, horseSlots.map(s => s === EquipmentType.DefensiveHorse ? '防御马' : '进攻马'),
                '麟迹-选择弃置的坐骑（可取消）', this.buildContext(source.id)
              );
              if (slot !== null && slot !== undefined && slot >= 0 && slot < horseSlots.length) {
                const equipSlot = horseSlots[slot];
                const horse = target.equipZone[equipSlot];
                if (horse) {
                  target.equipZone[equipSlot] = null;
                  this.deck.sendToDiscard(horse);
                  this.eventBus.emit(GameEvent.Log, {
                    message: `【麟迹】${source.name} 弃置了 ${target.name} 的坐骑牌！`
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // ======================== 桃 ========================

  private async executePeachLogic(card: Card, source: PlayerState): Promise<boolean> {
    if (source.hp >= source.maxHp) {
      this.eventBus.emit(GameEvent.Log, { message: '体力值已满，无法使用【桃】。' });
      return false;
    }
    // 希格雯-温度：桃回复量+2
    const healAmount = (this.skillManager?.isSigewinneTempActive?.(source)) ? 3 : 1;
    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 使用了 ${getCardDetail(card)}${healAmount > 1 ? '【温度】回复+2！' : ''}` });
    if (healAmount > 1) VoiceManager.getInstance().playSkillVoice('sigewinne', '温度', source.id);
    await this.damageSystem.applyHpChange(source, healAmount);
    // 提纳里-生论：使用桃时可额外指定一名其他角色回复
    if (this.skillManager && source.heroId === 'tighnari') {
      await (this.skillManager as any).tighnariBiologyPrompt?.(source, this.buildContext(source.id));
    }
    return true;
  }

  // ======================== 酒 ========================

  private executeAnalepticLogic(card: Card, source: PlayerState): boolean {
    if (source.nextSlashDamageBonus > 0) {
      this.eventBus.emit(GameEvent.Log, { message: '已经喝过酒了，药力不能叠加。' });
      return false;
    }
    if (source.wineUsedThisTurn) {
      this.eventBus.emit(GameEvent.Log, { message: '本回合已经使用过【酒】了。' });
      return false;
    }
    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 使用了 ${getCardDetail(card)}` });
    source.nextSlashDamageBonus = 1;
    source.wineUsedThisTurn = true;
    return true;
  }

  // ======================== 群体锦囊（南蛮/万箭） ========================

  private async executeMassiveAOE(card: Card, source: PlayerState, responseCardName: string, reason: string): Promise<void> {
    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 发动了 ${getCardDetail(card)}！${reason}` });

    const total = this.allPlayers.length;
    const startIndex = this.allPlayers.indexOf(source);

    // 对所有其他存活角色发出光线（铁索/南蛮/万箭全场光线）
    for (let i = 1; i < total; i++) {
      const currentIndex = (startIndex + i) % total;
      const target = this.allPlayers[currentIndex];
      if (target.isDead) continue;
      this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: target.id, cardName: card.name });
    }

    for (let i = 1; i < total; i++) {
      const currentIndex = (startIndex + i) % total;
      const target = this.allPlayers[currentIndex];
      if (target.isDead || target === source) continue;

      // 无懈可击
      if (await this.askForNullificationStack(target, source, false, card)) {
        this.eventBus.emit(GameEvent.Log, { message: `【无懈可击】起效！${target.name} 免受影响。` });
        continue;
      }

      // 防具检查
      const armorBlocked = await this.equipManager.handleArmorOnResponse(target, responseCardName, card, source);
      if (armorBlocked) continue;

      // 琴-蒲骑：跳过AOE并摸牌
      if (this.skillManager && this.skillManager.isJeanBreezeActive(target) &&
          (card.name === '南蛮入侵' || card.name === '万箭齐发')) {
        const driver = this.drivers.get(target.id)!;
        const useBreeze = await (driver as any).promptYesNo?.(
          `【蒲骑】是否跳过${card.name}并摸一张牌？`
        ) ?? false;
        if (useBreeze) {
          this.skillManager.jeanBreezeSkip(target);
          continue; // 跳过此AOE
        }
      }

      const driver = this.drivers.get(target.id)!;
      const response = await this.damageSystem.askForResponse(target, responseCardName, card, source, driver);
      if (!response) {
        await this.damageSystem.applyHpChange(target, -1, card, source);
        // 甘雨-霜华：万箭齐发造成伤害后给目标添加冰寒标记
        if (!target.isDead && source.heroId === 'ganyu' && card.name === '万箭齐发' && this.skillManager) {
          this.skillManager.applyFrostMark(target, source.name, '霜华');
          VoiceManager.getInstance().playSkillVoice('ganyu', '霜华', source.id);
        }
      }
    }
  }

  // ======================== 决斗 ========================

  private async executeDuel(card: Card, source: PlayerState): Promise<boolean> {
    const validTargets = this.allPlayers.filter(t => !t.isDead && t !== source);
    const driver = this.drivers.get(source.id)!;
    const targetId = await driver.promptTarget(source, validTargets.map(t => t.id), '决斗', this.buildContext(source.id));
    if (targetId === null) return false;
    const target = validTargets.find(t => t.id === targetId)!;

    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 对 ${target.name} 发起了【决斗】！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: target.id, cardName: '决斗' });

    // 技能钩子：成为非延时锦囊目标（哥伦比娅-少女）
    if (this.skillManager) {
      const magicResult = await this.skillManager.onMagicTargeted(target, card);
      if (magicResult.intercepted) return true;
    }

    if (await this.askForNullificationStack(target, source, false, card)) {
      this.eventBus.emit(GameEvent.Log, { message: '【无懈可击】起效！' });
      return true;
    }

    let currentRespondent = target;
    let other = source;

    while (true) {
      const respDriver = this.drivers.get(currentRespondent.id)!;
      const response = await this.damageSystem.askForResponse(currentRespondent, '杀', card, source, respDriver);
      if (response) {
        [currentRespondent, other] = [other, currentRespondent];
      } else {
        this.eventBus.emit(GameEvent.Log, { message: `${currentRespondent.name} 无法继续出【杀】，决斗失败！` });
        await this.damageSystem.applyHpChange(currentRespondent, -1, card, source);
        // 神里绫华-霜灭：决斗造成伤害后给目标添加冰寒标记
        if (!currentRespondent.isDead && source.heroId === 'ayaka' && this.skillManager) {
          this.skillManager.applyFrostMark(currentRespondent, source.name, '霜灭');
          VoiceManager.getInstance().playSkillVoice('ayaka', '霜灭', source.id);
        }
        return true;
      }
    }
  }

  // ======================== 火攻 ========================

  private async executeFireAttack(card: Card, source: PlayerState): Promise<boolean> {
    const driver = this.drivers.get(source.id)!;
    const driverAny = driver as any;
    // 火攻只能对敌方使用（非友方）
    const validTargets = this.allPlayers.filter(t =>
      !t.isDead && t.handCards.length > 0 && t !== source &&
      (typeof driverAny.isEnemy === 'function' ? driverAny.isEnemy(source, t) : false));
    if (validTargets.length === 0) { this.eventBus.emit(GameEvent.Log, { message: '没有可攻击的目标。' }); return false; }
    const targetId = await driver.promptTarget(source, validTargets.map(t => t.id), '火攻', this.buildContext(source.id));
    if (targetId === null) return false;
    const target = validTargets.find(t => t.id === targetId)!;

    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 对 ${target.name} 发动了【火攻】！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: target.id, cardName: '火攻' });

    // 技能钩子：成为非延时锦囊目标（哥伦比娅-少女）
    if (this.skillManager) {
      const magicResult = await this.skillManager.onMagicTargeted(target, card);
      if (magicResult.intercepted) return true;
    }

    if (await this.askForNullificationStack(target, source, false, card)) {
      this.eventBus.emit(GameEvent.Log, { message: '【无懈可击】起效！' });
      return true;
    }

    // 目标展示一张牌
    const targetDriver = this.drivers.get(target.id)!;
    const showIdx = await targetDriver.promptShowCard(target, this.buildContext(target.id));
    const shownCard = target.handCards[showIdx] ?? target.handCards[0];

    this.eventBus.emit(GameEvent.CardRevealed, {
      playerId: target.id,
      card: shownCard,
      cardName: shownCard.name,
    });
    this.eventBus.emit(GameEvent.Log, {
      message: `${target.name} 展示了 ${getCardDetail(shownCard)}`
    });

    // 源玩家需要弃置同花色
    const sourceResp = await this.damageSystem.askForSuitResponse(source, shownCard.suit, card, source, driver);
    if (sourceResp) {
      this.eventBus.emit(GameEvent.Log, { message: '火攻成功！' });
      // 展示火攻所使用的牌（弃置的牌作为伤害牌动画展示）
      this.eventBus.emit(GameEvent.CardResponded, {
        playerId: source.id, card: sourceResp, cardName: sourceResp.name
      });
      await this.damageSystem.applyHpChange(target, -1, card, source);
    } else {
      this.eventBus.emit(GameEvent.Log, { message: `${source.name} 没有同花色牌，火攻失败。` });
    }

    return true;
  }

  // ======================== 桃园结义 ========================

  private async executePeachGarden(card: Card, source: PlayerState): Promise<void> {
    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 使用了 ${getCardDetail(card)}！` });

    const total = this.allPlayers.length;
    const startIndex = this.allPlayers.indexOf(source);
    let totalHealed = 0;

    for (let i = 0; i < total; i++) {
      const currentIndex = (startIndex + i) % total;
      const target = this.allPlayers[currentIndex];
      if (target.isDead) continue;

      if (target.hp < target.maxHp) {
        if (await this.askForNullificationStack(target, source, false, card)) {
          this.eventBus.emit(GameEvent.Log, { message: `【无懈可击】起效！${target.name} 免受桃园效果。` });
          continue;
        }
        await this.damageSystem.applyHpChange(target, 1);
        totalHealed++;
      }
    }

    // 珊瑚宫心海-神巫：桃园结义打出时摸X张牌
    if (this.skillManager && totalHealed > 0) {
      this.skillManager.onKokomiPeachGarden(source, totalHealed);
    }
  }

  // ======================== 五谷丰登 ========================

  private async executeAmazingGrace(card: Card, source: PlayerState): Promise<void> {
    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 使用了 ${getCardDetail(card)}！` });

    const alivePlayers = getAlivePlayers(this.allPlayers);
    const zibaiBonus = this.skillManager?.getZibaiGraceBonus?.() || 0;
    const totalCards = alivePlayers.length + zibaiBonus;
    const tableCards = this.deck.dealToTable(totalCards);

    // 已选牌ID集合，防止 _pickedBy 标记丢失导致重复选取
    const pickedCardIds = new Set<number>();

    // 发出事件让UI立即展示所有牌（持久化窗口），传递所有存活玩家名
    this.eventBus.emit(GameEvent.CardsDealtToTable, {
      cards: [...tableCards],
      sourceName: source.name,
      allPlayerNames: alivePlayers.map(p => p.name),
    });

    if (zibaiBonus > 0) {
      this.eventBus.emit(GameEvent.Log, {
        message: `【三尸】兹白存活，【五谷丰登】多亮出1张牌（共${totalCards}张）。`
      });
      const zibai = this.allPlayers.find(p => p.heroId === 'zibai' && !p.isDead);
      if (zibai) VoiceManager.getInstance().playSkillVoice('zibai', '三尸', zibai.id);
    }

    // 从 source 开始按顺序选
    const startIndex = alivePlayers.indexOf(source);
    for (let i = 0; i < alivePlayers.length; i++) {
      const picker = alivePlayers[(startIndex + i) % alivePlayers.length];
      if (picker.isDead) continue;

      if (await this.askForNullificationStack(picker, source, false, card)) {
        this.eventBus.emit(GameEvent.Log, { message: `【无懈可击】起效！${picker.name} 跳过选牌。` });
        // 标记跳过，让UI知道
        this.eventBus.emit(GameEvent.GraceCardPicked, { cardId: -1, pickerName: picker.name });
        continue;
      }

      // 哥伦比娅-少女：询问是否移去标记跳过五谷丰登
      if (picker.heroId === 'columbina' && this.skillManager) {
        const cData = (this.skillManager as any).getData?.(picker.id);
        if (cData && !cData.lostMaiden && (cData.emptyMoonCount || 0) > 0) {
          const cDriver = this.drivers.get(picker.id);
          const cDriverAny = cDriver as any;
          const useIt = typeof cDriverAny?.promptYesNo === 'function'
            ? await cDriverAny.promptYesNo(`是否移去1枚"空月"标记（剩余${cData.emptyMoonCount}枚）令【五谷丰登】对你无效？`)
            : false;
          if (useIt) {
            cData.emptyMoonCount--;
            this.eventBus.emit(GameEvent.Log, {
              message: `【少女】${picker.name} 移去1枚"空月"标记，令【五谷丰登】对自己无效。（剩余${cData.emptyMoonCount}枚）`
            });
            this.eventBus.emit(GameEvent.GraceCardPicked, { cardId: -1, pickerName: picker.name });
            continue;
          }
        }
      }

      // 过滤出未被选的牌（双保险：_pickedBy标记 + pickedCardIds集合）
      let availableCards = tableCards.filter(c =>
        !(c as any)._pickedBy && !pickedCardIds.has(c.id)
      );
      if (availableCards.length === 0) break;

      const driver = this.drivers.get(picker.id)!;
      const isZibai = picker.heroId === 'zibai' && zibaiBonus > 0;

      // 兹白可以获得两张牌
      const maxPicks = isZibai ? 2 : 1;
      for (let pick = 0; pick < maxPicks; pick++) {
        availableCards = tableCards.filter(c =>
          !(c as any)._pickedBy && !pickedCardIds.has(c.id)
        );
        if (availableCards.length === 0) break;

        const choice = await driver.promptAmazingGrace(picker, availableCards, this.buildContext(picker.id));
        const idx = Math.max(0, Math.min(choice, availableCards.length - 1));
        const chosen = availableCards[idx];
        // 标记已选（双重保险：对象属性 + ID集合）
        (chosen as any)._pickedBy = picker.id;
        (chosen as any)._pickerName = picker.name;
        pickedCardIds.add(chosen.id);
        picker.handCards.push(chosen);
        this.eventBus.emit(GameEvent.Log, { message: `${picker.name} 挑选了 ${getCardDetail(chosen)}` });

        // 通知UI更新
        this.eventBus.emit(GameEvent.GraceCardPicked, {
          cardId: chosen.id,
          pickerName: picker.name,
        });
        this.eventBus.emit(GameEvent.CardDrawn, { playerId: picker.id, count: 1, cards: [chosen] });
      }
    }

    // 剩余牌（未被选的）进弃牌堆
    for (const remaining of tableCards) {
      if (!(remaining as any)._pickedBy && !pickedCardIds.has(remaining.id)) {
        this.deck.sendToDiscard(remaining);
      }
    }

    // 通知UI关闭五谷丰登窗口
    this.eventBus.emit(GameEvent.GraceCompleted, {});
  }

  // ======================== 无中生有 ========================

  private async executeExNihilo(card: Card, source: PlayerState): Promise<void> {
    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 使用了 ${getCardDetail(card)}` });

    if (await this.askForNullificationStack(source, source, false, card)) {
      this.eventBus.emit(GameEvent.Log, { message: '【无懈可击】起效！' });
      return;
    }

    this.deck.drawCards(source, 2);
  }

  // ======================== 过河拆桥 ========================

  private async executeDismantle(card: Card, source: PlayerState): Promise<boolean> {
    const validTargets = this.allPlayers.filter(t =>
      !t.isDead && t !== source &&
      (t.handCards.length > 0 || Object.values(t.equipZone).some(v => v !== null) || t.judgeZone.length > 0)
    );

    const driver = this.drivers.get(source.id)!;
    const targetId = await driver.promptTarget(source, validTargets.map(t => t.id), '过河拆桥', this.buildContext(source.id));
    if (targetId === null) return false;
    const target = validTargets.find(t => t.id === targetId)!;

    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 对 ${target.name} 发动了【过河拆桥】！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: target.id, cardName: '过河拆桥' });

    // 技能钩子：成为非延时锦囊目标（哥伦比娅-少女）
    if (this.skillManager) {
      const magicResult = await this.skillManager.onMagicTargeted(target, card);
      if (magicResult.intercepted) return true;
    }

    if (await this.askForNullificationStack(target, source, false, card)) {
      this.eventBus.emit(GameEvent.Log, { message: '【无懈可击】起效！' });
      return true;
    }

    await this.performRansack(source, target, card, false);
    return true;
  }

  // ======================== 顺手牵羊 ========================

  private async executeSnatch(card: Card, source: PlayerState): Promise<boolean> {
    const validTargets = this.allPlayers.filter(t =>
      !t.isDead && t !== source &&
      getDistance(source, t, this.allPlayers) <= 1 &&
      (t.handCards.length > 0 || Object.values(t.equipZone).some(v => v !== null) || t.judgeZone.length > 0)
    );

    const driver = this.drivers.get(source.id)!;
    const targetId = await driver.promptTarget(source, validTargets.map(t => t.id), '顺手牵羊', this.buildContext(source.id));
    if (targetId === null) return false;
    const target = validTargets.find(t => t.id === targetId)!;

    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 对 ${target.name} 发动了【顺手牵羊】！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: target.id, cardName: '顺手牵羊' });

    // 技能钩子：成为非延时锦囊目标（哥伦比娅-少女）
    if (this.skillManager) {
      const magicResult = await this.skillManager.onMagicTargeted(target, card);
      if (magicResult.intercepted) return true;
    }

    if (await this.askForNullificationStack(target, source, false, card)) {
      this.eventBus.emit(GameEvent.Log, { message: '【无懈可击】起效！' });
      return true;
    }

    const stolen = await this.performRansack(source, target, card, true);
    if (stolen) {
      source.handCards.push(stolen);
    }
    return true;
  }

  // ======================== 借刀杀人 ========================

  private async executeBorrowWeapon(card: Card, source: PlayerState): Promise<boolean> {
    // 所有存活角色（用于目标选择，无武器的会变黑）
    const allAlive = this.allPlayers.filter(p => !p.isDead && p !== source);
    const weaponHolders = allAlive.filter(p => p.equipZone[EquipmentType.Weapon] !== null);

    if (weaponHolders.length === 0) {
      this.eventBus.emit(GameEvent.Log, { message: '场上没有持有武器的角色，【借刀杀人】无法使用。' });
      return false;
    }

    // 步骤1：选择有武器的目标（无武器的不可选）
    const driver = this.drivers.get(source.id)!;
    const targetAId = await driver.promptTarget(source, weaponHolders.map(t => t.id), '借刀杀人-选择武器持有者', this.buildContext(source.id));
    if (targetAId === null) return false;
    const targetA = weaponHolders.find(t => t.id === targetAId)!;
    const borrowedWeapon = targetA.equipZone[EquipmentType.Weapon]!;

    // 选 targetA 能杀到的目标
    const legalVictims = this.allPlayers.filter(t =>
      !t.isDead && t !== targetA &&
      getWeaponRange(targetA) >= getDistance(targetA, t, this.allPlayers)
    );

    if (legalVictims.length === 0) {
      this.eventBus.emit(GameEvent.Log, { message: `${targetA.name} 的武器射程内没有可攻击的目标。` });
      return false;
    }

    const victimId = await driver.promptTarget(source, legalVictims.map(t => t.id), '借刀杀人-选择出杀目标', this.buildContext(source.id));
    if (victimId === null) return false;
    const victimB = legalVictims.find(t => t.id === victimId)!;

    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 对 ${targetA.name} 使用了 ${getCardDetail(card)}，要求对 ${victimB.name} 出杀！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: targetA.id, cardName: card.name });

    // 技能钩子：成为非延时锦囊目标（哥伦比娅-少女）
    if (this.skillManager) {
      const magicResult = await this.skillManager.onMagicTargeted(targetA, card);
      if (magicResult.intercepted) return true;
    }

    if (await this.askForNullificationStack(targetA, source, false, card)) {
      this.eventBus.emit(GameEvent.Log, { message: '【无懈可击】起效！' });
      return true;
    }

    const targetADriver = this.drivers.get(targetA.id)!;
    const usedSlash = await this.damageSystem.askForResponse(targetA, '杀', card, source, targetADriver);

    if (usedSlash) {
      // 借刀出杀
      // 奈芙尔-蛇蝎：若因此打出的杀造成伤害，视为体力流失
      const isNefurSnake = !!(card as any)._nefurSnake;
      if (isNefurSnake) {
        (usedSlash as any)._nefurSnakeHealthLoss = true;
      }
      await this.processSingleSlash(usedSlash, targetA, victimB, 1);
    } else {
      // 武器归 source
      targetA.equipZone[EquipmentType.Weapon] = null;
      source.handCards.push(borrowedWeapon);
      this.eventBus.emit(GameEvent.CardEquipped, { playerId: source.id, card: borrowedWeapon, slot: EquipmentType.Weapon });
      this.eventBus.emit(GameEvent.Log, { message: `${targetA.name} 拒绝出杀，武器归 ${source.name}！` });
    }

    return true;
  }

  // ======================== 铁索连环 ========================

  private async executeIronChain(card: Card, source: PlayerState): Promise<boolean> {
    const driver = this.drivers.get(source.id)!;
    const mode = await driver.promptIronChainMode(source, this.buildContext(source.id));

    if (mode === 'recast') {
      // 重铸：摸1张牌（铁索由GameFlowController进弃牌堆）
      this.deck.drawCards(source, 1);
      this.eventBus.emit(GameEvent.Log, {
        message: `${source.name} 重铸了【铁索连环】，摸1张牌。`
      });
      return true;
    }

    // 连环模式：选择两个目标
    const alivePlayers = getAlivePlayers(this.allPlayers);
    if (alivePlayers.length < 2) {
      this.eventBus.emit(GameEvent.Log, { message: '场上不足2名角色，无法使用【铁索连环】连环模式。' });
      return false;
    }

    // 选第一个目标
    const validTargets1 = alivePlayers.map(p => p.id);
    const t1Id = await driver.promptTarget(source, validTargets1, '铁索连环-选择第一个目标', this.buildContext(source.id));
    if (t1Id === null) return false;
    const t1 = alivePlayers.find(p => p.id === t1Id)!;

    // 选第二个目标（不能与第一个相同）
    const validTargets2 = alivePlayers.filter(p => p.id !== t1Id).map(p => p.id);
    const t2Id = await driver.promptTarget(source, validTargets2, '铁索连环-选择第二个目标', this.buildContext(source.id));
    if (t2Id === null) return false;
    const t2 = alivePlayers.find(p => p.id === t2Id)!;

    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 对 ${t1.name}、${t2.name} 使用了 ${getCardDetail(card)}！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: t1.id, cardName: '铁索连环' });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: t2.id, cardName: '铁索连环' });

    for (const target of [t1, t2]) {
      // 技能钩子：成为非延时锦囊目标（哥伦比娅-少女）
      if (this.skillManager) {
        const magicResult = await this.skillManager.onMagicTargeted(target, card);
        if (magicResult.intercepted) continue;
      }
      if (await this.askForNullificationStack(target, source, false, card)) {
        continue;
      }
      target.isChained = !target.isChained;
      this.eventBus.emit(GameEvent.ChainedStateChanged, {
        playerId: target.id,
        isChained: target.isChained
      });
    }

    return true;
  }

  // ======================== 延时锦囊 ========================

  private async executeTimeDelayedKit(card: Card, source: PlayerState, kitName: string): Promise<boolean> {
    const limit = kitName === '兵粮寸断' ? 1 : 99;
    const validTargets = this.allPlayers.filter(t =>
      !t.isDead && t !== source &&
      getDistance(source, t, this.allPlayers) <= limit &&
      !t.judgeZone.some(c => c.name === kitName)
    );

    // 无合法目标 → 直接失败，避免调用 promptTarget 造成卡死
    if (validTargets.length === 0) return false;

    const driver = this.drivers.get(source.id)!;
    const targetId = await driver.promptTarget(source, validTargets.map(t => t.id), kitName, this.buildContext(source.id));
    if (targetId === null) return false;
    const target = validTargets.find(t => t.id === targetId)!;

    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 对 ${target.name} 使用了 ${getCardDetail(card)}！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: source.id, targetId: target.id, cardName: kitName });

    target.judgeZone.push(card);
    this.eventBus.emit(GameEvent.CardMovedToJudge, {
      playerId: target.id,
      card,
      kitName
    });
    return true;
  }

  // ======================== 闪电 ========================

  private executeLightning(card: Card, source: PlayerState): boolean {
    if (source.judgeZone.some(c => c.name === '闪电')) return false;
    source.judgeZone.push(card);
    this.eventBus.emit(GameEvent.Log, { message: `${source.name} 使用了 ${getCardDetail(card)}` });
    this.eventBus.emit(GameEvent.CardMovedToJudge, {
      playerId: source.id,
      card,
      kitName: '闪电'
    });
    return true;
  }

  // ======================== 无懈可击堆栈 ========================

  async askForNullificationStack(
    target: PlayerState,
    source: PlayerState,
    currentState: boolean,
    magicCard?: Card,
    depth: number = 0
  ): Promise<boolean> {
    // 艾尔海森-书记：锦囊来源是艾尔海森时，不能被无懈
    if (magicCard?.cardSource && this.skillManager?.isAlhaithamMagicImmune(magicCard.cardSource)) {
      return currentState;
    }

    // 艾尔海森-知论：扣置牌可当无懈可击 + 知论无懈不能被反无懈
    const hasNullifyInHand = (p: PlayerState) => p.handCards.some(c => c.name === '无懈可击');
    const hasKnowledgeNullify = (p: PlayerState) => this.skillManager?.hasAlhaithamKnowledge(p) ?? false;

    const potentialResponders = this.allPlayers.filter(p =>
      !p.isDead && (hasNullifyInHand(p) || hasKnowledgeNullify(p))
    );

    if (potentialResponders.length === 0) return currentState;

    for (const chooser of potentialResponders) {
      const driver = this.drivers.get(chooser.id)!;
      const ctx = this.buildContext(chooser.id);
      ctx.nullifyTargetId = target.id;
      ctx.nullifySourceId = source.id;
      ctx.nullifyCardName = magicCard?.name || '';
      const useIt = await driver.promptNullification(chooser, ctx);
      if (useIt) {
        // 优先用手中的无懈可击，否则用知论牌
        const handIdx = chooser.handCards.findIndex(c => c.name === '无懈可击');
        if (handIdx >= 0) {
          const nullifyCard = chooser.handCards.splice(handIdx, 1)[0];
          nullifyCard.cardSource = chooser;
          this.deck.sendToDiscard(nullifyCard);
          this.eventBus.emit(GameEvent.Log, {
            message: `${chooser.name} 打出了一张【无懈可击】！`
          });
          this.eventBus.emit(GameEvent.CardResponded, {
            playerId: chooser.id, card: nullifyCard, cardName: '无懈可击'
          });
          // 触发技能钩子（神里绫华-白鹭等）
          if (this.skillManager) {
            await this.skillManager.onAfterCardPlay(chooser, nullifyCard);
          }
          // 知论无懈不能被反无懈：depth=0时，chooser用的是知论牌，跳过递归
          const nextDeeper = await this.askForNullificationStack(target, chooser, !currentState, magicCard, depth + 1);
          if (depth === 1 && magicCard && this.skillManager) {
            await this.skillManager.onDoubleNullify(magicCard, target);
          }
          return nextDeeper;
        } else if (this.skillManager?.hasAlhaithamKnowledge(chooser)) {
          // 使用知论牌当无懈可击
          this.skillManager.useAlhaithamKnowledge(chooser);
          this.eventBus.emit(GameEvent.Log, {
            message: `${chooser.name} 使用了一张"知论"牌当作【无懈可击】（不可反无懈）！`
          });
          // 艾尔海森-书记：知论无懈不能被反无懈，直接return（不递归）
          if (depth === 1 && magicCard && this.skillManager) {
            await this.skillManager.onDoubleNullify(magicCard, target);
          }
          return !currentState;
        }
      }
    }

    return currentState;
  }

  // ======================== 跨区域掠夺/破坏 ========================

  async performRansack(
    source: PlayerState,
    target: PlayerState,
    sourceCard: Card,
    steal: boolean
  ): Promise<Card | null> {
    // 检查泉标记
    const hasSpring = this.skillManager ? !!this.skillManager.getSpringMarker(target.id) : false;

    const totalCards = target.handCards.length +
      Object.values(target.equipZone).filter(v => v !== null).length +
      target.judgeZone.length +
      (hasSpring ? 1 : 0);

    if (totalCards === 0) return null;

    const driver = this.drivers.get(source.id)!;
    const zoneSelection = await driver.promptZone(source, target.id, this.buildContext(source.id));
    if (!zoneSelection) return null;

    let selected: Card | null = null;

    if (zoneSelection.zone === 'equip') {
      const equipCards = Object.entries(target.equipZone)
        .filter(([, v]) => v !== null) as [EquipmentType, Card][];
      if (equipCards.length > 0) {
        const idx = zoneSelection.index ?? 0;
        const safeIdx = Math.min(Math.max(0, idx), equipCards.length - 1);
        const [slot, card] = equipCards[safeIdx];
        selected = card;
        // 防具离场效果（白银狮子回血等）
        if (slot === EquipmentType.Armor) {
          this.equipManager.handleArmorOnLose(target, card);
        }
        target.equipZone[slot] = null;
      }
    } else if (zoneSelection.zone === 'judge') {
      if (target.judgeZone.length > 0) {
        const idx = zoneSelection.index ?? 0;
        const safeIdx = Math.min(Math.max(0, idx), target.judgeZone.length - 1);
        selected = target.judgeZone.splice(safeIdx, 1)[0];
      }
    }

    // 手牌区：主动选择（而非盲抽）
    if (zoneSelection.zone === 'hand' || !selected) {
      if (target.handCards.length > 0) {
        // 使用promptRansackHand让玩家从目标手牌中选一张
        const idx = await (driver as any).promptRansackHand?.(source, target.id,
          this.buildContext(source.id)) ?? -1;
        const validIdx = (idx >= 0 && idx < target.handCards.length) ? idx :
          Math.floor(Math.random() * target.handCards.length);
        selected = target.handCards.splice(validIdx, 1)[0];
      }
    }

    // 如果没有选到任何牌但目标有泉标记，询问是否拆除泉
    if (!selected && hasSpring && this.skillManager) {
      const useSpring = await (driver as any).promptYesNo?.(
        `${target.name} 有一张"泉"标记，是否拆除它？`
      ) ?? false;
      if (useSpring) {
        selected = this.skillManager.removeSpringMarker(target.id);
      }
    }

    if (selected) {
      if (!steal) {
        this.deck.sendToDiscard(selected);
        this.eventBus.emit(GameEvent.Log, {
          message: `${source.name} 破坏了 ${target.name} 的 ${getCardDetail(selected)}`
        });
        // 过河拆桥弃置动画
        this.eventBus.emit(GameEvent.CardDismantled, {
          playerId: target.id,
          card: selected,
          cardName: selected.name,
          suit: selected.suit,
          number: selected.number,
        });
        return null;
      } else {
        // 顺手牵羊飞入动画
        this.eventBus.emit(GameEvent.CardStolen, {
          sourceId: source.id,
          targetId: target.id,
          card: selected,
          cardName: selected.name,
          suit: selected.suit,
          number: selected.number,
        });
        return selected;
      }
    }

    return null;
  }

  // ======================== 铁索连环传导 ========================

  async transmitChainedDamage(
    target: PlayerState,
    finalDamageTaken: number,
    sourceCard: Card | null,
    source: PlayerState | null,
    isChainedTransmission: boolean
  ): Promise<void> {
    if (!target.isChained) return;

    const isElementDamage = sourceCard &&
      (sourceCard.element === ElementType.Pyro || sourceCard.element === ElementType.Electro);

    if (!isElementDamage) return;

    target.isChained = false;
    this.eventBus.emit(GameEvent.ChainedStateChanged, {
      playerId: target.id,
      isChained: false
    });

    if (!isChainedTransmission) {
      this.eventBus.emit(GameEvent.Log, { message: '⚡ 铁索连锁反应开始传导！' });

      const chainedVictims = this.allPlayers.filter(p =>
        !p.isDead && p !== target && p.isChained
      );

      for (const otherPlayer of chainedVictims) {
        // 跳过在传导过程中已阵亡的角色（前一个连环受害者求桃失败死亡）
        if (otherPlayer.isDead) continue;
        this.eventBus.emit(GameEvent.Log, { message: `连锁传导 → ${otherPlayer.name}！` });
        await this.damageSystem.applyHpChange(otherPlayer, -finalDamageTaken, sourceCard, source, true);
        // 传导结算完成：清除该角色的连环标志（无论死亡还是被救活）
        otherPlayer.isChained = false;
        this.eventBus.emit(GameEvent.ChainedStateChanged, {
          playerId: otherPlayer.id,
          isChained: false
        });
      }
    }
  }

  // ======================== 辅助 ========================

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
