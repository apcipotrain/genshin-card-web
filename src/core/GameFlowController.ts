// ============================================================
// GameFlowController.ts — 游戏回合/阶段流转控制器
// ============================================================

import {
  PlayerState, RoleType, Card, CardType, GamePhase, EquipmentType,
  GameContextSnapshot
} from './types';
import { GameEvent } from './types';
import { DeckManager } from './DeckManager';
import { EventBus } from './EventBus';
import { CardEffectManager } from './CardEffectManager';
import { DamageSystem } from './DamageSystem';
import { EquipEffectManager } from './EquipEffectManager';
import { IPlayerDriver } from './types';
import { getHandLimit } from './Player';
import { getCardDetail } from './Card';
import { findNextAlivePlayer } from './DistanceCalc';
import { SuitType, ElementType, Faction } from './types';

export class GameFlowController {
  private allPlayers: PlayerState[];
  private deck: DeckManager;
  private eventBus: EventBus;
  private cardEffectManager: CardEffectManager;
  private damageSystem: DamageSystem;
  private equipManager: EquipEffectManager;
  private drivers: Map<number, IPlayerDriver>;

  // SkillManager 注入
  public skillManager: {
    onAfterJudge: (player: PlayerState, judgeCard: Card, kitName?: string, effectTriggered?: boolean) => void;
    onBeforeJudgeEffect: (judgeCard: Card, judgeTarget: PlayerState) => Promise<{ modified: boolean; card: Card }>;
    onTurnStart: (player: PlayerState, ctx: GameContextSnapshot) => Promise<void>;
    onPlayPhaseStart: (player: PlayerState, ctx: GameContextSnapshot) => Promise<void>;
    onPlayPhaseEnd: (player: PlayerState, ctx: GameContextSnapshot) => Promise<void>;
    onAfterCardPlay: (player: PlayerState) => Promise<void>;
    onTurnEnd: (player: PlayerState, ctx: GameContextSnapshot) => Promise<void>;
    onRoundStart: () => void;
    getEffectiveHandLimit: (player: PlayerState) => number;
    getZibaiGraceBonus: () => number;
    onZibaiPlayCardCheck: (player: PlayerState, card: Card, cardsPlayedThisPhase: number) => void;
    onZibaiMultipleCheck: (player: PlayerState, cardsPlayedThisPhase: number) => void;
    onMagicUsed: (player: PlayerState, card: Card) => Promise<boolean>;
    onMagicTargeted: (player: PlayerState, card: Card) => { intercepted: boolean; data?: any };
    onBeforeSlashTarget: (target: PlayerState, source: PlayerState) => { intercepted: boolean; data?: any };
    canDelayKitAffect: (player: PlayerState, kitName: string) => boolean;
    isSuitSealed: (suit: string) => boolean;
    hasYelanExtraTurn: (player: PlayerState) => boolean;
    clearYelanExtraTurn: (player: PlayerState) => void;
    onHutaoKillCheck: (killer: PlayerState, victim: PlayerState) => void;
    getEulaSlashDamage: (source: PlayerState, target: PlayerState, baseDamage: number) => number;
    getSlashRangeBonus: (source: PlayerState) => number;
    getAnalepticDamageBonus: (source: PlayerState) => number;
    getPeachHealBonus: (source: PlayerState) => number;
    isImmuneToFire: (player: PlayerState) => boolean;
    getEulaDistanceBonus: (target: PlayerState, source: PlayerState) => number;
    getEulaDistanceReduction: (source: PlayerState, target: PlayerState) => number;
    getNilouStanceConvert: (player: PlayerState, card: Card) => string | null;
    isXiaoGoldenwingActive: (target: PlayerState) => boolean;
    onFireworkExplosion: (player: PlayerState) => Promise<boolean>;
    onDoubleNullify: (magicCard: Card, target: PlayerState) => Promise<boolean>;
    getActiveSkills: (player: PlayerState, ctx: GameContextSnapshot) => { id: string; name: string; description: string }[];
    executeActiveSkill: (player: PlayerState, skillId: string, ctx: GameContextSnapshot) => Promise<boolean>;
    onBeforeCardUse: (player: PlayerState, card: Card, ctx: GameContextSnapshot) => Promise<{ useCard: Card | null; returnCards: Card[] }>;
    onAfterKitEffect: (player: PlayerState, kitName: string, effectTriggered: boolean, kit: Card) => Promise<void>;
    mualaniUnity: (player: PlayerState) => Promise<{ drawReduction: number; chainTargetIds: number[] }>;
    isKleeBomb: (card: Card) => boolean;
    getKleeBombPlacerId: (card: Card) => number | null;
    handleBombJudge: (kit: Card, player: PlayerState, judgeResult: Card) => Promise<{ bombExploded: boolean; moveBomb: boolean }>;
    passKleeBomb: (bomb: Card, current: PlayerState) => void;
    isJeanBreezeActive: (player: PlayerState) => boolean;
    jeanBreezeSkip: (player: PlayerState) => void;
    checkNefurSecretOnUse: (player: PlayerState, usedCard: Card) => Promise<void>;
    checkNefurSecretOnDiscard: (player: PlayerState, discardedCard: Card) => Promise<void>;
    citlaliShamanPredict: (player: PlayerState) => Promise<{ suit: string | null; predicted: boolean }>;
    checkCitlaliShamanResult: (actualSuit: string) => void;
    checkCitlaliObsidian: (judgeResult: Card, judgeTarget: PlayerState, ctx: GameContextSnapshot) => Promise<boolean>;
    getData: (playerId: number) => any;
  } | null = null;

  public roundCount: number = 1;
  public currentTurnInRound: number = 1;
  public gameOverWinner: string | null = null;
  /** 击杀统计：killerPlayerId → { monarch:0|1, minister:0|1, rebel:0|1, traitor:0|1 } */
  public killStats: Map<number, { monarch: number; minister: number; rebel: number; traitor: number }> = new Map();
  private monarchIndex: number = 0;
  private aborted = false;

  /** PVE 闯关模式自定义出牌顺序（playerId数组） */
  private pveTurnOrder: number[] | null = null;

  /** PVP 模式回合间延迟（默认600ms，PVP建议1200-1500ms） */
  public turnDelayMs: number = 600;
  /** PVP 模式两次操作间延迟（默认0即无等待，PVP建议400-600ms） */
  public aiActionDelayMs: number = 0;

  constructor(
    players: PlayerState[],
    deck: DeckManager,
    eventBus: EventBus,
    cardEffectManager: CardEffectManager,
    damageSystem: DamageSystem,
    equipManager: EquipEffectManager,
    drivers: Map<number, IPlayerDriver>
  ) {
    this.allPlayers = players;
    this.deck = deck;
    this.eventBus = eventBus;
    this.cardEffectManager = cardEffectManager;
    this.damageSystem = damageSystem;
    this.equipManager = equipManager;
    this.drivers = drivers;
  }

  // ======================== 游戏初始化 ========================

  /** 终止游戏循环（PVE离开时调用） */
  abort(): void {
    this.aborted = true;
    if (!this.gameOverWinner) {
      this.gameOverWinner = 'aborted';
    }
  }

  async startGame(humanPlayerId?: number, turnOrder?: number[]): Promise<void> {
    // 检测 PVE 模式
    const isPVE = this.allPlayers.some(p => (p as any).faction !== undefined);
    if (isPVE) {
      this.pveTurnOrder = turnOrder || null;
      // 起始玩家 = turnOrder第一个元素对应的玩家索引（而非固定0）
      if (turnOrder && turnOrder.length > 0) {
        const firstId = turnOrder[0];
        const idx = this.allPlayers.findIndex(p => p.id === firstId);
        this.monarchIndex = idx >= 0 ? idx : 0;
      } else {
        this.monarchIndex = 0;
      }
      if (humanPlayerId !== undefined) {
        this.eventBus.emit(GameEvent.Log, { message: '⚔️ PVE 闯关模式开始！' });
      }
    } else {
      this.assignRoles(humanPlayerId);
    }
    this.eventBus.emit(GameEvent.RolesAssigned, { players: this.allPlayers });

    // 初始发牌
    this.initialDraw();

    // 初始化击杀统计
    this.killStats = new Map();
    for (const p of this.allPlayers) {
      this.killStats.set(p.id, { monarch: 0, minister: 0, rebel: 0, traitor: 0 });
    }
    // 击杀回调
    this.damageSystem.onKill = (killer, victim) => {
      const stats = this.killStats.get(killer.id);
      if (!stats) return;
      // PVE模式：所有击杀记入rebel（结算时合并显示为杀敌数）
      const isPVE = this.allPlayers.some(p => (p as any).faction !== undefined);
      if (isPVE) { stats.rebel++; return; }
      if (victim.role === RoleType.Monarch) stats.monarch = 1;
      else if (victim.role === RoleType.Minister) stats.minister = 1;
      else if (victim.role === RoleType.Rebel) stats.rebel = 1;
      else if (victim.role === RoleType.Traitor) stats.traitor = 1;
    };

    // 设置胜负回调
    this.damageSystem.setGameOverCallback((winner) => {
      if (winner) {
        this.gameOverWinner = winner;
        this.eventBus.emit(GameEvent.GameOver, { winner });
      }
    });

    // 进入主循环
    await this.gameLoop();
  }

  private assignRoles(humanPlayerId?: number): void {
    // 检查是否所有角色已预分配（PVE模式）
    const allPreAssigned = this.allPlayers.every(p => p.role !== RoleType.None);
    if (allPreAssigned) {
      for (let i = 0; i < this.allPlayers.length; i++) {
        if (this.allPlayers[i].role === RoleType.Monarch) {
          this.monarchIndex = i;
          this.allPlayers[i].maxHp += 1;
          this.allPlayers[i].hp = this.allPlayers[i].maxHp;
          break;
        }
      }
      if (humanPlayerId !== undefined && humanPlayerId >= 0 && humanPlayerId < this.allPlayers.length) {
        if (this.allPlayers[humanPlayerId].role === RoleType.Monarch) {
          this.eventBus.emit(GameEvent.Log, { message: '你是主公！' });
        } else {
          this.eventBus.emit(GameEvent.Log, { message: `你的身份：${this.getRoleName(this.allPlayers[humanPlayerId].role)}` });
        }
      }
      this.eventBus.emit(GameEvent.Log, { message: '身份分配完毕。' });
      return;
    }

    // 检查君主是否已预设定（PVP选将阶段确定的）
    const monarchPreSetIdx = this.allPlayers.findIndex(p => p.role === RoleType.Monarch);
    const monarchIsPreSet = monarchPreSetIdx >= 0;

    if (monarchIsPreSet) {
      // 君主已预设：设置君主属性，其余角色随机分配
      this.monarchIndex = monarchPreSetIdx;
      this.allPlayers[monarchPreSetIdx].maxHp += 1;
      this.allPlayers[monarchPreSetIdx].hp = this.allPlayers[monarchPreSetIdx].maxHp;
      console.log(`[assignRoles] 君主已预设: playerId=${monarchPreSetIdx}`);

      // 为其他玩家准备角色池（不含君主）
      const nonMonarchRolePool: RoleType[] = [
        RoleType.Minister, RoleType.Minister,
        RoleType.Rebel, RoleType.Rebel, RoleType.Rebel, RoleType.Rebel,
        RoleType.Traitor
      ];

      // Fisher-Yates洗牌
      for (let i = nonMonarchRolePool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [nonMonarchRolePool[i], nonMonarchRolePool[j]] = [nonMonarchRolePool[j], nonMonarchRolePool[i]];
      }

      // 分配给非君主玩家
      let poolIdx = 0;
      for (let i = 0; i < this.allPlayers.length; i++) {
        if (i === monarchPreSetIdx) continue;
        if (poolIdx < nonMonarchRolePool.length) {
          this.allPlayers[i].role = nonMonarchRolePool[poolIdx++];
        }
      }

      // 记录人类玩家身份
      if (humanPlayerId !== undefined && humanPlayerId >= 0 && humanPlayerId < this.allPlayers.length) {
        if (humanPlayerId === monarchPreSetIdx) {
          this.eventBus.emit(GameEvent.Log, { message: '你是主公！' });
        } else {
          this.eventBus.emit(GameEvent.Log, { message: `你的身份：${this.getRoleName(this.allPlayers[humanPlayerId].role)}` });
        }
      }
      this.eventBus.emit(GameEvent.Log, { message: '身份分配完毕。' });
      return;
    }

    // 全随机分配（PVE或旧逻辑）
    const rolePool: RoleType[] = [
      RoleType.Monarch,
      RoleType.Minister, RoleType.Minister,
      RoleType.Rebel, RoleType.Rebel, RoleType.Rebel, RoleType.Rebel,
      RoleType.Traitor
    ];

    // Fisher-Yates 洗牌（完全随机分配，不强制人类玩家为主公）
    for (let i = rolePool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rolePool[i], rolePool[j]] = [rolePool[j], rolePool[i]];
    }

    for (let i = 0; i < this.allPlayers.length; i++) {
      this.allPlayers[i].role = rolePool[i];
      if (rolePool[i] === RoleType.Monarch) {
        this.monarchIndex = i;
        this.allPlayers[i].maxHp += 1;
        this.allPlayers[i].hp = this.allPlayers[i].maxHp;
      }
    }

    // 如果人类玩家恰好是主公，记录日志
    if (humanPlayerId !== undefined && humanPlayerId >= 0 && humanPlayerId < this.allPlayers.length) {
      if (this.allPlayers[humanPlayerId].role === RoleType.Monarch) {
        this.eventBus.emit(GameEvent.Log, { message: '你是主公！' });
      } else {
        this.eventBus.emit(GameEvent.Log, { message: `你的身份：${this.getRoleName(this.allPlayers[humanPlayerId].role)}` });
      }
    }

    this.eventBus.emit(GameEvent.Log, { message: '身份分配完毕。' });
  }

  private getRoleName(role: RoleType): string {
    switch (role) {
      case RoleType.Monarch: return '主公';
      case RoleType.Minister: return '忠臣';
      case RoleType.Rebel: return '反贼';
      case RoleType.Traitor: return '内奸';
      default: return '未知';
    }
  }

  private initialDraw(): void {
    for (const player of this.allPlayers) {
      this.deck.drawCards(player, 4);
    }
  }

  // ======================== 主循环 ========================

  private async gameLoop(): Promise<void> {
    let currentPlayerIndex = this.monarchIndex;

    while (this.gameOverWinner === null && !this.aborted) {
      const player = this.allPlayers[currentPlayerIndex];

      if (!player.isDead) {
        // 翻面检查：翻面的角色跳过本回合，并翻回正面
        if (player.isFlipped) {
          player.isFlipped = false;
          this.eventBus.emit(GameEvent.TurnStarted, {
            playerId: player.id,
            round: this.roundCount,
            turn: this.currentTurnInRound
          });
          this.eventBus.emit(GameEvent.Log, {
            message: `【翻面】${player.name} 武将牌翻面，跳过本回合。`
          });
          this.eventBus.emit(GameEvent.PhaseSkipped, { playerId: player.id, phase: '整回合（翻面）' });
          this.eventBus.emit(GameEvent.TurnEnded, { playerId: player.id });
        } else {
          await this.executeTurn(player);
        }
      }

      if (this.gameOverWinner || this.aborted) break;

      // PVE 模式：使用自定义出牌顺序
      if (this.pveTurnOrder && this.pveTurnOrder.length > 0) {
        const currentOrderIdx = this.pveTurnOrder.indexOf(this.allPlayers[currentPlayerIndex].id);
        const nextOrderIdx = (currentOrderIdx + 1) % this.pveTurnOrder.length;
        if (nextOrderIdx === 0) {
          this.roundCount++;
          this.currentTurnInRound = 1;
          this.eventBus.emit(GameEvent.RoundChanged, { round: this.roundCount });
          this.eventBus.emit(GameEvent.Log, { message: `\n>>>>>> 进入第 ${this.roundCount} 轮 <<<<<<` });
          if (this.skillManager) this.skillManager.onRoundStart();
        } else {
          this.currentTurnInRound++;
        }
        const nextPlayerId = this.pveTurnOrder[nextOrderIdx];
        const nextIdx = this.allPlayers.findIndex(p => p.id === nextPlayerId);
        currentPlayerIndex = nextIdx >= 0 ? nextIdx : findNextAlivePlayer(currentPlayerIndex, this.allPlayers);
      } else {
        const nextIndex = findNextAlivePlayer(currentPlayerIndex, this.allPlayers);
        if (nextIndex === this.monarchIndex) {
          this.roundCount++;
          this.currentTurnInRound = 1;
          this.eventBus.emit(GameEvent.RoundChanged, { round: this.roundCount });
          this.eventBus.emit(GameEvent.Log, { message: `\n>>>>>> 进入第 ${this.roundCount} 轮 <<<<<<` });
          if (this.skillManager) this.skillManager.onRoundStart();
        } else {
          this.currentTurnInRound++;
        }
        currentPlayerIndex = nextIndex;
      }

      // 延时让UI渲染（默认600ms，PVP模式应从外部调高）
      await this.sleep(this.turnDelayMs);
    }

    if (this.aborted) {
      this.eventBus.emit(GameEvent.Log, { message: '游戏已中止。' });
    } else {
      this.eventBus.emit(GameEvent.Log, { message: `游戏结束！胜利方：${this.gameOverWinner}` });
    }
  }

  // ======================== 单回合执行 ========================

  private async executeTurn(player: PlayerState): Promise<void> {
    if (this.aborted) return;
    this.eventBus.emit(GameEvent.TurnStarted, {
      playerId: player.id,
      round: this.roundCount,
      turn: this.currentTurnInRound
    });
    this.eventBus.emit(GameEvent.Log, {
      message: `\n=== 第 ${this.roundCount} 轮 | 第 ${this.currentTurnInRound} 回合 | ${player.name} HP: ${player.hp}/${player.maxHp} ===`
    });

    // 1. 准备阶段
    player.skipDrawPhase = false;
    player.skipPlayPhase = false;
    player.skipDiscardPhase = false;
    player.slashUsedCount = 0;

    // 技能钩子：回合开始（钟离-契约、妮露-花舞等）
    if (this.skillManager) {
      await this.skillManager.onTurnStart(player, this.buildContext(player.id));
    }

    // 八重神子-宫司：额外杀次数上限（在onTurnStart之后，以便祝福等技能优先执行）
    if (this.skillManager) {
      const extraSlash = (this.skillManager as any)._getYaeExtraSlashCount?.(player) || 0;
      if (extraSlash > 0) {
        player.slashUsedCount = -extraSlash;
        (this.skillManager as any)._resetYaeExtraSlashCount?.(player);
        this.eventBus.emit(GameEvent.Log, {
          message: `【宫司】${player.name} 本回合使用【杀】的次数上限+${extraSlash}！`
        });
      }
    }
    if (this.checkTurnInterrupt(player, '准备阶段')) return;

    // 2. 判定阶段
    await this.judgingPhase(player);
    if (this.checkTurnInterrupt(player, '判定阶段')) return;

    // 3. 摸牌阶段
    if (!player.skipDrawPhase) {
      // 迪卢克-晨曦：摸牌阶段开始前扣置最多2张手牌为标记（仅迪卢克可用）
      if (this.skillManager && player.heroId === 'diluc') {
        await (this.skillManager as any).dilucMorningExecute?.(player, this.buildContext(player.id));
      }
      let drawCount = 2;
      // 玛拉妮-团结：摸牌阶段开始时，可少摸1张并选至多2名角色连环
      if (this.skillManager) {
        const unityResult = await this.skillManager.mualaniUnity(player);
        if (unityResult.drawReduction > 0) {
          drawCount = Math.max(0, drawCount - unityResult.drawReduction);
        }
      }
      // 哥伦比娅-月神：摸牌数+X
      if (this.skillManager) {
        const data = (this.skillManager as any)._getColumbinaData?.(player);
        if (data?.moonBonusDraw) {
          drawCount += data.moonBonusDraw;
          data.moonBonusDraw = 0;
          this.eventBus.emit(GameEvent.Log, {
            message: `【月神】${player.name} 摸牌数+${drawCount - 2}，共摸${drawCount}张。`
          });
        }
        // 月神惩罚：下回合摸牌-1
        if (data?.drawPenalty) {
          drawCount = Math.max(0, drawCount - data.drawPenalty);
          data.drawPenalty = 0;
          this.eventBus.emit(GameEvent.Log, {
            message: `${player.name} 受【月神】影响，摸牌数-1，共摸${drawCount}张。`
          });
        }
        // 希诺宁-祝福：摸牌数+X
        const xilonenBonus = (this.skillManager as any)._consumeXilonenDrawBonus?.(player) || 0;
        if (xilonenBonus > 0) {
          drawCount += xilonenBonus;
          this.eventBus.emit(GameEvent.Log, {
            message: `【祝福】${player.name} 摸牌数+${xilonenBonus}，共摸${drawCount}张。`
          });
        }
      }
      this.deck.drawCards(player, drawCount);
    } else {
      this.eventBus.emit(GameEvent.PhaseSkipped, { playerId: player.id, phase: '摸牌阶段' });
    }
    if (this.checkTurnInterrupt(player, '摸牌阶段')) return;

    // 4. 出牌阶段
    if (!player.skipPlayPhase) {
      // 技能钩子：出牌阶段开始（哥伦比娅-少女、魈-降魔）
      if (this.skillManager) {
        await this.skillManager.onPlayPhaseStart(player, this.buildContext(player.id));
      }
      if (this.checkTurnInterrupt(player, '出牌阶段')) return;

      await this.playPhase(player);

      // 技能钩子：出牌阶段结束（哥伦比娅-少女）
      if (this.skillManager && !player.isDead) {
        await this.skillManager.onPlayPhaseEnd(player, this.buildContext(player.id));
      }
    } else {
      this.eventBus.emit(GameEvent.PhaseSkipped, { playerId: player.id, phase: '出牌阶段' });
    }
    if (this.checkTurnInterrupt(player, '出牌阶段')) return;

    // 5. 弃牌阶段
    if (!player.skipDiscardPhase) {
      await this.discardPhase(player);
    } else {
      this.eventBus.emit(GameEvent.PhaseSkipped, { playerId: player.id, phase: '弃牌阶段' });
    }
    if (this.checkTurnInterrupt(player, '弃牌阶段')) return;

    // 6. 结束阶段
    player.slashUsedCount = 0;
    player.nextSlashDamageBonus = 0;
    player.wineUsedThisTurn = false;

    // 技能钩子：回合结束（玛薇卡-领袖、枫原万叶-落叶等）
    if (this.skillManager && !player.isDead) {
      await this.skillManager.onTurnEnd(player, this.buildContext(player.id));
    }

    this.eventBus.emit(GameEvent.TurnEnded, { playerId: player.id });
  }

  private checkTurnInterrupt(player: PlayerState, phaseName: string): boolean {
    if (this.aborted) return true;
    if (player.isDead || this.gameOverWinner) {
      if (!this.gameOverWinner) {
        this.eventBus.emit(GameEvent.Log, {
          message: `👻 玩家 ${player.name} 已在${phaseName}阵亡，跳过后续阶段。`
        });
      }
      return true;
    }
    return false;
  }

  // ======================== 判定阶段 ========================

  private async judgingPhase(player: PlayerState): Promise<void> {
    if (player.judgeZone.length === 0) return;

    // 茜特菈莉-萨满：判定开始前预言花色（每轮限一次）
    let shamanPredictedSuit: string | null = null;
    if (this.skillManager) {
      const citlaliCheck = this.allPlayers.find(p => p.heroId === 'citlali' && !p.isDead);
      if (citlaliCheck) {
        const predictResult = await this.skillManager.citlaliShamanPredict(citlaliCheck);
        if (predictResult.predicted) {
          shamanPredictedSuit = predictResult.suit;
          // 存储预言花色
          const skData = (this.skillManager as any).getData?.(citlaliCheck.id);
          if (skData) skData._shamanPrediction = shamanPredictedSuit;
        }
      }
    }

    const totalJudge = player.judgeZone.length;
    let judgeIndex = 0;
    for (let i = player.judgeZone.length - 1; i >= 0; i--) {
      if (this.gameOverWinner || this.aborted) return;

      const kit = player.judgeZone[i];
      const kitSource = kit.cardSource ?? player;

      // 可莉炸弹特殊处理：不进入无懈可击，直接判定
      if (this.skillManager && this.skillManager.isKleeBomb(kit)) {
        await this.executeKleeBombJudge(kit, player, i, judgeIndex, totalJudge);
        judgeIndex++;
        // 多个判定牌之间等待
        if (player.judgeZone.length > 0 && judgeIndex > 0) {
          await this.sleep(500);
        }
        continue;
      }

      // 无懈可击拦截
      if (await this.cardEffectManager.askForNullificationStack(player, kitSource, false)) {
        this.eventBus.emit(GameEvent.Log, { message: `【无懈可击】起效！${kit.name} 不进行判定。` });
        player.judgeZone.splice(i, 1);

        if (kit.name === '闪电') {
          this.passLightning(kit, player);
        } else {
          this.deck.sendToDiscard(kit);
        }
        continue;
      }

      await this.executeSingleCardJudge(kit, player, i, judgeIndex, totalJudge);
      judgeIndex++;
      
      // 多个判定牌之间等待（前一个动画结束时自动继续）
      if (player.judgeZone.length > 0 && judgeIndex > 0) {
        await this.sleep(500);
      }
    }
  }

  private async executeSingleCardJudge(kit: Card, player: PlayerState, indexInZone: number, judgeIndex: number = 0, totalJudge: number = 1): Promise<void> {
    let judgeResult = this.deck.dealOneCard();
    if (!judgeResult) return;

    // 技能钩子：判定牌即将生效前（那维莱特-审判）
    if (this.skillManager) {
      const beforeResult = await this.skillManager.onBeforeJudgeEffect(judgeResult, player);
      if (beforeResult.modified) {
        judgeResult = beforeResult.card;
      }
    }

    this.eventBus.emit(GameEvent.Log, {
      message: `[判定牌] ${getCardDetail(judgeResult)}`
    });

    const effectTriggered = this.checkJudgeEffect(kit.name, judgeResult);

    // 发出判定动画事件
    this.eventBus.emit(GameEvent.JudgeResult, {
      playerId: player.id,
      kitName: kit.name,
      cardName: judgeResult.name,
      suit: judgeResult.suit,
      number: judgeResult.number,
      triggered: effectTriggered,
      judgeIndex,
      totalJudge,
    });

    // 茜特菈莉-萨满：检查预言结果
    if (this.skillManager) {
      this.skillManager.checkCitlaliShamanResult(judgeResult.suit);
    }

    if (effectTriggered) {
      await this.applyKitEffect(kit.name, player);
    } else {
      this.eventBus.emit(GameEvent.Log, { message: `【${kit.name}】判定失败。` });
    }

    // 茜特菈莉-黑曜：黑桃判定牌出现时，可进行决斗
    if (this.skillManager && judgeResult.suit === SuitType.Spade) {
      const shouldDuel = await this.skillManager.checkCitlaliObsidian(judgeResult, player, this.buildContext(player.id));
      if (shouldDuel) {
        // 触发黑曜决斗：对方需双杀
        await this.executeObsidianDuel(player);
      }
    }

    // 技能钩子：延时锦囊效果处理完毕后（荒泷一斗-赤鬼等）
    if (this.skillManager) {
      await this.skillManager.onAfterKitEffect(player, kit.name, effectTriggered, kit);
    }

    // 技能钩子：判定生效后（芙宁娜-正义、那维莱特-龙权、莱欧斯利-狱长）
    if (this.skillManager) {
      this.skillManager.onAfterJudge(player, judgeResult, kit.name, effectTriggered);
    }

    if (player.isDead) {
      this.deck.sendToDiscard(judgeResult);
      return;
    }

    player.judgeZone.splice(indexInZone, 1);

    if (kit.name === '闪电' && !effectTriggered) {
      this.passLightning(kit, player);
    } else {
      this.deck.sendToDiscard(kit);
    }

    this.deck.sendToDiscard(judgeResult);
  }

  private checkJudgeEffect(kitName: string, judgeResult: Card): boolean {
    switch (kitName) {
      case '乐不思蜀':
        return judgeResult.suit !== SuitType.Heart;
      case '兵粮寸断':
        return judgeResult.suit !== SuitType.Club;
      case '闪电':
        return judgeResult.suit === SuitType.Spade && judgeResult.number >= 2 && judgeResult.number <= 9;
      default:
        return false;
    }
  }

  /** 茜特菈莉-黑曜：与判定角色进行决斗，对方每回合需打出两张【杀】 */
  private async executeObsidianDuel(judgeTarget: PlayerState): Promise<void> {
    const citlali = this.allPlayers.find(p => p.heroId === 'citlali' && !p.isDead);
    if (!citlali || citlali.isDead) return;
    if (judgeTarget.isDead) return;

    const card: Card = {
      id: -1, name: '决斗', type: CardType.Magic, suit: SuitType.Spade, number: 1,
      description: '', element: ElementType.None, equipType: EquipmentType.None,
      weaponRange: 0, isVirtual: true, cardSource: citlali,
    };

    this.eventBus.emit(GameEvent.Log, { message: `【黑曜】${citlali.name} 与 ${judgeTarget.name} 进行决斗！对方每回合需打出两张【杀】！` });
    this.eventBus.emit(GameEvent.CardTargeted, { sourceId: citlali.id, targetId: judgeTarget.id, cardName: '决斗' });

    let currentRespondent = judgeTarget;
    let other = citlali;

    while (true) {
      const respDriver = this.drivers.get(currentRespondent.id)!;

      // 对方需要打出两张【杀】（黑曜效果）
      if (currentRespondent.id === judgeTarget.id) {
        const response1 = await this.damageSystem.askForResponse(
          currentRespondent, '杀', card, citlali, respDriver
        );
        if (!response1) {
          this.eventBus.emit(GameEvent.Log, { message: `${currentRespondent.name} 无法出【杀】，决斗失败！` });
          await this.damageSystem.applyHpChange(currentRespondent, -1, card, citlali);
          return;
        }
        const response2 = await this.damageSystem.askForResponse(
          currentRespondent, '杀', card, citlali, respDriver
        );
        if (!response2) {
          this.eventBus.emit(GameEvent.Log, { message: `${currentRespondent.name} 第二张【杀】不足，决斗失败！` });
          await this.damageSystem.applyHpChange(currentRespondent, -1, card, citlali);
          return;
        }
      } else {
        // 茜特菈莉只需要出一张
        const response = await this.damageSystem.askForResponse(
          currentRespondent, '杀', card, null, respDriver
        );
        if (!response) {
          this.eventBus.emit(GameEvent.Log, { message: `${currentRespondent.name} 无法出【杀】，决斗失败！` });
          await this.damageSystem.applyHpChange(currentRespondent, -1, card, citlali);
          return;
        }
      }

      [currentRespondent, other] = [other, currentRespondent];
    }
  }

  private async applyKitEffect(kitName: string, player: PlayerState): Promise<void> {
    switch (kitName) {
      case '乐不思蜀':
        player.skipPlayPhase = true;
        this.eventBus.emit(GameEvent.Log, { message: `【乐不思蜀】生效！${player.name} 跳过出牌阶段。` });
        break;
      case '兵粮寸断':
        player.skipDrawPhase = true;
        this.eventBus.emit(GameEvent.Log, { message: `【兵粮寸断】生效！${player.name} 跳过摸牌阶段。` });
        break;
      case '闪电':
        this.eventBus.emit(GameEvent.Log, { message: `【闪电】判定成功！${player.name} 受到3点伤害！` });
        await this.damageSystem.applyHpChange(player, -3);
        break;
    }
  }

  private passLightning(lightning: Card, current: PlayerState): void {
    let nextIdx = (this.allPlayers.indexOf(current) + 1) % this.allPlayers.length;
    let nextPlayer = this.allPlayers[nextIdx];

    while (nextPlayer.isDead || nextPlayer.judgeZone.some(c => c.name === '闪电')) {
      nextIdx = (nextIdx + 1) % this.allPlayers.length;
      nextPlayer = this.allPlayers[nextIdx];
      if (nextPlayer === current) return;
    }

    nextPlayer.judgeZone.push(lightning);
    this.eventBus.emit(GameEvent.Log, { message: `【闪电】移至 ${nextPlayer.name} 的判定区。` });
  }

  /** 可莉炸弹判定 */
  private async executeKleeBombJudge(kit: Card, player: PlayerState, indexInZone: number, judgeIndex: number, totalJudge: number): Promise<void> {
    let judgeResult = this.deck.dealOneCard();
    if (!judgeResult) return;

    // 技能钩子：判定牌即将生效前（那维莱特-审判）
    if (this.skillManager) {
      const beforeResult = await this.skillManager.onBeforeJudgeEffect(judgeResult, player);
      if (beforeResult.modified) {
        judgeResult = beforeResult.card;
      }
    }

    this.eventBus.emit(GameEvent.Log, {
      message: `[炸弹判定] ${getCardDetail(judgeResult)}，炸弹牌：【${kit.name}(${kit.suit}${kit.number})】`
    });

    this.eventBus.emit(GameEvent.JudgeResult, {
      playerId: player.id,
      kitName: '炸弹',
      cardName: judgeResult.name,
      suit: judgeResult.suit,
      number: judgeResult.number,
      triggered: judgeResult.name === kit.name,
      judgeIndex,
      totalJudge,
    });

    // 炸弹判定处理
    const result = this.skillManager!.handleBombJudge(kit, player, judgeResult);
    const { bombExploded, moveBomb } = await result;

    // 移除炸弹
    player.judgeZone.splice(indexInZone, 1);

    if (bombExploded) {
      // 炸弹爆炸：造成2点火伤
      await this.damageSystem.applyHpChange(player, -2, kit, kit.cardSource || null);
      this.deck.sendToDiscard(kit);
    } else if (moveBomb) {
      // 传递炸弹
      this.skillManager!.passKleeBomb(kit, player);
    }

    this.deck.sendToDiscard(judgeResult);
  }

  // ======================== 出牌阶段 ========================

  /**
   * AI 自动执行主动技能
   * 在出牌阶段开始时，依次尝试所有可用的主动技能
   */
  private async aiExecuteActiveSkills(player: PlayerState, driver: IPlayerDriver): Promise<void> {
    if (!this.skillManager) return;

    const ctx = this.buildContext(player.id);

    // 循环尝试所有可用主动技能（每个技能独立判断是否发动）
    let triedCount = 0;
    const maxTries = 5; // 防止无限循环
    while (this.gameOverWinner === null && !this.aborted && triedCount < maxTries) {
      triedCount++;
      const availableSkills = this.skillManager.getActiveSkills(player, ctx);
      if (availableSkills.length === 0) return;

      // 让 AI 选择要发动的技能
      const skillId = (driver as any).promptActiveSkill(player, availableSkills, ctx);
      if (!skillId) return;

      // 执行选中的技能
      const skill = availableSkills.find(s => s.id === skillId);
      if (!skill) return;

      this.eventBus.emit(GameEvent.Log, {
        message: `🤖 ${player.name}（AI）发动了主动技能【${skill.name}】`
      });

      const success = await this.skillManager.executeActiveSkill(player, skillId, ctx);

      if (success) {
        this.eventBus.emit(GameEvent.Log, {
          message: `${player.name} 的【${skill.name}】发动成功。`
        });
      }
    }
  }

  private async playPhase(player: PlayerState): Promise<void> {
    this.eventBus.emit(GameEvent.PhaseChanged, { playerId: player.id, phase: GamePhase.Play });

    // AI 主动技能自动执行
    const driver = this.drivers.get(player.id)!;
    if (this.skillManager && typeof (driver as any).promptActiveSkill === 'function') {
      await this.aiExecuteActiveSkills(player, driver);
    }

    // 死循环防护：记录本回合已尝试但失败的牌名及失败次数
    const failedCards: Map<string, number> = new Map();
    const MAX_RETRY_PER_CARD = 1; // 每张牌最多重试1次（即第一次失败后，第二次仍然失败就跳过）
    const MAX_CONSECUTIVE_FAILURES = 8; // 连续失败上限：防止AI死循环，但不影响正常出牌
    let consecutiveFailures = 0;
    let cardsPlayedThisPhase = 0; // 兹白三尸：出牌阶段已打出牌数

    while (this.gameOverWinner === null && !this.aborted) {
      // 连续失败达到上限 → 自动结束出牌，防止AI死循环
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.eventBus.emit(GameEvent.Log, {
          message: `${player.name} 连续出牌失败次数过多，自动结束出牌阶段。`
        });
        break;
      }
      const myWeapon = player.equipZone[EquipmentType.Weapon];
      const canUseZhanBa = myWeapon?.name === '丈八蛇矛' && player.handCards.length >= 2;

      // 通过 driver 获取出牌选择
      let choice = await driver.promptPlayCard(player, {
        players: this.allPlayers,
        roundCount: this.roundCount,
        currentTurn: this.currentTurnInRound,
        currentPlayerId: player.id,
        gameOverWinner: this.gameOverWinner,
        drawPileCount: this.deck.drawPileCount,
        discardPileCount: this.deck.discardPile.length,
        nilouStance: (this.skillManager as any)?.getData?.(player.id)?.nilouStance,
        cardsPlayedThisPhase,
      });

      if (choice === -1) break; // 结束出牌

      if (choice === -2 && canUseZhanBa) {
        // 丈八蛇矛：先检查出杀次数上限（刻晴雷杀不计、迪卢克夜枭无限、诸葛连弩无限）
        const isOwlUnrestricted = (this.skillManager as any)?.isDilucOwlActive?.(player) ?? false;
        const canSlashFree = isOwlUnrestricted || this.equipManager.canSlashUnrestricted(player);
        if (!canSlashFree && player.slashUsedCount >= 1) {
          this.eventBus.emit(GameEvent.Log, { message: '本回合使用【杀】的次数已达上限，无法使用【丈八蛇矛】。' });
          continue;
        }
        // 让玩家选择两张手牌合成杀（不在此弃牌，由调用方根据结果决定）
        const result = await this.equipManager.tryZhanBaTransformInteractive(player);
        if (result) {
          const { virtualSlash, physicalCards } = result;
          const success = await this.cardEffectManager.handleActivePlay(virtualSlash, player);
          if (success) {
            // 成功：两张实体牌进弃牌堆
            for (const c of physicalCards) this.deck.sendToDiscard(c);
            // 技能钩子：白鹭等
            if (this.skillManager) {
              await this.skillManager.onAfterCardPlay(player);
            }
            await this.sleep(this.aiActionDelayMs);
          } else {
            // 失败：返还两张手牌
            player.handCards.push(...physicalCards);
          }
        }
        continue;
      }

      if (choice >= 0 && choice < player.handCards.length) {
        let selected = player.handCards[choice];
        let cardName = selected.name;

        // 死循环检测：如果这张牌已经失败过，检查是否超过重试上限
        const failCount = failedCards.get(cardName) || 0;
        if (failCount >= MAX_RETRY_PER_CARD) {
          this.eventBus.emit(GameEvent.Log, {
            message: `${getCardDetail(selected)} 已连续使用失败，本回合不再尝试打出。`
          });
          // 使用 getNextBestCardIndex 跳过已失败的牌名，而不是回到循环顶部（避免AI再次选同一张牌）
          if (driver.getNextBestCardIndex) {
            const nextIdx = driver.getNextBestCardIndex(player, {
              players: this.allPlayers,
              roundCount: this.roundCount,
              currentTurn: this.currentTurnInRound,
              currentPlayerId: player.id,
              gameOverWinner: this.gameOverWinner,
              drawPileCount: this.deck.drawPileCount,
              discardPileCount: this.deck.discardPile.length,
              nilouStance: (this.skillManager as any)?.getData?.(player.id)?.nilouStance,
              cardsPlayedThisPhase,
            }, cardName);
            if (nextIdx >= 0) {
              // 用新索引替换 choice，让下面的正常流程处理
              choice = nextIdx;
              // 重新获取 selected 引用
              if (choice >= 0 && choice < player.handCards.length) {
                selected = player.handCards[choice];
                cardName = selected.name;
              } else {
                continue;
              }
            } else {
              // 没有其他可出牌，结束出牌阶段
              this.eventBus.emit(GameEvent.Log, {
                message: `${player.name} 没有其他可出手牌，结束出牌阶段。`
              });
              break;
            }
          } else {
            // 如果 driver 不支持 getNextBestCardIndex，回到循环顶部继续
            continue;
          }
        }

        this.eventBus.emit(GameEvent.CardPlayed, {
          playerId: player.id,
          card: selected
        });

        player.handCards.splice(choice, 1);

        // 技能钩子：使用手牌前（莉奈娅-启喻等）
        let cardReplaced = false; // 标记牌是否被 onBeforeCardUse 替换
        if (this.skillManager) {
          const beforeResult = await this.skillManager.onBeforeCardUse(player, selected, this.buildContext(player.id));
          if (beforeResult.useCard === null) {
            // 取消使用，返还手牌
            player.handCards.splice(choice, 0, selected);
            for (const rc of beforeResult.returnCards) {
              player.handCards.push(rc);
            }
            continue;
          }
          if (beforeResult.useCard !== selected) {
            // 牌被替换，使用新牌
            selected = beforeResult.useCard;
            cardReplaced = true;
            // 收回旧牌
            for (const rc of beforeResult.returnCards) {
              player.handCards.push(rc);
            }
          }
        }

        const success = await this.cardEffectManager.handleActivePlay(selected, player);

        if (success) {
          if (!selected.isVirtual && !(selected as any)._daixianClaimed) {
            this.deck.sendToDiscard(selected);
          }
          // 奈芙尔-秘闻：检查是否使用了被标记的牌
          if (this.skillManager) {
            await this.skillManager.checkNefurSecretOnUse(player, selected);
          }
          // 成功后清除此牌的失败记录，重置连续失败计数
          failedCards.delete(cardName);
          consecutiveFailures = 0;
          // 兹白-三尸：出牌阶段计数+质数/5的倍数检测
          if (this.skillManager) {
            cardsPlayedThisPhase++;
            this.skillManager.onZibaiPlayCardCheck(player, selected, cardsPlayedThisPhase);
            this.skillManager.onZibaiMultipleCheck(player, cardsPlayedThisPhase);
            // 甘雨-月海：记录本回合打出的牌（非虚拟牌）
            if (!selected.isVirtual) {
              const sd = this.skillManager.getData(player.id);
              if (sd && !sd._cardsPlayedThisTurn) sd._cardsPlayedThisTurn = [];
              if (sd) sd._cardsPlayedThisTurn.push(selected);
            }
            // 莉奈娅-启喻：出牌成功后显示翻开牌堆顶（确保在"使用了XX牌"之后）
            if (player.heroId === 'lyneya') {
              const sd = this.skillManager.getData(player.id);
              if (sd?._lyneyaTopCardLog) {
                this.eventBus.emit(GameEvent.Log, { message: sd._lyneyaTopCardLog });
                delete sd._lyneyaTopCardLog;
              }
            }
            // 神里绫华-白鹭：每打出一张牌即时检查，手牌不足时摸至体力值
            await this.skillManager.onAfterCardPlay(player);
          }
          await this.sleep(this.aiActionDelayMs);
        } else {
          if (cardReplaced) {
            // 技能替换来的牌无法打出（如启喻开出闪/杀无目标），放回牌堆顶，无事发生
            // 原牌已通过 returnCards 返还手牌，不记录失败（继续正常出牌）
            if (!selected.isVirtual) {
              this.deck.returnToDrawPile([selected]);
              this.eventBus.emit(GameEvent.Log, { message: `${getCardDetail(selected)} 无法使用，已放回牌堆顶。` });
            } else {
              // 虚拟牌无法使用时，显示原牌名（而非虚拟名，如庇笛转换的闪电）
              this.eventBus.emit(GameEvent.Log, { message: `${cardName}(${selected.suit}${selected.number}) 无法使用，牌已丢弃。` });
            }
            // 记录本次启喻失败，防止AI死循环重试同一张牌
            if (this.skillManager) {
              const skillData = this.skillManager.getData(player.id);
              if (skillData) {
                skillData.revelationFailedCard = cardName;
              }
            }
          } else {
            player.handCards.splice(choice, 0, selected);
            this.eventBus.emit(GameEvent.Log, { message: `${getCardDetail(selected)} 使用失败，已返还。` });
            // 记录失败次数
            failedCards.set(cardName, failCount + 1);
            consecutiveFailures++;

            // 如果手牌中只剩这一张失败过的牌，且已达到重试上限，自动结束出牌
            const allFailed = player.handCards.every(c =>
              (failedCards.get(c.name) || 0) >= MAX_RETRY_PER_CARD
            );
            if (allFailed && player.handCards.length > 0) {
              this.eventBus.emit(GameEvent.Log, {
                message: `${player.name} 所有手牌均已无法使用，结束出牌阶段。`
              });
              break;
            }
          }
        }

        if (this.gameOverWinner || this.aborted) return;
      }
    }
  }

  // ======================== 弃牌阶段 ========================

  private async discardPhase(player: PlayerState): Promise<void> {
    this.eventBus.emit(GameEvent.PhaseChanged, { playerId: player.id, phase: GamePhase.Discard });

    while (player.handCards.length > getHandLimit(player)) {
      const driver = this.drivers.get(player.id)!;
      const choice = await driver.promptDiscard(player, {
        players: this.allPlayers,
        roundCount: this.roundCount,
        currentTurn: this.currentTurnInRound,
        currentPlayerId: player.id,
        gameOverWinner: this.gameOverWinner,
        drawPileCount: this.deck.drawPileCount,
        discardPileCount: this.deck.discardPile.length,
      });

      if (choice >= 0 && choice < player.handCards.length) {
        const toDiscard = player.handCards.splice(choice, 1)[0];
        this.deck.sendToDiscard(toDiscard);
        this.eventBus.emit(GameEvent.Log, {
          message: `${player.name} 弃置了 ${getCardDetail(toDiscard)}`
        });
        // 奈芙尔-秘闻：检查是否弃置了被标记的牌
        if (this.skillManager) {
          await this.skillManager.checkNefurSecretOnDiscard(player, toDiscard);
        }
        await this.sleep(this.aiActionDelayMs);
      }
    }
  }

  // ======================== 辅助 ========================

  private buildContext(playerId: number): GameContextSnapshot {
    return {
      players: this.allPlayers,
      roundCount: this.roundCount,
      currentTurn: this.currentTurnInRound,
      currentPlayerId: playerId,
      gameOverWinner: this.gameOverWinner,
      drawPileCount: this.deck.drawPileCount,
      discardPileCount: this.deck.discardPile.length,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
