// ============================================================
// GameHost.ts — 服务端游戏主持人（创建+运行GameFlowController）
// ============================================================

import type { Server as SocketIOServer, Socket } from 'socket.io';
import {
  PlayerState, RoleType, GameEvent, Card, GenderType, EquipmentType,
  IPlayerDriver, GameContextSnapshot
} from '../src/core/types.js';
import { EventBus } from '../src/core/EventBus.js';
import { DeckManager } from '../src/core/DeckManager.js';
import { CardEffectManager } from '../src/core/CardEffectManager.js';
import { DamageSystem } from '../src/core/DamageSystem.js';
import { EquipEffectManager } from '../src/core/EquipEffectManager.js';
import { GameFlowController } from '../src/core/GameFlowController.js';
import { SkillManager } from '../src/core/skills/SkillManager.js';
import { DelayedAIDriver } from '../src/ai/DelayedAIDriver.js';
import { RemotePlayerDriver } from './RemotePlayerDriver.js';
import { CARD_DATA } from '../src/data/CardData.js';
import { HeroData, getHeroById } from '../src/data/heroes.js';
import type { Account } from './AccountManager.js';
import type { RoomSlot } from './RoomManager.js';

/** 每个槽位对应的玩家信息 */
interface PlayerSlotInfo {
  slotIndex: number;
  socketId: string | null;
  token: string | null;   // account session token
  account: Omit<Account, 'passwordHash'> | null;
  isAI: boolean;
}

export class GameHost {
  private roomId: string;
  private io: SocketIOServer;
  private eventBus!: EventBus;
  private deck!: DeckManager;
  private cardEffectManager!: CardEffectManager;
  private damageSystem!: DamageSystem;
  private equipManager!: EquipEffectManager;
  private skillManager!: SkillManager;
  private flowController!: GameFlowController;
  private drivers!: Map<number, IPlayerDriver>;
  private players!: PlayerState[];
  private playerSlotMap: Map<number, PlayerSlotInfo> = new Map(); // playerId → slot info
  private socketToPlayerId: Map<string, number> = new Map(); // socketId → playerId
  private heroesPicked: Map<number, string> = new Map(); // slotIndex → heroId
  private gameStarted = false;
  private monarchPlayerId: number = -1; // 从选将阶段确定的君主 playerId
  private escapedPlayerIds: Set<number> = new Set(); // 中途逃跑的真人玩家

  /** 获取牌堆剩余数量（供外部读取） */
  get deckPileCount(): number {
    return this.deck?.drawPileCount ?? 160;
  }

  // 重连时保存游戏状态
  public lastGameState: { players: PlayerState[]; phase: string; round: number; turn: number } | null = null;

  constructor(
    roomId: string,
    io: SocketIOServer,
    slots: RoomSlot[],
    aiFillCount: number,
    accountMap: Map<string, Omit<Account, 'passwordHash'>>,
    tokenToSocket: Map<string, string>, // token → socketId
  ) {
    this.roomId = roomId;
    this.io = io;

    // ==================== 构建玩家列表（按槽位索引 0-7 排列） ====================
    // players[i] 严格对应 room.slots[i]，确保座位布局与 UI 渲染一致
    this.players = [];
    this.playerSlotMap = new Map();

    // 先按槽位顺序收集所有8个槽位的信息
    const allSlots = slots.slice(0, 8); // 只取前8个槽位
    // 统计已有人数
    const realSlots = allSlots.filter(s => s.token !== null);
    let playerId = 0;

    // 为每个槽位（按 index 顺序）分配 playerId
    for (const slot of allSlots) {
      const isReal = slot.token !== null;
      const account = isReal && slot.token ? accountMap.get(slot.token) || null : null;
      const socketId = isReal && slot.token ? (tokenToSocket.get(slot.token) || null) : null;
      const hero = slot.heroId ? getHeroById(slot.heroId) : null;

      const player: PlayerState = {
        id: playerId,
        playerName: isReal
          ? (account?.nickname || account?.name || `玩家${slot.index + 1}`)
          : `AI-${playerId + 1}`,
        heroId: hero?.id || 'unknown',
        name: hero?.name || '???',
        region: hero?.region || '',
        gender: (hero?.gender === 'male' ? GenderType.Male : GenderType.Female),
        role: RoleType.None,
        maxHp: hero?.maxHp || 4,
        hp: hero?.maxHp || 4,
        handCards: [],
        equipZone: {
          [EquipmentType.None]: null,
          [EquipmentType.Weapon]: null,
          [EquipmentType.Armor]: null,
          [EquipmentType.OffensiveHorse]: null,
          [EquipmentType.DefensiveHorse]: null,
        },
        judgeZone: [],
        isFlipped: false,
        isChained: false,
        isDead: false,
        skipDrawPhase: false,
        skipPlayPhase: false,
        skipDiscardPhase: false,
        slashUsedCount: 0,
        nextSlashDamageBonus: 0,
        wineUsedThisTurn: false,
      };

      this.players.push(player);
      this.playerSlotMap.set(playerId, {
        slotIndex: slot.index,
        socketId,
        token: slot.token ?? null,
        account,
        isAI: !isReal,
      });
      if (socketId) {
        this.socketToPlayerId.set(socketId, playerId);
      }

      playerId++;
    }

    console.log(`[GameHost] 房间 ${roomId}: ${realSlots.length} 真人 + ${(allSlots.length - realSlots.length)} AI = ${this.players.length} 玩家 (按槽位索引排列)`);
  }

  /** 初始化游戏核心组件 */
  async initGame(heroesForAI: string[]): Promise<void> {
    // 为AI分配英雄（跳过已有heroId的AI，如AI主公已在选将阶段确定英雄）
    let aiHeroIndex = 0;
    for (const [pid, slotInfo] of this.playerSlotMap) {
      if (!slotInfo.isAI) continue;
      const p = this.players.find(pp => pp.id === pid);
      if (!p) continue;
      // 如果该AI已有heroId（如AI主公在选将阶段已确定），跳过
      if (p.heroId && p.heroId !== 'unknown') continue;
      if (heroesForAI && aiHeroIndex < heroesForAI.length) {
        const hero = getHeroById(heroesForAI[aiHeroIndex++]);
        if (hero) {
          p.heroId = hero.id;
          p.name = hero.name;
          p.region = hero.region;
          p.gender = hero.gender === 'male' ? GenderType.Male : GenderType.Female;
          p.maxHp = hero.maxHp;
          p.hp = hero.maxHp;
          // AI 玩家统一用 AI-数字 命名，与构造函数一致
          // p.playerName 已在构造函数中设为 `AI-${playerId + 1}`，无需覆盖
        }
      }
    }

    // ==================== 创建核心组件 ====================
    this.eventBus = new EventBus();
    this.deck = new DeckManager(this.eventBus);
    this.deck.init(CARD_DATA);

    // 创建 drivers（AI 使用 DelayedAIDriver 匹配客户端 1.2 秒出牌设定）
    this.drivers = new Map();
    for (const [pid, slotInfo] of this.playerSlotMap) {
      if (slotInfo.isAI) {
        this.drivers.set(pid, new DelayedAIDriver(pid, () => 1200));
      } else if (slotInfo.socketId) {
        const socket = this.io.sockets.sockets.get(slotInfo.socketId);
        if (socket) {
          this.drivers.set(pid, new RemotePlayerDriver(pid, socket));
        } else {
          // 断线了，用AI暂代
          this.drivers.set(pid, new DelayedAIDriver(pid, () => 1200));
        }
      } else {
        this.drivers.set(pid, new DelayedAIDriver(pid, () => 1200));
      }
    }

    this.damageSystem = new DamageSystem(this.deck, this.eventBus, this.drivers, this.players);
    this.equipManager = new EquipEffectManager(this.deck, this.eventBus, this.damageSystem, this.drivers, this.players);
    this.cardEffectManager = new CardEffectManager(
      this.deck, this.eventBus, this.damageSystem, this.equipManager,
      this.drivers, this.players
    );

    // SkillManager
    this.skillManager = new SkillManager(this.deck, this.eventBus, this.damageSystem, this.drivers, this.players);
    (this.cardEffectManager.skillManager as any) = this.skillManager as any;
    (this.damageSystem.skillManager as any) = this.skillManager as any;

    // 铁索传导回调
    this.damageSystem.onTransmitChain = async (target, damage, sourceCard, source) => {
      this.cardEffectManager.transmitChainedDamage(target, damage, sourceCard, source, false);
    };

    // GameFlowController
    this.flowController = new GameFlowController(
      this.players, this.deck, this.eventBus, this.cardEffectManager,
      this.damageSystem, this.equipManager, this.drivers
    );
    (this.flowController.skillManager as any) = this.skillManager as any;

    // PVP 模式延迟：DelayedAIDriver 已为每次AI决策提供1200ms延迟（匹配客户端1.2s设定），
    // 此处仅保留回合间延迟，aiActionDelayMs 归零避免双重叠加
    this.flowController.turnDelayMs = 2500;       // 回合间 2.5 秒
    this.flowController.aiActionDelayMs = 0;      // DelayedAIDriver 已覆盖每次决策延迟

    // 设置胜负回调
    this.damageSystem.setGameOverCallback((winner) => {
      if (winner && !this.flowController.gameOverWinner) {
        this.flowController.gameOverWinner = winner;
        this.eventBus.emit(GameEvent.GameOver, { winner });
      }
    });

    // ==================== 转发事件到各客户端 ====================
    this.registerEventForwarding();
  }

  /** 将 EventBus 事件即时广播到各客户端（带身份脱敏）。
   *  不再批量缓冲：服务端 aiActionDelayMs/turnDelayMs 已自然节流，
   *  逐条推送让客户端可以逐条渲染，避免批量爆破。
   *  Prompt 类事件由 RemotePlayerDriver 单独通过 prompt 通道发送，此处跳过。 */
  private registerEventForwarding(): void {
    const allGameEvents = Object.values(GameEvent);
    // 不转发给客户端的事件（由 RemotePlayerDriver.prompt 独立处理）
    const skipEvents = new Set([
      GameEvent.PromptPlayCard, GameEvent.PromptResponse,
      GameEvent.PromptTarget, GameEvent.PromptDiscard,
      GameEvent.PromptNullification,
    ]);

    for (const eventType of allGameEvents) {
      if (skipEvents.has(eventType as GameEvent)) continue;
      this.eventBus.on(eventType, (eventData) => {
        try {
          // 将当前玩家状态 + 牌堆数量注入到事件 data 中，让客户端能实时更新战场
          const enrichedData = {
            ...eventData,
            data: {
              ...(eventData.data || {}),
              players: this.players,
              drawPileCount: this.deck?.drawPileCount ?? 0,
            },
          };

          // 对每个真人玩家：脱敏后即时发送
          for (const [pid, slotInfo] of this.playerSlotMap) {
            if (slotInfo.isAI || !slotInfo.socketId) continue;
            const sanitized = this.sanitizeEventForPlayer(enrichedData, pid);
            this.io.to(slotInfo.socketId).emit('game_event', sanitized);
          }
        } catch (err) {
          console.error(`[GameHost] 事件转发异常 (${eventType}):`, err);
        }
      });
    }
  }

  /** 为特定玩家脱敏事件数据 */
  private sanitizeEventForPlayer(eventData: any, viewerPlayerId: number): any {
    // 深度克隆（移除 cardSource 双向引用防止循环序列化：
    //   Card.cardSource → Player，Player.equipZone[X] → Card 形成闭环）
    const cloned = JSON.parse(JSON.stringify(eventData, (key, value) => {
      if (key === 'cardSource') return null;
      return value;
    }));

    if (cloned.data?.players) {
      cloned.data.players = cloned.data.players.map((p: any) =>
        this.sanitizePlayerForViewer(p, viewerPlayerId)
      );
    }
    if (cloned.players) {
      cloned.players = cloned.players.map((p: any) =>
        this.sanitizePlayerForViewer(p, viewerPlayerId)
      );
    }
    // 处理嵌套在 event data 中的 players
    if (cloned.data && typeof cloned.data === 'object') {
      for (const key of Object.keys(cloned.data)) {
        if (cloned.data[key] && typeof cloned.data[key] === 'object' && cloned.data[key].players) {
          cloned.data[key].players = cloned.data[key].players.map((p: any) =>
            this.sanitizePlayerForViewer(p, viewerPlayerId)
          );
        }
      }
    }

    return cloned;
  }

  /** 根据视角玩家脱敏单个玩家状态 */
  private sanitizePlayerForViewer(player: any, viewerPlayerId: number): any {
    if (player.isDead) return player; // 阵亡：全部可见
    if (player.id === viewerPlayerId) return player; // 自己：全部可见
    if (player.role === 'Monarch' || player.role === RoleType.Monarch) return player; // 主公：全部可见

    // 隐藏身份，但保留英雄名/heroId/region 和玩家昵称（名字不需要隐藏）
    return {
      ...player,
      role: 'Unknown',
    };
  }

  /** 根据 socketId 获取对应的 playerId */
  getPlayerIdForSocketId(socketId: string): number | undefined {
    return this.socketToPlayerId.get(socketId);
  }

  /** 获取 playerId → socketId 的映射 */
  getPlayerIds(): number[] {
    return [...this.playerSlotMap.keys()];
  }

  /** 为特定视角玩家生成脱敏后的玩家列表 */
  getSanitizedPlayers(viewerPlayerId: number): any[] {
    return this.players.map(p => this.sanitizePlayerForViewer(p, viewerPlayerId));
  }

  /** 处理断线：换AI接替，标记逃跑 */
  handleDisconnect(socketId: string): void {
    const playerId = this.socketToPlayerId.get(socketId);
    if (playerId === undefined) return;

    const slotInfo = this.playerSlotMap.get(playerId);
    if (!slotInfo || slotInfo.isAI) return;

    slotInfo.socketId = null;

    if (this.gameStarted) {
      // 游戏进行中：标记逃跑，用AI接替
      this.escapedPlayerIds.add(playerId);
      if (this.drivers) {
        this.drivers.set(playerId, new DelayedAIDriver(playerId, () => 1200));
      }
      console.log(`[GameHost] Player ${playerId} 逃跑，AI接替`);
    }
  }

  /** 检查是否还有人类玩家在线 */
  hasAnyHumanPlayer(): boolean {
    for (const [, info] of this.playerSlotMap) {
      if (!info.isAI && info.socketId) return true;
    }
    return false;
  }

  /** 处理重连：换回 RemotePlayerDriver，清除逃跑标记 */
  handleReconnect(socketId: string, socket: Socket): void {
    const playerId = this.socketToPlayerId.get(socketId);
    if (playerId === undefined) return;

    const slotInfo = this.playerSlotMap.get(playerId);
    if (!slotInfo) return;

    slotInfo.socketId = socketId;
    this.escapedPlayerIds.delete(playerId); // 重连清除逃跑标记

    if (this.drivers && this.gameStarted) {
      const existing = this.drivers.get(playerId);
      if (existing instanceof RemotePlayerDriver) {
        existing.updateSocket(socket);
      } else {
        this.drivers.set(playerId, new RemotePlayerDriver(playerId, socket));
      }
      console.log(`[GameHost] Player ${playerId} 重连，恢复RemoteDriver`);
    }
  }

  /** 设置君主（选将阶段确定后调用）。
   *  @param monarchSlotIndex room 槽位索引（0-7），不是 playerId。
   *  通过 playerSlotMap 查找该槽位对应的 playerId。 */
  setMonarchPlayerId(monarchSlotIndex: number): void {
    // 通过 slotIndex → playerId 映射找到正确的 player
    const pid = this.getPlayerIdBySlotIndex(monarchSlotIndex);
    if (pid === undefined) {
      console.error(`[GameHost] setMonarchPlayerId: 槽位 ${monarchSlotIndex} 无对应玩家`);
      return;
    }
    this.monarchPlayerId = pid;
    // 预设置该玩家的角色为主公
    if (this.players && pid >= 0 && pid < this.players.length) {
      this.players[pid].role = RoleType.Monarch;
    }
  }

  /** 根据槽位索引查找 playerId */
  getPlayerIdBySlotIndex(slotIndex: number): number | undefined {
    for (const [pid, info] of this.playerSlotMap) {
      if (info.slotIndex === slotIndex) return pid;
    }
    return undefined;
  }

  /** 开始游戏 */
  async start(): Promise<void> {
    this.gameStarted = true;
    console.log(`[GameHost] 房间 ${this.roomId} 游戏开始！`);

    // 确保君主角色已预分配（setMonarchPlayerId 已设置role，其余角色由assignRoles随机分配）
    const monarchHumanId = this.monarchPlayerId >= 0 && !this.playerSlotMap.get(this.monarchPlayerId)?.isAI
      ? this.monarchPlayerId : undefined;

    await this.flowController.startGame(monarchHumanId);
  }

  /** 终止游戏（所有玩家离开时调用） */
  abort(): void {
    if (this.flowController) {
      this.flowController.abort();
    }
  }

  /** 获取游戏胜利方（游戏结束后可用） */
  get winner(): string | null {
    return this.flowController?.gameOverWinner ?? null;
  }

  /** 获取游戏结果数据（含击杀统计 + 逃跑标记），供服务端计算经验 */
  getGameResultData(): { winner: string | null; players: Array<{ playerId: number; name: string; role: string; accountId: string | null; token: string | null; isAI: boolean; escaped: boolean }>; killStats: Record<number, { monarch: number; minister: number; rebel: number; traitor: number }>; escapedPlayerIds: number[] } | null {
    if (!this.flowController) return null;
    const killStats: Record<number, { monarch: number; minister: number; rebel: number; traitor: number }> = {};
    for (const [pid, stats] of this.flowController.killStats) {
      killStats[pid] = { ...stats };
    }
    const escapedArr = [...this.escapedPlayerIds];
    const players = this.players.map(p => {
      const slotInfo = this.playerSlotMap.get(p.id);
      return {
        playerId: p.id,
        name: p.playerName,
        role: p.role,
        accountId: slotInfo?.account?.id ?? null,
        token: slotInfo?.token ?? null,
        isAI: slotInfo?.isAI ?? false,
        escaped: escapedArr.includes(p.id),
      };
    });
    return { winner: this.winner, players, killStats, escapedPlayerIds: escapedArr };
  }

  /** 计算所有真人玩家的经验值列表（逃跑者 totalExp=0） */
  computeExpForAllPlayers(): Array<{ playerId: number; baseExp: number; bonusExp: number; totalExp: number; oldLevel: number; newLevel: number; leveledUp: boolean; escaped: boolean }> | null {
    const result = this.getGameResultData();
    if (!result) return null;
    const winner = result.winner;
    const escapedSet = new Set(result.escapedPlayerIds);
    const list: Array<{ playerId: number; baseExp: number; bonusExp: number; totalExp: number; oldLevel: number; newLevel: number; leveledUp: boolean; escaped: boolean }> = [];
    for (const p of result.players) {
      const escaped = escapedSet.has(p.playerId);
      // 逃跑者经验直接为零
      const baseExp = escaped ? 0 : GameHost.calcBaseExp(p.role, winner);
      const stats = result.killStats[p.playerId] ?? { monarch: 0, minister: 0, rebel: 0, traitor: 0 };
      const bonusExp = escaped ? 0 : GameHost.calcKillExp(p.role, stats);
      const totalExp = baseExp + bonusExp;
      list.push({
        playerId: p.playerId,
        baseExp,
        bonusExp,
        totalExp,
        oldLevel: 0,
        newLevel: 0,
        leveledUp: false,
        escaped,
      });
    }
    return list;
  }

  /** 根据 role 计算胜利基础经验 */
  static calcBaseExp(role: string, winner: string | null): number {
    if (!winner) return 20;
    if (winner.includes('内奸')) {
      if (role === RoleType.Traitor) return 100;
      return 20;
    }
    if (winner.includes('反贼')) {
      if (role === RoleType.Rebel) return 40;
      return 20;
    }
    // 主忠阵营胜利
    if (role === RoleType.Monarch) return 75;
    if (role === RoleType.Minister) return 50;
    return 20; // 内奸在主忠阵营胜利中失败
  }

  /** 根据击杀统计计算额外经验 */
  static calcKillExp(role: string, stats: { monarch: number; minister: number; rebel: number; traitor: number }): number {
    let bonus = 0;
    if (role === RoleType.Monarch) {
      if (stats.rebel) bonus += 3;
      if (stats.traitor) bonus += 2;
      if (stats.minister) bonus -= 5;
    } else if (role === RoleType.Minister) {
      if (stats.rebel) bonus += 3;
      if (stats.traitor) bonus += 2;
      if (stats.monarch) bonus -= 5;
    } else if (role === RoleType.Rebel) {
      if (stats.minister) bonus += 3;
      if (stats.traitor) bonus += 3;
      if (stats.monarch) bonus += 5;
    } else if (role === RoleType.Traitor) {
      bonus += (stats.monarch + stats.minister + stats.rebel + stats.traitor) * 3;
    }
    return bonus;
  }

  /** 获取游戏进行中的状态快照（用于重连） */
  getStateSnapshot(): { players: PlayerState[]; phase: string; round: number; turn: number } | null {
    if (!this.flowController) return null;
    return {
      players: this.players,
      phase: 'playing',
      round: this.flowController.roundCount,
      turn: this.flowController.currentTurnInRound,
    };
  }
}
