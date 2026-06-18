// ============================================================
// SkillManager.ts — 角色技能管理器
// ============================================================

import {
  PlayerState, Card, CardType, EquipmentType, GameContextSnapshot, IPlayerDriver
} from '../types';
import { GameEvent } from '../types';
import { DeckManager } from '../DeckManager';
import { EventBus } from '../EventBus';
import { getAlivePlayers } from '../DistanceCalc';
import { isSlash, getCardDetail, getCardColor } from '../Card';
import { getHandLimit, getRoleChineseName } from '../Player';
import { DamageSystem } from '../DamageSystem';
import { getDistance } from '../DistanceCalc';
import { SuitType, ColorType, ElementType } from '../types';

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  type: 'active' | 'passive' | 'trigger' | 'limited';
  usable: (player: PlayerState, ctx: GameContextSnapshot) => boolean;
}

export interface SkillHookResult {
  /** 是否拦截/修改了默认行为 */
  intercepted: boolean;
  /** 额外数据 */
  data?: any;
}

export class SkillManager {
  private deck: DeckManager;
  private eventBus: EventBus;
  private damageSystem: DamageSystem;
  private drivers: Map<number, IPlayerDriver>;
  private allPlayers: PlayerState[];

  /** 由外部注入（GamePage.initGameCore），供比喻等技能执行锦囊效果 */
  public cardEffectManager: { executeMagicByName: (cardName: string, source: PlayerState) => Promise<boolean>; handleActivePlay: (card: Card, source: PlayerState) => Promise<boolean> } | null = null;

  // 每个玩家的技能数据
  private playerSkillData: Map<number, any> = new Map();

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

  public getData(playerId: number): any {
    if (!this.playerSkillData.has(playerId)) {
      this.playerSkillData.set(playerId, {});
    }
    return this.playerSkillData.get(playerId);
  }

  // ======================== 获取玩家技能列表 ========================

  getSkills(player: PlayerState, ctx: GameContextSnapshot): SkillInfo[] {
    const skills: SkillInfo[] = [];
    switch (player.heroId) {
      case 'venti': this.addVentiSkills(skills, player, ctx); break;
      case 'zhongli': this.addZhongliSkills(skills, player, ctx); break;
      case 'raiden': this.addRaidenSkills(skills, player, ctx); break;
      case 'nahida': this.addNahidaSkills(skills, player, ctx); break;
      case 'furina': this.addFurinaSkills(skills, player, ctx); break;
      case 'mavuika': this.addMavuikaSkills(skills, player, ctx); break;
      case 'columbina': this.addColumbinaSkills(skills, player, ctx); break;
      case 'kazuha': this.addKazuhaSkills(skills, player, ctx); break;
      case 'yoimiya': this.addYoimiyaSkills(skills, player, ctx); break;
      case 'neuvillette': this.addNeuvilletteSkills(skills, player, ctx); break;
      case 'yae': this.addYaeSkills(skills, player, ctx); break;
      case 'xilonen': this.addXilonenSkills(skills, player, ctx); break;
      case 'zibai': this.addZibaiSkills(skills, player, ctx); break;
      case 'eula': this.addEulaSkills(skills, player, ctx); break;
      case 'wriothesley': this.addWriothesleySkills(skills, player, ctx); break;
      case 'hutao': this.addHutaoSkills(skills, player, ctx); break;
      case 'ningguang': this.addNingguangSkills(skills, player, ctx); break;
      case 'alhaitham': this.addAlhaithamSkills(skills, player, ctx); break;
      case 'xiao': this.addXiaoSkills(skills, player, ctx); break;
      case 'yelan': this.addYelanSkills(skills, player, ctx); break;
      case 'nilou': this.addNilouSkills(skills, player, ctx); break;
      case 'dehya': this.addDehyaSkills(skills, player, ctx); break;
      case 'lyneya': this.addLyneyaSkills(skills, player, ctx); break;
      case 'itto': this.addIttoSkills(skills, player, ctx); break;
      case 'kokomi': this.addKokomiSkills(skills, player, ctx); break;
      case 'kinich': this.addKinichSkills(skills, player, ctx); break;
      case 'mualani': this.addMualaniSkills(skills, player, ctx); break;
      case 'kaeya': this.addKaeyaSkills(skills, player, ctx); break;
      case 'diluc': this.addDilucSkills(skills, player, ctx); break;
      case 'jean': this.addJeanSkills(skills, player, ctx); break;
      case 'klee': this.addKleeSkills(skills, player, ctx); break;
      case 'keqing': this.addKeqingSkills(skills, player, ctx); break;
      case 'ayaka': this.addAyakaSkills(skills, player, ctx); break;
      case 'ganyu': this.addGanyuSkills(skills, player, ctx); break;
      case 'shenhe': this.addShenheSkills(skills, player, ctx); break;
      case 'nefur': this.addNefurSkills(skills, player, ctx); break;
      case 'lauma': this.addLaumaSkills(skills, player, ctx); break;
      case 'olorun': this.addOlorunSkills(skills, player, ctx); break;
      case 'citlali': this.addCitlaliSkills(skills, player, ctx); break;
    }

    // 丈八蛇矛作为额外技能
    if (player.equipZone[EquipmentType.Weapon]?.name === '丈八蛇矛') {
      skills.push({
        id: 'zhanba',
        name: '丈八',
        description: '可将两张手牌当【杀】使用或打出。',
        type: 'active',
        usable: (p) => p.handCards.length >= 2 && p.id === player.id,
      });
    }

    // 欧洛伦-残魂：偷来的技能
    const stolenSkills = this.getOlorunStolenSkills(player, ctx);
    for (const s of stolenSkills) {
      skills.push(s);
    }

    return skills;
  }

  /** 获取玩家技能数量（不含丈八） */
  getHeroSkillCount(heroId: string): number {
    const skillCounts: Record<string, number> = {
      'venti': 3, 'zhongli': 3, 'raiden': 3, 'nahida': 3,
      'furina': 3, 'mavuika': 3, 'columbina': 2,
      'kazuha': 2, 'yoimiya': 2,
      'neuvillette': 2, 'yae': 2, 'xilonen': 2, 'zibai': 1,
      'eula': 3, 'wriothesley': 2, 'hutao': 2, 'ningguang': 3,
      'alhaitham': 3, 'xiao': 2, 'yelan': 2, 'nilou': 4, 'dehya': 2,
      'lyneya': 2, 'itto': 2, 'kokomi': 2,
      'kinich': 3, 'mualani': 2, 'kaeya': 2, 'diluc': 2,
      'jean': 2, 'klee': 2,
      'keqing': 2, 'ayaka': 2, 'ganyu': 3, 'shenhe': 2,
      'nefur': 3, 'lauma': 2, 'olorun': 2, 'citlali': 3,
    };
    return skillCounts[heroId] || 0;
  }

  // ======================== 技能钩子 ========================

  /** 回合开始时 */
  async onTurnStart(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    switch (player.heroId) {
      case 'zhongli': await this.zhongliContract(player, ctx); break;
      case 'nilou': await this.nilouFlowerDance(player); break;
      case 'dehya': this.dehyaReturnCards(player); break;
      case 'hutao': this.hutaoEndCheck(player); break;
      case 'itto': await this.ittouRedOni(player, ctx); break;
      case 'olorun': await this.olorunSoul(player, ctx); break;
      case 'columbina':
        // 月神：摸牌阶段触发
        if (this.getData(player.id).lostMaiden) {
          await this.executeColumbinaMoon(player, ctx);
        }
        break;
      case 'mualani': await this.mualaniSpringCheck(player, ctx); break;
    }
  }

  /** 出牌阶段开始时 */
  async onPlayPhaseStart(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    switch (player.heroId) {
      case 'columbina': await this.columbinaMaidenStart(player, ctx); break;
      case 'xiao': await this.xiaoDemonTamer(player, ctx); break;
    }
  }

  /** 出牌阶段结束时 */
  async onPlayPhaseEnd(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    switch (player.heroId) {
      case 'columbina': await this.columbinaMaidenEnd(player, ctx); break;
    }
  }

  /** 每打出一张牌后立即触发（神里绫华-白鹭，类似张春华伤逝） */
  async onAfterCardPlay(player: PlayerState): Promise<void> {
    if (player.heroId === 'ayaka') {
      await this.ayakaHeronDraw(player);
    }
  }

  /** 回合结束时 */
  async onTurnEnd(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    switch (player.heroId) {
      case 'mavuika': this.mavuikaLeaderCheck(player); break;
      case 'kazuha': await this.kazuhaFallenLeaves(player, ctx); break;
      case 'hutao': this.hutaoEndCheck(player); break;
      case 'ningguang': await this.ningguangXuanji(player, ctx); break;
      case 'yelan': this.yelanExtraTurnCheck(player, ctx); break;
      case 'ganyu': await this.ganyuMoonseaTurnEnd(player, ctx); break;
    }
  }

  /** 成为杀的目标前（雷电将军-永恒） */
  onBeforeSlashTarget(target: PlayerState, source: PlayerState): SkillHookResult {
    if (target.heroId === 'raiden') {
      this.eventBus.emit(GameEvent.Log, { message: `【永恒】${target.name} 无法成为【杀】的目标！` });
      return { intercepted: true };
    }
    return { intercepted: false };
  }

  /** 受到伤害后 */
  async onAfterDamaged(player: PlayerState, damage: number, sourceCard: Card | null, source: PlayerState | null): Promise<void> {
    switch (player.heroId) {
      case 'venti': await this.ventiHighSky(player); break;
      case 'furina': await this.furinaSing(player); break;
      case 'yae': await this.yaeGuji(player); break;
      case 'dehya': await this.dehyaLionBristle(player, source); break;
    }
  }

  /** 体力值变化后（芙宁娜-歌颂） */
  async onHpChanged(player: PlayerState, delta: number): Promise<void> {
    if (player.heroId === 'furina' && delta !== 0) {
      await this.furinaSing(player);
    }
  }

  /** 濒死状态（芙宁娜-罪舞 首次, 胡桃-往生） */
  async onDying(player: PlayerState): Promise<SkillHookResult> {
    // 胡桃-往生：获得濒死角色所有手牌
    this.onHutaoRebirth(player);
    
    if (player.heroId === 'furina') {
      const data = this.getData(player.id);
      if (!data.sinDanceUsed) {
        return await this.furinaSinDance(player);
      }
    }
    return { intercepted: false };
  }

  /** 角色死亡时（胡桃-往生拿装备, 夜兰-幽客检查） */
  onPlayerDeath(deadPlayer: PlayerState): void {
    this.onHutaoRebirthEquip(deadPlayer);
  }

  /** 判定牌生效后（芙宁娜-正义, 那维莱特-龙权, 莱欧斯利-狱长） */
  onAfterJudge(player: PlayerState, judgeCard: Card, kitName?: string, effectTriggered?: boolean): void {
    if (player.heroId === 'furina') {
      this.furinaJustice(player, judgeCard);
    }
    // 那维莱特-龙权
    this.neuvilletteDragonAuthority(judgeCard, kitName || '', effectTriggered ?? false);
    // 莱欧斯利-狱长（只对乐不思蜀生效，但跳过赤鬼假乐不思蜀）
    if (kitName === '乐不思蜀' && !(kitName && (player as any)._ittouRedOniKit)) {
      this.wriothesleyWarden(player, effectTriggered ?? false);
    }
  }

  /** 延时锦囊效果处理完毕（荒泷一斗-赤鬼等） */
  async onAfterKitEffect(player: PlayerState, kitName: string, effectTriggered: boolean, kit: Card): Promise<void> {
    if ((kit as any)?._onifake && kit.name === '乐不思蜀' && player.heroId === 'itto') {
      const data = this.getData(player.id);
      if (!data.redOniPending) return;
      data.redOniPending = false;

      if (effectTriggered) {
        // 乐不思蜀生效：摸牌=已损失体力（上限-当前），跳过弃牌阶段
        player.skipDiscardPhase = true;
        const drawCount = player.maxHp - player.hp;
        this.eventBus.emit(GameEvent.Log, {
          message: `【赤鬼】${player.name} 的乐不思蜀生效！摸${drawCount}张牌，跳过弃牌阶段。`
        });
        this.deck.drawCards(player, drawCount);
      } else {
        // 乐不思蜀失效：弃所有手牌，恢复1点体力
        const count = player.handCards.length;
        if (count > 0) {
          for (const c of [...player.handCards]) {
            const idx = player.handCards.indexOf(c);
            if (idx >= 0) player.handCards.splice(idx, 1);
            this.deck.sendToDiscard(c);
          }
        }
        player.hp = Math.min(player.maxHp, player.hp + 1);
        this.eventBus.emit(GameEvent.Log, {
          message: `【赤鬼】${player.name} 的乐不思蜀失效！弃置${count}张牌，恢复1点体力。(HP:${player.hp})`
        });
        this.eventBus.emit(GameEvent.HpChanged, {
          playerId: player.id, newHp: player.hp, maxHp: player.maxHp, delta: 1, isDamage: false
        });
      }
    }
  }

  /** 使用非延时锦囊时（纳西妲-囚笼） */
  async onMagicUsed(player: PlayerState, card: Card): Promise<boolean> {
    if (player.heroId === 'nahida') {
      return await this.nahidaCage(player, card);
    }
    return false;
  }

  /** 延时锦囊能否生效（纳西妲-智慧） */
  canDelayKitAffect(player: PlayerState, kitName: string): boolean {
    if (player.heroId === 'nahida') {
      this.eventBus.emit(GameEvent.Log, { message: `【智慧】${player.name} 免疫延时锦囊！` });
      return false;
    }
    return true;
  }

  /** 成为非延时锦囊目标时（哥伦比娅-少女, 荒泷一斗-天牛） */
  onMagicTargeted(player: PlayerState, card: Card): SkillHookResult {
    if (player.heroId === 'columbina' && !this.getData(player.id).lostMaiden) {
      return this.columbinaMaidenProtect(player);
    }
    return this.ittouHeavenlyBull(player, card);
  }

  /** 造成伤害时（雷电将军-无想, 胡桃-幽蝶伤害加成） */
  async onDealingDamage(source: PlayerState, target: PlayerState, damage: number): Promise<SkillHookResult> {
    // 胡桃幽蝶伤害加成
    const hutaoBonus = this.getHutaoDamageBonus(source);
    let finalDamage = damage + hutaoBonus;
    
    if (source.heroId === 'raiden') {
      return await this.raidenMusou(source, target, finalDamage);
    }
    if (hutaoBonus > 0) {
      this.eventBus.emit(GameEvent.Log, {
        message: `【幽蝶】${source.name} 伤害+1，造成 ${finalDamage} 点伤害。`
      });
    }
    return { intercepted: false, data: { damage: finalDamage } };
  }

  /** 火属性伤害加成（玛薇卡-战争） */
  getFireDamageBonus(source: PlayerState): number {
    if (source.heroId === 'mavuika') return 1;
    // 检查场上所有纳塔角色
    const hasNataAlly = this.allPlayers.some(p =>
      !p.isDead && p.heroId === 'mavuika' && (p.region as any) === '纳塔'
    );
    if (source.region === '纳塔' && hasNataAlly) return 1;
    return 0;
  }

  /** 获取攻击范围加成（枫原万叶-红枫） */
  getSlashRangeBonus(source: PlayerState): number {
    if (source.heroId !== 'kazuha') return 0;
    const data = this.getData(source.id);
    const mapleLeaves: Card[] = data.mapleLeaves || [];
    return mapleLeaves.filter((l: Card) => l.name === '杀' || l.name === '火杀' || l.name === '雷杀').length;
  }

  /** 获取酒伤害加成（枫原万叶-红枫） */
  getAnalepticDamageBonus(source: PlayerState): number {
    if (source.heroId !== 'kazuha') return 0;
    const data = this.getData(source.id);
    const mapleLeaves: Card[] = data.mapleLeaves || [];
    return mapleLeaves.filter((l: Card) => l.name === '酒').length * 2;
  }

  /** 获取桃额外回复（枫原万叶-红枫） */
  getPeachHealBonus(source: PlayerState): number {
    if (source.heroId !== 'kazuha') return 0;
    const data = this.getData(source.id);
    const mapleLeaves: Card[] = data.mapleLeaves || [];
    return mapleLeaves.filter((l: Card) => l.name === '桃').length;
  }

  /** 宵宫琉金：是否免疫火属性伤害 */
  isImmuneToFire(player: PlayerState): boolean {
    return player.heroId === 'yoimiya';
  }

  /** 出牌阶段-主动技能可用性 */
  getActiveSkills(player: PlayerState, ctx: GameContextSnapshot): SkillInfo[] {
    return this.getSkills(player, ctx).filter(s => s.type === 'active' && s.usable(player, ctx));
  }

  /** 执行主动技能 */
  async executeActiveSkill(player: PlayerState, skillId: string, ctx: GameContextSnapshot): Promise<boolean> {
    switch (skillId) {
      case 'venti_free': return await this.ventiFree(player, ctx);
      case 'zhongli_contract': return await this.zhongliContract(player, ctx);
      case 'zhongli_leisure': return await this.zhongliLeisure(player, ctx);
      case 'raiden_decree': return await this.raidenDecree(player, ctx);
      case 'nahida_metaphor': return await this.nahidaMetaphor(player, ctx);
      case 'mavuika_holyFire': return await this.mavuikaHolyFire(player, ctx);
      case 'kazuha_redmaple': return await this.kazuhaRedMaple(player, ctx);
      case 'yoimiya_firework': return await this.yoimiyaFirework(player, ctx);
      case 'yae_charm': return await this.yaeCharm(player, ctx);
      case 'xilonen_craft': return await this.xilonenCraft(player, ctx);
      case 'xilonen_blessing': return await this.xilonenBlessing(player, ctx);
      case 'wriothesley_duke': return await this.wriothesleyDuke(player, ctx);
      case 'hutao_butterfly': return await this.hutaoButterfly(player, ctx);
      case 'ningguang_stars': return await this.ningguangStars(player, ctx);
      case 'ningguang_heaven': return await this.ningguangHeaven(player, ctx);
      case 'alhaitham_knowledge': return await this.alhaithamKnowledge(player, ctx);
      case 'yelan_spy': return await this.yelanSpy(player, ctx);
      case 'nilou_step': return this.nilouStep(player, ctx);
      case 'dehya_mercenary': return await this.dehyaMercenary(player, ctx);
      case 'ittou_redoni': return await this.ittouRedOni(player, ctx);
      case 'kokomi_strategist': return await this.kokomiStrategist(player, ctx);
      case 'kinich_fireback': return await this.kinichFireback(player, ctx);
      case 'mualani_spring': return await this.mualaniSpring(player, ctx);
      case 'kaeya_afternoon': return await this.kaeyaAfternoon(player, ctx);
      case 'kaeya_marker_wine': return this.kaeyaUseMarkerWine(player);
      case 'diluc_owl': return await this.dilucOwl(player, ctx);
      case 'diluc_marker_wine': return this.dilucUseMarkerWine(player);
      case 'jean_agent': return await this.jeanAgent(player, ctx);
      case 'klee_bombfish': return await this.kleeBombfish(player, ctx);
      case 'keqing_stars': return await this.keqingStars(player, ctx);
      case 'nefur_secret': return await this.nefurSecret(player, ctx);
      case 'lauma_moonsong': return await this.laumaMoonsong(player, ctx);
      case 'lauma_frostmoon': return await this.laumaFrostmoon(player, ctx);
      case 'olorun_soul': return await this.olorunSoul(player, ctx);
      case 'olorun_flute': return await this.olorunFlute(player, ctx);
      case 'zhanba': return false; // 丈八由EquipEffectManager处理
      default:
        // 欧洛伦-残魂：偷来的技能（格式: stolen_xxx）
        if (skillId.startsWith('stolen_')) {
          const originalSkillId = skillId.replace('stolen_', '');
          return await this.executeActiveSkill(player, originalSkillId, ctx);
        }
        return false;
    }
  }

  // ======================== 温迪技能 ========================

  private addVentiSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'venti_free',
      name: '自由',
      description: '锁定技：体力上限与手牌上限之和恒为8。每回合限一次，可将体力上限调整为1-7之间任意值。',
      type: 'active',
      usable: (p, c) => !data.freeUsedThisTurn && p.id === (c.currentPlayerId),
    });
    skills.push({
      id: 'venti_highsky',
      name: '高天',
      description: '受到伤害后，可将手牌补至手牌上限。',
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'venti_bard',
      name: '吟游',
      description: '回合外受到伤害进入濒死时，可选择将所有手牌当一张【酒】打出。',
      type: 'active',
      usable: () => true,
    });
  }

  private async ventiFree(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const driver = this.drivers.get(player.id)!;
    const data = this.getData(player.id);

    // 让玩家选择新的体力上限
    const newMaxHp = await (driver as any).promptVentiFree?.(player) ?? player.maxHp;
    if (newMaxHp < 1 || newMaxHp > 7) return false;

    const oldMaxHp = player.maxHp;
    player.maxHp = newMaxHp;
    // 手牌上限 = 8 - 体力上限
    const newHandLimit = 8 - newMaxHp;
    data.freeUsedThisTurn = true;
    data.customHandLimit = newHandLimit;

    if (player.hp > player.maxHp) player.hp = player.maxHp;
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【自由】，体力上限 ${oldMaxHp}→${newMaxHp}，手牌上限=${newHandLimit}`
    });
    return true;
  }

  private async ventiHighSky(player: PlayerState): Promise<void> {
    const handLimit = this.getEffectiveHandLimit(player);
    const deficit = handLimit - player.handCards.length;
    if (deficit > 0) {
      this.deck.drawCards(player, deficit);
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 发动【高天】，补了 ${deficit} 张手牌。`
      });
    }
  }

  /** 温迪-吟游：回合外将所有手牌当酒打出 */
  tryVentiBard(player: PlayerState, isSelfRescue: boolean): boolean {
    if (player.heroId !== 'venti') return false;
    if (player.handCards.length === 0) return false;
    // 只在回合外可用（isSelfRescue=true表示濒死自救）
    if (!isSelfRescue) return false;

    const cardCount = player.handCards.length;
    const cards = [...player.handCards];
    player.handCards = [];
    for (const c of cards) {
      this.deck.sendToDiscard(c);
    }
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【吟游】，将 ${cardCount} 张手牌当一张【酒】打出！`
    });
    return true;
  }

  // ======================== 钟离技能 ========================

  private addZhongliSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'zhongli_contract',
      name: '契约',
      description: '回合开始时，可将1枚"玉璋"标记交给一名其他角色建立契约关系。',
      type: 'active',
      usable: (p, c) => data.jadeCount >= 1 && p.id === (c.currentPlayerId),
    });
    skills.push({
      id: 'zhongli_jade',
      name: '玉璋',
      description: '锁定技：每轮开始增加2枚标记(上限4)。拥有标记的角色受伤害时移去1枚抵消1点伤害。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'zhongli_leisure',
      name: '闲游',
      description: '出牌阶段限一次，弃置1枚玉璋与场上任意一名其他角色交换座位。',
      type: 'active',
      usable: (p, c) => data.jadeCount >= 1 && !data.leisureUsedThisTurn && p.id === (c.currentPlayerId),
    });
  }

  async onRoundStart(): Promise<void> {
    // 钟离每轮加2枚玉璋
    // 艾尔海森每轮重置代贤标记
    for (const p of this.allPlayers) {
      if (p.isDead) continue;
      const data = this.getData(p.id);
      if (p.heroId === 'zhongli') {
        data.jadeCount = Math.min(4, (data.jadeCount || 0) + 2);
        this.eventBus.emit(GameEvent.Log, {
          message: `【玉璋】${p.name} 获得2枚玉璋标记（共${data.jadeCount}枚）。`
        });
      }
      // 代贤每轮限一次，新轮重置
      if (p.heroId === 'alhaitham') {
        data.actingUsedThisRound = false;
      }
      // 茜特菈莉-萨满：每轮限一次，新轮重置
      if (p.heroId === 'citlali') {
        data.shamanUsedThisRound = false;
      }
    }
  }

  private async zhongliContract(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length === 0) return false;
    if ((data.jadeCount || 0) < 1) return false; // 需要至少1枚玉璋标记

    const driver = this.drivers.get(player.id)!;
    // 先询问是否发动（可选技能）
    const useContract = await (driver as any).promptYesNo?.(
      `【契约】是否消耗1枚玉璋标记，与一名其他角色建立契约关系？（剩余${data.jadeCount || 0}枚）`
    ) ?? false;
    if (!useContract) return false;

    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '契约-选择角色', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.jadeCount--;
    data.contractPartnerId = target.id;
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 与 ${target.name} 建立【契约】关系，可互相使用对方手牌。`
    });
    return true;
  }

  private async zhongliLeisure(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '闲游-交换座位', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.jadeCount--;
    data.leisureUsedThisTurn = true;

    // 迁都式交换：将钟离从当前位置移除，插入到目标位置
    // 其他7位玩家的位置都会因此发生顺时针/逆时针变化
    const pi = this.allPlayers.indexOf(player);
    this.allPlayers.splice(pi, 1); // 移除钟离
    const tiNew = this.allPlayers.indexOf(target); // 目标新位置
    this.allPlayers.splice(tiNew + 1, 0, player); // 将钟离插入到目标后面（目标保持不动，其他玩家顺移）

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【闲游】，与 ${target.name} 交换了座位！`
    });
    return true;
  }

  /** 玉璋标记抵消伤害 */
  onJadeProtect(player: PlayerState, damage: number): number {
    const data = this.getData(player.id);
    let remaining = damage;
    while (remaining > 0 && (data.jadeCount || 0) > 0) {
      data.jadeCount--;
      remaining--;
      this.eventBus.emit(GameEvent.Log, {
        message: `【玉璋】${player.name} 移去1枚标记抵消1点伤害。（剩余${data.jadeCount}枚）`
      });
    }
    return remaining;
  }

  // ======================== 雷电将军技能 ========================

  private addRaidenSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'raiden_eternity',
      name: '永恒',
      description: '锁定技：无法成为【杀】的目标。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'raiden_decree',
      name: '御决',
      description: '出牌阶段限一次，选两名角色各摸1张，前者对后者发起决斗，然后可对败者打出一张不可闪避的杀。',
      type: 'active',
      usable: (p, c) => !data.decreeUsedThisTurn && p.id === (c.currentPlayerId),
    });
    skills.push({
      id: 'raiden_musou',
      name: '无想',
      description: '造成伤害时可防止此伤害获得1枚标记(上限3)；或不防止则伤害+X+1(X=标记×2)并移除所有标记。',
      type: 'trigger',
      usable: () => false,
    });
  }

  private async raidenDecree(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length < 2) return false;

    const driver = this.drivers.get(player.id)!;

    // 选第一个人
    const t1Id = await driver.promptTarget(player, aliveOthers.map(p => p.id), '御决-选择发起者', ctx);
    if (t1Id === null) return false;
    const t1 = aliveOthers.find(p => p.id === t1Id)!;

    // 选第二个人（不能与第一个相同）
    const remaining = aliveOthers.filter(p => p.id !== t1Id);
    const t2Id = await driver.promptTarget(player, remaining.map(p => p.id), '御决-选择目标', ctx);
    if (t2Id === null) return false;
    const t2 = remaining.find(p => p.id === t2Id)!;

    data.decreeUsedThisTurn = true;

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【御决】，令 ${t1.name} 对 ${t2.name} 发起决斗！`
    });

    // 各摸1张牌
    this.deck.drawCards(t1, 1);
    this.deck.drawCards(t2, 1);

    // t1对t2发起决斗
    const t1Driver = this.drivers.get(t1.id)!;
    const t2Driver = this.drivers.get(t2.id)!;

    let currentRespondent = t2;
    let other = t1;

    while (true) {
      const respDriver = this.drivers.get(currentRespondent.id)!;
      const response = await this.damageSystem.askForResponse(currentRespondent, '杀', null, player, respDriver);
      if (response) {
        [currentRespondent, other] = [other, currentRespondent];
      } else {
        // 败者受到伤害
        this.eventBus.emit(GameEvent.Log, {
          message: `${currentRespondent.name} 决斗失败！`
        });
        await this.damageSystem.applyHpChange(currentRespondent, -1, null, player);
        // 对败者打出不可闪避的杀
        if (!currentRespondent.isDead && player.handCards.some(c => isSlash(c))) {
          const slashCard = player.handCards.find(c => isSlash(c))!;
          const idx = player.handCards.indexOf(slashCard);
          player.handCards.splice(idx, 1);
          this.deck.sendToDiscard(slashCard);
          this.eventBus.emit(GameEvent.Log, {
            message: `${player.name} 对 ${currentRespondent.name} 打出 ${getCardDetail(slashCard)}（不可闪避）！`
          });
          // 不可闪避：直接造成伤害
          await this.damageSystem.applyHpChange(currentRespondent, -1, slashCard, player);
        }
        break;
      }
    }

    return true;
  }

  private async raidenMusou(source: PlayerState, target: PlayerState, damage: number): Promise<SkillHookResult> {
    const data = this.getData(source.id);
    const musouCount: number = data.musouCount || 0;

    const driver = this.drivers.get(source.id)!;
    const prevent = await (driver as any).promptYesNo?.(`是否发动【无想】防止此伤害？（当前标记：${musouCount}枚）`);

    if (prevent) {
      data.musouCount = Math.min(3, musouCount + 1);
      this.eventBus.emit(GameEvent.Log, {
        message: `${source.name} 发动【无想】防止了伤害，获得1枚标记（共${data.musouCount}枚）。`
      });
      return { intercepted: true };
    } else {
      const bonus = musouCount * 2;
      const totalDamage = damage + bonus + 1;
      data.musouCount = 0;
      this.eventBus.emit(GameEvent.Log, {
        message: `${source.name} 发动【无想】，伤害 ${damage}→${totalDamage}，移除所有标记。`
      });
      return { intercepted: false, data: { damage: totalDamage } };
    }
  }

  // ======================== 纳西妲技能 ========================

  private addNahidaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    skills.push({
      id: 'nahida_wisdom',
      name: '智慧',
      description: '锁定技：延时类锦囊无法对你生效。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'nahida_cage',
      name: '囚笼',
      description: '使用非延时锦囊时可弃置1张基本牌，令此牌生效两次。',
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'nahida_metaphor',
      name: '比喻',
      description: '出牌阶段限一次，可将手上所有锦囊牌当作一张非延时锦囊使用。',
      type: 'active',
      usable: (p, c) => {
        const data = this.getData(p.id);
        return !data.metaphorUsedThisTurn && p.handCards.some(c => c.type === 'Magic') && p.id === (c.currentPlayerId);
      },
    });
  }

  private async nahidaCage(player: PlayerState, card: Card): Promise<boolean> {
    const basicCards = player.handCards.filter(c => c.type === 'Basic');
    if (basicCards.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const useIt = await (driver as any).promptYesNo?.('是否发动【囚笼】弃置1张基本牌，令此锦囊生效两次？');
    if (!useIt) return false;

    // 让玩家主动选择弃哪张基本牌
    const ctx: GameContextSnapshot = this.buildContext(player.id);
    const cardIdx = await driver.promptSelectCard?.(player, '囚笼-选择1张基本牌弃置', c => c.type === 'Basic', ctx) ?? -1;
    if (cardIdx < 0) return false; // 取消
    
    const basic = player.handCards[cardIdx];
    player.handCards.splice(cardIdx, 1);
    this.deck.sendToDiscard(basic);
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【囚笼】，弃置了 ${getCardDetail(basic)}，令【${card.name}】生效两次！`
    });
    return true; // 调用者需要处理"生效两次"
  }

  private async nahidaMetaphor(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    // 手上所有锦囊牌（包括延时锦囊：乐不思蜀/兵粮寸断/闪电）
    const allMagicCards = player.handCards.filter(c => c.type === 'Magic');
    if (allMagicCards.length === 0) return false;

    const chosenCardName = (ctx as any).metaphorCardName;

    // 弃置所有锦囊牌（无论是否选择具体牌名，都先弃牌）
    const magicCount = allMagicCards.length;
    for (const mc of allMagicCards) {
      const idx = player.handCards.indexOf(mc);
      if (idx >= 0) player.handCards.splice(idx, 1);
      this.deck.sendToDiscard(mc);
    }

    data.metaphorUsedThisTurn = true;

    if (!chosenCardName) {
      // 用户取消选择 → 弃牌但无效果，技能仍视为已发动
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 发动【比喻】，弃置了 ${magicCount} 张锦囊牌（未选择目标锦囊，无额外效果）。`
      });
      return true;
    }

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【比喻】，将 ${magicCount} 张锦囊牌当作【${chosenCardName}】使用！`
    });

    // 通过 cardEffectManager 执行所选锦囊效果
    if (this.cardEffectManager) {
      const ok = await this.cardEffectManager.executeMagicByName(chosenCardName, player);
      if (!ok) {
        this.eventBus.emit(GameEvent.Log, {
          message: `【比喻】的【${chosenCardName}】无法生效（无合法目标/不可主动使用），但技能已发动。`
        });
      }
    } else {
      // 兜底：无 cardEffectManager 时技能仍视为已发动
      this.eventBus.emit(GameEvent.Log, {
        message: `【比喻】【${chosenCardName}】无效果（技能已发动）。`
      });
    }

    return true;
  }

  // ======================== 芙宁娜技能 ========================

  private addFurinaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'furina_justice',
      name: '正义',
      description: '锁定技：判定牌判定生效后，你获得此牌。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'furina_sing',
      name: '歌颂',
      description: '体力值变化后可判定：黑色则回复1点体力（不触发歌颂自身）。',
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'furina_sindance',
      name: '罪舞',
      description: `限定技：首次濒死时判定。红色回复3点体力；黑色指定一名角色造成3点伤害。${data.sinDanceUsed ? '（已使用）' : ''}`,
      type: 'limited',
      usable: () => !data.sinDanceUsed,
    });
  }

  private furinaJustice(player: PlayerState, judgeCard: Card): void {
    player.handCards.push(judgeCard);
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【正义】，获得了判定牌 ${getCardDetail(judgeCard)}`
    });
  }

  private async furinaSing(player: PlayerState): Promise<void> {
    const data = this.getData(player.id);
    if (data.singLock) return; // 防止歌颂触发歌颂自身

    data.singLock = true;
    const judgeCard = this.deck.dealOneCard();
    if (!judgeCard) { data.singLock = false; return; }

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【歌颂】，判定牌：${getCardDetail(judgeCard)}`
    });

    if (judgeCard.suit === SuitType.Spade || judgeCard.suit === SuitType.Club) {
      // 黑色：回复1点体力，判定生效触发正义
      if (player.hp < player.maxHp) {
        player.hp = Math.min(player.maxHp, player.hp + 1);
        this.eventBus.emit(GameEvent.Log, {
          message: `【歌颂】${player.name} 回复1点体力。当前HP: ${player.hp}/${player.maxHp}`
        });
      }
      this.furinaJustice(player, judgeCard);
    } else {
      // 红色：无效果，判定牌弃置
      this.deck.sendToDiscard(judgeCard);
    }
    data.singLock = false;
  }

  private async furinaSinDance(player: PlayerState): Promise<SkillHookResult> {
    const data = this.getData(player.id);
    data.sinDanceUsed = true;

    const judgeCard = this.deck.dealOneCard();
    if (!judgeCard) return { intercepted: false };

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【罪舞】！判定牌：${getCardDetail(judgeCard)}`
    });

    if (judgeCard.suit === SuitType.Heart || judgeCard.suit === SuitType.Diamond) {
      // 红色：回复3点体力，判定生效触发正义
      player.hp = Math.min(player.maxHp, player.hp + 3);
      this.eventBus.emit(GameEvent.Log, {
        message: `【罪舞】红色判定！${player.name} 回复3点体力。HP: ${player.hp}/${player.maxHp}`
      });
      this.furinaJustice(player, judgeCard);
      return { intercepted: true };
    } else {
      // 黑色：指定一名角色造成3点伤害，判定生效触发正义
      this.furinaJustice(player, judgeCard);
      const driver = this.drivers.get(player.id)!;
      const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
      const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '罪舞-选择目标造成3点伤害', {
        players: this.allPlayers, roundCount: 0, currentTurn: 0, currentPlayerId: player.id,
        gameOverWinner: null, drawPileCount: this.deck.drawPileCount, discardPileCount: this.deck.discardPile.length,
      });
      if (targetId !== null) {
        const target = aliveOthers.find(p => p.id === targetId)!;
        await this.damageSystem.applyHpChange(target, -3, null, player);
      }
      // 黑色造成伤害后，芙宁娜仍处于濒死，需要继续求桃
      return { intercepted: false };
    }
  }

  // ======================== 玛薇卡技能 ========================

  private addMavuikaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    skills.push({
      id: 'mavuika_war',
      name: '战争',
      description: '锁定技：你与所有纳塔阵营角色造成的火属性伤害+1。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'mavuika_holyFire',
      name: '圣火',
      description: '可将【杀】当【火杀】使用。若此【火杀】造成伤害，回复1点体力。',
      type: 'active',
      usable: (p, _c) => p.handCards.some(card => isSlash(card) && (!card.element || card.element === ElementType.None)),
    });
    skills.push({
      id: 'mavuika_leader',
      name: '领袖',
      description: '回合结束后若体力值为全场最高（或之一），直到下回合开始累计最多受到2点伤害。',
      type: 'trigger',
      usable: () => false,
    });
  }

  private async mavuikaHolyFire(player: PlayerState, _ctx: GameContextSnapshot): Promise<boolean> {
    const normalSlashes = player.handCards.filter(c => isSlash(c) && (!c.element || c.element === ElementType.None));
    if (normalSlashes.length === 0) return false;
    const driver = this.drivers.get(player.id)!;
    const useHoly = await (driver as any).promptYesNo?.(
      `【圣火】是否将 ${getCardDetail(normalSlashes[0])} 当【火杀】使用？（造成伤害可回复1点体力）`
    ) ?? false;
    if (!useHoly) return false;
    normalSlashes[0].element = ElementType.Pyro;
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【圣火】，将 ${getCardDetail(normalSlashes[0])} 转为【火杀】！`
    });
    return true;
  }

  /** 玛薇卡圣火回血 */
  onHolyFireDamage(source: PlayerState): void {
    if (source.heroId === 'mavuika' && source.hp < source.maxHp) {
      source.hp = Math.min(source.maxHp, source.hp + 1);
      this.eventBus.emit(GameEvent.Log, {
        message: `${source.name} 的【圣火】触发，回复1点体力。HP: ${source.hp}/${source.maxHp}`
      });
    }
  }

  private mavuikaLeaderCheck(player: PlayerState): void {
    const allAlive = this.allPlayers.filter(p => !p.isDead);
    if (allAlive.length === 0) return;
    const highestCurrentHp = Math.max(...allAlive.map(p => p.hp));
    const data = this.getData(player.id);
    if (player.hp >= highestCurrentHp) {
      data.leaderActive = true;
      data.leaderDamageTaken = 0;
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 的【领袖】激活！(HP ${player.hp}/${player.maxHp}，全场最高${highestCurrentHp})直到下回合开始最多受到2点伤害。`
      });
    } else {
      data.leaderActive = false;
      data.leaderDamageTaken = 0;
    }
  }

  /** 领袖减伤 */
  onLeaderProtect(player: PlayerState, damage: number): number {
    const data = this.getData(player.id);
    if (data.leaderActive) {
      const canTake = Math.max(0, 2 - (data.leaderDamageTaken || 0));
      const actual = Math.min(damage, canTake);
      data.leaderDamageTaken = (data.leaderDamageTaken || 0) + actual;
      if (actual < damage) {
        this.eventBus.emit(GameEvent.Log, {
          message: `【领袖】${player.name} 累计已受 ${data.leaderDamageTaken} 点伤害，减免了 ${damage - actual} 点。`
        });
      }
      return actual;
    }
    return damage;
  }

  // ======================== 哥伦比娅技能 ========================

  private addColumbinaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    if (!data.lostMaiden) {
      skills.push({
        id: 'columbina_maiden',
        name: '少女',
        description: '出牌阶段开始/结束时各减1体力上限获1枚"空月"标记。被非延时锦囊目标时可移去1枚令其无效。体力上限为1时重置为5(主公6)并失去此技能获"月神"。',
        type: 'trigger',
        usable: () => false,
      });
    } else {
      skills.push({
        id: 'columbina_moon',
        name: '月神',
        description: '每回合限一次，摸牌阶段可移去1枚"霜月"标记令摸牌数+X(X=空月标记数)，可选至多X名角色下回合摸牌-1。',
        type: 'trigger',
        usable: () => false,
      });
    }
  }

  private async columbinaMaidenStart(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    const data = this.getData(player.id);
    if (data.lostMaiden) return;

    const driver = this.drivers.get(player.id)!;
    const useIt = await (driver as any).promptYesNo?.('是否发动【少女】（出牌阶段开始时）？减少1点体力上限，获得1枚"空月"标记。');
    if (!useIt) return;

    player.maxHp -= 1;
    if (player.hp > player.maxHp) player.hp = player.maxHp;
    data.emptyMoonCount = (data.emptyMoonCount || 0) + 1;
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【少女】，体力上限-1（${player.maxHp}），获得1枚"空月"标记（共${data.emptyMoonCount}枚）。`
    });
    this.checkColumbinaTransform(player);
  }

  private async columbinaMaidenEnd(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    const data = this.getData(player.id);
    if (data.lostMaiden) return;

    const driver = this.drivers.get(player.id)!;
    const useIt = await (driver as any).promptYesNo?.('是否发动【少女】（出牌阶段结束时）？减少1点体力上限，获得1枚"空月"标记。');
    if (!useIt) return;

    player.maxHp -= 1;
    if (player.hp > player.maxHp) player.hp = player.maxHp;
    data.emptyMoonCount = (data.emptyMoonCount || 0) + 1;
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【少女】，体力上限-1（${player.maxHp}），获得1枚"空月"标记（共${data.emptyMoonCount}枚）。`
    });
    this.checkColumbinaTransform(player);
  }

  private checkColumbinaTransform(player: PlayerState): void {
    const data = this.getData(player.id);
    if (player.maxHp <= 1) {
      const isMonarch = player.role === 'Monarch' as any;
      player.maxHp = isMonarch ? 6 : 5;
      data.lostMaiden = true;
      data.frostMoonCount = (data.frostMoonCount || 0) + 1;
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 的体力上限重置为${player.maxHp}，失去【少女】，获得【月神】！`
      });
    }
  }

  private columbinaMaidenProtect(player: PlayerState): SkillHookResult {
    const data = this.getData(player.id);
    if ((data.emptyMoonCount || 0) > 0) {
      data.emptyMoonCount--;
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 移去1枚"空月"标记，令锦囊无效。（剩余${data.emptyMoonCount}枚）`
      });
      return { intercepted: true };
    }
    return { intercepted: false };
  }

  /** 哥伦比娅-月神：摸牌阶段+X，选择角色摸牌-1 */
  async executeColumbinaMoon(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    const data = this.getData(player.id);
    if (!data.lostMaiden) return; // 还没变成月神
    if (data.moonUsedThisTurn) return;
    if ((data.frostMoonCount || 0) <= 0) return;

    const emptyMoonCount = data.emptyMoonCount || 0;
    if (emptyMoonCount <= 0) {
      // 没有空月标记了，无法发动
      return;
    }

    // 询问是否发动
    const driver = this.drivers.get(player.id)!;
    const useIt = await (driver as any).promptYesNo?.(`是否发动【月神】？移去1枚"霜月"标记，摸牌数+${emptyMoonCount}，并可令至多${emptyMoonCount}名角色下回合摸牌-1。`);
    if (!useIt) return;

    // 移去1枚霜月标记
    data.frostMoonCount--;
    data.moonUsedThisTurn = true;

    // 摸牌数+X（由GameFlowController在摸牌阶段读取）
    data.moonBonusDraw = emptyMoonCount;

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【月神】，移去1枚"霜月"标记（剩余${data.frostMoonCount}枚），摸牌数+${emptyMoonCount}！`
    });

    // 选择至多X名其他角色下回合摸牌-1
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length > 0) {
      const targets: PlayerState[] = [];
      let remaining = emptyMoonCount;
      while (remaining > 0 && aliveOthers.filter(p => !targets.includes(p)).length > 0) {
        const available = aliveOthers.filter(p => !targets.includes(p));
        const targetId = await driver.promptTarget(player, available.map(p => p.id),
          `月神-选择角色下回合摸牌-1（还可选${remaining}名）`, ctx);
        if (targetId === null) break;
        const target = available.find(p => p.id === targetId)!;
        targets.push(target);
        remaining--;
      }

      for (const t of targets) {
        const tData = this.getData(t.id);
        tData.drawPenalty = (tData.drawPenalty || 0) + 1;
        this.eventBus.emit(GameEvent.Log, {
          message: `【月神】${t.name} 下回合摸牌数-1。`
        });
      }
    }
  }

  /** 获取哥伦比娅数据（供外部读取moonBonusDraw） */
  _getColumbinaData(player: PlayerState): any {
    return this.getData(player.id);
  }

  /** 获取并消耗希诺宁祝福的摸牌加成 */
  _consumeXilonenDrawBonus(player: PlayerState): number {
    const data = this.getData(player.id);
    const bonus = data.drawBonus || 0;
    data.drawBonus = 0;
    return bonus;
  }

  /** 获取八重神子宫司的额外杀次数 */
  _getYaeExtraSlashCount(player: PlayerState): number {
    const data = this.getData(player.id);
    return data.extraSlashCount || 0;
  }

  /** 重置八重神子宫司的额外杀次数 */
  _resetYaeExtraSlashCount(player: PlayerState): void {
    const data = this.getData(player.id);
    data.extraSlashCount = 0;
  }

  // ======================== 枫原万叶技能 ========================

  private addKazuhaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    const mapleLeaves: Card[] = data.mapleLeaves || [];
    skills.push({
      id: 'kazuha_redmaple',
      name: '红枫',
      description: '出牌阶段，将任意张基本牌扣置于武将牌上称为"枫"。每有一张"枫"获得效果：【杀】范围+1；【闪】摸1牌；【桃】回复+1；【酒】伤害+2。',
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return p.handCards.some(card => card.type === 'Basic') && p.id === (c.currentPlayerId);
      },
    });
    skills.push({
      id: 'kazuha_fallenleaves',
      name: '落叶',
      description: `回合结束时若你有"枫"，需弃置一张"枫"将其当【顺手牵羊】或【过河拆桥】使用。（当前${mapleLeaves.length}张）`,
      type: 'trigger',
      usable: () => false,
    });
  }

  private async kazuhaRedMaple(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    if (!data.mapleLeaves) data.mapleLeaves = [];

    const driver = this.drivers.get(player.id)!;
    const basicCards = player.handCards.filter(c => c.type === 'Basic');
    const hasStoredCards = data.mapleLeaves.length > 0;

    if (basicCards.length === 0 && !hasStoredCards) return false;

    // Step 1: 存牌还是打出？
    let storeMode = true;
    if (basicCards.length > 0 && hasStoredCards) {
      storeMode = await driver.promptYesNo?.('【红枫】存牌还是打出已存的牌？（是=存牌，否=打出）') ?? true;
    } else if (basicCards.length === 0 && hasStoredCards) {
      storeMode = false;
    }

    if (storeMode) {
      // 存牌模式：选择一张基本牌扣置为"枫"
      const cardIdx = await driver.promptSelectCard?.(player, '红枫-选择一张基本牌扣置为"枫"',
        c => c.type === 'Basic', ctx) ?? -1;
      if (cardIdx < 0) return false;

      const selected = player.handCards[cardIdx];
      player.handCards.splice(cardIdx, 1);
      data.mapleLeaves.push(selected);

      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 发动【红枫】，将 ${getCardDetail(selected)} 扣置为"枫"。（共${data.mapleLeaves.length}张）`
      });

      // 显示效果汇总
      this._kazuhaShowEffects(data.mapleLeaves);
    } else {
      // 打出模式：选择一张已存的"枫"牌打出
      const leafIdx = await driver.promptSelectCard?.(player,
        '红枫-选择一张"枫"牌打出',
        (_card) => true, ctx) ?? -1;
      if (leafIdx < 0) return false;

      const leaf = data.mapleLeaves[leafIdx];
      data.mapleLeaves.splice(leafIdx, 1);
      this.deck.sendToDiscard(leaf);

      // 创建虚拟牌并打出（使用 cardEffectManager 执行卡牌效果）
      const virtualCard: Card = {
        ...leaf,
        isVirtual: true,
        cardSource: player,
      };

      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 发动【红枫】，打出了"枫" ${getCardDetail(leaf)}。`
      });

      if (this.cardEffectManager) {
        await this.cardEffectManager.handleActivePlay(virtualCard, player);
      }
    }

    return true;
  }

  private _kazuhaShowEffects(mapleLeaves: Card[]): void {
    const effects: string[] = [];
    const slashCount = mapleLeaves.filter((l: Card) => l.name === '杀' || l.name === '火杀' || l.name === '雷杀').length;
    const dodgeCount = mapleLeaves.filter((l: Card) => l.name === '闪').length;
    const peachCount = mapleLeaves.filter((l: Card) => l.name === '桃').length;
    const wineCount = mapleLeaves.filter((l: Card) => l.name === '酒').length;
    if (slashCount > 0) effects.push(`攻击范围+${slashCount}`);
    if (dodgeCount > 0) effects.push(`摸${dodgeCount}牌`);
    if (peachCount > 0) effects.push(`桃额外回${peachCount}血`);
    if (wineCount > 0) effects.push(`下一张杀伤害+${wineCount * 2}`);
    if (effects.length > 0) {
      this.eventBus.emit(GameEvent.Log, {
        message: `【红枫】当前效果：${effects.join('；')}`
      });
    }
  }

  private async kazuhaFallenLeaves(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    const data = this.getData(player.id);
    const mapleLeaves: Card[] = data.mapleLeaves || [];
    if (mapleLeaves.length === 0) return;

    const driver = this.drivers.get(player.id)!;
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);

    // 处理所有"枫"（而非仅最后一张）
    while (mapleLeaves.length > 0) {
      if (aliveOthers.length === 0) break;

      const leaf = mapleLeaves.pop()!;
      this.deck.sendToDiscard(leaf);

      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 发动【落叶】，弃置了"枫" ${getCardDetail(leaf)}。`
      });

      // 选择当作顺手牵羊还是过河拆桥
      const asSnatch = await driver.promptYesNo?.('【落叶】是否当作【顺手牵羊】使用？（否=过河拆桥）');
      const kitName = asSnatch ? '顺手牵羊' : '过河拆桥';
      const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), 
        `落叶-选择【${kitName}】目标`, ctx);
      if (targetId === null) continue;
      const target = aliveOthers.find(p => p.id === targetId)!;

      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 将"枫"化作【${kitName}】对 ${target.name} 使用！`
      });

      if (kitName === '过河拆桥') {
        if (target.handCards.length > 0) {
          const rIdx = Math.floor(Math.random() * target.handCards.length);
          const discarded = target.handCards.splice(rIdx, 1)[0];
          this.deck.sendToDiscard(discarded);
          this.eventBus.emit(GameEvent.Log, {
            message: `【落叶】${player.name} 弃置了 ${target.name} 的 ${getCardDetail(discarded)}。`
          });
        }
      } else {
        if (target.handCards.length > 0) {
          const rIdx = Math.floor(Math.random() * target.handCards.length);
          const stolen = target.handCards.splice(rIdx, 1)[0];
          player.handCards.push(stolen);
          this.eventBus.emit(GameEvent.Log, {
            message: `【落叶】${player.name} 顺走了 ${target.name} 的一张牌。`
          });
        }
      }
    }
  }

  // ======================== 宵宫技能 ========================

  private addYoimiyaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    skills.push({
      id: 'yoimiya_goldfish',
      name: '琉金',
      description: '锁定技：你不能受到火属性伤害。',
      type: 'passive',
      usable: () => false,
    });
    const hasFirework = this.allPlayers.some(p => !p.isDead && (this.getData(p.id).hasFireworkMark));
    skills.push({
      id: 'yoimiya_firework',
      name: '夏祭',
      description: `弃置一张红桃牌为一名角色挂上"烟花"标记。有标记的角色使用【桃】时无效并引爆造成范围1点火伤。${hasFirework ? '（场上已有烟花）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        if (hasFirework) return false;
        return p.handCards.some(card => card.suit === SuitType.Heart) && p.id === (c.currentPlayerId);
      },
    });
  }

  private async yoimiyaFirework(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const heartCards = player.handCards.filter(c => c.suit === SuitType.Heart);
    if (heartCards.length === 0) return false;

    const aliveOthers = getAlivePlayers(this.allPlayers);
    if (aliveOthers.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const useIt = await driver.promptYesNo?.('是否发动【夏祭】弃置一张♥牌，为目标挂上"烟花"标记？');
    if (!useIt) return false;

    // 让玩家选择弃哪张红桃牌
    const ctx2 = this.buildContext(player.id);
    const cardIdx = await driver.promptSelectCard?.(player, '夏祭-选择一张♥牌弃置', 
      c => c.suit === SuitType.Heart, ctx2) ?? -1;
    if (cardIdx < 0) return false;

    const selected = player.handCards[cardIdx];
    player.handCards.splice(cardIdx, 1);
    this.deck.sendToDiscard(selected);

    // 选择目标
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '夏祭-选择烟花标记目标', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;
    const tData = this.getData(target.id);
    tData.hasFireworkMark = true;

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【夏祭】，弃置 ${getCardDetail(selected)}，为 ${target.name} 挂上"烟花"标记！`
    });

    return true;
  }

  /** 烟花引爆：当有标记的角色使用桃时触发 */
  async onFireworkExplosion(player: PlayerState): Promise<boolean> {
    const data = this.getData(player.id);
    if (!data.hasFireworkMark) return false;

    data.hasFireworkMark = false;
    this.eventBus.emit(GameEvent.Log, {
      message: `💥 ${player.name} 身上的"烟花"标记引爆！桃的效果无效。`
    });

    // 该角色及其距离1以内的所有角色各受到1点火属性伤害
    const affected = new Set<PlayerState>();
    affected.add(player);

    const alivePlayers = getAlivePlayers(this.allPlayers);
    for (const p of alivePlayers) {
      if (p.id === player.id) continue;
      // 简化：距离为1 = 相邻座位
      const pi = alivePlayers.indexOf(player);
      const ppi = alivePlayers.indexOf(p);
      const diff = Math.abs(pi - ppi);
      const dist = Math.min(diff, alivePlayers.length - diff);
      if (dist <= 1) affected.add(p);
    }

    for (const victim of affected) {
      if (victim.isDead) continue;
      // 创建虚拟火属性伤害卡
      const fireCard: Card = {
        id: -1, name: '烟花', type: CardType.Basic, suit: SuitType.None, number: 0,
        element: ElementType.Pyro,
        description: '', isVirtual: true,
        equipType: EquipmentType.None, weaponRange: 0, cardSource: null,
      };
      await this.damageSystem.applyHpChange(victim, -1, fireCard, player);
    }

    return true;
  }

  // ======================== 那维莱特技能 ========================

  private addNeuvilletteSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    skills.push({
      id: 'neuvillette_judge',
      name: '审判',
      description: '当一名角色的判定牌即将生效时，可弃置1张红色牌改花色，或弃置1张黑色牌改点数。',
      type: 'trigger',
      usable: () => false,
    });
    const data = this.getData(player.id);
    skills.push({
      id: 'neuvillette_authority',
      name: '龙权',
      description: `每回合限一次，当一名角色的判定牌判定生效后，你可以摸1张牌。${data.dragonUsedThisTurn ? '（本回合已触发）' : ''}`,
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 判定牌即将生效前（改判顺序：茜特菈莉-记忆 → 那维莱特-审判） */
  async onBeforeJudgeEffect(judgeCard: Card, judgeTarget: PlayerState): Promise<{ modified: boolean; card: Card }> {
    // 记录本次判定牌（茜特菈莉-记忆用）
    this.recordLastJudgeCard({...judgeCard});

    // 第一步：茜特菈莉-记忆（用上次判定牌替换）
    if (this.allPlayers.some(p => p.heroId === 'citlali' && !p.isDead)) {
      const citlaliResult = await this.citlaliMemoryReplace(judgeCard);
      if (citlaliResult.modified) {
        judgeCard = citlaliResult.card;
      }
    }

    // 第二步：那维莱特-审判（弃牌改花色/点数）
    const neuv = this.allPlayers.find(p => !p.isDead && p.heroId === 'neuvillette');
    if (!neuv) {
      // 如果茜特菈莉已经修改过，返回modified:true
      const wasModifiedByCitlali = this.allPlayers.some(p => p.heroId === 'citlali' && !p.isDead);
      return { modified: wasModifiedByCitlali, card: judgeCard };
    }

    // 红色牌：可弃置改花色；黑色牌：可弃置改点数
    const hasRed = neuv.handCards.some(c => c.suit === SuitType.Heart || c.suit === SuitType.Diamond);
    const hasBlack = neuv.handCards.some(c => c.suit === SuitType.Spade || c.suit === SuitType.Club);
    if (!hasRed && !hasBlack) return { modified: false, card: judgeCard };

    const driver = this.drivers.get(neuv.id)!;
    const ctx = this.buildContext(neuv.id);

    // 询问是否发动
    const useIt = await driver.promptYesNo?.(`【审判】是否弃置手牌修改 ${judgeTarget.name} 的判定牌？`);
    if (!useIt) return { modified: false, card: judgeCard };

    // 策略：优先用红色牌改花色为红桃（对抗乐不思蜀），其次用黑色牌改点数（对抗闪电2-9）
    if (hasRed && judgeCard.suit !== SuitType.Heart) {
      const cardIdx = await driver.promptSelectCard?.(neuv, '审判-选择一张红色牌弃置，改花色为♥', 
        c => c.suit === SuitType.Heart || c.suit === SuitType.Diamond, ctx) ?? -1;
      if (cardIdx < 0) {
        // 玩家取消改花色，尝试改用黑色牌改点数
        if (hasBlack && judgeCard.number >= 2 && judgeCard.number <= 9) {
          const blackIdx = await driver.promptSelectCard?.(neuv, '审判-选择一张黑色牌弃置，改点数', 
            c => c.suit === SuitType.Spade || c.suit === SuitType.Club, ctx) ?? -1;
          if (blackIdx >= 0) {
            const blackCard = neuv.handCards[blackIdx];
            neuv.handCards.splice(blackIdx, 1);
            this.deck.sendToDiscard(blackCard);
            const safeNumbers = [1, 10, 11, 12, 13];
            judgeCard.number = safeNumbers[Math.floor(Math.random() * safeNumbers.length)];
            this.eventBus.emit(GameEvent.Log, {
              message: `${neuv.name} 发动【审判】，弃置 ${getCardDetail(blackCard)}，将判定牌点数改为${judgeCard.number}！`
            });
            return { modified: true, card: judgeCard };
          }
        }
        return { modified: false, card: judgeCard };
      }
      const redCard = neuv.handCards[cardIdx];
      neuv.handCards.splice(cardIdx, 1);
      this.deck.sendToDiscard(redCard);
      judgeCard.suit = SuitType.Heart;
      this.eventBus.emit(GameEvent.Log, {
        message: `${neuv.name} 发动【审判】，弃置 ${getCardDetail(redCard)}，将判定牌花色改为♥！`
      });
      return { modified: true, card: judgeCard };
    }

    // 次选：用黑色牌改点数（避开闪电2-9）
    if (hasBlack && judgeCard.number >= 2 && judgeCard.number <= 9) {
      const cardIdx = await driver.promptSelectCard?.(neuv, '审判-选择一张黑色牌弃置，改点数', 
        c => c.suit === SuitType.Spade || c.suit === SuitType.Club, ctx) ?? -1;
      if (cardIdx < 0) return { modified: false, card: judgeCard };
      const blackCard = neuv.handCards[cardIdx];
      neuv.handCards.splice(cardIdx, 1);
      this.deck.sendToDiscard(blackCard);
      const safeNumbers = [1, 10, 11, 12, 13];
      judgeCard.number = safeNumbers[Math.floor(Math.random() * safeNumbers.length)];
      this.eventBus.emit(GameEvent.Log, {
        message: `${neuv.name} 发动【审判】，弃置 ${getCardDetail(blackCard)}，将判定牌点数改为${judgeCard.number}！`
      });
      return { modified: true, card: judgeCard };
    }

    return { modified: false, card: judgeCard };
  }

  /** 那维莱特-龙权：判定后摸牌 */
  private neuvilletteDragonAuthority(judgeCard: Card, kitName: string, effectTriggered: boolean): void {
    const neuv = this.allPlayers.find(p => !p.isDead && p.heroId === 'neuvillette');
    if (!neuv) return;
    const data = this.getData(neuv.id);
    if (data.dragonUsedThisTurn) return;
    data.dragonUsedThisTurn = true;
    this.deck.drawCards(neuv, 1);
    this.eventBus.emit(GameEvent.Log, {
      message: `${neuv.name} 发动【龙权】，摸1张牌。`
    });
  }

  // ======================== 八重神子技能 ========================

  private addYaeSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'yae_charm',
      name: '狐魅',
      description: '出牌阶段限一次，选择两名其他角色选择一项：1.对另一名使用一张【杀】；2.交给你一张牌。',
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.charmUsedThisTurn && getAlivePlayers(this.allPlayers).filter(q => q.id !== p.id).length >= 2
          && p.id === (c.currentPlayerId);
      },
    });
    skills.push({
      id: 'yae_guji',
      name: '宫司',
      description: '受到伤害后，可观看牌堆顶3张牌，放回1张，剩下2张交给任意角色。若给了其他角色，其下个出牌阶段内杀次数上限+1。',
      type: 'trigger',
      usable: () => false,
    });
  }

  private async yaeCharm(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length < 2) return false;

    const driver = this.drivers.get(player.id)!;
    const t1Id = await driver.promptTarget(player, aliveOthers.map(p => p.id), '狐魅-选择第一名角色', ctx);
    if (t1Id === null) return false;
    const t1 = aliveOthers.find(p => p.id === t1Id)!;
    const remaining = aliveOthers.filter(p => p.id !== t1Id);
    const t2Id = await driver.promptTarget(player, remaining.map(p => p.id), '狐魅-选择第二名角色', ctx);
    if (t2Id === null) return false;
    const t2 = remaining.find(p => p.id === t2Id)!;

    data.charmUsedThisTurn = true;

    // t1选择：对t2使用杀 或 交给八重一张牌
    const t1Driver = this.drivers.get(t1.id)!;
    const isT1Human = t1.id === 1; // 玩家1是人类
    let choice: number;

    if (isT1Human) {
      // 人类玩家默认选择出杀（选项0）
      choice = 0;
    } else {
      // AI 智能选择：
      // - 有杀且t2是敌人/手牌少 → 出杀（选项0）
      // - 没杀或t2是盟友且手牌多 → 交牌（选项1）
      const hasSlashCard = t1.handCards.some(c => isSlash(c));
      const t1DriverAny = t1Driver as any;
      // 判断t2是否为t1的敌人
      const t1IsEnemy = typeof t1DriverAny.isEnemy === 'function'
        ? t1DriverAny.isEnemy(t1, t2)
        : true; // 默认视为敌人
      
      if (hasSlashCard && t1IsEnemy) {
        choice = 0; // 出杀造成伤害
      } else if (hasSlashCard && t2.hp <= 1) {
        choice = 0; // t2残血，出杀收割
      } else if (t1.handCards.length >= 3) {
        choice = 1; // 手牌多，交一张给八重（可能是盟友）
      } else {
        choice = hasSlashCard ? 0 : 1;
      }
    }

    if (choice === 0) {
      // 对t2使用一张杀
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 发动【狐魅】！${t1.name} 选择对 ${t2.name} 使用一张【杀】。`
      });
      const slash = t1.handCards.find(c => isSlash(c));
      if (slash) {
        const idx = t1.handCards.indexOf(slash);
        t1.handCards.splice(idx, 1);
        this.deck.sendToDiscard(slash);
        // 杀不可闪避（狐魅效果）
        await this.damageSystem.applyHpChange(t2, -1, slash, t1);
      } else {
        this.eventBus.emit(GameEvent.Log, { message: `${t1.name} 没有【杀】可用。` });
      }
    } else {
      // 交给八重一张牌
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 发动【狐魅】！${t1.name} 选择交给 ${player.name} 一张牌。`
      });
      if (t1.handCards.length > 0) {
        // AI优先给价值最低的牌
        const priority: Record<string, number> = {
          '桃': 10, '无懈可击': 9, '酒': 8, '闪': 7,
          '杀': 5, '火杀': 5, '雷杀': 5,
        };
        let worstIdx = 0;
        let worstScore = Infinity;
        for (let i = 0; i < t1.handCards.length; i++) {
          const score = priority[t1.handCards[i].name] ?? 3;
          if (score < worstScore) {
            worstScore = score;
            worstIdx = i;
          }
        }
        const card = t1.handCards.splice(worstIdx, 1)[0];
        player.handCards.push(card);
      }
    }

    return true;
  }

  private async yaeGuji(player: PlayerState): Promise<void> {
    // 宫司：受到伤害后观看牌堆顶3张
    const topCards: Card[] = [];
    for (let i = 0; i < 3; i++) {
      const c = this.deck.dealOneCard();
      if (c) topCards.push(c);
    }
    if (topCards.length === 0) return;

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【宫司】，观看牌堆顶${topCards.length}张牌。`
    });

    // 放回1张
    const keep = topCards.shift()!;
    this.deck.returnToDrawPile([keep]);

    // 剩下2张交给任意角色
    const alivePlayers = getAlivePlayers(this.allPlayers);
    if (alivePlayers.length > 0 && topCards.length > 0) {
      const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      for (const c of topCards) {
        target.handCards.push(c);
      }
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 将 ${topCards.length} 张牌交给了 ${target.name}。`
      });
      if (target.id !== player.id) {
        const tData = this.getData(target.id);
        tData.extraSlashCount = (tData.extraSlashCount || 0) + 1;
        this.eventBus.emit(GameEvent.Log, {
          message: `${target.name} 下个出牌阶段杀次数上限+1！`
        });
      }
    }
  }

  // ======================== 希诺宁技能 ========================

  private addXilonenSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'xilonen_craft',
      name: '工匠',
      description: '出牌阶段限一次，失去1点体力，选择装备区有牌的角色。摸X张牌（X=其装备数），选X张手牌作为装备复制品装备给任意角色。',
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.craftUsedThisTurn && p.hp > 1 && p.id === (c.currentPlayerId);
      },
    });
    skills.push({
      id: 'xilonen_blessing',
      name: '祝福',
      description: '出牌阶段限一次，选择一名角色，令其下回合摸牌数增加X（X=其装备数/2，向下取整）。',
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.blessingUsedThisTurn && p.id === (c.currentPlayerId);
      },
    });
  }

  private async xilonenCraft(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    // 失去1点体力（体力流失）
    await this.damageSystem.applyHealthLoss(player, 1, player.name);

    // 选择装备区有牌的角色
    const targets = getAlivePlayers(this.allPlayers).filter(p => {
      return Object.values(p.equipZone).some(v => v !== null && (v as any).name);
    });
    if (targets.length === 0) {
      this.eventBus.emit(GameEvent.Log, { message: `${player.name} 发动【工匠】，但没有角色有装备。` });
      return false;
    }

    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, targets.map(p => p.id), '工匠-选择有装备的角色', ctx);
    if (targetId === null) return false;
    const target = targets.find(p => p.id === targetId)!;

    // 收集目标装备区的所有装备
    const equippedCards: { slot: string; card: Card }[] = [];
    for (const [slot, card] of Object.entries(target.equipZone)) {
      if (card && (card as Card).name) {
        equippedCards.push({ slot, card: card as Card });
      }
    }
    const equipCount = equippedCards.length;
    if (equipCount === 0) return false;

    data.craftUsedThisTurn = true;

    // 摸X张牌
    this.deck.drawCards(player, equipCount);

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【工匠】，失去1点体力，选择${target.name}（装备数${equipCount}），摸${equipCount}张牌。`
    });

    // 选择X张手牌作为装备复制品，装备给任意角色
    if (player.handCards.length >= equipCount && equipCount > 0) {
      const isAI = !(driver as any).promptSelectCard || (driver as any).isAI;

      if (isAI) {
        // AI简化：选取靠后的 equipCount 张手牌全装备给自己
        const copyCards = player.handCards.splice(player.handCards.length - equipCount, equipCount);
        for (let i = 0; i < equipCount; i++) {
          const template = equippedCards[i];
          const copyCard = copyCards[i];
          this.applyCraftCopy(copyCard, template);
          this.equipCraftCopy(player, copyCard, template.slot);
        }
      } else {
        // 人类玩家：选择X张手牌，再选择装备目标
        for (let i = 0; i < equipCount; i++) {
          const remaining = player.handCards.filter(c => !(c as any)._craftPicked);
          if (remaining.length === 0) break;

          // 第1步：选一张手牌作为原材料
          const cardIdx = await driver.promptSelectCard!(
            player,
            `工匠-选择第${i + 1}张手牌作为装备复制品（共需${equipCount}张）`,
            c => !(c as any)._craftPicked,
            this.buildContext(player.id)
          );
          if (cardIdx === null || cardIdx < 0) break;

          const rawCard = player.handCards[cardIdx];
          (rawCard as any)._craftPicked = true;

          // 第2步：选择装备模板（如果只剩1个模板，直接使用）
          let templateIdx = 0;
          if (equippedCards.length > 1) {
            // 简化：询问"复制第几个装备"（列出装备名称）
            const templateNames = equippedCards.map((e, idx) =>
              `[${idx + 1}] ${getCardDetail(e.card)}`);
            const chosen = await driver.promptTarget(
              player,
              equippedCards.map((_, idx) => idx),
              `工匠-选择要复制的装备模板:\n${templateNames.join('\n')}`,
              ctx
            );
            if (chosen === null) {
              (rawCard as any)._craftPicked = false;
              break;
            }
            templateIdx = chosen;
          }
          const template = equippedCards[templateIdx];

          // 第3步：选择装备目标
          const alivePlayers = getAlivePlayers(this.allPlayers);
          const equipTargetId = await driver.promptTarget(
            player,
            alivePlayers.map(p => p.id),
            `工匠-将 ${getCardDetail(template.card)} 的复制品装备给谁？`,
            ctx
          );
          if (equipTargetId === null) {
            (rawCard as any)._craftPicked = false;
            break;
          }
          const equipTarget = alivePlayers.find(p => p.id === equipTargetId)!;

          // 移出该卡并制作复制品
          player.handCards.splice(cardIdx, 1);
          delete (rawCard as any)._craftPicked;
          this.applyCraftCopy(rawCard, template);
          this.equipCraftCopy(equipTarget, rawCard, template.slot);
        }
      }
    }

    return true;
  }

  /** 将手牌转化为装备复制品（虚拟牌） */
  private applyCraftCopy(copyCard: Card, template: { slot: string; card: Card }): void {
    // 保存原始属性，供拆卸时还原
    (copyCard as any)._craftOriginal = {
      name: copyCard.name, type: copyCard.type,
      suit: copyCard.suit, number: copyCard.number,
      description: copyCard.description, element: copyCard.element,
      equipType: copyCard.equipType, weaponRange: copyCard.weaponRange,
    };
    copyCard.name = template.card.name;
    copyCard.type = template.card.type;
    copyCard.suit = template.card.suit;
    copyCard.number = template.card.number;
    copyCard.description = template.card.description;
    copyCard.element = template.card.element;
    copyCard.equipType = template.card.equipType;
    copyCard.weaponRange = template.card.weaponRange;
    copyCard.isVirtual = true;
  }

  /** 将工匠复制品装备到目标角色的对应槽位 */
  private equipCraftCopy(equipTarget: PlayerState, copyCard: Card, slot: string): void {
    if (!slot || slot === 'None') return;
    const oldEquip = equipTarget.equipZone[slot as EquipmentType];
    if (oldEquip) {
      this.deck.sendToDiscard(oldEquip);
    }
    equipTarget.equipZone[slot as EquipmentType] = copyCard;
    this.eventBus.emit(GameEvent.CardEquipped, {
      playerId: equipTarget.id,
      card: copyCard,
      slot
    });
    this.eventBus.emit(GameEvent.Log, {
      message: `【工匠】${equipTarget.name} 装备了复制品 ${getCardDetail(copyCard)}`
    });
  }

  private async xilonenBlessing(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers);

    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '祝福-选择角色', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    const equipCount = Object.values(target.equipZone).filter(v => v !== null && (v as any).name).length;
    const bonus = Math.floor(equipCount / 2);

    data.blessingUsedThisTurn = true;
    const tData = this.getData(target.id);
    tData.drawBonus = bonus;

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【祝福】，${target.name} 下回合摸牌数+${bonus}。`
    });
    return true;
  }

  // ======================== 兹白技能 ========================

  private addZibaiSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'zibai_threecorpses',
      name: '三尸',
      description: '1.出牌阶段使用的牌数为质数X且点数为X时摸X张。2.打出5的倍数张牌时获得1枚玉璋(上限2)。3.五谷丰登亮出牌数+1，兹白获得两张。',
      type: 'passive',
      usable: () => false,
    });
  }

  /** 兹白-三尸1：质数检测 */
  onZibaiPlayCardCheck(player: PlayerState, card: Card, cardsPlayedThisPhase: number): void {
    if (player.heroId !== 'zibai') return;
    const primes = new Set([2, 3, 5, 7, 11, 13]);
    if (primes.has(cardsPlayedThisPhase) && card.number === cardsPlayedThisPhase) {
      this.deck.drawCards(player, cardsPlayedThisPhase);
      this.eventBus.emit(GameEvent.Log, {
        message: `【三尸】${player.name} 使用的第${cardsPlayedThisPhase}张牌点数为${card.number}（质数），摸${cardsPlayedThisPhase}张牌！`
      });
    }
  }

  /** 兹白-三尸2：5的倍数给玉璋 */
  onZibaiMultipleCheck(player: PlayerState, cardsPlayedThisPhase: number): void {
    if (player.heroId !== 'zibai') return;
    if (cardsPlayedThisPhase > 0 && cardsPlayedThisPhase % 5 === 0) {
      const data = this.getData(player.id);
      const current = data.jadeCount || 0;
      if (current < 2) {
        data.jadeCount = current + 1;
        this.eventBus.emit(GameEvent.Log, {
          message: `【三尸】${player.name} 打出第${cardsPlayedThisPhase}张牌（5的倍数），获得1枚玉璋标记（共${data.jadeCount}枚）。`
        });
      }
    }
  }

  /** 兹白-三尸3：五谷丰登牌数+1，兹白获得两张 */
  getZibaiGraceBonus(): number {
    const zibai = this.allPlayers.find(p => !p.isDead && p.heroId === 'zibai');
    return zibai ? 1 : 0;
  }

  onZibaiGracePick(player: PlayerState, tableCards: Card[], resolve: (i: number) => void): void {
    if (player.heroId !== 'zibai') return;
    // 兹白获得两张牌（简化：自动选前两张）
    // 实际由外部调用
  }

  // ======================== 优菈技能 ========================

  private addEulaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    skills.push({
      id: 'eula_wave',
      name: '浪花',
      description: '锁定技：你的【杀】造成的伤害等于目标对你的距离。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'eula_return',
      name: '不归',
      description: '锁定技：其他角色对你的距离+1。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'eula_revenge',
      name: '复仇',
      description: '锁定技：你对其他角色的距离-1。',
      type: 'passive',
      usable: () => false,
    });
  }

  /** 优菈-不归：其他角色对优菈距离+1 */
  getEulaDistanceBonus(target: PlayerState, source: PlayerState): number {
    if (target.heroId === 'eula' && source.heroId !== 'eula') return 1;
    return 0;
  }

  /** 优菈-复仇：优菈对其他角色距离-1 */
  getEulaDistanceReduction(source: PlayerState, target: PlayerState): number {
    if (source.heroId === 'eula' && target.heroId !== 'eula') return 1;
    return 0;
  }

  /** 优菈-浪花：杀伤害=目标对优菈的距离 */
  getEulaSlashDamage(source: PlayerState, target: PlayerState, baseDamage: number): number {
    if (source.heroId !== 'eula') return baseDamage;
    const dist = getDistance(target, source, this.allPlayers);
    return Math.max(1, dist); // 至少1点伤害
  }

  // ======================== 莱欧斯利技能 ========================

  private addWriothesleySkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'wriothesley_warden',
      name: '狱长',
      description: '锁定技：当一名角色的【乐不思蜀】判定生效后，你对该角色造成1点伤害；判定失效后，你获得其1张牌。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'wriothesley_duke',
      name: '公爵',
      description: `出牌阶段，若你于上个回合结束后曾通过"狱长"获得过牌，可将任意一张黑色牌当【乐不思蜀】使用。${data.dukeActive ? '（可用）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        if (!d.dukeActive) return false;
        return p.handCards.some(card => getCardColor(card) === ColorType.Black) && p.id === (c.currentPlayerId);
      },
    });
  }

  /** 莱欧斯利-狱长：乐不思蜀联动 */
  private wriothesleyWarden(judgeTarget: PlayerState, effectTriggered: boolean): void {
    const wrio = this.allPlayers.find(p => !p.isDead && p.heroId === 'wriothesley');
    if (!wrio) return;
    const data = this.getData(wrio.id);

    if (effectTriggered) {
      // 乐不思蜀生效 → 造成1点伤害
      this.eventBus.emit(GameEvent.Log, {
        message: `【狱长】${wrio.name} 对 ${judgeTarget.name} 造成1点伤害！`
      });
      // 使用damageSystem直接调用
      this.damageSystem.applyHpChange(judgeTarget, -1, null, wrio);
    } else {
      // 乐不思蜀失效 → 获得1张牌
      if (judgeTarget.handCards.length > 0) {
        const rIdx = Math.floor(Math.random() * judgeTarget.handCards.length);
        const card = judgeTarget.handCards.splice(rIdx, 1)[0];
        wrio.handCards.push(card);
        data.dukeActive = true;
        this.eventBus.emit(GameEvent.Log, {
          message: `【狱长】${wrio.name} 获得了 ${judgeTarget.name} 的 ${getCardDetail(card)}。【公爵】可用！`
        });
      }
    }
  }

  private async wriothesleyDuke(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const blackCards = player.handCards.filter(c => getCardColor(c) === ColorType.Black);
    if (blackCards.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const useIt = await driver.promptYesNo?.('是否发动【公爵】弃置一张黑色牌，当【乐不思蜀】使用？');
    if (!useIt) return false;

    const ctx2 = this.buildContext(player.id);
    const cardIdx = await driver.promptSelectCard?.(player, '公爵-选择一张黑色牌当【乐不思蜀】', 
      c => getCardColor(c) === ColorType.Black, ctx2) ?? -1;
    if (cardIdx < 0) return false;

    const selected = player.handCards[cardIdx];
    player.handCards.splice(cardIdx, 1);
    this.deck.sendToDiscard(selected);

    // 选择目标
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '公爵-选择乐不思蜀目标', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;
    target.judgeZone.push({
      ...selected,
      name: '乐不思蜀',
    });

    data.dukeActive = false;
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【公爵】，将 ${getCardDetail(selected)} 当【乐不思蜀】对 ${target.name} 使用！`
    });
    return true;
  }

  // ======================== 胡桃技能 ========================

  private addHutaoSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'hutao_rebirth',
      name: '往生',
      description: '锁定技：当一名角色进入濒死状态时，你获得其所有手牌；当一名角色死亡后，你获得其装备区里的所有牌。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'hutao_butterfly',
      name: '幽蝶',
      description: `出牌阶段限一次，若体力值>1，可失去体力至1点。直到回合结束，造成的所有伤害+1；若击杀一名角色，回复2点体力。${data.butterflyActive ? '（已激活）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.butterflyUsedThisTurn && p.hp > 1 && p.id === (c.currentPlayerId);
      },
    });
  }

  /** 胡桃-往生：濒死时拿手牌 */
  onHutaoRebirth(dyingPlayer: PlayerState): void {
    const hutao = this.allPlayers.find(p => !p.isDead && p.heroId === 'hutao' && p.id !== dyingPlayer.id);
    if (!hutao || dyingPlayer.handCards.length === 0) return;

    const cards = [...dyingPlayer.handCards];
    dyingPlayer.handCards = [];
    hutao.handCards.push(...cards);
    this.eventBus.emit(GameEvent.Log, {
      message: `【往生】${hutao.name} 获得了 ${dyingPlayer.name} 的 ${cards.length} 张手牌！`
    });
  }

  /** 胡桃-往生：死亡时拿装备 */
  onHutaoRebirthEquip(deadPlayer: PlayerState): void {
    const hutao = this.allPlayers.find(p => !p.isDead && p.heroId === 'hutao' && p.id !== deadPlayer.id);
    if (!hutao) return;

    for (const slot of Object.values(EquipmentType)) {
      if (slot === EquipmentType.None) continue;
      const equip = deadPlayer.equipZone[slot];
      if (equip) {
        deadPlayer.equipZone[slot] = null;
        hutao.handCards.push(equip);
        this.eventBus.emit(GameEvent.Log, {
          message: `【往生】${hutao.name} 获得了 ${deadPlayer.name} 的装备 ${equip.name}！`
        });
      }
    }
  }

  private async hutaoButterfly(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    if (player.hp <= 1) return false;

    const hpLoss = player.hp - 1;
    // 失去体力至1点（体力流失）
    await this.damageSystem.applyHealthLoss(player, hpLoss, player.name);
    data.butterflyUsedThisTurn = true;
    data.butterflyActive = true;
    data.butterflyKilledThisTurn = false;

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【幽蝶】，体力流失至1点，造成的所有伤害+1！`
    });
    return true;
  }

  /** 胡桃-幽蝶：伤害加成 */
  getHutaoDamageBonus(source: PlayerState): number {
    if (source.heroId !== 'hutao') return 0;
    const data = this.getData(source.id);
    return data.butterflyActive ? 1 : 0;
  }

  /** 胡桃-幽蝶：击杀回血检查 */
  onHutaoKillCheck(killer: PlayerState, victim: PlayerState): void {
    if (killer.heroId !== 'hutao') return;
    const data = this.getData(killer.id);
    if (data.butterflyActive && !data.butterflyKilledThisTurn) {
      data.butterflyKilledThisTurn = true;
      killer.hp = Math.min(killer.maxHp, killer.hp + 2);
      this.eventBus.emit(GameEvent.Log, {
        message: `【幽蝶】${killer.name} 击杀角色，回复2点体力！HP: ${killer.hp}/${killer.maxHp}`
      });
    }
  }

  /** 胡桃回合结束清理标记 */
  private hutaoEndCheck(player: PlayerState): void {
    const data = this.getData(player.id);
    data.butterflyActive = false;
  }

  // ======================== 凝光技能 ========================

  private addNingguangSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'ningguang_stars',
      name: '七星',
      description: `限定技，出牌阶段，令你与一名角色各恢复2点体力并获得2枚"玉璋"标记。${data.starsUsed ? '（已使用）' : ''}`,
      type: 'limited',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.starsUsed && p.id === (c.currentPlayerId);
      },
    });
    skills.push({
      id: 'ningguang_heaven',
      name: '天权',
      description: '出牌阶段限一次，观看牌堆顶3张牌，指定其他角色猜花色。根据猜错数惩罚或奖励。',
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.heavenUsedThisTurn && p.id === (c.currentPlayerId);
      },
    });
    skills.push({
      id: 'ningguang_xuanji',
      name: '璇玑',
      description: '你的回合结束后，可以将一张牌置于牌堆顶。',
      type: 'trigger',
      usable: () => false,
    });
  }

  private async ningguangStars(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);

    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '七星-选择目标', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.starsUsed = true;

    // 各回复2点体力
    player.hp = Math.min(player.maxHp, player.hp + 2);
    target.hp = Math.min(target.maxHp, target.hp + 2);

    // 各获得2枚玉璋标记
    const pData = this.getData(player.id);
    pData.jadeCount = Math.min(4, (pData.jadeCount || 0) + 2);
    const tData = this.getData(target.id);
    tData.jadeCount = Math.min(4, (tData.jadeCount || 0) + 2);

    this.eventBus.emit(GameEvent.Log, {
      message: `【七星】${player.name} 与 ${target.name} 各回复2点体力，获得2枚玉璋标记！`
    });
    return true;
  }

  private async ningguangHeaven(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const topCards: Card[] = [];
    for (let i = 0; i < 3; i++) {
      const c = this.deck.dealOneCard();
      if (c) topCards.push(c);
    }
    if (topCards.length < 3) {
      // 牌不够，放回
      if (topCards.length > 0) this.deck.returnToDrawPile(topCards);
      return false;
    }

    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '天权-选择猜花色的角色', ctx);
    if (targetId === null) { this.deck.returnToDrawPile(topCards); return false; }
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.heavenUsedThisTurn = true;

    // 显示牌面（简化日志）
    const cardDescs = topCards.map(c => getCardDetail(c)).join(', ');
    this.eventBus.emit(GameEvent.Log, {
      message: `【天权】${player.name} 展示牌堆顶3张：${cardDescs}，${target.name} 需猜花色。`
    });

    // AI：逐张随机猜花色（每张独立1/4概率猜对）
    // 对于真人玩家，需要通过UI交互
    const suitNames: Record<string, string> = {
      [SuitType.Spade]: '♠',
      [SuitType.Heart]: '♥',
      [SuitType.Club]: '♣',
      [SuitType.Diamond]: '♦'
    };
    const suits = Object.values(SuitType).filter(s => s !== SuitType.None);
    
    let wrongCount = 0;
    const guesses: string[] = [];
    for (const card of topCards) {
      const correctSuit = card.suit;
      const guess = suits[Math.floor(Math.random() * suits.length)];
      guesses.push(guess);
      if (guess !== correctSuit) wrongCount++;
    }

    // 凝光视角显示猜测详情，其他人只显示结果
    const guessDetail = guesses.map((g, i) => {
      const actual = topCards[i].suit; // 使用实际花色变量
      return `第${i+1}张猜${suitNames[g]}`;
    }).join('，');
    this.eventBus.emit(GameEvent.Log, {
      message: `${target.name} 猜测花色：${guessDetail}（实际：${cardDescs}）`,
      visibleTo: [player.id]  // 仅凝光可见
    });

    // 公开日志：仅显示猜错数量
    this.eventBus.emit(GameEvent.Log, {
      message: `【天权】${target.name} 猜错了 ${wrongCount} 张牌的花色！`
    });

    if (wrongCount === 3) {
      target.skipDrawPhase = true;
      this.eventBus.emit(GameEvent.Log, { message: `${target.name} 跳过下个摸牌阶段！` });
    } else if (wrongCount === 2) {
      await this.damageSystem.applyHealthLoss(target, 1, target.name);
      this.eventBus.emit(GameEvent.Log, { message: `${target.name} 流失1点体力。` });
    } else if (wrongCount === 1) {
      // 获得点数最大的牌
      const maxCard = topCards.reduce((a, b) => a.number > b.number ? a : b);
      target.handCards.push(maxCard);
      const idx = topCards.indexOf(maxCard);
      topCards.splice(idx, 1);
      this.eventBus.emit(GameEvent.Log, { message: `${target.name} 获得 ${getCardDetail(maxCard)}。` });
    } else {
      // 全对：获得3张牌+回1点体力
      target.handCards.push(...topCards);
      target.hp = Math.min(target.maxHp, target.hp + 1);
      this.eventBus.emit(GameEvent.Log, { message: `${target.name} 全猜对！获得3张牌并回复1点体力。` });
      return true; // 牌已分配
    }

    // 弃置剩余牌
    for (const c of topCards) {
      this.deck.sendToDiscard(c);
    }
    return true;
  }

  private async ningguangXuanji(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    if (player.handCards.length === 0) return;
    const driver = this.drivers.get(player.id)!;
    // 先询问是否发动
    const doIt = await (driver as any).promptYesNo?.('是否发动【璇玑】？选择一张手牌置于牌堆顶（可取消）。');
    if (!doIt) return;
    const cardIdx = await driver.promptSelectCard?.(player, '璇玑-选择一张手牌置于牌堆顶', c => true, ctx) ?? -1;
    if (cardIdx < 0) return;
    const card = player.handCards.splice(cardIdx, 1)[0];
    this.deck.returnToDrawPile([card]);
    this.eventBus.emit(GameEvent.Log, {
      message: `【璇玑】${player.name} 将一张牌置于牌堆顶。`
    });
  }

  // ======================== 艾尔海森技能 ========================

  private addAlhaithamSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'alhaitham_secretary',
      name: '书记',
      description: '锁定技：你使用的锦囊牌不能被【无懈可击】响应。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'alhaitham_knowledge',
      name: '知论',
      description: `出牌阶段限两次，可将一张手牌置于武将牌上，这些牌可当【无懈可击】使用。（当前${(data.knowledgeCards || []).length}张）`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        const count = d.knowledgeUsedThisTurn || 0;
        return count < 2 && p.handCards.length > 0 && p.id === (c.currentPlayerId);
      },
    });
    skills.push({
      id: 'alhaitham_acting',
      name: '代贤',
      description: `每轮限一次，当一张锦囊牌被连续使用两张【无懈可击】后，可获得此锦囊牌。${data.actingUsedThisRound ? '（本轮已使用）' : ''}`,
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 艾尔海森-书记：锦囊不可被无懈 */
  isAlhaithamMagicImmune(source: PlayerState): boolean {
    return source.heroId === 'alhaitham';
  }

  private async alhaithamKnowledge(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const count = data.knowledgeUsedThisTurn || 0;
    if (count >= 2 || player.handCards.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const cardIdx = await driver.promptSelectCard?.(player, '知论-选择一张手牌扣置于武将牌上', c => true, ctx) ?? -1;
    if (cardIdx < 0) return false;

    const card = player.handCards.splice(cardIdx, 1)[0];
    if (!data.knowledgeCards) data.knowledgeCards = [];
    data.knowledgeCards.push(card);
    data.knowledgeUsedThisTurn = count + 1;

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【知论】，将 ${getCardDetail(card)} 置于武将牌上（共${data.knowledgeCards.length}张）。`
    });
    return true;
  }

  /** 艾尔海森-知论：可使用扣置的牌当无懈可击 */
  hasAlhaithamKnowledge(player: PlayerState): boolean {
    if (player.heroId !== 'alhaitham') return false;
    const data = this.getData(player.id);
    return (data.knowledgeCards || []).length > 0;
  }

  useAlhaithamKnowledge(player: PlayerState): boolean {
    const data = this.getData(player.id);
    if (!data.knowledgeCards || data.knowledgeCards.length === 0) return false;
    const card = data.knowledgeCards.pop();
    this.deck.sendToDiscard(card);
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 使用了一张"知论"牌当作【无懈可击】。`
    });
    return true;
  }

  /** 艾尔海森-代贤：双无懈后回收锦囊 */
  async onDoubleNullify(magicCard: Card, target: PlayerState): Promise<boolean> {
    // 查找艾尔海森
    const alhaitham = this.allPlayers.find(p => p.heroId === 'alhaitham' && !p.isDead);
    if (!alhaitham) return false;
    const data = this.getData(alhaitham.id);
    // 每轮限一次
    if (data.actingUsedThisRound) return false;

    // 询问艾尔海森是否要获得锦囊
    const driver = this.drivers.get(alhaitham.id);
    if (!driver) return false;
    const ctx: GameContextSnapshot = {
      players: this.allPlayers,
      roundCount: 0, currentTurn: 0, currentPlayerId: alhaitham.id,
      gameOverWinner: null, drawPileCount: 0, discardPileCount: 0,
    };
    const accept = await driver.promptYesNo?.(`【代贤】是否获得【${magicCard.name}】？`);
    if (accept) {
      alhaitham.handCards.push(magicCard);
      (magicCard as any)._daixianClaimed = true;
      data.actingUsedThisRound = true;
      this.eventBus.emit(GameEvent.Log, {
        message: `${alhaitham.name} 发动【代贤】，获得了【${magicCard.name}】。`
      });
      return true;
    }
    return false;
  }

  // ======================== 魈技能 ========================

  private addXiaoSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    const sealed = data.sealedSuits || {};
    const sealedList = Object.keys(sealed).filter(k => sealed[k]);
    skills.push({
      id: 'xiao_goldenwing',
      name: '金鹏',
      description: '锁定技：当其他角色对你使用【杀】时，须额外使用一张颜色不同的【杀】，否则此【杀】对你无效。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'xiao_demontamer',
      name: '降魔',
      description: `出牌阶段开始时，可弃置一种花色的所有手牌，直到下回合开始所有角色不能使用该花色的牌。${sealedList.length > 0 ? `已封印：${sealedList.join(',')}` : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return p.id === (c.currentPlayerId) && p.handCards.length > 0;
      },
    });
  }

  /** 魈-金鹏：需要双色杀 */
  isXiaoGoldenwingActive(target: PlayerState): boolean {
    return target.heroId === 'xiao';
  }

  /** 魈-降魔：封印花色 */
  private async xiaoDemonTamer(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    const data = this.getData(player.id);
    if (!data.sealedSuits) data.sealedSuits = {};

    // 统计手牌中各花色数量
    const suitCounts: Record<string, number> = {};
    for (const c of player.handCards) {
      suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
    }

    // 过滤出可封印的花色（未被封印且有手牌）
    const availableSuits = Object.entries(suitCounts).filter(([suit]) => !data.sealedSuits[suit]);
    if (availableSuits.length === 0) return;

    // 让玩家选择封印哪个花色（通过选择该花色的一张牌）
    const driver = this.drivers.get(player.id)!;
    const cardIdx = await driver.promptSelectCard?.(player, '降魔-选择一张牌，封印其花色并弃置所有该花色手牌', 
      c => !data.sealedSuits[c.suit], ctx) ?? -1;
    if (cardIdx < 0) return;

    const chosenSuit = player.handCards[cardIdx].suit;

    // 弃置该花色的所有手牌
    const toDiscard = player.handCards.filter(c => c.suit === chosenSuit);
    for (const c of toDiscard) {
      const idx = player.handCards.indexOf(c);
      if (idx >= 0) player.handCards.splice(idx, 1);
      this.deck.sendToDiscard(c);
    }

    data.sealedSuits[chosenSuit] = true;
    const suitNames: Record<string, string> = { Heart: '♥', Diamond: '♦', Spade: '♠', Club: '♣' };
    this.eventBus.emit(GameEvent.Log, {
      message: `【降魔】${player.name} 弃置了所有${suitNames[chosenSuit] || chosenSuit}花色手牌（${toDiscard.length}张），封印该花色直到下回合开始！`
    });
  }

  /** 魈-降魔：检查花色是否被封印 */
  isSuitSealed(suit: string): boolean {
    for (const p of this.allPlayers) {
      if (p.isDead) continue;
      const data = this.getData(p.id);
      if (data.sealedSuits && data.sealedSuits[suit]) return true;
    }
    return false;
  }

  // ======================== 夜兰技能 ========================

  private addYelanSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'yelan_lifeline',
      name: '络命',
      description: '锁定技：你造成的伤害均视为体力流失。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'yelan_spy',
      name: '幽客',
      description: `每回合限一次，可查看一名其他角色的身份牌。若被查看过身份的角色死亡，当前回合结束后获得一个完整回合。${data.spyUsedThisTurn ? '（本回合已使用）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.spyUsedThisTurn && p.id === (c.currentPlayerId);
      },
    });
  }

  /** 夜兰-络命：伤害视为体力流失 */
  isYelanDamageHealthLoss(source: PlayerState): boolean {
    return source.heroId === 'yelan';
  }

  private async yelanSpy(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '幽客-查看身份', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.spyUsedThisTurn = true;
    if (!data.spiedTargets) data.spiedTargets = [];
    data.spiedTargets.push(target.id);

    this.eventBus.emit(GameEvent.Log, {
      message: `【幽客】${player.name} 查看了 ${target.name} 的身份：${getRoleChineseName(target.role)}`
    });
    return true;
  }

  /** 夜兰-幽客：检查被查看者死亡获得额外回合 */
  private yelanExtraTurnCheck(player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    if (!data.spiedTargets || data.spiedTargets.length === 0) return;

    for (const targetId of data.spiedTargets) {
      const target = this.allPlayers.find(p => p.id === targetId);
      if (target && target.isDead) {
        data.spiedTargets = data.spiedTargets.filter((id: number) => id !== targetId);
        data.extraTurnPending = true;
        this.eventBus.emit(GameEvent.Log, {
          message: `【幽客】${player.name} 查看过的 ${target.name} 已死亡，获得一个额外回合！`
        });
        break;
      }
    }
  }

  /** 夜兰是否有额外回合待执行 */
  hasYelanExtraTurn(player: PlayerState): boolean {
    if (player.heroId !== 'yelan') return false;
    const data = this.getData(player.id);
    return !!data.extraTurnPending;
  }

  clearYelanExtraTurn(player: PlayerState): void {
    const data = this.getData(player.id);
    data.extraTurnPending = false;
  }

  // ======================== 妮露技能 ========================

  private addNilouSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    const stance = data.nilouStance || '水环';
    // 花舞：trigger类型，回合开始自动触发
    skills.push({
      id: 'nilou_dance',
      name: '花舞',
      description: '回合开始时，连续判定三次牌堆顶的牌：获得所有黑色判定牌；若至少两张红色，回复1点体力并弃置红色牌。',
      type: 'trigger',
      usable: () => false,
    });
    // 莲步：active类型，出牌阶段限一次切换状态
    skills.push({
      id: 'nilou_step',
      name: '莲步',
      description: `出牌阶段限一次，切换【水环】与【水月】状态。当前：${stance}。`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.stepUsedThisTurn && p.id === (c.currentPlayerId);
      },
    });
    // 水环/水月：active类型，显示当前激活的转换效果，点击触发转换选择
    if (stance === '水环') {
      const hasBlack = player.handCards.some(c => c.suit === SuitType.Spade || c.suit === SuitType.Club);
      skills.push({
        id: 'nilou_water_ring',
        name: '水环',
        description: '你的黑色手牌可以当【闪】使用或打出。',
        type: 'active',
        usable: () => hasBlack,
      });
    } else {
      const hasRed = player.handCards.some(c => c.suit === SuitType.Heart || c.suit === SuitType.Diamond);
      skills.push({
        id: 'nilou_water_moon',
        name: '水月',
        description: '你的红色手牌可以当【杀】使用或打出。',
        type: 'active',
        usable: () => hasRed,
      });
    }
  }

  private async nilouFlowerDance(player: PlayerState): Promise<void> {
    const data = this.getData(player.id);
    const judgeCards: Card[] = [];
    for (let i = 0; i < 3; i++) {
      const c = this.deck.dealOneCard();
      if (c) judgeCards.push(c);
    }
    if (judgeCards.length === 0) return;

    const blackCards = judgeCards.filter(c => c.suit === SuitType.Spade || c.suit === SuitType.Club);
    const redCards = judgeCards.filter(c => c.suit === SuitType.Heart || c.suit === SuitType.Diamond);

    this.eventBus.emit(GameEvent.Log, {
      message: `【花舞】${player.name} 判定3张牌：${judgeCards.map(c => getCardDetail(c)).join(', ')}`
    });

    // 获得黑色牌
    if (blackCards.length > 0) {
      player.handCards.push(...blackCards);
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 获得 ${blackCards.length} 张黑色判定牌。`
      });
    }

    // 至少两张红色 → 回复1点体力
    if (redCards.length >= 2 && player.hp < player.maxHp) {
      player.hp = Math.min(player.maxHp, player.hp + 1);
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 回复1点体力。HP: ${player.hp}/${player.maxHp}`
      });
    }

    // 弃置红色牌
    for (const c of redCards) {
      this.deck.sendToDiscard(c);
    }
  }

  private nilouStep(player: PlayerState, ctx: GameContextSnapshot): boolean {
    const data = this.getData(player.id);
    const current = data.nilouStance || '水环';
    data.nilouStance = current === '水环' ? '水月' : '水环';
    data.stepUsedThisTurn = true;

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【莲步】，切换为"${data.nilouStance}"状态。`
    });
    return true;
  }

  /** 妮露-莲步：手牌当闪/杀 */
  getNilouStanceConvert(player: PlayerState, card: Card): string | null {
    if (player.heroId !== 'nilou') return null;
    const data = this.getData(player.id);
    const stance = data.nilouStance || '水环';
    if (stance === '水环' && (card.suit === SuitType.Spade || card.suit === SuitType.Club)) {
      return '闪';
    }
    if (stance === '水月' && (card.suit === SuitType.Heart || card.suit === SuitType.Diamond)) {
      return '杀';
    }
    return null;
  }

  // ======================== 迪希雅技能 ========================

  private addDehyaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'dehya_mercenary',
      name: '佣兵',
      description: `出牌阶段限一次，与一名其他角色拼点。若赢，获得其所有手牌（不计入手牌上限），直到下回合开始，该角色受到的所有伤害由你承担。${data.mercenaryActive ? '（保护中）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.mercenaryUsedThisTurn && !d.mercenaryActive && p.handCards.length > 0 && p.id === (c.currentPlayerId);
      },
    });
    skills.push({
      id: 'dehya_lionbristle',
      name: '鬃狮',
      description: '受到【杀】的伤害后，可对目标来源使用1张【杀】，若此【杀】造成伤害则回复1点体力。',
      type: 'trigger',
      usable: () => false,
    });
  }

  private async dehyaMercenary(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id && p.handCards.length > 0);
    if (aliveOthers.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '佣兵-拼点目标', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    // 拼点：各选一张手牌比较点数
    const myCard = player.handCards[player.handCards.length - 1]; // 简化：用最后一张
    const theirCard = target.handCards[target.handCards.length - 1];

    player.handCards.pop();
    target.handCards.pop();
    this.deck.sendToDiscard(myCard);
    this.deck.sendToDiscard(theirCard);

    data.mercenaryUsedThisTurn = true;

    // 拼点播报：展示双方卡牌详情
    this.eventBus.emit(GameEvent.Log, {
      message: `【佣兵】拼点: ${player.name} ${getCardDetail(myCard)} VS ${target.name} ${getCardDetail(theirCard)}`
    });

    if (myCard.number > theirCard.number) {
      // 赢：获得所有手牌
      data.mercenaryActive = true;
      data.mercenaryTargetId = target.id;
      data.mercenaryCards = [...target.handCards];
      data.mercenaryOriginalOwner = target.id;
      player.handCards.push(...target.handCards);
      target.handCards = [];

      this.eventBus.emit(GameEvent.Log, {
        message: `【佣兵】${player.name} 拼点获胜！获得 ${target.name} 的所有手牌，直到下回合开始为其承担伤害。`
      });
    } else {
      this.eventBus.emit(GameEvent.Log, {
        message: `【佣兵】${player.name} 拼点失败。`
      });
    }
    return true;
  }

  /** 迪希雅-佣兵：回合开始返还手牌 */
  private dehyaReturnCards(player: PlayerState): void {
    const data = this.getData(player.id);
    if (!data.mercenaryActive) return;

    const targetId = data.mercenaryTargetId;
    const target = this.allPlayers.find(p => p.id === targetId);
    const cards: Card[] = data.mercenaryCards || [];

    // 返还仍在手中的牌
    const toReturn: Card[] = [];
    for (const c of cards) {
      const idx = player.handCards.indexOf(c);
      if (idx >= 0) {
        player.handCards.splice(idx, 1);
        toReturn.push(c);
      }
    }
    if (target && toReturn.length > 0) {
      target.handCards.push(...toReturn);
      this.eventBus.emit(GameEvent.Log, {
        message: `【佣兵】${player.name} 返还 ${target.name} 的 ${toReturn.length} 张牌。`
      });
    }

    data.mercenaryActive = false;
    data.mercenaryTargetId = undefined;
    data.mercenaryCards = [];
  }

  /** 迪希雅-佣兵：承担伤害 */
  onDehyaMercenaryProtect(target: PlayerState, damage: number): { protect: boolean; damage: number } {
    if (target.heroId === 'dehya') return { protect: false, damage };
    const dehya = this.allPlayers.find(p => !p.isDead && p.heroId === 'dehya');
    if (!dehya) return { protect: false, damage };
    const data = this.getData(dehya.id);
    if (!data.mercenaryActive || data.mercenaryTargetId !== target.id) return { protect: false, damage };

    // 伤害由迪希雅承担
    this.eventBus.emit(GameEvent.Log, {
      message: `【佣兵】${dehya.name} 为 ${target.name} 承担 ${damage} 点伤害！`
    });
    this.damageSystem.applyHpChange(dehya, -damage, null, target);
    return { protect: true, damage: 0 };
  }

  /** 迪希雅-鬃狮：被杀后反击 */
  private async dehyaLionBristle(player: PlayerState, source: PlayerState | null): Promise<void> {
    if (!source || source.isDead || player.heroId !== 'dehya') return;
    // 检查手牌中是否有杀
    const slash = player.handCards.find(c => isSlash(c));
    if (!slash) return;

    const idx = player.handCards.indexOf(slash);
    player.handCards.splice(idx, 1);
    this.deck.sendToDiscard(slash);

    this.eventBus.emit(GameEvent.Log, {
      message: `【鬃狮】${player.name} 对 ${source.name} 使用 ${getCardDetail(slash)}！`
    });

    // 造成伤害
    await this.damageSystem.applyHpChange(source, -1, slash, player);

    // 若造成伤害则回复
    if (!source.isDead) {
      // 检查是否造成了伤害（简化：目标仍存活说明造成了伤害，但也可能被闪避）
      // 这里简化处理：如果目标HP减少了就回血
    }
    if (player.hp < player.maxHp) {
      player.hp = Math.min(player.maxHp, player.hp + 1);
      this.eventBus.emit(GameEvent.Log, {
        message: `【鬃狮】${player.name} 回复1点体力。HP: ${player.hp}/${player.maxHp}`
      });
    }
  }

  // ======================== 辅助方法 ========================

  /** 莉奈娅-启喻：使用手牌时，翻牌堆顶联动 / 奈芙尔-蛇蝎 / 欧洛伦-庇笛 */
  async onBeforeCardUse(player: PlayerState, card: Card, ctx: GameContextSnapshot): Promise<{
    useCard: Card | null;      // null=取消, card=将要使用的牌
    returnCards: Card[];       // 需收回手牌的牌
  }> {
    const result = { useCard: card, returnCards: [] as Card[] };

    // 奈芙尔-蛇蝎：杀可以当借刀杀人使用
    if (player.heroId === 'nefur' && isSlash(card)) {
      const driver = this.drivers.get(player.id)!;
      const useBorrow = await (driver as any).promptYesNo?.(
        `【蛇蝎】是否将 ${getCardDetail(card)} 当【借刀杀人】使用？`
      );
      if (useBorrow) {
        // 创建一个虚拟的借刀杀人牌
        const fakeBorrowWeapon: Card = {
          ...card, name: '借刀杀人', type: CardType.Magic, isVirtual: true, cardSource: player
        };
        (fakeBorrowWeapon as any)._nefurSnake = true; // 标记为蛇蝎借刀杀人
        result.useCard = fakeBorrowWeapon;
        this.eventBus.emit(GameEvent.Log, {
          message: `【蛇蝎】${player.name} 将 ${getCardDetail(card)} 当【借刀杀人】使用！`
        });
        return result;
      }
      return result;
    }

    if (player.heroId !== 'lyneya') return result;
    const data = this.getData(player.id);

    // 本回合已发动过启喻 或 牌堆顶牌不可打出 → 不再发动，防止AI死循环
    if (data.revelationUsedThisTurn || data.revelationDisabledThisTurn) return result;

    const topCard = this.deck.peekTopCard();
    if (!topCard) return result;

    // 检查牌堆顶牌是否可打出：不可打出则本回合不再发动启喻
    if (!this.canPlayTopCard(topCard, player)) {
      data.revelationDisabledThisTurn = true;
      // 如果是AI驱动（promptYesNo存在且非人类驱动），记录跳过日志
      const driver = this.drivers.get(player.id);
      if (driver && !(driver as any).gamePage) {
        // AI驱动：静默跳过，不再触发本回合
        // HumanWebUIDriver 有 gamePage 属性，AIDriver 没有
        this.eventBus.emit(GameEvent.Log, {
          message: `【启喻】${player.name} 翻开牌堆顶 ${getCardDetail(topCard)} 无法打出，本回合不再发动启喻。`
        });
      }
      return result;
    }

    // 如果本回合这张牌已触发过启喻且替换牌失败，不再触发启喻，直接正常使用
    if (data.revelationFailedCard === card.name) {
      delete data.revelationFailedCard; // 清除标记，直接正常打出
      return result;
    }

    // 存储牌堆顶牌信息，稍后在出牌成功后显示（确保出牌日志在前）
    data._lyneyaTopCardLog = `【启喻】${player.name} 翻开牌堆顶：${getCardDetail(topCard)}`;

    // 花色相同：可以选择用翻开的牌替代
    if (card.suit !== 'None' && topCard.suit !== 'None' && card.suit === topCard.suit) {
      const driver = this.drivers.get(player.id)!;
      const useRevealed = await (driver as any).promptYesNo?.(
        `【启喻】牌堆顶 ${getCardDetail(topCard)} 与你的 ${getCardDetail(card)} 花色相同！\n是否改为使用翻开的牌并收回原牌？`
      );
      if (useRevealed) {
        // 取出牌堆顶牌
        const realTop = this.deck.dealOneCard();
        result.useCard = realTop || topCard;
        result.returnCards = [card];
        data.revelationUsedThisTurn = true;
        this.eventBus.emit(GameEvent.Log, {
          message: `【启喻】${player.name} 改为使用翻开的 ${getCardDetail(result.useCard)}，收回了 ${getCardDetail(card)}`
        });
        return result;
      }
    }

    // 点数相同：可以选择原牌当翻开的牌使用
    if (card.number === topCard.number && card.number > 0) {
      const driver = this.drivers.get(player.id)!;
      const useAsRevealed = await (driver as any).promptYesNo?.(
        `【启喻】牌堆顶 ${getCardDetail(topCard)} 与你的 ${getCardDetail(card)} 点数相同(${card.number})！\n是否将原牌当作翻开的牌使用并收回翻开的牌？`
      );
      if (useAsRevealed) {
        // 从摸牌堆取出真正的牌堆顶牌给玩家
        const realTop = this.deck.dealOneCard();
        // 创建一个虚拟副本当牌使用
        const virtualCopy: Card = { ...topCard, isVirtual: true };
        result.useCard = virtualCopy;
        // 收回真正的那张牌到手中
        result.returnCards = realTop ? [realTop] : [];
        data.revelationUsedThisTurn = true;
        this.eventBus.emit(GameEvent.Log, {
          message: `【启喻】${player.name} 将原牌当作翻开的 ${getCardDetail(topCard)} 使用，获得了牌堆顶牌`
        });
        return result;
      }
    }

    // 都不匹配或不想发动，牌堆顶牌不变

    return result;
  }

  /** 判断牌堆顶牌是否可以被主动打出（供启喻使用，防止AI死循环） */
  private canPlayTopCard(card: Card, player: PlayerState): boolean {
    if (card.type === 'Equipment') return true;
    if (card.name === '无中生有') return true;
    if (card.name === '桃') return player.hp < player.maxHp;
    if (card.name === '酒') return player.nextSlashDamageBonus === 0;
    if (isSlash(card)) {
      const canSlashFree = player.equipZone?.['Weapon']?.name === '诸葛连弩';
      return player.slashUsedCount < 1 || canSlashFree;
    }
    // 其他锦囊/基本牌：理论上都有目标，先返回true
    return true;
  }

  /** 获取莉奈娅谶鸟可看到的牌堆顶牌（仅UI展示用） */
  getLyneyaTopCard(player: PlayerState): Card | null {
    if (player.heroId !== 'lyneya') return null;
    return this.deck.peekTopCard();
  }

  // ======================== 莉奈娅技能 ========================

  private addLyneyaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'lyneya_omenbird',
      name: '谶鸟',
      description: '锁定技：牌堆顶的1张牌对你始终可见。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'lyneya_revelation',
      name: '启喻',
      description: `主动使用手牌时可翻牌堆顶：同花则可用翻开牌并收回原牌；同点则可当翻开牌使用并收回翻开牌。${data.revelationUsedThisTurn ? '（本回合已发动）' : ''}`,
      type: 'trigger',
      usable: () => false,
    });
  }

  // ======================== 荒泷一斗技能 ========================

  private addIttoSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'ittou_redoni',
      name: '赤鬼',
      description: `回合开始时可失去1点体力，获得【乐不思蜀】效果。生效则摸牌=已损失体力并跳弃牌；失效则弃所有牌并回复1点。${data.redOniUsedThisRound ? '（本轮已发动）' : ''}`,
      type: 'active',
      usable: (p, c) => !this.getData(p.id).redOniUsedThisRound && p.hp > 0 && p.id === (c.currentPlayerId),
    });
    skills.push({
      id: 'ittou_heavenlybull',
      name: '天牛',
      description: '锁定技：当你的手牌数小于你的体力值时，其他角色不能以你为目标使用单体锦囊牌。',
      type: 'passive',
      usable: () => false,
    });
  }

  /** 荒泷一斗-赤鬼 */
  async ittouRedOni(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    if (data.redOniUsedThisRound) return false;
    const driver = this.drivers.get(player.id)!;
    const txt = `是否发动【赤鬼】？失去1点体力，获得【乐不思蜀】效果。`;
    const useIt = await (driver as any).promptYesNo?.(txt);
    if (!useIt) return false;

    data.redOniUsedThisRound = true;
    data.redOniPending = true; // 标记等待判定结果
    await this.damageSystem.applyHealthLoss(player, 1, player.name);
    this.eventBus.emit(GameEvent.Log, {
      message: `【赤鬼】${player.name} 失去1点体力，获得【乐不思蜀】效果！`
    });

    // 顶替现有的乐不思蜀
    player.judgeZone = player.judgeZone.filter(c => c.name !== '乐不思蜀');
    // 创建假的乐不思蜀放入判定区
    const fakeBliss: Card = {
      id: -9000 - player.id,
      name: '乐不思蜀',
      type: 'Magic' as any,
      suit: 'Heart' as any,
      number: 0,
      description: '赤鬼生成的乐不思蜀效果',
      isVirtual: true,
      element: ElementType.None,
      equipType: EquipmentType.None,
      weaponRange: 0,
      mtMagicTargetType: 'Single' as any,
      mtMagicTimeType: 'Delay' as any,
    } as any as Card;
    (fakeBliss as any)._onifake = true;
    player.judgeZone.push(fakeBliss);

    return true;
  }

  /** 荒泷一斗-天牛 */
  private ittouHeavenlyBull(player: PlayerState, card: Card): SkillHookResult {
    if (player.heroId !== 'itto') return { intercepted: false };
    const singleTargetMagic = ['过河拆桥', '顺手牵羊', '决斗', '火攻', '借刀杀人'];
    if (!singleTargetMagic.includes(card.name)) return { intercepted: false };
    if (player.handCards.length >= player.hp) return { intercepted: false };

    this.eventBus.emit(GameEvent.Log, {
      message: `【天牛】${player.name} 手牌数(${player.handCards.length})<体力值(${player.hp})，免疫单体锦囊！`
    });
    return { intercepted: true };
  }

  // ======================== 珊瑚宫心海技能 ========================

  private addKokomiSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'kokomi_strategist',
      name: '军师',
      description: `出牌阶段限一次，可将任意张手牌交给一名其他角色，然后可以视为使用【桃园结义】。${data.strategistUsedThisTurn ? '（本回合已使用）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.strategistUsedThisTurn && p.handCards.length > 0 && p.id === (c.currentPlayerId);
      },
    });
    skills.push({
      id: 'kokomi_oracle',
      name: '神巫',
      description: '当你打出【桃园结义】时，若此时回复的体力值总和为X，则你摸X张牌。',
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 珊瑚宫心海-军师 */
  private async kokomiStrategist(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length === 0 || player.handCards.length === 0) return false;

    const driver = this.drivers.get(player.id)!;

    // 选择目标
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '军师-选择给牌目标', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    // 选择给哪些牌（简化：AI给所有，人类通过交互选择）
    let giveCards: Card[] = [];
    if ((driver as any).promptSelectMultipleCards) {
      const indices = await (driver as any).promptSelectMultipleCards(
        player, '军师-选择要送出的牌（可多选）', () => true, ctx
      );
      if (indices === null || indices.length === 0) return false;
      giveCards = indices.sort((a: number, b: number) => b - a).map((i: number) => {
        const [c] = player.handCards.splice(i, 1);
        return c;
      });
    } else {
      // 简化：AI随机给1张
      if (player.handCards.length === 0) return false;
      const [c] = player.handCards.splice(0, 1);
      giveCards = [c];
    }

    // 送牌
    target.handCards.push(...giveCards);
    data.strategistUsedThisTurn = true;
    this.eventBus.emit(GameEvent.Log, {
      message: `【军师】${player.name} 将${giveCards.length}张牌交给 ${target.name}。`
    });

    // 是否触发桃园结义
    const usePeach = await (driver as any).promptYesNo?.('是否发动【军师】，视为使用【桃园结义】？');
    if (usePeach) {
      this.eventBus.emit(GameEvent.Log, {
        message: `【军师】${player.name} 视为使用【桃园结义】！`
      });
      // 执行桃园结义效果
      await this.kokomiPeachGardenEffect(player);
    }

    return true;
  }

  /** 珊瑚宫心海-桃园结义效果（含神巫计数） */
  async kokomiPeachGardenEffect(source: PlayerState): Promise<void> {
    const total = this.allPlayers.length;
    const startIndex = this.allPlayers.indexOf(source);
    let totalHealed = 0;

    for (let i = 0; i < total; i++) {
      const target = this.allPlayers[(startIndex + i) % total];
      if (target.isDead) continue;
      if (target.hp < target.maxHp) {
        target.hp = Math.min(target.maxHp, target.hp + 1);
        totalHealed++;
        this.eventBus.emit(GameEvent.HpChanged, {
          playerId: target.id, newHp: target.hp, maxHp: target.maxHp, delta: 1, isDamage: false
        });
        this.eventBus.emit(GameEvent.Log, {
          message: `${target.name} 回复1点体力。(HP:${target.hp}/${target.maxHp})`
        });
      }
    }

    // 神巫：回复体力总和为X，摸X张牌
    if (source.heroId === 'kokomi' && totalHealed > 0) {
      this.eventBus.emit(GameEvent.Log, {
        message: `【神巫】桃园结义回复体力总和为${totalHealed}，${source.name} 摸${totalHealed}张牌！`
      });
      this.deck.drawCards(source, totalHealed);
    }
  }

  /** 珊瑚宫心海-神巫（真正的桃园结义打出时触发） */
  onKokomiPeachGarden(source: PlayerState, totalHealed: number): void {
    if (source.heroId !== 'kokomi' || totalHealed <= 0) return;
    this.eventBus.emit(GameEvent.Log, {
      message: `【神巫】桃园结义回复体力总和为${totalHealed}，${source.name} 摸${totalHealed}张牌！`
    });
    this.deck.drawCards(source, totalHealed);
  }

  // ======================== 基尼奇技能 ========================

  private addKinichSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'kinich_fireback',
      name: '回火',
      description: `可将一张装备牌当【火攻】使用。若造成伤害，可获得目标的任意一张手牌。${data.firebackUsedThisTurn ? '（本回合已发动）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.firebackUsedThisTurn && p.id === (c.currentPlayerId) && p.handCards.some(card => card.type === CardType.Equipment);
      },
    });
    skills.push({
      id: 'kinich_ajaw',
      name: '阿乔',
      description: `出牌阶段限一次，当你造成火属性伤害时，可令一名角色进入连环状态。${data.ajawUsedThisTurn ? '（本回合已发动）' : ''}`,
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'kinich_price',
      name: '价格',
      description: '锁定技：当你成为【杀】的目标时，来源需再对你使用一张【杀】。若无法使用则此【杀】无效；若打出则你不可闪避。',
      type: 'passive',
      usable: () => false,
    });
  }

  /** 基尼奇-回火：装备牌当火攻使用（从装备区选择），造成伤害则获得目标随机一张手牌 */
  private async kinichFireback(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const driver = this.drivers.get(player.id)!;

    // 1. 从装备区选择一张装备牌
    const equipEntries = (Object.entries(player.equipZone) as [EquipmentType, Card | null][])
      .filter(([, card]) => card !== null) as [EquipmentType, Card][];
    if (equipEntries.length === 0) return false;

    let chosenEntry: [EquipmentType, Card] | null = null;
    if (equipEntries.length === 1) {
      // 只有一件装备：确认后直接使用
      const confirm = await (driver as any).promptYesNo?.(
        `【回火】是否牺牲装备区的【${equipEntries[0][1].name}】当【火攻】使用？`
      ) ?? true; // AI默认确认
      if (confirm) chosenEntry = equipEntries[0];
    } else {
      // 多件装备：逐件询问
      for (const entry of equipEntries) {
        const yes = await (driver as any).promptYesNo?.(
          `【回火】是否牺牲装备区的【${entry[1].name}】当【火攻】使用？`
        ) ?? false;
        if (yes) { chosenEntry = entry; break; }
      }
    }
    if (!chosenEntry) return false;

    const [equipSlot, equipCard] = chosenEntry;
    player.equipZone[equipSlot] = null; // 卸下装备
    this.eventBus.emit(GameEvent.Log, {
      message: `【回火】${player.name} 卸下装备区的 ${getCardDetail(equipCard)} 当【火攻】使用！`
    });

    // 2. 创建虚拟火攻卡牌（含火元素，用于玛薇卡战争加成）
    const fireCard: Card = {
      id: equipCard.id, name: '火攻', type: CardType.Magic, suit: equipCard.suit,
      number: equipCard.number, element: ElementType.Pyro, description: `【火攻】（回火）`,
      equipType: EquipmentType.None, weaponRange: 0, cardSource: player, isVirtual: true,
    };

    // 3. 选择目标（必须有手牌）
    const validTargets = this.allPlayers.filter(t => !t.isDead && t.handCards.length > 0);
    if (validTargets.length === 0) {
      this.eventBus.emit(GameEvent.Log, { message: '没有手牌的目标，回火取消。' });
      this.deck.sendToDiscard(equipCard);
      return true;
    }
    const targetId = await driver.promptTarget(player, validTargets.map(t => t.id), '火攻', ctx);
    if (targetId === null) {
      this.deck.sendToDiscard(equipCard);
      return true;
    }
    const target = validTargets.find(t => t.id === targetId)!;

    this.eventBus.emit(GameEvent.Log, { message: `${player.name} 对 ${target.name} 发动了【火攻】！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: player.id, targetId: target.id, cardName: '火攻' });

    // 4. 目标展示一张牌
    const targetDriver = this.drivers.get(target.id)!;
    const showIdx = await targetDriver.promptShowCard(target, this.buildContext(target.id));
    const shownCard = target.handCards[showIdx] ?? target.handCards[0];
    this.eventBus.emit(GameEvent.CardRevealed, {
      playerId: target.id, card: shownCard, cardName: shownCard.name,
    });
    this.eventBus.emit(GameEvent.Log, {
      message: `${target.name} 展示了 ${getCardDetail(shownCard)}`
    });

    // 5. 源玩家弃置同花色牌
    const sourceResp = await this.damageSystem.askForSuitResponse(player, shownCard.suit, fireCard, player, driver);
    if (sourceResp) {
      this.eventBus.emit(GameEvent.Log, { message: '火攻成功！' });

      // 记录目标当前HP，判断是否造成伤害
      const oldHp = target.hp;
      await this.damageSystem.applyHpChange(target, -1, fireCard, player);

      // 若造成伤害，主动选择是否获得随机一张手牌
      if (target.hp < oldHp && target.handCards.length > 0 && !target.isDead) {
        const steal = await (driver as any).promptYesNo?.(
          `【回火】是否获得 ${target.name} 的随机一张手牌？`
        ) ?? true;
        if (steal) {
          const randomIdx = Math.floor(Math.random() * target.handCards.length);
          const stolen = target.handCards.splice(randomIdx, 1)[0];
          player.handCards.push(stolen);
          this.eventBus.emit(GameEvent.Log, {
            message: `【回火】${player.name} 获得了 ${target.name} 的 ${stolen.name}！`
          });
        }
      }
    } else {
      this.eventBus.emit(GameEvent.Log, {
        message: `${player.name} 没有同花色牌，火攻失败。`
      });
      this.deck.sendToDiscard(equipCard);
    }

    data.firebackUsedThisTurn = true;
    return true;
  }

  /** 基尼奇-阿乔：造成火属性伤害时，可令一名角色进入连环状态 */
  onKinichAjaw(source: PlayerState, target: PlayerState): void {
    if (source.heroId !== 'kinich') return;
    const data = this.getData(source.id);
    if (data.ajawUsedThisTurn) return;

    // 异步执行
    this.kinichAjawExecute(source);
  }

  private async kinichAjawExecute(source: PlayerState): Promise<void> {
    const data = this.getData(source.id);
    if (data.ajawUsedThisTurn) return;

    const driver = this.drivers.get(source.id)!;
    const useAjaw = await (driver as any).promptYesNo?.(
      '【阿乔】是否令一名角色进入连环状态？'
    ) ?? false;
    if (!useAjaw) return;

    // 选择一名角色
    const validTargets = this.allPlayers.filter(t => !t.isDead);
    const targetId = await driver.promptTarget(source, validTargets.map(t => t.id), '阿乔-选择连环目标',
      this.buildContext(source.id));
    if (targetId === null) return;
    const target = validTargets.find(t => t.id === targetId)!;

    // 进入连环状态
    if (!target.isChained) {
      target.isChained = true;
      this.eventBus.emit(GameEvent.Log, {
        message: `【阿乔】${target.name} 进入连环状态！`
      });
      this.eventBus.emit(GameEvent.ChainedStateChanged, {
        playerId: target.id, isChained: true,
      });
    }

    data.ajawUsedThisTurn = true;
  }

  /** 基尼奇-价格：被动技，检查是否需要额外杀 */
  isKinichPriceActive(target: PlayerState): boolean {
    return target.heroId === 'kinich';
  }

  /** 价格-杀拦截：返回 { intercepted: 杀无效, dodgeForced: 必须命中 } */
  async onKinichPriceSlash(target: PlayerState, source: PlayerState, slashCard: Card): Promise<SkillHookResult> {
    if (target.heroId !== 'kinich') return { intercepted: false };

    this.eventBus.emit(GameEvent.Log, {
      message: `【价格】${source.name} 需要对 ${target.name} 再使用一张【杀】！`
    });

    // 提示来源再打出一张杀
    const sourceDriver = this.drivers.get(source.id)!;
    const extraSlash = await this.damageSystem.askForResponse(source, '杀', slashCard, source, sourceDriver);

    if (!extraSlash) {
      this.eventBus.emit(GameEvent.Log, {
        message: `【价格】${source.name} 无法使用额外【杀】，此【杀】对 ${target.name} 无效！`
      });
      return { intercepted: true };
    }

    this.eventBus.emit(GameEvent.Log, {
      message: `【价格】${source.name} 打出了额外【杀】，${target.name} 不可闪避此伤害！`
    });
    return { intercepted: false, data: { dodgeForced: true } };
  }

  // ======================== 玛拉妮技能 ========================

  private addMualaniSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'mualani_spring',
      name: '流泉',
      description: `将一张手牌扣置为"泉"，仅能被过河拆桥/顺手牵羊拆除。下回合开始时收回并对距离1内角色造成1点火伤。${data.springUsedThisTurn ? '（本回合已发动）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.springUsedThisTurn && p.id === (c.currentPlayerId) && p.handCards.length > 0 && !d.springCard;
      },
    });
    skills.push({
      id: 'mualani_unity',
      name: '团结',
      description: '摸牌阶段开始时，可少摸1张牌，选择至多2名角色进入连环状态。',
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 玛拉妮-流泉：扣置一张手牌为"泉" */
  private async mualaniSpring(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const driver = this.drivers.get(player.id)!;

    const cardIdx = await driver.promptSelectCard?.(player, '流泉-选择一张手牌扣置为"泉"',
      () => true, ctx) ?? -1;
    if (cardIdx < 0) return false;

    const selected = player.handCards.splice(cardIdx, 1)[0];
    data.springCard = selected;
    data.springUsedThisTurn = true;

    this.eventBus.emit(GameEvent.Log, {
      message: `【流泉】${player.name} 将一张手牌扣置为"泉"。`
    });
    return true;
  }

  /** 玛拉妮-流泉：回合开始时检查泉 */
  private async mualaniSpringCheck(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    const data = this.getData(player.id);
    if (!data.springCard) return;

    const springCard = data.springCard as Card;
    data.springCard = null;

    // 收回泉牌
    player.handCards.push(springCard);
    this.eventBus.emit(GameEvent.Log, {
      message: `【流泉】${player.name} 收回了"泉"牌！`
    });

    // 对距离1以内的一名角色造成1点火属性伤害
    const driver = this.drivers.get(player.id)!;
    const alivePlayers = this.allPlayers.filter(p => !p.isDead);
    const withinOne = alivePlayers.filter(p => p.id !== player.id && this.getDistance(player, p, alivePlayers) <= 1);

    if (withinOne.length > 0) {
      const targetId = await driver.promptTarget(player, withinOne.map(t => t.id),
        '流泉-选择距离1内一名角色造成1点火属性伤害', ctx);
      if (targetId !== null) {
        const target = withinOne.find(t => t.id === targetId)!;
        const fireCard: Card = {
          id: springCard.id, name: '火攻', type: CardType.Magic, suit: springCard.suit,
          number: springCard.number, element: ElementType.Pyro, description: `【流泉】火属性伤害`,
          equipType: EquipmentType.None, weaponRange: 0, cardSource: player, isVirtual: true,
        };
        this.eventBus.emit(GameEvent.Log, {
          message: `【流泉】${player.name} 对 ${target.name} 造成1点火属性伤害！`
        });
        await this.damageSystem.applyHpChange(target, -1, fireCard, player);
      }
    } else {
      this.eventBus.emit(GameEvent.Log, {
        message: `【流泉】${player.name} 距离1以内没有可攻击的角色。`
      });
    }
  }

  /** 玛拉妮-团结：摸牌阶段开始时少摸1张，选至多2名角色进入连环状态 */
  async mualaniUnity(player: PlayerState): Promise<{ drawReduction: number; chainTargetIds: number[] }> {
    if (player.heroId !== 'mualani') return { drawReduction: 0, chainTargetIds: [] };

    const driver = this.drivers.get(player.id)!;
    const useUnity = await (driver as any).promptYesNo?.(
      '【团结】是否少摸1张牌，选择至多2名角色进入连环状态？'
    ) ?? false;

    if (!useUnity) return { drawReduction: 0, chainTargetIds: [] };

    this.eventBus.emit(GameEvent.Log, {
      message: `【团结】${player.name} 发动团结，少摸1张牌！`
    });

    // 选择至多2名角色进入连环
    const chainTargetIds: number[] = [];
    const validTargets = this.allPlayers.filter(t => !t.isDead);

    for (let i = 0; i < 2; i++) {
      const remaining = validTargets.filter(t => !chainTargetIds.includes(t.id));
      if (remaining.length === 0) break;

      const targetId = await driver.promptTarget(player, remaining.map(t => t.id),
        `团结-选择第${i + 1}名角色进入连环${i === 0 ? '（可取消，最多选2名）' : '（可取消）'}`,
        this.buildContext(player.id));
      if (targetId === null) break;
      chainTargetIds.push(targetId);
    }

    // 使选中的角色进入连环状态
    for (const tid of chainTargetIds) {
      const t = validTargets.find(p => p.id === tid);
      if (t && !t.isChained) {
        t.isChained = true;
        this.eventBus.emit(GameEvent.Log, {
          message: `【团结】${t.name} 进入连环状态！`
        });
        this.eventBus.emit(GameEvent.ChainedStateChanged, {
          playerId: t.id, isChained: true,
        });
      }
    }

    return { drawReduction: 1, chainTargetIds };
  }

  /** 获取泉标记（供CardEffectManager拆/顺时查询） */
  getSpringMarker(playerId: number): Card | null {
    const data = this.playerSkillData.get(playerId);
    return data?.springCard || null;
  }

  /** 移除泉标记（供CardEffectManager拆/顺时移除） */
  removeSpringMarker(playerId: number): Card | null {
    const data = this.playerSkillData.get(playerId);
    if (!data?.springCard) return null;
    const card = data.springCard as Card;
    data.springCard = null;
    this.eventBus.emit(GameEvent.Log, {
      message: `"泉"被移除！`
    });
    return card;
  }

  /** 计算两个玩家之间的距离 */
  private getDistance(source: PlayerState, target: PlayerState, alivePlayers: PlayerState[]): number {
    const si = alivePlayers.indexOf(source);
    const ti = alivePlayers.indexOf(target);
    if (si < 0 || ti < 0) return 999;
    const diff = Math.abs(si - ti);
    return Math.min(diff, alivePlayers.length - diff);
  }

  // ======================== 凯亚技能 ========================

  private addKaeyaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    if (!data.kayeaMarkers) data.kayeaMarkers = [];
    skills.push({
      id: 'kaeya_afternoon',
      name: '午后',
      description: `将至多两张手牌扣置为标记，可当【酒】使用。以此法存储的酒不超过2张。${data.afternoonUsedThisTurn ? '（本回合已发动）' : ''}（当前${data.kayeaMarkers?.length || 0}张）`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.afternoonUsedThisTurn && p.id === (c.currentPlayerId) && p.handCards.length > 0;
      },
    });
    // 标记当酒：有标记且未喝过酒时可发动
    if ((data.kayeaMarkers?.length || 0) > 0 && player.nextSlashDamageBonus === 0) {
      skills.push({
        id: 'kaeya_marker_wine',
        name: '午后-酒',
        description: `消耗一个午后标记当【酒】使用。（剩余${data.kayeaMarkers?.length || 0}张）`,
        type: 'active',
        usable: (p, c) => {
          const d = this.getData(p.id);
          return p.id === (c.currentPlayerId) && (d.kayeaMarkers?.length || 0) > 0 && p.nextSlashDamageBonus === 0;
        },
      });
    }
    skills.push({
      id: 'kaeya_cavalry',
      name: '骑队',
      description: '当你使用的【杀】是最后一张手牌时，可额外指定至多距离内3个目标，伤害=4-目标数。',
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 凯亚-午后：将至多两张手牌扣置，可当酒使用。以此法存储的酒不超过2张。 */
  private async kaeyaAfternoon(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const driver = this.drivers.get(player.id)!;

    if (!data.kayeaMarkers) data.kayeaMarkers = [];
    // 存储上限2张
    if (data.kayeaMarkers.length >= 2) return false;
    const maxMarkers = Math.min(2 - data.kayeaMarkers.length, player.handCards.length);

    for (let i = 0; i < maxMarkers; i++) {
      const cardIdx = await driver.promptSelectCard?.(player,
        `午后-选择第${i + 1}张手牌扣置（可取消，最多扣置2张）`,
        () => true, ctx) ?? -1;
      if (cardIdx < 0) break;
      const card = player.handCards.splice(cardIdx, 1)[0];
      data.kayeaMarkers.push(card);
      this.eventBus.emit(GameEvent.Log, {
        message: `【午后】${player.name} 将 ${getCardDetail(card)} 扣置为标记。（共${data.kayeaMarkers.length}张）`
      });
    }

    if (data.kayeaMarkers.length > 0) {
      data.afternoonUsedThisTurn = true;
      return true;
    }
    return false;
  }

  /** 凯亚：消耗一个午后标记当酒（每回合限一次） */
  private kaeyaUseMarkerWine(player: PlayerState): boolean {
    const data = this.getData(player.id);
    if (!data.kayeaMarkers || data.kayeaMarkers.length === 0) return false;
    if (player.nextSlashDamageBonus > 0) return false;
    if (data.wineUsedThisTurn) return false; // 每回合限喝一次酒

    const card = data.kayeaMarkers.pop()!;
    this.deck.sendToDiscard(card);
    player.nextSlashDamageBonus = 1;
    data.wineUsedThisTurn = true;
    this.eventBus.emit(GameEvent.Log, {
      message: `【午后】${player.name} 消耗一个标记（${card.name}）当【酒】使用！剩余${data.kayeaMarkers.length}张。`
    });
    return true;
  }

  /** 凯亚-骑队：检查最后一张手牌打出杀时的多目标 */
  isKaeyaCavalryActive(source: PlayerState): boolean {
    return source.heroId === 'kaeya' && source.handCards.length === 0;
  }

  /** 凯亚：获取午后标记 */
  getKaeyaMarkers(playerId: number): Card[] {
    const data = this.playerSkillData.get(playerId);
    return data?.kayeaMarkers || [];
  }

  /** 凯亚：消耗一个午后标记（当酒） */
  consumeKaeyaMarker(playerId: number): Card | null {
    const data = this.playerSkillData.get(playerId);
    if (!data?.kayeaMarkers || data.kayeaMarkers.length === 0) return null;
    const card = data.kayeaMarkers.pop()!;
    this.eventBus.emit(GameEvent.Log, {
      message: `消耗一个"午后"标记：${getCardDetail(card)}`
    });
    return card;
  }

  // ======================== 迪卢克技能 ========================

  private addDilucSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    if (!data.dilucMarkers) data.dilucMarkers = [];
    skills.push({
      id: 'diluc_morning',
      name: '晨曦',
      description: `摸牌阶段开始前，将至多两张手牌扣置为标记，可当【酒】使用。以此法存储的酒不超过2张。（当前${data.dilucMarkers?.length || 0}张）`,
      type: 'trigger',
      usable: () => false,
    });
    // 标记当酒：有标记且未喝过酒时可发动
    if ((data.dilucMarkers?.length || 0) > 0 && player.nextSlashDamageBonus === 0) {
      skills.push({
        id: 'diluc_marker_wine',
        name: '晨曦-酒',
        description: `消耗一个晨曦标记当【酒】使用。（剩余${data.dilucMarkers?.length || 0}张）`,
        type: 'active',
        usable: (p, c) => {
          const d = this.getData(p.id);
          return p.id === (c.currentPlayerId) && (d.dilucMarkers?.length || 0) > 0 && p.nextSlashDamageBonus === 0;
        },
      });
    }
    skills.push({
      id: 'diluc_owl',
      name: '夜枭',
      description: `弃置除【杀】以外的所有手牌，本回合使用【杀】无次数限制且均视为【火杀】。${data.owlUsedThisTurn ? '（本回合已发动）' : ''}${data.owlActive ? '（夜枭激活中）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.owlUsedThisTurn && p.id === (c.currentPlayerId) && p.handCards.some(card => card.type !== CardType.Basic || (card.name !== '杀' && card.name !== '火杀' && card.name !== '雷杀'));
      },
    });
  }

  /** 迪卢克-晨曦：摸牌阶段开始前扣置最多2张牌。以此法存储的酒不超过2张。 */
  private async dilucMorningExecute(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    const data = this.getData(player.id);
    const driver = this.drivers.get(player.id)!;

    if (!data.dilucMarkers) data.dilucMarkers = [];
    // 存储上限2张
    if (data.dilucMarkers.length >= 2) return;
    if (player.handCards.length === 0) return;

    const useMorning = await (driver as any).promptYesNo?.(
      '【晨曦】摸牌前，是否将至多两张手牌扣置为标记（可当【酒】使用）？'
    ) ?? false;
    if (!useMorning) return;

    const maxMarkers = Math.min(2 - data.dilucMarkers.length, player.handCards.length);
    for (let i = 0; i < maxMarkers; i++) {
      const cardIdx = await driver.promptSelectCard?.(player,
        `晨曦-选择第${i + 1}张手牌扣置（可取消，最多扣置2张）`,
        () => true, ctx) ?? -1;
      if (cardIdx < 0) break;
      const card = player.handCards.splice(cardIdx, 1)[0];
      data.dilucMarkers.push(card);
      this.eventBus.emit(GameEvent.Log, {
        message: `【晨曦】${player.name} 将 ${getCardDetail(card)} 扣置为标记。（共${data.dilucMarkers.length}张）`
      });
    }
  }

  /** 迪卢克-夜枭：弃置除杀以外所有手牌，无限杀+火杀 */
  private async dilucOwl(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const driver = this.drivers.get(player.id)!;

    const toDiscard = player.handCards.filter(c => {
      if (c.type !== CardType.Basic) return true;
      return !(c.name === '杀' || c.name === '火杀' || c.name === '雷杀');
    });

    if (toDiscard.length === 0) return false;

    const confirm = await (driver as any).promptYesNo?.(
      `【夜枭】将弃置 ${toDiscard.length} 张非【杀】手牌，是否发动？`
    ) ?? false;
    if (!confirm) return false;

    // 弃置所有非杀手牌
    for (const card of toDiscard) {
      const idx = player.handCards.indexOf(card);
      if (idx >= 0) player.handCards.splice(idx, 1);
      this.deck.sendToDiscard(card);
    }

    data.owlUsedThisTurn = true;
    data.owlActive = true;

    this.eventBus.emit(GameEvent.Log, {
      message: `【夜枭】${player.name} 弃置了${toDiscard.length}张手牌！本回合【杀】无次数限制且均视为【火杀】！`
    });
    return true;
  }

  /** 迪卢克：消耗一个晨曦标记当酒（每回合限一次） */
  private dilucUseMarkerWine(player: PlayerState): boolean {
    const data = this.getData(player.id);
    if (!data.dilucMarkers || data.dilucMarkers.length === 0) return false;
    if (player.nextSlashDamageBonus > 0) return false;
    if (data.wineUsedThisTurn) return false; // 每回合限喝一次酒

    const card = data.dilucMarkers.pop()!;
    this.deck.sendToDiscard(card);
    player.nextSlashDamageBonus = 1;
    data.wineUsedThisTurn = true;
    this.eventBus.emit(GameEvent.Log, {
      message: `【晨曦】${player.name} 消耗一个标记（${card.name}）当【酒】使用！剩余${data.dilucMarkers.length}张。`
    });
    return true;
  }

  /** 迪卢克-夜枭：是否无限杀 */
  isDilucOwlActive(source: PlayerState): boolean {
    if (source.heroId !== 'diluc') return false;
    const data = this.getData(source.id);
    return !!data.owlActive;
  }

  /** 迪卢克-夜枭：是否将杀转为火杀 */
  shouldConvertDilucFireSlash(source: PlayerState): boolean {
    if (source.heroId !== 'diluc') return false;
    const data = this.getData(source.id);
    return !!data.owlActive;
  }

  /** 迪卢克：获取晨曦标记 */
  getDilucMarkers(playerId: number): Card[] {
    const data = this.playerSkillData.get(playerId);
    return data?.dilucMarkers || [];
  }

  /** 迪卢克：消耗一个晨曦标记（当酒） */
  consumeDilucMarker(playerId: number): Card | null {
    const data = this.playerSkillData.get(playerId);
    if (!data?.dilucMarkers || data.dilucMarkers.length === 0) return null;
    const card = data.dilucMarkers.pop()!;
    this.eventBus.emit(GameEvent.Log, {
      message: `消耗一个"晨曦"标记：${getCardDetail(card)}`
    });
    return card;
  }

  /** 通用：尝试用标记当酒（凯亚午后/迪卢克晨曦），每回合限一次 */
  tryUseMarkerAsWine(playerId: number): boolean {
    const player = this.allPlayers.find(p => p.id === playerId);
    if (!player) return false;
    const data = this.getData(playerId);
    if (data.wineUsedThisTurn) return false; // 每回合限喝一次酒

    if (player.heroId === 'kaeya') {
      const marker = this.consumeKaeyaMarker(playerId);
      if (marker) {
        this.deck.sendToDiscard(marker);
        if (player.nextSlashDamageBonus === 0) {
          player.nextSlashDamageBonus = 1;
          data.wineUsedThisTurn = true;
        }
        return true;
      }
    }
    if (player.heroId === 'diluc') {
      const marker = this.consumeDilucMarker(playerId);
      if (marker) {
        this.deck.sendToDiscard(marker);
        if (player.nextSlashDamageBonus === 0) {
          player.nextSlashDamageBonus = 1;
          data.wineUsedThisTurn = true;
        }
        return true;
      }
    }
    return false;
  }

  // ======================== 琴技能 ========================

  private addJeanSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'jean_agent',
      name: '代理',
      description: `与一名其他角色交换所有手牌，交换后手牌数较少的一方回复1点体力。${data.agentUsedThisTurn ? '（本回合已发动）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.agentUsedThisTurn && p.id === (c.currentPlayerId);
      },
    });
    skills.push({
      id: 'jean_breeze',
      name: '蒲骑',
      description: '可跳过【南蛮入侵】和【万箭齐发】，并摸一张牌。',
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 琴-代理：与一名其他角色交换所有手牌，手牌数较少的一方回复1点体力 */
  private async jeanAgent(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const driver = this.drivers.get(player.id)!;
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length === 0) return false;

    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '代理-选择交换手牌的角色', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    // 交换所有手牌
    const jeanCards = [...player.handCards];
    const targetCards = [...target.handCards];
    player.handCards = targetCards;
    target.handCards = jeanCards;

    this.eventBus.emit(GameEvent.Log, {
      message: `【代理】${player.name} 与 ${target.name} 交换了所有手牌！(${player.name}:${player.handCards.length}张, ${target.name}:${target.handCards.length}张)`
    });

    data.agentUsedThisTurn = true;

    // 交换后手牌数较少的一方回复1点体力（满血不回，相等不触发）
    const jeanCount = player.handCards.length;
    const targetCount = target.handCards.length;

    if (jeanCount < targetCount) {
      // 琴手牌少 → 琴回血
      if (player.hp < player.maxHp) {
        player.hp = Math.min(player.maxHp, player.hp + 1);
        this.eventBus.emit(GameEvent.Log, {
          message: `【代理】${player.name} 手牌较少(${jeanCount}<${targetCount})，回复1点体力。(HP:${player.hp}/${player.maxHp})`
        });
        this.eventBus.emit(GameEvent.HpChanged, {
          playerId: player.id, newHp: player.hp, maxHp: player.maxHp, delta: 1, isDamage: false
        });
      }
    } else if (targetCount < jeanCount) {
      // 目标手牌少 → 目标回血
      if (target.hp < target.maxHp) {
        target.hp = Math.min(target.maxHp, target.hp + 1);
        this.eventBus.emit(GameEvent.Log, {
          message: `【代理】${target.name} 手牌较少(${targetCount}<${jeanCount})，回复1点体力。(HP:${target.hp}/${target.maxHp})`
        });
        this.eventBus.emit(GameEvent.HpChanged, {
          playerId: target.id, newHp: target.hp, maxHp: target.maxHp, delta: 1, isDamage: false
        });
      }
    } else {
      this.eventBus.emit(GameEvent.Log, {
        message: `【代理】双方手牌数相等(${jeanCount}张)，不触发回复。`
      });
    }

    return true;
  }

  /** 琴-蒲骑：检查是否可跳过AOE并摸牌 */
  isJeanBreezeActive(player: PlayerState): boolean {
    return player.heroId === 'jean';
  }

  /** 琴-蒲骑：执行跳过AOE并摸一张牌 */
  jeanBreezeSkip(player: PlayerState): void {
    this.deck.drawCards(player, 1);
    this.eventBus.emit(GameEvent.Log, {
      message: `【蒲骑】${player.name} 跳过群体锦囊，摸一张牌。`
    });
  }

  // ======================== 可莉技能 ========================

  private addKleeSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'klee_bombfish',
      name: '炸鱼',
      description: `将一张手牌扣置于自己的判定区上称为"炸弹"。${data.bombfishUsedThisTurn ? '（本回合已发动）' : ''}`,
      type: 'active',
      usable: (p, c) => {
        const d = this.getData(p.id);
        return !d.bombfishUsedThisTurn && p.id === (c.currentPlayerId) && p.handCards.length > 0;
      },
    });
    skills.push({
      id: 'klee_confinement',
      name: '禁闭',
      description: '当"炸弹"爆炸时，可再弃置一张牌名与判定牌相同的手牌，令其再受2点伤害，然后翻面。',
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 可莉-炸鱼：将一张手牌扣置于自己的判定区上，称为"炸弹" */
  private async kleeBombfish(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const driver = this.drivers.get(player.id)!;

    // 检查自己是否已经有炸弹
    if (player.judgeZone.some(c => (c as any)._kleeBomb)) {
      this.eventBus.emit(GameEvent.Log, { message: `【炸鱼】${player.name} 的判定区已有炸弹！` });
      return false;
    }

    // 选一张手牌
    const cardIdx = await driver.promptSelectCard?.(player,
      '炸鱼-选择一张手牌扣置为"炸弹"',
      () => true, ctx) ?? -1;
    if (cardIdx < 0) return false;

    const card = player.handCards.splice(cardIdx, 1)[0];
    // 标记为炸弹
    (card as any)._kleeBomb = true;
    (card as any)._kleeBombPlacerId = player.id;
    // 放在自己判定区
    player.judgeZone.push(card);

    data.bombfishUsedThisTurn = true;

    this.eventBus.emit(GameEvent.Log, {
      message: `【炸鱼】${player.name} 将 ${getCardDetail(card)} 扣置为"炸弹"！`
    });
    this.eventBus.emit(GameEvent.CardMovedToJudge, {
      playerId: player.id, cardName: card.name, cardSuit: card.suit, cardNumber: card.number, isBomb: true,
    });
    return true;
  }

  /** 检查判定区中的牌是否是可莉炸弹 */
  isKleeBomb(card: Card): boolean {
    return !!(card as any)._kleeBomb;
  }

  /** 获取炸弹放置者ID */
  getKleeBombPlacerId(card: Card): number | null {
    return (card as any)._kleeBombPlacerId || null;
  }

  /** 处理炸弹判定：返回判定结果 */
  async handleBombJudge(kit: Card, player: PlayerState, judgeResult: Card): Promise<{ bombExploded: boolean; moveBomb: boolean }> {
    const bombName = kit.name;
    const judgeName = judgeResult.name;
    const bombPlacerId = (kit as any)._kleeBombPlacerId as number;

    if (bombName === judgeName) {
      // 炸弹爆炸！
      this.eventBus.emit(GameEvent.Log, {
        message: `💣【炸弹】爆炸！判定牌 ${judgeName} 与炸弹 ${bombName} 匹配，${player.name} 受到2点火属性伤害！`
      });

      // 在弃置炸弹前检查禁闭
      const klee = this.allPlayers.find(p => p.id === bombPlacerId);
      if (klee && !klee.isDead) {
        await this.tryKleeConfinement(klee, player, judgeResult);
      }

      return { bombExploded: true, moveBomb: false };
    } else {
      this.eventBus.emit(GameEvent.Log, {
        message: `【炸弹】判定牌 ${judgeName} 与炸弹 ${bombName} 不匹配，移至下一位存活玩家。`
      });
      return { bombExploded: false, moveBomb: true };
    }
  }

  /** 可莉-禁闭：炸弹爆炸时，可弃置一张同名手牌追加2点伤害并翻面 */
  private async tryKleeConfinement(klee: PlayerState, victim: PlayerState, judgeResult: Card): Promise<void> {
    const driver = this.drivers.get(klee.id);
    if (!driver) return;

    const hasSameName = klee.handCards.some(c => c.name === judgeResult.name);
    if (!hasSameName) return;

    const useSkill = await (driver as any).promptYesNo?.(
      `【禁闭】是否弃置一张${judgeResult.name}手牌，令${victim.name}再受2点伤害，然后翻面？`
    ) ?? false;
    if (!useSkill) return;

    const ctx = this.buildContext(klee.id);
    const cardIdx = await driver.promptSelectCard?.(klee,
      `禁闭-选择一张${judgeResult.name}弃置`,
      (c) => c.name === judgeResult.name, ctx) ?? -1;
    if (cardIdx < 0) return;

    const discardCard = klee.handCards.splice(cardIdx, 1)[0];
    this.deck.sendToDiscard(discardCard);

    this.eventBus.emit(GameEvent.Log, {
      message: `【禁闭】${klee.name} 弃置${discardCard.name}(${discardCard.suit}${discardCard.number})，${victim.name} 再受2点伤害！`
    });

    await this.damageSystem.applyHpChange(victim, -2, discardCard, klee);

    // 可莉翻面
    klee.isFlipped = true;
    this.eventBus.emit(GameEvent.Log, {
      message: `【禁闭】${klee.name} 将武将牌翻面！下回合跳过。`
    });
  }

  /** 传递炸弹到下一位存活玩家（该玩家不能已拥有炸弹） */
  passKleeBomb(bomb: Card, current: PlayerState): void {
    let nextIdx = (this.allPlayers.indexOf(current) + 1) % this.allPlayers.length;
    let nextPlayer = this.allPlayers[nextIdx];

    while (nextPlayer.isDead || nextPlayer.judgeZone.some(c => (c as any)._kleeBomb)) {
      nextIdx = (nextIdx + 1) % this.allPlayers.length;
      nextPlayer = this.allPlayers[nextIdx];
      if (nextPlayer === current) {
        // 传递一圈回到自己，且自己已经有炸弹 → 无法传递，移除炸弹
        this.eventBus.emit(GameEvent.Log, { message: `【炸弹】无法继续传递（所有存活角色均有炸弹），移除。` });
        this.deck.sendToDiscard(bomb);
        return;
      }
    }

    nextPlayer.judgeZone.push(bomb);
    this.eventBus.emit(GameEvent.Log, {
      message: `【炸弹】移至 ${nextPlayer.name} 的判定区。`
    });
  }

  // ======================== 辅助方法 ========================

  /** 重置每回合标记 */
  resetTurnFlags(playerId: number): void {
    const data = this.getData(playerId);
    const player = this.allPlayers.find(p => p.id === playerId);
    if (!player) return;

    switch (player.heroId) {
      case 'venti':
        data.freeUsedThisTurn = false;
        break;
      case 'zhongli':
        data.leisureUsedThisTurn = false;
        break;
      case 'raiden':
        data.decreeUsedThisTurn = false;
        break;
      case 'nahida':
        data.metaphorUsedThisTurn = false;
        break;
      case 'mavuika':
        data.leaderActive = false;
        data.leaderDamageTaken = 0;
        data.holyFireUsedThisTurn = false;
        break;
      case 'columbina':
        data.moonUsedThisTurn = false;
        // 清理下回合摸牌惩罚
        data.moonBonusDraw = 0;
        break;
      case 'neuvillette':
        data.dragonUsedThisTurn = false;
        break;
      case 'yae':
        data.charmUsedThisTurn = false;
        data.extraSlashCount = 0;
        break;
      case 'xilonen':
        data.craftUsedThisTurn = false;
        data.blessingUsedThisTurn = false;
        data.drawBonus = 0;
        break;
      case 'wriothesley':
        data.dukeActive = false;
        break;
      case 'hutao':
        data.butterflyUsedThisTurn = false;
        data.butterflyActive = false;
        break;
      case 'ningguang':
        data.heavenUsedThisTurn = false;
        break;
      case 'alhaitham':
        data.knowledgeUsedThisTurn = 0;
        break;
      case 'yelan':
        data.spyUsedThisTurn = false;
        break;
      case 'nilou':
        data.stepUsedThisTurn = false;
        break;
      case 'dehya':
        data.mercenaryUsedThisTurn = false;
        break;
      case 'lyneya':
        data.revelationUsedThisTurn = false;
        data.revelationFailedCard = undefined;
        data.revelationDisabledThisTurn = false;
        break;
      case 'itto':
        data.redOniUsedThisRound = false;
        break;
      case 'kokomi':
        data.strategistUsedThisTurn = false;
        break;
      case 'kinich':
        data.firebackUsedThisTurn = false;
        data.ajawUsedThisTurn = false;
        break;
      case 'mualani':
        data.springUsedThisTurn = false;
        break;
      case 'kaeya':
        data.afternoonUsedThisTurn = false;
        data.wineUsedThisTurn = false;
        break;
      case 'diluc':
        data.owlUsedThisTurn = false;
        data.owlActive = false;
        data.wineUsedThisTurn = false;
        break;
      case 'jean':
        data.agentUsedThisTurn = false;
        break;
      case 'klee':
        data.bombfishUsedThisTurn = false;
        break;
      case 'keqing':
        data.starsUsed = data.starsUsed || false; // 保持已使用状态
        data.yuhengDisabledThisTurn = false;
        break;
      case 'ayaka':
        data.heronTriggeredThisTurn = false;
        break;
      case 'ganyu':
        data.moonseaUsedThisTurn = false;
        data._cardsPlayedThisTurn = [];
        break;
      case 'shenhe':
        data.icefeatherUsedThisTurn = false;
        // 冰翎持续到自己的下回合开始，此时重置
        break;
      case 'nefur':
        data.secretUsedThisTurn = false;
        // 清除奈芙尔在当前玩家身上的秘闻标记
        if (data.secretMarkedCard && data.secretMarkedTargetId) {
          const tData = this.getData(data.secretMarkedTargetId);
          if (tData._nefurSecretMark) delete tData._nefurSecretMark;
        }
        data.secretMarkedCard = undefined;
        data.secretMarkedTargetId = undefined;
        break;
      case 'lauma':
        data.moonsongUsedThisTurn = false;
        data.frostmoonUsedThisTurn = false;
        // 清除霜月标记（持续到自己的下回合开始）
        if (data.frostMoonPartnerId) {
          const fmData = this.getData(data.frostMoonPartnerId);
          if (fmData._frostMoonOwnerId === playerId) delete fmData._frostMoonOwnerId;
        }
        data.frostMoonPartnerId = undefined;
        break;
      case 'olorun':
        // 清除偷来的技能（持续到下回合开始）
        data.stolenSkillId = undefined;
        data.stolenSkillHeroId = undefined;
        data.lightningUsedThisTurn = false;
        data.stolenSkillData = undefined;
        break;
      case 'citlali':
        // 黑曜每回合重置（双杀要求）
        data.obsidianUsedThisTurn = false;
        break;
    }
    // 清除所有角色的冰翎标记（申鹤-劈观持续到下回合开始）
    for (const [pid, d] of this.playerSkillData) {
      if (d.iceFeatherCount) delete d.iceFeatherCount;
    }
  }

  /** 获取有效手牌上限（温迪-自由 可能修改） */
  getEffectiveHandLimit(player: PlayerState): number {
    if (player.heroId === 'venti') {
      const data = this.getData(player.id);
      if (data.customHandLimit !== undefined) return data.customHandLimit;
      return 8 - player.maxHp;
    }
    return getHandLimit(player);
  }

  private buildContext(playerId: number): GameContextSnapshot {
    return {
      players: this.allPlayers,
      roundCount: 0, currentTurn: 0, currentPlayerId: playerId,
      gameOverWinner: null,
      drawPileCount: this.deck.drawPileCount,
      discardPileCount: this.deck.discardPile.length,
    };
  }

  // ======================== 刻晴技能 ========================

  private addKeqingSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'keqing_stars',
      name: '七星',
      description: `限定技，令你与一名角色各恢复2点体力并获得2枚"玉璋"标记。${data.starsUsed ? '（已使用）' : ''}`,
      type: 'limited',
      usable: (p, c) => !data.starsUsed && p.id === (c.currentPlayerId),
    });
    skills.push({
      id: 'keqing_yuheng',
      name: '玉衡',
      description: '锁定技：你使用的【雷杀】无视防具且不计入出杀次数。',
      type: 'passive',
      usable: () => false,
    });
  }

  /** 刻晴-七星：与凝光七星逻辑相同 */
  async keqingStars(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '七星-选择目标', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;
    data.starsUsed = true;
    player.hp = Math.min(player.maxHp, player.hp + 2);
    target.hp = Math.min(target.maxHp, target.hp + 2);
    const pData = this.getData(player.id);
    pData.jadeCount = Math.min(4, (pData.jadeCount || 0) + 2);
    const tData = this.getData(target.id);
    tData.jadeCount = Math.min(4, (tData.jadeCount || 0) + 2);
    this.eventBus.emit(GameEvent.Log, {
      message: `【七星】${player.name} 与 ${target.name} 各恢复2点体力，各获得2枚玉璋标记！`
    });
    return true;
  }

  // ======================== 神里绫华技能 ========================

  private addAyakaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    skills.push({
      id: 'ayaka_heron',
      name: '白鹭',
      description: '当你打出手牌时，若手牌数小于体力值，你将手牌数摸至体力值。',
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'ayaka_frost',
      name: '霜灭',
      description: '当你使用【决斗】对一名角色造成伤害时，该角色获得"冰寒"标记。',
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 神里绫华-白鹭：手牌数小于体力值时摸至体力值 */
  async ayakaHeronDraw(player: PlayerState): Promise<void> {
    if (player.heroId !== 'ayaka' || player.isDead) return;
    if (player.handCards.length < player.hp) {
      const drawCount = player.hp - player.handCards.length;
      this.deck.drawCards(player, drawCount);
      this.eventBus.emit(GameEvent.Log, {
        message: `【白鹭】${player.name} 手牌数(${player.handCards.length - drawCount})小于体力值(${player.hp})，摸${drawCount}张牌至${player.hp}张。`
      });
    }
  }

  // ======================== 甘雨技能 ========================

  private addGanyuSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'ganyu_frost',
      name: '霜华',
      description: '当你使用【万箭齐发】时，受到伤害的角色获得"冰寒"标记。',
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'ganyu_moonsea',
      name: '月海',
      description: `回合结束后，可以将武将牌翻面，获得该回合内打出的所有手牌。${data.moonseaUsedThisTurn ? '（本回合已发动）' : ''}`,
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'ganyu_unifire',
      name: '麟迹',
      description: '锁定技：装备区没有武器时，默认拥有麒麟弓效果。',
      type: 'passive',
      usable: () => false,
    });
  }

  /** 甘雨-麟迹：没有武器时拥有麒麟弓效果 */
  isGanyuKylinActive(source: PlayerState): boolean {
    if (source.heroId !== 'ganyu') return false;
    if (source.equipZone[EquipmentType.Weapon]) return false;
    return true;
  }

  /** 甘雨-月海（回合结束时触发）：翻面回收本回合打出的牌 */
  async ganyuMoonseaTurnEnd(player: PlayerState, ctx: GameContextSnapshot): Promise<void> {
    if (player.heroId !== 'ganyu') return;
    const data = this.getData(player.id);
    if (data.moonseaUsedThisTurn) return;
    const trackedCards: Card[] = data._cardsPlayedThisTurn || [];
    if (trackedCards.length === 0) return;
    const driver = this.drivers.get(player.id)!;
    const use = await (driver as any).promptYesNo?.(
      `【月海】是否将武将牌翻面，获得本回合打出的${trackedCards.length}张手牌？`
    );
    if (!use) return;
    data.moonseaUsedThisTurn = true;
    player.isFlipped = true;
    // 从弃牌堆中回收本回合打出的牌（按id匹配）
    const retrieveIds = trackedCards.map(c => c.id);
    const retrieved = this.deck.retrieveFromDiscardPile(retrieveIds);
    for (const card of retrieved) {
      player.handCards.push(card);
    }
    const actualCount = retrieved.length;
    this.eventBus.emit(GameEvent.Log, {
      message: `【月海】${player.name} 将武将牌翻面，从弃牌堆收回了${actualCount}张本回合打出的牌！`
    });
  }

  // ======================== 申鹤技能 ========================

  private addShenheSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'shenhe_icefeather',
      name: '劈观',
      description: `出牌阶段限一次，使用【杀】指定目标后可令其获得"冰翎"标记。拥有"冰翎"标记的角色每次需使用两张【闪】才能抵消一张【杀】。${data.icefeatherUsedThisTurn ? '（本回合已发动）' : ''}`,
      type: 'active',
      usable: (p) => !data.icefeatherUsedThisTurn && p.id === (ctx.currentPlayerId || player.id),
    });
    skills.push({
      id: 'shenhe_heronreturn',
      name: '鹤归',
      description: '当你使用【杀】对一名角色造成伤害时，该角色获得"冰寒"标记。',
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 给目标添加冰翎标记 */
  applyShenheIceFeather(source: PlayerState, target: PlayerState): void {
    if (source.heroId !== 'shenhe') return;
    const data = this.getData(source.id);
    if (data.icefeatherUsedThisTurn) return;
    data.icefeatherUsedThisTurn = true;
    const tData = this.getData(target.id);
    tData.iceFeatherCount = (tData.iceFeatherCount || 0) + 1;
    this.eventBus.emit(GameEvent.Log, {
      message: `【劈观】${source.name} 给 ${target.name} 添加了"冰翎"标记（需使用2张闪）！`
    });
  }

  /** 检查目标是否有冰翎标记 */
  hasIceFeather(target: PlayerState): boolean {
    const data = this.getData(target.id);
    return (data.iceFeatherCount || 0) > 0;
  }

  // ======================== 冰寒标记（共享） ========================

  /** 给目标添加冰寒标记 */
  applyFrostMark(target: PlayerState, sourceName: string, skillName: string): void {
    const data = this.getData(target.id);
    data.frostMark = true;
    this.eventBus.emit(GameEvent.Log, {
      message: `【${skillName}】${sourceName} 给 ${target.name} 添加了"冰寒"标记！`
    });
  }

  /** 检查并触发冰寒标记：受到火属性伤害时伤害+1并移除 */
  checkFrostMark(target: PlayerState, sourceCard: Card | null): number {
    if (!sourceCard || sourceCard.element !== 'Pyro') return 0;
    const data = this.getData(target.id);
    if (!data.frostMark) return 0;
    delete data.frostMark;
    this.eventBus.emit(GameEvent.Log, {
      message: `【冰寒】${target.name} 的"冰寒"标记触发，火属性伤害+1，标记移除！`
    });
    return 1;
  }

  // ======================== 体力流失钩子（奈芙尔-北网） ========================

  /** 当有角色流失体力时 */
  onHealthLoss(player: PlayerState, amount: number, sourceName: string): void {
    // 奈芙尔-北网：其他角色流失体力时摸一张牌
    const nefur = this.allPlayers.find(p => p.heroId === 'nefur' && !p.isDead);
    if (nefur && player.id !== nefur.id) {
      this.deck.drawCards(nefur, 1);
      this.eventBus.emit(GameEvent.Log, {
        message: `【北网】${nefur.name} 因 ${player.name} 流失体力摸了一张牌。`
      });
    }
  }

  // ======================== 霜月标记（菈乌玛-灵使） ========================

  /** 获取当前霜月标记的拥有者 */
  getFrostMoonOwner(): PlayerState | null {
    for (const p of this.allPlayers) {
      if (p.isDead) continue;
      const data = this.getData(p.id);
      if (data._frostMoonOwnerId) {
        return this.allPlayers.find(pp => pp.id === data._frostMoonOwnerId && !pp.isDead) || null;
      }
    }
    return null;
  }

  /** 霜月伤害重定向 */
  onFrostMoonRedirect(target: PlayerState, damage: number, source: PlayerState | null): { redirected: boolean; newTarget: PlayerState } {
    // 查找菈乌玛
    const lauma = this.allPlayers.find(p => p.heroId === 'lauma' && !p.isDead);
    if (!lauma) return { redirected: false, newTarget: target };

    const laumaData = this.getData(lauma.id);
    const partnerId = laumaData.frostMoonPartnerId;
    if (!partnerId) return { redirected: false, newTarget: target };

    const partner = this.allPlayers.find(p => p.id === partnerId && !p.isDead);
    if (!partner) return { redirected: false, newTarget: target };

    // 如果伤害目标不是菈乌玛也不是搭档，不重定向
    if (target.id !== lauma.id && target.id !== partner.id) {
      return { redirected: false, newTarget: target };
    }

    // 菈乌玛 HP > 搭档 HP → 菈乌玛替搭档承伤
    // 菈乌玛 HP <= 搭档 HP → 搭档替菈乌玛承伤
    if (target.id === partner.id && lauma.hp > partner.hp) {
      // 菈乌玛替搭档承伤
      this.eventBus.emit(GameEvent.Log, {
        message: `【灵使】${lauma.name}(${lauma.hp}HP) 替 ${partner.name}(${partner.hp}HP) 承受伤害！`
      });
      return { redirected: true, newTarget: lauma };
    } else if (target.id === lauma.id && lauma.hp <= partner.hp) {
      // 搭档替菈乌玛承伤
      this.eventBus.emit(GameEvent.Log, {
        message: `【灵使】${partner.name}(${partner.hp}HP) 替 ${lauma.name}(${lauma.hp}HP) 承受伤害！`
      });
      return { redirected: true, newTarget: partner };
    }

    return { redirected: false, newTarget: target };
  }

  // ======================== 上次判定牌记录 ========================

  /** 记录本局游戏上一次判定牌（茜特菈莉-记忆） */
  recordLastJudgeCard(card: Card): void {
    // 全局记录在第一个玩家数据中
    const firstPlayer = this.allPlayers[0];
    if (!firstPlayer) return;
    const data = this.getData(firstPlayer.id);
    data._lastJudgeCard = card; // 引用，需要clone
  }

  /** 获取本局游戏上一次判定牌（茜特菈莉-记忆） */
  getLastJudgeCard(): Card | null {
    const firstPlayer = this.allPlayers[0];
    if (!firstPlayer) return null;
    const data = this.getData(firstPlayer.id);
    return data._lastJudgeCard || null;
  }

  /** 检查上次判定牌是否在弃牌堆中 */
  isLastJudgeCardInDiscard(): boolean {
    const card = this.getLastJudgeCard();
    if (!card) return false;
    return this.deck.discardPile.includes(card);
  }

  // ======================== 奈芙尔技能 ========================
  // (nefur.ts mirror)

  private addNefurSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'nefur_secret',
      name: '秘闻',
      description: `出牌阶段限一次，查看一名其他角色的1张手牌并进行标记。${data.secretUsedThisTurn ? '（本回合已使用）' : ''}`,
      type: 'active',
      usable: (p, c) => !data.secretUsedThisTurn && p.id === (c.currentPlayerId),
    });
    skills.push({
      id: 'nefur_snake',
      name: '蛇蝎',
      description: '可将一张【杀】当【借刀杀人】使用。若因此打出的【杀】造成伤害，视为体力流失。',
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'nefur_net',
      name: '北网',
      description: '当有其他角色流失体力时，你摸一张牌。',
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 奈芙尔-秘闻：查看并标记一名其他角色的1张手牌 */
  async nefurSecret(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id && p.handCards.length > 0);
    if (aliveOthers.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '秘闻-选择目标', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.secretUsedThisTurn = true;

    // 查看目标手牌并选择一张进行标记
    const cardIdx = await (driver as any).promptRansackHand?.(player, target.id, this.buildContext(player.id)) ?? -1;
    if (cardIdx < 0 || cardIdx >= target.handCards.length) return false;

    const markedCard = target.handCards[cardIdx];
    data.secretMarkedCard = markedCard.name;
    data.secretMarkedTargetId = target.id;

    const tData = this.getData(target.id);
    tData._nefurSecretMark = {
      cardName: markedCard.name,
      markedById: player.id,
      suit: markedCard.suit,
      number: markedCard.number,
    };

    this.eventBus.emit(GameEvent.Log, {
      message: `【秘闻】${player.name} 查看了 ${target.name} 的一张手牌并进行了标记：${getCardDetail(markedCard)}`
    });
    return true;
  }

  /** 检查并处理秘闻标记（在使用手牌时和弃牌时调用） */
  async checkNefurSecretOnUse(player: PlayerState, usedCard: Card): Promise<void> {
    const data = this.getData(player.id);
    const mark = data._nefurSecretMark;
    if (!mark) return;
    // 检查是否是标记的牌
    if (usedCard.name !== mark.cardName) return;
    if (usedCard.suit !== mark.suit || usedCard.number !== mark.number) return;

    // 使用者流失1点体力
    const nefur = this.allPlayers.find(p => p.id === mark.markedById && !p.isDead);
    if (!nefur) return;

    delete data._nefurSecretMark;
    const nefurData = this.getData(nefur.id);
    delete nefurData.secretMarkedCard;
    delete nefurData.secretMarkedTargetId;

    this.eventBus.emit(GameEvent.Log, {
      message: `【秘闻】${player.name} 使用了被标记的牌，流失1点体力！`
    });
    await this.damageSystem.applyHealthLoss(player, 1, nefur.name);
  }

  /** 检查并处理秘闻标记（在弃牌时调用） */
  async checkNefurSecretOnDiscard(player: PlayerState, discardedCard: Card): Promise<void> {
    const data = this.getData(player.id);
    const mark = data._nefurSecretMark;
    if (!mark) return;
    if (discardedCard.name !== mark.cardName) return;
    if (discardedCard.suit !== mark.suit || discardedCard.number !== mark.number) return;

    const nefur = this.allPlayers.find(p => p.id === mark.markedById && !p.isDead);
    if (!nefur) return;

    delete data._nefurSecretMark;
    const nefurData = this.getData(nefur.id);
    delete nefurData.secretMarkedCard;
    delete nefurData.secretMarkedTargetId;

    this.eventBus.emit(GameEvent.Log, {
      message: `【秘闻】${player.name} 弃置了被标记的牌，须再弃置一张牌！`
    });

    // 目标须再弃置一张牌
    if (player.handCards.length > 0) {
      const driver = this.drivers.get(player.id)!;
      const discardIdxs = await (driver as any).promptDiscardMulti?.(player, 1, this.buildContext(player.id)) ?? [];
      if (discardIdxs.length > 0) {
        for (const idx of discardIdxs) {
          if (idx >= 0 && idx < player.handCards.length) {
            const c = player.handCards.splice(idx, 1)[0];
            this.deck.sendToDiscard(c);
            this.eventBus.emit(GameEvent.Log, {
              message: `${player.name} 因【秘闻】额外弃置了 ${getCardDetail(c)}`
            });
          }
        }
      }
    }
  }

  // ======================== 菈乌玛技能 ========================

  private addLaumaSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'lauma_moonsong',
      name: '咏月',
      description: `出牌阶段限一次，弃置两张颜色不同的手牌，选择一名其他角色摸两张牌，你回复1点体力。${data.moonsongUsedThisTurn ? '（本回合已使用）' : ''}`,
      type: 'active',
      usable: (p, c) => !data.moonsongUsedThisTurn && p.id === (c.currentPlayerId) && p.handCards.length >= 2,
    });
    skills.push({
      id: 'lauma_frostmoon',
      name: '灵使',
      description: `出牌阶段限一次，指定一名其他角色获得"霜月"标记。${data.frostmoonUsedThisTurn ? '（本回合已使用）' : ''}`,
      type: 'active',
      usable: (p, c) => !data.frostmoonUsedThisTurn && p.id === (c.currentPlayerId),
    });
  }

  /** 菈乌玛-咏月：弃置两张颜色不同的手牌，目标摸2，自回1血 */
  async laumaMoonsong(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    if (player.handCards.length < 2) return false;

    // 选择一张红牌和一张黑牌
    const redCard = player.handCards.find(c => c.suit === SuitType.Heart || c.suit === SuitType.Diamond);
    const blackCard = player.handCards.find(c => c.suit === SuitType.Spade || c.suit === SuitType.Club);
    if (!redCard || !blackCard) {
      this.eventBus.emit(GameEvent.Log, { message: `【咏月】需要弃置两张颜色不同的手牌，当前手牌颜色不足。` });
      return false;
    }

    const driver = this.drivers.get(player.id)!;
    // 选择红色牌
    const redIdx = await (driver as any).promptSelectCard?.(player, '咏月-选择一张红色牌弃置',
      (c: Card) => c.suit === SuitType.Heart || c.suit === SuitType.Diamond, ctx) ?? -1;
    if (redIdx < 0) return false;
    // 选择黑色牌（排除已选的红色牌）
    const blackIdx = await (driver as any).promptSelectCard?.(player, '咏月-选择一张黑色牌弃置',
      (c: Card) => (c.suit === SuitType.Spade || c.suit === SuitType.Club) && player.handCards.indexOf(c) !== redIdx, ctx) ?? -1;
    if (blackIdx < 0) return false;

    // 弃置两张牌（先弃后选，避免索引错乱）
    const cardsToDiscard: Card[] = [];
    const idx1 = Math.max(redIdx, blackIdx);
    const idx2 = Math.min(redIdx, blackIdx);
    cardsToDiscard.push(player.handCards.splice(idx1, 1)[0]);
    cardsToDiscard.push(player.handCards.splice(idx2, 1)[0]);
    for (const c of cardsToDiscard) {
      c.cardSource = player;
      this.deck.sendToDiscard(c);
    }

    // 选择目标
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '咏月-选择目标', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.moonsongUsedThisTurn = true;
    // 目标摸2张牌
    this.deck.drawCards(target, 2);
    // 自己回复1点体力
    player.hp = Math.min(player.maxHp, player.hp + 1);
    this.eventBus.emit(GameEvent.HpChanged, {
      playerId: player.id, newHp: player.hp, maxHp: player.maxHp, delta: 1, isDamage: false
    });

    this.eventBus.emit(GameEvent.Log, {
      message: `【咏月】${player.name} 弃置了2张牌，${target.name} 摸2张牌，${player.name} 回复1点体力(HP:${player.hp}/${player.maxHp})`
    });
    return true;
  }

  /** 菈乌玛-灵使：指定一名其他角色获得霜月标记 */
  async laumaFrostmoon(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '灵使-选择目标', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.frostmoonUsedThisTurn = true;
    data.frostMoonPartnerId = target.id;
    const tData = this.getData(target.id);
    tData._frostMoonOwnerId = player.id;

    const relation = player.hp > target.hp
      ? `${player.name}(${player.hp}HP) 将替 ${target.name}(${target.hp}HP) 承受伤害`
      : `${target.name}(${target.hp}HP) 将替 ${player.name}(${player.hp}HP) 承受伤害`;

    this.eventBus.emit(GameEvent.Log, {
      message: `【灵使】${player.name} 与 ${target.name} 建立"霜月"标记！${relation}。持续到${player.name}的下回合开始。`
    });
    return true;
  }

  // ======================== 欧洛伦技能 ========================

  private addOlorunSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'olorun_flute',
      name: '庇笛',
      description: `可以将一张手牌当【闪电】打出。${data.lightningUsedThisTurn ? '（本回合已发动）' : ''}`,
      type: 'active',
      usable: (p, c) => !data.lightningUsedThisTurn && p.id === (c.currentPlayerId) && p.handCards.length > 0,
    });
    skills.push({
      id: 'olorun_soul',
      name: '残魂',
      description: '回合开始时，可失去1点体力，选择场上已死亡角色获得其一项技能至下回合开始。',
      type: 'active',
      usable: (p) => p.handCards.length > 0 || true, // 总是可用
    });
  }

  /** 欧洛伦-残魂：失去1点体力，选择死亡角色获得其一项技能 */
  async olorunSoul(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);

    const deadPlayers = this.allPlayers.filter(p => p.isDead);
    if (deadPlayers.length === 0) return false;

    const driver = this.drivers.get(player.id)!;

    // 失去1点体力
    await this.damageSystem.applyHealthLoss(player, 1, player.name);
    if (player.isDead) return true;

    // 选择已死亡角色
    const targetId = await driver.promptTarget(player, deadPlayers.map(p => p.id), '残魂-选择已死亡角色', ctx);
    if (targetId === null) return false;
    const deadTarget = deadPlayers.find(p => p.id === targetId)!;

    // 获取死亡角色的技能列表
    const deadSkills = this.getSkills(deadTarget, ctx).filter(s => s.type !== 'passive'); // 被动技不能偷
    if (deadSkills.length === 0) {
      this.eventBus.emit(GameEvent.Log, { message: `【残魂】${deadTarget.name} 没有可获得的技能。` });
      return false;
    }

    // 选择一项技能
    const skillIdx = await (driver as any).promptSelectSkill?.(player, deadSkills.map(s => ({ id: s.id, name: s.name, desc: s.description })), ctx) ?? -1;
    if (skillIdx < 0 || skillIdx >= deadSkills.length) return false;

    const chosenSkill = deadSkills[skillIdx];

    // 存储偷来的技能
    data.stolenSkillId = chosenSkill.id;
    data.stolenSkillHeroId = deadTarget.heroId;
    data.stolenSkillData = {};

    this.eventBus.emit(GameEvent.Log, {
      message: `【残魂】${player.name} 失去了1点体力，获得了 ${deadTarget.name} 的技能【${chosenSkill.name}】！持续到${player.name}的下回合开始。`
    });

    // 将偷来的技能注册到当前玩家的技能列表中
    // 注意：这需要在getSkills中处理
    return true;
  }

  /** 获取欧洛伦偷来的技能（在getSkills中调用） */
  getOlorunStolenSkills(player: PlayerState, ctx: GameContextSnapshot): SkillInfo[] {
    const data = this.getData(player.id);
    if (!data.stolenSkillId) return [];

    const deadTarget = this.allPlayers.find(p => p.heroId === data.stolenSkillHeroId);
    if (!deadTarget) return [];

    const deadSkills = this.getSkills(deadTarget, ctx).filter(s => s.id === data.stolenSkillId);
    if (deadSkills.length === 0) return [];

    return [{
      ...deadSkills[0],
      id: `stolen_${data.stolenSkillId}`,
      usable: () => true,
    }];
  }

  /** 欧洛伦-庇笛：选择一张手牌当【闪电】打出（主动技能） */
  async olorunFlute(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    if (data.lightningUsedThisTurn) {
      this.eventBus.emit(GameEvent.Log, { message: '【庇笛】本回合已发动过，每回合限一次。' });
      return false;
    }
    if (player.handCards.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const cardIdx = await driver.promptSelectCard?.(player, '【庇笛】选择一张手牌当【闪电】打出', () => true, ctx) ?? -1;
    if (cardIdx < 0 || cardIdx >= player.handCards.length) return false;

    const card = player.handCards[cardIdx];
    data.lightningUsedThisTurn = true;

    // 创建虚拟闪电卡牌并在玩家判定区使用
    const fakeLightning: Card = {
      ...card, name: '闪电', type: CardType.Magic, isVirtual: true, cardSource: player
    };
    // 将手牌移到弃牌堆
    player.handCards.splice(cardIdx, 1);
    this.deck.sendToDiscard(card);

    // 将虚拟闪电放到自己判定区
    player.judgeZone.push(fakeLightning);
    this.eventBus.emit(GameEvent.CardMovedToJudge, {
      playerId: player.id, cardName: '闪电', cardSuit: fakeLightning.suit, cardNumber: fakeLightning.number
    });
    this.eventBus.emit(GameEvent.Log, {
      message: `【庇笛】${player.name} 将 ${getCardDetail(card)} 当【闪电】打入自己的判定区！`
    });
    return true;
  }

  // ======================== 茜特菈莉技能 ========================

  private addCitlaliSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'citlali_shaman',
      name: '萨满',
      description: `每轮限一次，判定开始前预言花色。正确回复1点体力，错误摸一张牌。${data.shamanUsedThisRound ? '（本轮已使用）' : ''}`,
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'citlali_memory',
      name: '记忆',
      description: '当一名角色进行判定时，若本局游戏上次判定牌仍在弃牌堆中，可替换本次判定牌。',
      type: 'trigger',
      usable: () => false,
    });
    skills.push({
      id: 'citlali_obsidian',
      name: '黑曜',
      description: '若场上出现黑桃判定牌，可选择与该判定角色进行决斗。对方每回合需打出两张【杀】。',
      type: 'trigger',
      usable: () => false,
    });
  }

  /** 茜特菈莉-萨满：预言判定花色（在onBeforeJudgeEffect中调用） */
  async citlaliShamanPredict(player: PlayerState): Promise<{ suit: string | null; predicted: boolean }> {
    const data = this.getData(player.id);
    if (data.shamanUsedThisRound) return { suit: null, predicted: false };

    const driver = this.drivers.get(player.id)!;
    const suits = ['Spade', 'Heart', 'Club', 'Diamond'];
    const suitNames = ['♠黑桃', '♥红心', '♣梅花', '♦方块'];

    // 选择预言花色
    const idx = await (driver as any).promptSelectOption?.(player, '萨满-预言判定花色', suitNames, this.buildContext(player.id)) ?? -1;
    if (idx < 0 || idx >= suits.length) return { suit: null, predicted: false };

    data.shamanUsedThisRound = true;
    const predictedSuit = suits[idx];
    this.eventBus.emit(GameEvent.Log, {
      message: `【萨满】${player.name} 预言了 ${suitNames[idx]} 花色。`
    });
    return { suit: predictedSuit, predicted: true };
  }

  /** 检查茜特菈莉-萨满预言结果（判定阶段中每张判定牌判定后调用） */
  checkCitlaliShamanResult(actualSuit: string): void {
    const citlali = this.allPlayers.find(p => p.heroId === 'citlali' && !p.isDead);
    if (!citlali) return;
    const data = this.getData(citlali.id);
    if (!data._shamanPrediction) return;

    const predicted = data._shamanPrediction;
    delete data._shamanPrediction;

    if (predicted === actualSuit) {
      citlali.hp = Math.min(citlali.maxHp, citlali.hp + 1);
      this.eventBus.emit(GameEvent.Log, {
        message: `【萨满】${citlali.name} 预言正确（${actualSuit}），回复1点体力！(HP:${citlali.hp}/${citlali.maxHp})`
      });
    } else {
      this.deck.drawCards(citlali, 1);
      this.eventBus.emit(GameEvent.Log, {
        message: `【萨满】${citlali.name} 预言错误（预言${predicted}，实际${actualSuit}），摸一张牌。`
      });
    }
  }

  /** 茜特菈莉-记忆：用上次判定牌替换本次判定牌 */
  async citlaliMemoryReplace(currentJudgeCard: Card): Promise<{ modified: boolean; card: Card }> {
    const citlali = this.allPlayers.find(p => p.heroId === 'citlali' && !p.isDead);
    if (!citlali) return { modified: false, card: currentJudgeCard };
    if (!this.isLastJudgeCardInDiscard()) return { modified: false, card: currentJudgeCard };

    const lastCard = this.getLastJudgeCard();
    if (!lastCard) return { modified: false, card: currentJudgeCard };
    if (lastCard === currentJudgeCard) return { modified: false, card: currentJudgeCard }; // 同一张牌不替换

    const driver = this.drivers.get(citlali.id)!;
    const use = await (driver as any).promptYesNo?.(
      `【记忆】上次判定牌 ${getCardDetail(lastCard)} 仍在弃牌堆中，是否替换本次判定牌 ${getCardDetail(currentJudgeCard)}？`
    );
    if (!use) return { modified: false, card: currentJudgeCard };

    // 从弃牌堆取出上次判定牌
    const discardIdx = this.deck.discardPile.indexOf(lastCard);
    if (discardIdx >= 0) {
      this.deck.discardPile.splice(discardIdx, 1);
    }
    // 将当前判定牌放入弃牌堆
    this.deck.sendToDiscard(currentJudgeCard);

    this.eventBus.emit(GameEvent.Log, {
      message: `【记忆】${citlali.name} 用上次判定牌 ${getCardDetail(lastCard)} 替换了本次判定牌！`
    });
    return { modified: true, card: lastCard };
  }

  /** 检查茜特菈莉-黑曜：黑桃判定牌出现时，询问是否决斗 */
  async checkCitlaliObsidian(judgeResult: Card, judgeTarget: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    if (judgeResult.suit !== SuitType.Spade) return false;

    const citlali = this.allPlayers.find(p => p.heroId === 'citlali' && !p.isDead);
    if (!citlali) return false;
    if (citlali.id === judgeTarget.id) return false; // 不能与自己决斗

    const data = this.getData(citlali.id);
    if (data.obsidianUsedThisTurn) return false;

    // AI 检查：不对队友打出决斗
    const driver = this.drivers.get(citlali.id)!;
    if (typeof (driver as any).isEnemy === 'function') {
      if (!(driver as any).isEnemy(citlali, judgeTarget)) {
        return false; // 判定目标不是敌人，跳过黑曜
      }
    }

    const use = await (driver as any).promptYesNo?.(
      `【黑曜】场上出现黑桃判定牌，是否与 ${judgeTarget.name} 进行决斗？（对方每回合需打出两张【杀】）`
    );
    if (!use) return false;

    data.obsidianUsedThisTurn = true;
    return true;
  }

  /** 检查回合限一次的标记是否已使用 */
  isShamanUsedThisRound(citlaliId: number): boolean {
    const data = this.getData(citlaliId);
    return !!data.shamanUsedThisRound;
  }
}
