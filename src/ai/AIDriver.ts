// ============================================================
// AIDriver.ts — AI 出牌决策引擎
// 规则驱动 + 优先级队列策略
// 包含角色特定策略（那维莱特、八重神子、希诺宁 等）
// ============================================================

import {
  IPlayerDriver, PlayerState, Card, CardType, EquipmentType,
  RoleType, SuitType, ElementType, GameContextSnapshot, ZoneSelection
} from '../core/types';
import { isSlash, getCardDetail, getCardColor, ColorType, getMagicSubType, MagicTimeType } from '../core/Card';
import { getWeaponRange, hasHandCards, getRoleChineseName } from '../core/Player';
import { getDistance, isInRange, getAlivePlayers } from '../core/DistanceCalc';

export class AIDriver implements IPlayerDriver {
  readonly playerId: number;
  private lastCtx: GameContextSnapshot | null = null;

  constructor(playerId: number) {
    this.playerId = playerId;
  }

  private getMe(ctx: GameContextSnapshot): PlayerState {
    this.lastCtx = ctx;
    return ctx.players.find(p => p.id === this.playerId)!;
  }

  // ======================== 出牌选择 ========================

  async promptPlayCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    const me = this.getMe(ctx);
    if (me.isDead || me.handCards.length === 0) return -1;

    // AI 出牌优先级策略
    const sorted = this.sortCardsByPriority(me, ctx);
    if (sorted.length === 0) return -1;

    // 返回优先级最高的牌在手牌中的索引
    const bestCard = sorted[0];
    const idx = me.handCards.indexOf(bestCard);
    return idx >= 0 ? idx : -1;
  }

  /** 获取手牌中除了指定名称外的最高优先级牌索引（用于跳过失败牌） */
  getNextBestCardIndex(state: PlayerState, ctx: GameContextSnapshot, excludeName: string): number {
    const me = this.getMe(ctx);
    const sorted = this.sortCardsByPriority(me, ctx);
    const filtered = sorted.filter(c => c.name !== excludeName);
    if (filtered.length === 0) return -1;
    const bestCard = filtered[0];
    const idx = me.handCards.indexOf(bestCard);
    return idx >= 0 ? idx : -1;
  }

  private sortCardsByPriority(me: PlayerState, ctx: GameContextSnapshot): Card[] {
    const cards = [...me.handCards];
    const enemies = this.getEnemies(me, ctx);
    const allies = this.getAllies(me, ctx);

    // 给每张牌打分
    const scored = cards.map(card => ({
      card,
      score: this.scoreCard(card, me, ctx, enemies, allies)
    }));

    // 过滤掉分值为0的牌（不能打出的）
    const playable = scored.filter(s => s.score > 0);
    // 按分值降序排列
    playable.sort((a, b) => b.score - a.score);

    return playable.map(s => s.card);
  }

  private scoreCard(
    card: Card,
    me: PlayerState,
    ctx: GameContextSnapshot,
    enemies: PlayerState[],
    allies: PlayerState[]
  ): number {
    // 装备牌优先挂
    if (card.type === CardType.Equipment) return 90;

    switch (card.name) {
      // 桃：自己不满血才用
      case '桃':
        return me.hp < me.maxHp ? 100 : 0;
      // 酒：每回合限一次（用 wineUsedThisTurn 而非 nextSlashDamageBonus，避免杀消耗后误判可再出）
      case '酒':
        if (me.wineUsedThisTurn) return 0;
        const hasSlash = me.handCards.some(c => isSlash(c) && c !== card);
        return hasSlash ? 75 : (me.hp <= 1 ? 80 : 30);
      // 无中生有：几乎必用
      case '无中生有':
        return 95;
      // 顺手牵羊：距离1内有可偷的目标
      case '顺手牵羊': {
        const hasTarget = enemies.some(e =>
          getDistance(me, e, ctx.players) <= 1 &&
          (e.handCards.length > 0 || Object.values(e.equipZone).some(v => v !== null))
        );
        return hasTarget ? 85 : 0;
      }
      // 过河拆桥：有可拆的目标
      case '过河拆桥': {
        const hasTarget = enemies.some(e =>
          e.handCards.length > 0 || Object.values(e.equipZone).some(v => v !== null)
        );
        return hasTarget ? 80 : 0;
      }
      // 决斗：对手牌少的敌人用
      case '决斗': {
        const weakEnemy = enemies.find(e => e.handCards.length <= 1);
        return weakEnemy ? 75 : 50;
      }
      // 火攻：对手牌比自己少的敌人用
      case '火攻': {
        const target = enemies.find(e => e.handCards.length > 0 && e.handCards.length < me.handCards.length);
        return target ? 70 : 30;
      }
      // 南蛮入侵：己方存活人数多于敌方时使用
      case '南蛮入侵':
        return allies.length >= enemies.length ? 65 : 20;
      // 万箭齐发
      case '万箭齐发':
        return allies.length >= enemies.length ? 65 : 20;
      // 桃园结义：己方有受伤的
      case '桃园结义': {
        const injuredAllies = allies.filter(a => a.hp < a.maxHp).length;
        return injuredAllies >= 2 ? 70 : (injuredAllies >= 1 ? 50 : 10);
      }
      // 五谷丰登：己方先选则使用
      case '五谷丰登': {
        const alivePlayers = getAlivePlayers(ctx.players);
        const myIdx = alivePlayers.indexOf(me);
        const enemyCount = enemies.length;
        // 己方先选（前几位）则使用
        return myIdx < alivePlayers.length / 2 ? 60 : 30;
      }
      // 杀/火杀/雷杀
      case '杀':
      case '火杀':
      case '雷杀': {
        if (me.slashUsedCount >= 1 &&
            me.equipZone[EquipmentType.Weapon]?.name !== '诸葛连弩') return 0;
        const canHit = enemies.some(e =>
          getWeaponRange(me) >= getDistance(me, e, ctx.players)
        );
        return canHit ? 55 : 0;
      }
      // 延时锦囊
      case '乐不思蜀':
      case '兵粮寸断': {
        const limit = card.name === '兵粮寸断' ? 1 : 99;
        const hasTarget = enemies.some(e =>
          getDistance(me, e, ctx.players) <= limit &&
          !e.judgeZone.some(c => c.name === card.name)
        );
        return hasTarget ? 60 : 0;
      }
      // 闪电：随意
      case '闪电':
        return me.judgeZone.some(c => c.name === '闪电') ? 0 : 40;
      // 借刀杀人：特判防止连续借刀（必须排除自己，不能借自己的武器）
      case '借刀杀人': {
        const weaponHolders = ctx.players.filter(p =>
          !p.isDead && p.id !== me.id && p.equipZone[EquipmentType.Weapon] !== null
        );
        if (weaponHolders.length === 0) return 0;

        // 检查是否有武器持有者能杀到的目标
        let bestVictimIsEnemy = false;
        const hasValidSetup = weaponHolders.some(wh => {
          const victims = ctx.players.filter(t =>
            !t.isDead && t !== wh &&
            getWeaponRange(wh) >= getDistance(wh, t, ctx.players)
          );
          // 记录是否存在敌方受害者（借刀能对敌人造成伤害更优）
          if (victims.some(v => this.isEnemy(me, v))) {
            bestVictimIsEnemy = true;
          }
          return victims.length > 0;
        });
        if (!hasValidSetup) return 0;

        // 特判核心：已有武器时借刀杀人价值大幅下降
        const hasWeapon = me.equipZone[EquipmentType.Weapon] !== null;
        if (hasWeapon) {
          // 有武器时只在高价值场景使用：
          // 1) 武器持有者是敌人（削弱敌人装备）
          // 2) 借刀目标能杀到敌人（借刀杀敌）
          const enemyWeaponHolder = weaponHolders.some(wh => this.isEnemy(me, wh));
          if (enemyWeaponHolder && bestVictimIsEnemy) {
            return 20; // 一石二鸟：夺敌武器 + 借刀杀敌
          }
          if (enemyWeaponHolder) {
            return 12; // 仅夺敌武器，收益有限
          }
          // 武器持有者是盟友 or 不能杀敌人 → 很低价值
          return 5;
        }

        // 无武器：借刀杀人价值高（获取武器 或 借刀杀敌）
        const enemyWeaponHolder = weaponHolders.some(wh => this.isEnemy(me, wh));
        return enemyWeaponHolder && bestVictimIsEnemy ? 55 : 40;
      }
      // 铁索连环：重铸或连环
      case '铁索连环':
        return 45;
      default: {
        // 妮露-水月：红色非杀手牌可以当杀使用
        if (ctx.nilouStance === '水月' && me.heroId === 'nilou' &&
            (card.suit === SuitType.Heart || card.suit === SuitType.Diamond)) {
          if (me.slashUsedCount >= 1 &&
              me.equipZone[EquipmentType.Weapon]?.name !== '诸葛连弩') return 0;
          const canHit = enemies.some(e =>
            getWeaponRange(me) >= getDistance(me, e, ctx.players)
          );
          return canHit ? 55 : 0;
        }
        return 0;
      }
    }
  }

  // ======================== 目标选择 ========================

  async promptTarget(
    state: PlayerState,
    validTargets: number[],
    reason: string,
    ctx: GameContextSnapshot
  ): Promise<number | null> {
    const me = this.getMe(ctx);
    const targets = ctx.players.filter(p => validTargets.includes(p.id));
    if (targets.length === 0) return null;

    // 根据 reason 判断技能是进攻型还是辅助型
    const isDefensive = this.isDefensiveSkill(reason);
    
    if (isDefensive) {
      // 辅助/防御型技能：优先选择盟友（需要帮助的队友）
      const allies = targets.filter(t => !this.isEnemy(me, t) && t.id !== me.id);
      if (allies.length > 0) {
        // 优先选血量最低的盟友
        allies.sort((a, b) => a.hp - b.hp);
        return allies[0].id;
      }
      // 没有盟友则在目标中选最需要帮助的
      targets.sort((a, b) => a.hp - b.hp);
      return targets[0].id;
    }

    // 进攻型技能（或默认）：优先选择敌人
    const enemies = targets.filter(t => this.isEnemy(me, t));
    if (enemies.length > 0) {
      // 内奸策略：动态平衡 反→忠→反→忠→反→反→主
      if (me.role === RoleType.Traitor) {
        const rebels = enemies.filter(e => e.role === RoleType.Rebel);
        const ministers = enemies.filter(e => e.role === RoleType.Minister);
        const monarchs = enemies.filter(e => e.role === RoleType.Monarch);

        // 根据剩余人数动态平衡：优先削弱人数多的一方
        if (rebels.length > 0 || ministers.length > 0) {
          // 双方都存在时：交替击杀，从反贼开始
          if (rebels.length > 0 && ministers.length > 0) {
            // 交替：上次杀了谁，这次杀另一方
            const lastRole = (me as any)._traitorLastTargetRole;
            if (lastRole === 'Minister') {
              (me as any)._traitorLastTargetRole = 'Rebel';
              rebels.sort((a, b) => a.hp - b.hp);
              return rebels[0].id;
            } else {
              // 首次或上次杀反贼，这次杀忠臣
              (me as any)._traitorLastTargetRole = 'Minister';
              ministers.sort((a, b) => a.hp - b.hp);
              return ministers[0].id;
            }
          }
          // 只剩一方：清剿
          if (rebels.length > 0) {
            (me as any)._traitorLastTargetRole = 'Rebel';
            rebels.sort((a, b) => a.hp - b.hp);
            return rebels[0].id;
          }
          if (ministers.length > 0) {
            (me as any)._traitorLastTargetRole = 'Minister';
            ministers.sort((a, b) => a.hp - b.hp);
            return ministers[0].id;
          }
        }
        // 最后击杀主公
        if (monarchs.length > 0) {
          monarchs.sort((a, b) => a.hp - b.hp);
          return monarchs[0].id;
        }
      }
      // 其他身份：优先选血量低的
      // 主公/忠臣：优先击杀反贼，后内奸
      if (me.role === RoleType.Monarch || me.role === RoleType.Minister) {
        const rebels = enemies.filter(e => e.role === RoleType.Rebel);
        const traitors = enemies.filter(e => e.role === RoleType.Traitor);
        if (rebels.length > 0) {
          rebels.sort((a, b) => a.hp - b.hp);
          return rebels[0].id;
        }
        if (traitors.length > 0) {
          traitors.sort((a, b) => a.hp - b.hp);
          return traitors[0].id;
        }
      }
      // 反贼：优先击杀主公，后忠臣，后内奸
      if (me.role === RoleType.Rebel) {
        const monarchs = enemies.filter(e => e.role === RoleType.Monarch);
        const ministers = enemies.filter(e => e.role === RoleType.Minister);
        const traitors = enemies.filter(e => e.role === RoleType.Traitor);
        if (monarchs.length > 0) {
          monarchs.sort((a, b) => a.hp - b.hp);
          return monarchs[0].id;
        }
        if (ministers.length > 0) {
          ministers.sort((a, b) => a.hp - b.hp);
          return ministers[0].id;
        }
        if (traitors.length > 0) {
          traitors.sort((a, b) => a.hp - b.hp);
          return traitors[0].id;
        }
      }
      // fallback: 血量最低优先
      enemies.sort((a, b) => a.hp - b.hp);
      return enemies[0].id;
    }

    return targets[0].id;
  }

  /** 判断技能reason是否为辅助/防御型 */
  private isDefensiveSkill(reason: string): boolean {
    const defensiveReasons = [
      '祝福',    // 希诺宁-祝福：buff队友
      '七星',    // 凝光-七星：回复体力
      '契约',    // 钟离-契约：建立保护关系
      '军师',    // 珊瑚宫心海-军师：给牌给队友
      // 闲游为中性，默认选敌人作为目标交换位置更有战术价值
    ];
    return defensiveReasons.some(r => reason.includes(r));
  }

  // ======================== 响应索要 ========================

  async promptResponse(
    state: PlayerState,
    cardName: string,
    ctx: GameContextSnapshot
  ): Promise<Card | null> {
    const me = this.getMe(ctx);

    // 花色响应（火攻用）
    if (cardName.startsWith('花色:')) {
      const suit = cardName.split(':')[1];
      const matched = me.handCards.find(c => c.suit === suit);
      return matched ?? null;
    }

    // 杀/闪/桃/酒 响应
    switch (cardName) {
      case '杀': {
        // 保命优先，有杀就出
        const slashes = me.handCards.filter(c => isSlash(c));
        if (slashes.length > 0) return slashes[0];
        // 妮露-水月：红色牌可当杀
        if (me.heroId === 'nilou' && ctx.nilouStance === '水月') {
          const red = me.handCards.find(c => c.suit === SuitType.Heart || c.suit === SuitType.Diamond);
          if (red) return red;
        }
        return null;
      }
      case '闪': {
        const flash = me.handCards.find(c => c.name === '闪');
        if (flash) return flash;
        // 妮露-水环：黑色牌可当闪
        if (me.heroId === 'nilou' && ctx.nilouStance === '水环') {
          const black = me.handCards.find(c => c.suit === SuitType.Spade || c.suit === SuitType.Club);
          if (black) return black;
        }
        return null;
      }
      case '桃': {
        // AI 在濒死救援时：同阵营才出桃；自救时无条件
        const dyingId = ctx.dyingPlayerId;
        if (dyingId !== undefined && dyingId !== me.id) {
          const dyingPlayer = ctx.players.find(p => p.id === dyingId);
          if (dyingPlayer && this.isEnemy(me, dyingPlayer)) {
            return null; // 不救敌人
          }
        }
        const peach = me.handCards.find(c => c.name === '桃');
        return peach ?? null;
      }
      case '酒': {
        const wine = me.handCards.find(c => c.name === '酒');
        return wine ?? null;
      }
      default:
        return null;
    }
  }

  // ======================== 区域选择 ========================

  async promptZone(
    state: PlayerState,
    targetId: number,
    ctx: GameContextSnapshot
  ): Promise<ZoneSelection | null> {
    const target = ctx.players.find(p => p.id === targetId);
    if (!target) return null;

    // AI 优先级：装备区 > 判定区 > 手牌区
    const hasEquip = Object.values(target.equipZone).some(v => v !== null);
    if (hasEquip) {
      const equipSlots = Object.entries(target.equipZone)
        .filter(([, v]) => v !== null);
      return { zone: 'equip', index: 0 };
    }

    if (target.judgeZone.length > 0) {
      return { zone: 'judge', index: 0 };
    }

    if (target.handCards.length > 0) {
      return { zone: 'hand', index: 0 };
    }

    return null;
  }

  // ======================== 丈八蛇矛 ========================

  async promptZhanBa(
    state: PlayerState,
    ctx: GameContextSnapshot
  ): Promise<[number, number] | null> {
    const me = this.getMe(ctx);
    if (me.handCards.length < 2) return null;
    // 选前两张非杀的牌
    const nonSlashes = me.handCards.filter(c => !isSlash(c));
    if (nonSlashes.length >= 2) {
      return [me.handCards.indexOf(nonSlashes[0]), me.handCards.indexOf(nonSlashes[1])];
    }
    return [0, 1];
  }

  // ======================== 弃牌 ========================

  async promptDiscard(
    state: PlayerState,
    ctx: GameContextSnapshot
  ): Promise<number> {
    const me = this.getMe(ctx);
    if (me.handCards.length === 0) return 0;

    // AI 弃牌策略：优先弃置价值最低的牌
    // 优先级（从高到低保留）：桃 > 无懈可击 > 闪 > 杀 > 锦囊 > 装备
    const priority: Record<string, number> = {
      '桃': 10, '无懈可击': 9, '酒': 8, '闪': 7,
      '杀': 5, '火杀': 5, '雷杀': 5,
    };

    let worstIdx = 0;
    let worstScore = Infinity;
    for (let i = 0; i < me.handCards.length; i++) {
      const score = priority[me.handCards[i].name] ?? 3;
      if (score < worstScore) {
        worstScore = score;
        worstIdx = i;
      }
    }

    return worstIdx;
  }

  // ======================== 无懈可击 ========================

  async promptNullification(
    state: PlayerState,
    ctx: GameContextSnapshot
  ): Promise<boolean> {
    const me = this.getMe(ctx);
    const hasNullify = me.handCards.some(c => c.name === '无懈可击');
    if (!hasNullify) return false;

    // 获取无懈可击的上下文信息
    const targetId = ctx.nullifyTargetId;
    const sourceId = ctx.nullifySourceId;
    const cardName = ctx.nullifyCardName || '';

    // 如果没有上下文信息，保守策略：不使用（避免无懈自己的锦囊）
    if (targetId === undefined || sourceId === undefined) return false;

    const target = ctx.players.find(p => p.id === targetId);
    const source = ctx.players.find(p => p.id === sourceId);
    if (!target || !source) return false;

    // 益类锦囊（五谷丰登、桃园结义、无中生有）绝不无懈
    const BENEFICIAL_CARDS = ['五谷丰登', '桃园结义', '无中生有'];
    if (BENEFICIAL_CARDS.includes(cardName)) {
      return false;
    }

    // 策略判断：
    // 1. 如果锦囊来源(source)是己方盟友 → 不无懈（保护盟友的锦囊）
    // 2. 如果锦囊目标(target)是己方盟友（包括自己）且来源是敌方 → 无懈（保护盟友）
    // 3. 如果锦囊目标(target)是敌方 → 不无懈（让敌方受到效果）

    const sourceIsAlly = !this.isEnemy(me, source);
    const targetIsAlly = !this.isEnemy(me, target);

    // 来源是盟友 → 不无懈盟友的锦囊
    if (sourceIsAlly) {
      return false;
    }

    // 来源是敌方，目标是盟友（含自己）→ 无懈保护盟友
    if (!sourceIsAlly && targetIsAlly) {
      return true;
    }

    // 来源是敌方，目标也是敌方 → 不无懈（鹬蚌相争）
    return false;
  }

  // ======================== 防具触发 ========================

  async promptArmorTrigger(
    state: PlayerState,
    armorName: string,
    ctx: GameContextSnapshot
  ): Promise<boolean> {
    // AI 总是发动防具效果
    return true;
  }

  // ======================== 武器特效 ========================

  async promptWeaponEffect(
    state: PlayerState,
    weaponName: string,
    ctx: GameContextSnapshot
  ): Promise<boolean> {
    const me = this.getMe(ctx);
    // AI 根据武器决定是否发动
    switch (weaponName) {
      case '贯石斧': {
        // 手牌足够则发动
        const totalAvailable = me.handCards.length +
          Object.values(me.equipZone).filter(v => v !== null).length;
        return totalAvailable >= 2;
      }
      case '青龙偃月刀': {
        const hasSlash = me.handCards.some(c => isSlash(c));
        return hasSlash;
      }
      case '寒冰剑': {
        // 对方有牌可弃则发动
        return true;
      }
      default:
        return true;
    }
  }

  // ======================== 铁索连环模式 ========================

  async promptIronChainMode(
    state: PlayerState,
    ctx: GameContextSnapshot
  ): Promise<'recast' | 'chain'> {
    const me = this.getMe(ctx);
    // 手牌少时重铸摸牌，手牌多时连环
    return me.handCards.length <= 3 ? 'recast' : 'chain';
  }

  // ======================== 五谷丰登选牌 ========================

  async promptAmazingGrace(
    state: PlayerState,
    tableCards: Card[],
    ctx: GameContextSnapshot
  ): Promise<number> {
    const me = this.getMe(ctx);
    // AI 选牌策略：优先桃 > 无懈 > 顺手 > 过河 > 无中 > 杀 > 闪 > 其他
    const priority: Record<string, number> = {
      '桃': 100, '无懈可击': 90, '顺手牵羊': 80, '过河拆桥': 75,
      '无中生有': 70, '决斗': 60, '火攻': 55, '南蛮入侵': 50,
      '万箭齐发': 50, '五谷丰登': 45, '借刀杀人': 40,
      '乐不思蜀': 65, '兵粮寸断': 65, '闪电': 10,
      '杀': 30, '火杀': 30, '雷杀': 30, '闪': 25, '酒': 35, '桃园结义': 40,
    };

    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < tableCards.length; i++) {
      const score = priority[tableCards[i].name] ?? (tableCards[i].type === CardType.Equipment ? 50 : 20);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    return bestIdx;
  }

  // ======================== 火攻展示牌 ========================

  async promptShowCard(
    state: PlayerState,
    ctx: GameContextSnapshot
  ): Promise<number> {
    const me = this.getMe(ctx);
    // AI 展示一张花色最多的牌（让对手更难匹配）
    if (me.handCards.length === 0) return 0;

    // 统计花色分布
    const suitCount: Record<string, number> = {};
    for (const c of me.handCards) {
      suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
    }
    // 展示花色最少的牌
    let worstIdx = 0;
    let minCount = Infinity;
    for (let i = 0; i < me.handCards.length; i++) {
      const count = suitCount[me.handCards[i].suit] || 0;
      if (count < minCount) {
        minCount = count;
        worstIdx = i;
      }
    }
    return worstIdx;
  }

  // ======================== 青龙刀选牌 / 通用选牌 ========================

  // TypeScript 重载声明（旧式3参 + 新式4参）
  promptSelectCard(state: PlayerState, validCards: Card[], ctx: GameContextSnapshot): Promise<number>;
  promptSelectCard(state: PlayerState, title: string, filter: (card: Card) => boolean, ctx: GameContextSnapshot): Promise<number>;

  async promptSelectCard(
    state: PlayerState,
    arg2: Card[] | string,
    arg3?: any,
    arg4?: any
  ): Promise<number> {
    if (Array.isArray(arg2)) {
      // 旧式: (state, validCards: Card[], ctx) — 从给定牌中选第一张
      return arg2.length > 0 ? 0 : -1;
    }
    // 新式: (state, title: string, filter, ctx) — 从手牌中按标题和filter选
    const title = arg2 as string;
    const filter = arg3 as ((card: Card) => boolean);
    const ctx = arg4 as GameContextSnapshot;
    const me = this.getMe(ctx);
    // AI: 在符合条件的牌中选价值最低的（因为通常是要弃置或交出）
    // title含"弃"、"献"等代表要失去 → 选价值最低的
    const isLosing = title.includes('弃') || title.includes('置于') || title.includes('扣置') || title.includes('放回');
    
    if (isLosing) {
      // 选价值最低的牌弃置
      let worstIdx = -1;
      let worstScore = Infinity;
      for (let i = 0; i < me.handCards.length; i++) {
        if (filter(me.handCards[i])) {
          const score = this.getCardRetainPriority(me.handCards[i]);
          if (score < worstScore) {
            worstScore = score;
            worstIdx = i;
          }
        }
      }
      return worstIdx;
    }
    // 选价值最高的
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < me.handCards.length; i++) {
      if (filter(me.handCards[i])) {
        const score = this.getCardRetainPriority(me.handCards[i]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
    }
    return bestIdx;
  }

  // ======================== 雌雄双股剑 ========================

  async promptGenderWeapon(
    state: PlayerState,
    attackerName: string,
    ctx: GameContextSnapshot
  ): Promise<'discard' | 'draw'> {
    const me = this.getMe(ctx);
    // 手牌多则弃牌，手牌少则让对方摸
    return me.handCards.length >= 3 ? 'discard' : 'draw';
  }

  /** 获取手牌保留优先级（值越小越优先弃置） */
  private getCardRetainPriority(card: Card): number {
    // 基本牌
    if (card.name === '桃') return 10;
    if (card.name === '酒') return 8;
    if (card.name === '闪') return 7;
    if (card.name === '杀' || card.name === '火杀' || card.name === '雷杀') return 6;
    // 锦囊牌
    if (card.name === '无懈可击') return 9;
    if (card.name === '无中生有') return 7;
    if (card.name === '五谷丰登') return 5;
    if (card.name === '南蛮入侵' || card.name === '万箭齐发') return 4;
    if (card.name === '借刀杀人' || card.name === '决斗' || card.name === '火攻') return 3;
    if (card.name === '过河拆桥' || card.name === '顺手牵羊') return 5;
    if (card.name === '铁索连环') return 3;
    // 延时锦囊
    if (card.name === '乐不思蜀' || card.name === '兵粮寸断') return 6;
    if (card.name === '闪电') return 2;
    // 装备牌
    if (card.type === 'Equipment') return 4;
    return 3;
  }

  // ======================== 阵营判定辅助 ========================

  private isEnemy(me: PlayerState, other: PlayerState): boolean {
    if (me.role === RoleType.None || other.role === RoleType.None) return true;

    // 主公视角：反贼和内奸是敌人
    if (me.role === RoleType.Monarch) {
      return other.role === RoleType.Rebel || other.role === RoleType.Traitor;
    }
    // 忠臣视角：反贼和内奸是敌人
    if (me.role === RoleType.Minister) {
      return other.role === RoleType.Rebel || other.role === RoleType.Traitor;
    }
    // 反贼视角：主公和忠臣是敌人
    if (me.role === RoleType.Rebel) {
      return other.role === RoleType.Monarch || other.role === RoleType.Minister;
    }
    // 内奸视角：所有人都是潜在的敌人（但优先杀忠反）
    if (me.role === RoleType.Traitor) {
      return true;
    }

    return true;
  }

  private getEnemies(me: PlayerState, ctx: GameContextSnapshot): PlayerState[] {
    return ctx.players.filter(p => !p.isDead && p.id !== me.id && this.isEnemy(me, p));
  }

  private getAllies(me: PlayerState, ctx: GameContextSnapshot): PlayerState[] {
    return ctx.players.filter(p =>
      !p.isDead && p.id !== me.id && !this.isEnemy(me, p)
    );
  }

  // ======================== 通用 Yes/No 决策 ========================

  /** AI 通用 Yes/No 决策：根据上下文智能判断是否发动技能 */
  async promptYesNo(question: string): Promise<boolean> {
    // 温迪-吟游：濒死自救时总是使用
    if (question.includes('吟游') && question.includes('自救')) {
      return true;
    }
    // 雷电将军-无想：防止伤害积累标记（标记>=3时释放伤害）
    if (question.includes('无想') && question.includes('防止')) {
      const match = question.match(/当前标记：(\d+)枚/);
      const marks = match ? parseInt(match[1]) : 0;
      if (marks >= 3) return false; // 标记达到上限，释放伤害
      return true; // 优先积累标记
    }
    // 纳西妲-囚笼：双倍锦囊
    if (question.includes('囚笼')) {
      return true; // 总是发动
    }
    // 哥伦比娅-少女：出牌阶段开始/结束，减体力上限获空月标记
    if (question.includes('少女')) {
      if (this.lastCtx) {
        const me = this.lastCtx.players.find(p => p.id === this.playerId);
        if (me && me.hp <= 2) {
          // 血量低时不再减少体力上限
          return false;
        }
      }
      return true;
    }
    // 哥伦比娅-月神：摸牌加成
    if (question.includes('月神')) {
      return true; // 总是发动
    }
    // 艾尔海森-代贤：双无懈后回收锦囊
    if (question.includes('代贤')) {
      return true; // 白拿锦囊，总是发动
    }
    // 琴-蒲骑：跳过AOE总是好
    if (question.includes('蒲骑')) {
      return true; // 跳过群体锦囊并摸牌，总是有利
    }
    // 可莉-禁闭：追加伤害+翻面，斟酌
    if (question.includes('禁闭')) {
      // 只在有足够手牌且不会危及自身时发动
      return true; // AI 激进策略：总是发动
    }
    // 玛拉妮-团结：如果所有敌方已连环则不发动
    if (question.includes('团结') && question.includes('连环')) {
      if (this.lastCtx) {
        const me = this.lastCtx.players.find(p => p.id === this.playerId);
        if (me) {
          const enemies = this.lastCtx.players.filter(p =>
            !p.isDead && p.id !== me.id && this.isEnemy(me, p)
          );
          const allChained = enemies.length > 0 && enemies.every(e => e.isChained);
          if (allChained) return false; // 全体已连环，不发动
        }
      }
      return true;
    }
    // 甘雨-月海：翻面回收本回合打出的牌（超过5张才发动）
    if (question.includes('月海') && question.includes('翻面')) {
      // 从问题中解析打出牌数："获得本回合打出的X张手牌"
      const match = question.match(/打出的(\d+)张/);
      const playedCount = match ? parseInt(match[1]) : 0;
      return playedCount > 5; // 超过5张才值得翻面
    }
    // 茜特菈莉-记忆：替换判定牌
    if (question.includes('记忆') && question.includes('替换')) {
      return true; // 替换判定牌通常有利
    }
    // 茜特菈莉-黑曜：黑桃判定时决斗
    if (question.includes('黑曜') && question.includes('决斗')) {
      return true; // 主动决斗总是有利
    }
    // 欧洛伦-庇笛：不要每张牌都转闪电，控制频率（约30%概率）
    if (question.includes('庇笛') && question.includes('闪电')) {
      return Math.random() < 0.3;
    }
    // 默认：总是发动有利技能
    return true;
  }

  /** 温迪-自由：AI 选择体力上限 */
  async promptVentiFree(state: PlayerState): Promise<number> {
    // AI 策略：手牌多则降低体力上限（增加手牌上限），血量危急则保留较高体力
    if (state.hp <= 2) {
      // 血量低：保持较高体力上限 = 7（手牌上限=1）
      return 7;
    }
    if (state.handCards.length >= 6) {
      // 手牌多：降低体力上限以增加手牌上限
      // 体力上限 = 3（手牌上限=5）或 4（手牌上限=4）
      return state.hp <= 3 ? 4 : 3;
    }
    // 默认：体力上限=4（手牌上限=4）
    return 4;
  }

  // ======================== 主动技能决策 ========================

  /**
   * AI 选择是否使用主动技能。
   * 返回技能ID（如 'yae_charm'），或 null 表示跳过。
   * 由 GameFlowController 在出牌阶段开始时调用。
   */
  promptActiveSkill(
    state: PlayerState,
    availableSkills: { id: string; name: string; description: string }[],
    ctx: GameContextSnapshot
  ): string | null {
    if (availableSkills.length === 0) return null;

    const me = this.getMe(ctx);
    const enemies = this.getEnemies(me, ctx);
    const allies = this.getAllies(me, ctx);

    for (const skill of availableSkills) {
      const decision = this.evaluateSkill(skill.id, me, ctx, enemies, allies);
      if (decision) return skill.id;
    }

    return null;
  }

  /** 评估单个主动技能的发动价值 */
  private evaluateSkill(
    skillId: string,
    me: PlayerState,
    ctx: GameContextSnapshot,
    enemies: PlayerState[],
    allies: PlayerState[]
  ): boolean {
    switch (skillId) {
      // ======================== 八重神子-狐魅 ========================
      case 'yae_charm':
        return this.evaluateYaeCharm(me, ctx, enemies);

      // ======================== 希诺宁-工匠 ========================
      case 'xilonen_craft':
        return this.evaluateXilonenCraft(me, ctx, enemies, allies);

      // ======================== 希诺宁-祝福 ========================
      case 'xilonen_blessing':
        return this.evaluateXilonenBlessing(me, ctx, enemies, allies);

      // ======================== 钟离-契约 ========================
      case 'zhongli_contract':
        // 需要有其他存活角色才能建立契约
        return this.evaluateZhongliContract(me, ctx);

      // ======================== 钟离-闲游 ========================
      case 'zhongli_leisure':
        return this.evaluateZhongliLeisure(me, ctx, enemies);

      // ======================== 雷电将军-御决 ========================
      case 'raiden_decree':
        return enemies.length >= 2; // 有至少2个敌人时发动

      // ======================== 纳西妲-比喻 ========================
      case 'nahida_metaphor':
        // 检查手牌中是否有锦囊牌
        return me.handCards.some(c => c.type === CardType.Magic);

      // ======================== 玛薇卡-圣火 ========================
      case 'mavuika_holyFire': {
        // 确保有普通杀可转化且确实有敌人
        const hasNormalSlash = me.handCards.some(c => isSlash(c) && (!c.element || c.element === ElementType.None));
        return hasNormalSlash && enemies.length > 0;
      }

      // ======================== 枫原万叶-红枫 ========================
      case 'kazuha_redmaple':
        // 有至少2张基本牌且有敌人时发动
        const basicCount = me.handCards.filter(c => c.type === CardType.Basic).length;
        return basicCount >= 2 && enemies.length > 0;

      // ======================== 宵宫-夏祭 ========================
      case 'yoimiya_firework':
        // 有红桃牌且有敌人时挂烟花
        return me.handCards.some(c => c.suit === SuitType.Heart) && enemies.length > 0;

      // ======================== 莱欧斯利-公爵 ========================
      case 'wriothesley_duke':
        // 有黑色手牌且有敌人
        return me.handCards.some(c =>
          c.suit === SuitType.Spade || c.suit === SuitType.Club
        ) && enemies.length > 0;

      // ======================== 胡桃-幽蝶 ========================
      case 'hutao_butterfly':
        return me.hp >= 3 && enemies.length > 0; // HP>=3且有敌人才用

      // ======================== 凝光-七星 ========================
      case 'ningguang_stars':
        // 限定技：只在己方有成员HP严重不足（≤1）时才发动
        const criticalAlly = allies.find(a => a.hp <= 1);
        return criticalAlly !== undefined || me.hp <= 1;

      // ======================== 凝光-天权 ========================
      case 'ningguang_heaven':
        return enemies.length > 0;

      // ======================== 艾尔海森-知论 ========================
      case 'alhaitham_knowledge':
        return me.handCards.length >= 3; // 手牌多时扣置

      // ======================== 夜兰-幽客 ========================
      case 'yelan_spy':
        // 有未查看过的敌人时才发动
        return enemies.length > 0 && enemies.length <= 2;

      // ======================== 妮露-莲步 ========================
      case 'nilou_step':
        // 根据手牌颜色选择：红牌多→水月（红牌当杀），黑牌多→水环（黑牌当闪）
        const redCount = me.handCards.filter(c =>
          c.suit === SuitType.Heart || c.suit === SuitType.Diamond
        ).length;
        const blackCount = me.handCards.filter(c =>
          c.suit === SuitType.Spade || c.suit === SuitType.Club
        ).length;
        const currentStance = (ctx as any).nilouStance;
        // 红牌多时选水月，黑牌多时选水环
        if (redCount > blackCount && currentStance !== '水月') return true;
        if (blackCount > redCount && currentStance !== '水环') return true;
        return redCount === blackCount && currentStance === '水环'; // 均等时偏向水月

      // ======================== 迪希雅-佣兵 ========================
      case 'dehya_mercenary':
        return enemies.length > 0 && me.handCards.length > 0;

      // ======================== 珊瑚宫心海-军师 ========================
      case 'kokomi_strategist':
        // 有手牌且有盟友时发动：给牌+桃园结义
        return me.handCards.length > 0 && allies.length > 0;

      // ======================== 荒泷一斗-赤鬼 ========================
      case 'ittou_redoni':
        // 失去1点体力换取1张牌，HP≥2且有手牌需求时值得发动
        return me.hp >= 2;

      // ======================== 魈-降魔 ========================
      case 'xiao_demon_tamer':
        return enemies.length > 0 && me.handCards.length >= 2; // 有敌人且手牌>=2张时封印花色

      // ======================== 温迪-自由 ========================
      case 'venti_free':
        return true; // 总是可以调整

      // ======================== 琴-代理 ========================
      case 'jean_agent': {
        // 手牌多时有交换价值（换对手少的手牌）
        const aliveOthers = ctx.players.filter(p => !p.isDead && p.id !== me.id);
        if (aliveOthers.length === 0) return false;
        // 有敌人且手牌数>=2时值得发动
        const hasEnemyWithFewerCards = enemies.some(e => e.handCards.length < me.handCards.length);
        const hasAllyWithMoreCards = allies.some(a => a.handCards.length > me.handCards.length);
        return hasEnemyWithFewerCards || hasAllyWithMoreCards || me.handCards.length >= 3;
      }

      // ======================== 可莉-炸鱼 ========================
      case 'klee_bombfish': {
        // 有手牌且敌人>=2时值得发动（炸弹可传递）
        if (me.handCards.length === 0) return false;
        // 自己判定区已有炸弹则不发动
        if (me.judgeZone.some((c: any) => c._kleeBomb)) return false;
        // 有敌人时发动，手牌少于3时保留
        return enemies.length >= 1 && me.handCards.length >= 2;
      }

      // ======================== 刻晴-七星 ========================
      case 'keqing_stars':
        // 限定技：只在己方有成员HP严重不足（≤1）时才发动
        const criticalKAlly = allies.find(a => a.hp <= 1);
        return criticalKAlly !== undefined || me.hp <= 1;

      // ======================== 奈芙尔-秘闻 ========================
      case 'nefur_secret':
        // 有手牌的敌人时发动
        return enemies.some(e => e.handCards.length > 0);

      // ======================== 菈乌玛-咏月 ========================
      case 'lauma_moonsong':
        // 有2张不同颜色手牌且有盟友时发动
        const hasRed = me.handCards.some(c => c.suit === SuitType.Heart || c.suit === SuitType.Diamond);
        const hasBlack = me.handCards.some(c => c.suit === SuitType.Spade || c.suit === SuitType.Club);
        return hasRed && hasBlack && allies.length > 0;

      // ======================== 菈乌玛-灵使 ========================
      case 'lauma_frostmoon':
        // 有敌人时发动，优先给HP高的友军
        return enemies.length > 0 || allies.length > 0;

      default:
        return true; // 未知技能默认发动
    }
  }

  // ======================== 八重神子-狐魅 AI 策略 ========================

  private evaluateYaeCharm(
    me: PlayerState,
    ctx: GameContextSnapshot,
    enemies: PlayerState[]
  ): boolean {
    // 狐魅：选择两名其他角色，前者选杀后者或交牌给八重
    // AI策略：需要有至少2个其他存活角色
    const aliveOthers = ctx.players.filter(p => !p.isDead && p.id !== me.id);
    if (aliveOthers.length < 2) return false;

    // ≥2个敌人：发动价值高（可能造成伤害或获得牌）
    if (enemies.length >= 2) return true;

    // ≥1个敌人 + 至少2个存活角色：发动
    if (enemies.length >= 1) return true;

    // 没有敌人但有盟友可联动：手牌少时也可能发动（可能从盟友获得牌）
    if (me.handCards.length <= 3 && aliveOthers.length >= 2) return true;

    // 默认：只要场上有足够角色就发动（狐魅是优质控场技能）
    return aliveOthers.length >= 3; // 人多时无论如何都发动
  }

  // ======================== 希诺宁-工匠 AI 策略 ========================

  private evaluateXilonenCraft(
    me: PlayerState,
    ctx: GameContextSnapshot,
    enemies: PlayerState[],
    allies: PlayerState[]
  ): boolean {
    // 工匠：失去1体力，选有装备的角色，摸X张，造X个装备复制品
    // 条件：HP>1，场上有角色装备了牌
    if (me.hp <= 1) return false;

    // 检查场上是否有角色装备了牌
    const hasEquippedTarget = ctx.players.some(p =>
      !p.isDead && Object.values(p.equipZone).some(v => v !== null && (v as any)?.name)
    );
    if (!hasEquippedTarget) return false;

    // HP>=3时更值得发动（风险低）
    if (me.hp >= 3) return true;

    // HP=2时只在有高价值装备目标时发动（敌人或自己有多个装备）
    if (me.hp === 2) {
      const richTarget = ctx.players.find(p => !p.isDead && 
        Object.values(p.equipZone).filter(v => v !== null && (v as any)?.name).length >= 2
      );
      if (richTarget && (this.isEnemy(me, richTarget) || richTarget.id === me.id)) {
        return true;
      }
    }

    return false;
  }

  // ======================== 希诺宁-祝福 AI 策略 ========================

  private evaluateXilonenBlessing(
    me: PlayerState,
    ctx: GameContextSnapshot,
    enemies: PlayerState[],
    allies: PlayerState[]
  ): boolean {
    // 祝福：选一名角色，下回合摸牌数+X（X=装备数/2）
    // AI策略：优先选装备多的盟友，或装备多的自己
    const alivePlayers = ctx.players.filter(p => !p.isDead);

    // 检查是否有装备数>=2的角色（这样X>=1）
    const hasGoodTarget = alivePlayers.some(p => {
      const equipCount = Object.values(p.equipZone).filter(v => v !== null && (v as any)?.name).length;
      return equipCount >= 2;
    });

    if (hasGoodTarget) return true;

    // 如果自己或盟友有装备，也可以发动（X=0时至少不亏）
    const hasAnyEquip = alivePlayers.some(p => {
      return Object.values(p.equipZone).some(v => v !== null && (v as any)?.name);
    });

    return hasAnyEquip;
  }

  // ======================== 钟离-契约 AI 策略 ========================

  private evaluateZhongliContract(
    me: PlayerState,
    ctx: GameContextSnapshot
  ): boolean {
    // 契约：消耗1枚玉璋标记，选择一名其他角色建立契约关系
    // AI策略：需要至少有1名其他存活角色
    const aliveOthers = ctx.players.filter(p => !p.isDead && p.id !== me.id);
    if (aliveOthers.length === 0) return false;

    // 优先在盟友存活时建立契约（契约主要保护盟友）
    const aliveAllies = aliveOthers.filter(p => !this.isEnemy(me, p));
    return aliveAllies.length > 0;
  }

  // ======================== 钟离-闲游 AI 策略 ========================

  private evaluateZhongliLeisure(
    me: PlayerState,
    ctx: GameContextSnapshot,
    enemies: PlayerState[]
  ): boolean {
    // 闲游：消耗2枚玉璋标记，交换自己与目标角色的座位
    // AI策略：需要至少有2名其他存活角色（才有位置调整意义）
    const aliveOthers = ctx.players.filter(p => !p.isDead && p.id !== me.id);
    if (aliveOthers.length < 2) return false;

    // 当前位于首末两端时交换更有意义（调整场上距离关系）
    const alivePlayers = ctx.players.filter(p => !p.isDead);
    const myIdx = alivePlayers.indexOf(me);
    const totalAlive = alivePlayers.length;

    // 如果在边缘位置（第一个或最后一个），位置调整价值高
    if (myIdx === 0 || myIdx === totalAlive - 1) return true;

    // 如果被多个敌人包围，交换到安全位置
    if (myIdx > 0 && myIdx < totalAlive - 1) {
      const leftPlayer = alivePlayers[myIdx - 1];
      const rightPlayer = alivePlayers[myIdx + 1];
      const leftEnemy = this.isEnemy(me, leftPlayer);
      const rightEnemy = this.isEnemy(me, rightPlayer);
      // 两侧都是敌人 → 值得换位
      if (leftEnemy && rightEnemy) return true;
    }

    // 默认：有敌人就有调整价值
    return enemies.length > 0;
  }

  // ======================== 顺手牵羊/过河拆桥 手牌区选牌 ========================

  async promptRansackHand(
    state: PlayerState,
    targetId: number,
    ctx: GameContextSnapshot
  ): Promise<number> {
    const target = ctx.players.find(p => p.id === targetId);
    if (!target || target.handCards.length === 0) return -1;

    // AI: 随机选一张（等同于当前盲抽逻辑）
    return Math.floor(Math.random() * target.handCards.length);
  }

  // ======================== 多选弃牌（贯石斧等） ========================

  async promptDiscardMulti(
    state: PlayerState,
    count: number,
    ctx: GameContextSnapshot
  ): Promise<number[]> {
    const me = this.getMe(ctx);
    if (me.handCards.length === 0) return [];

    // AI: 使用弃牌优先级策略，选择价值最低的count张
    const priority: Record<string, number> = {
      '桃': 10, '无懈可击': 9, '酒': 8, '闪': 7,
      '杀': 5, '火杀': 5, '雷杀': 5,
    };

    // 给所有手牌打分并排序（低分优先弃）
    const indices = [...Array(me.handCards.length).keys()];
    indices.sort((a, b) => {
      const scoreA = priority[me.handCards[a].name] ?? 3;
      const scoreB = priority[me.handCards[b].name] ?? 3;
      return scoreA - scoreB;
    });

    return indices.slice(0, Math.min(count, indices.length));
  }
}
