// ============================================================
// types.ts — 所有枚举、接口和类型定义
// ============================================================

// ---------- 枚举 ----------

export enum CardType {
  Basic = 'Basic',
  Magic = 'Magic',
  Equipment = 'Equipment'
}

export enum MagicTimeType {
  None = 'None',
  Instant = 'Instant',
  Delay = 'Delay'
}

export enum MagicTargetType {
  None = 'None',
  Single = 'Single',
  Multi = 'Multi'
}

export enum EquipmentType {
  None = 'None',
  Weapon = 'Weapon',
  Armor = 'Armor',
  OffensiveHorse = 'OffensiveHorse',
  DefensiveHorse = 'DefensiveHorse'
}

export enum ElementType {
  None = 'None',
  Pyro = 'Pyro',
  Hydro = 'Hydro',
  Cryo = 'Cryo',
  Electro = 'Electro',
  Anemo = 'Anemo',
  Geo = 'Geo',
  Dendro = 'Dendro'
}

export enum SuitType {
  None = 'None',
  Spade = 'Spade',
  Heart = 'Heart',
  Club = 'Club',
  Diamond = 'Diamond'
}

export enum ColorType {
  Red = 'Red',
  Black = 'Black',
  None = 'None'
}

export enum RoleType {
  Monarch = 'Monarch',
  Minister = 'Minister',
  Rebel = 'Rebel',
  Traitor = 'Traitor',
  None = 'None'
}

export enum Faction {
  Ally = 'Ally',
  Enemy = 'Enemy'
}

export enum GenderType {
  None = 'None',
  Male = 'Male',
  Female = 'Female'
}

export enum GamePhase {
  Prepare = 'Prepare',
  Judging = 'Judging',
  Draw = 'Draw',
  Play = 'Play',
  Discard = 'Discard',
  End = 'End'
}

// ---------- 接口 ----------

/** 卡牌原始数据（JSON 配置） */
export interface CardData {
  Id: number;
  Name: string;
  Type: CardType;
  Suit: SuitType;
  Number: number;
  Description: string;
  Element?: ElementType;
  EquipType?: EquipmentType;
  WeaponRange?: number;
}

/** 卡牌运行时对象 */
export interface Card {
  id: number;
  name: string;
  type: CardType;
  suit: SuitType;
  number: number;
  description: string;
  element: ElementType;
  equipType: EquipmentType;
  weaponRange: number;
  // 运行时属性
  cardSource: PlayerState | null;
  isVirtual: boolean;
  // 计算属性由 getter 提供
}

/** 玩家公开状态（可序列化，用于UI渲染） */
export interface PlayerState {
  id: number;
  /** 玩家显示名（playerID，如"玩家1"） */
  playerName: string;
  /** 武将ID，对应 heroes.ts 中的 HeroData.id */
  heroId: string;
  /** 武将名（如"钟离"） */
  name: string;
  /** 所属区域（蒙德、璃月等） */
  region: string;
  gender: GenderType;
  role: RoleType;
  /** PVE阵营（闯关模式） */
  faction?: Faction;
  /** PVE座位布局索引（0-7，动态人数场用） */
  pveSeatIndex?: number;
  maxHp: number;
  hp: number;
  handCards: Card[];
  equipZone: Record<EquipmentType, Card | null>;
  judgeZone: Card[];
  isFlipped: boolean;
  isChained: boolean;
  isDead: boolean;
  skipDrawPhase: boolean;
  skipPlayPhase: boolean;
  skipDiscardPhase: boolean;
  slashUsedCount: number;
  nextSlashDamageBonus: number;
  wineUsedThisTurn: boolean;
}

/** 玩家驱动接口 */
export interface IPlayerDriver {
  /** 玩家标识 */
  readonly playerId: number;

  /** 出牌阶段：选择出哪张牌，返回手牌索引，-1 表示结束出牌，-2 表示发动丈八蛇矛 */
  promptPlayCard(state: PlayerState, context: GameContextSnapshot): Promise<number>;

  /** 获取手牌中排除指定牌ID后的最高优先级牌索引（用于跳过失败牌），-1 表示无其他牌可出 */
  getNextBestCardIndex?(state: PlayerState, context: GameContextSnapshot, excludeIds: Set<number>): number;

  /** 选择目标玩家，返回玩家 ID，null 表示取消 */
  promptTarget(
    state: PlayerState,
    validTargets: number[],
    reason: string,
    context: GameContextSnapshot
  ): Promise<number | null>;

  /** 响应索要卡牌（杀/闪/桃/酒等），返回打出的牌，null 表示不出 */
  promptResponse(
    state: PlayerState,
    cardName: string,
    context: GameContextSnapshot
  ): Promise<Card | null>;

  /** 选择区域操作（过河拆桥/顺手牵羊） */
  promptZone(
    state: PlayerState,
    targetId: number,
    context: GameContextSnapshot
  ): Promise<ZoneSelection | null>;

  /** 选择两张手牌合成（丈八蛇矛） */
  promptZhanBa(
    state: PlayerState,
    context: GameContextSnapshot
  ): Promise<[number, number] | null>;

  /** 弃牌阶段：选择弃哪张牌 */
  promptDiscard(
    state: PlayerState,
    context: GameContextSnapshot
  ): Promise<number>;

  /** 无懈可击判定：是否打出 */
  promptNullification(
    state: PlayerState,
    context: GameContextSnapshot
  ): Promise<boolean>;

  /** 防具判定（八卦阵）：是否发动 */
  promptArmorTrigger(
    state: PlayerState,
    armorName: string,
    context: GameContextSnapshot
  ): Promise<boolean>;

  /** 武器特效触发（贯石斧/青龙刀/寒冰剑等）：是否发动 */
  promptWeaponEffect(
    state: PlayerState,
    weaponName: string,
    context: GameContextSnapshot
  ): Promise<boolean>;

  /** 铁索连环模式选择 */
  promptIronChainMode(
    state: PlayerState,
    context: GameContextSnapshot
  ): Promise<'recast' | 'chain'>;

  /** 五谷丰登选牌 */
  promptAmazingGrace(
    state: PlayerState,
    tableCards: Card[],
    context: GameContextSnapshot
  ): Promise<number>;

  /** 火攻展示牌选择 */
  promptShowCard(
    state: PlayerState,
    context: GameContextSnapshot
  ): Promise<number>;

  /** 雌雄双股剑选择 */
  promptGenderWeapon(
    state: PlayerState,
    attackerName: string,
    context: GameContextSnapshot
  ): Promise<'discard' | 'draw'>;

  /** 从手牌中选择一张符合条件的牌，返回手牌索引，-1表示取消 */
  promptSelectCard?(
    state: PlayerState,
    title: string,
    filter: (card: Card) => boolean,
    context: GameContextSnapshot
  ): Promise<number>;

  /** 通用Yes/No决策 */
  promptYesNo?(question: string): Promise<boolean>;

  /** 顺手牵羊/过河拆桥手牌区选牌：从target的手牌中选择一张，返回手牌索引，-1表示取消 */
  promptRansackHand?(
    state: PlayerState,
    targetId: number,
    context: GameContextSnapshot
  ): Promise<number>;

  /** 贯石斧等多选弃牌：从手牌+装备中选择count张，返回弃牌索引数组（手牌区索引=0~handLen-1，装备区索引=handLen~） */
  promptDiscardMulti?(
    state: PlayerState,
    count: number,
    context: GameContextSnapshot
  ): Promise<number[]>;
}

/** 区域选择结果 */
export interface ZoneSelection {
  zone: 'hand' | 'equip' | 'judge';
  index: number; // 手牌区为随机，装备/判定区为具体索引
}

/** 游戏上下文快照（传给 Driver 用于决策） */
export interface GameContextSnapshot {
  players: PlayerState[];
  roundCount: number;
  currentTurn: number;
  currentPlayerId: number;
  gameOverWinner: string | null;
  drawPileCount: number;
  discardPileCount: number;
  /** PVE模式自定义出牌顺序 */
  turnOrder?: number[];
  /** 无懈可击判定时的上下文：被保护者（target）、锦囊来源者（source）和锦囊牌名 */
  nullifyTargetId?: number;
  nullifySourceId?: number;
  nullifyCardName?: string;
  /** 濒死求桃时的上下文：濒死玩家ID */
  dyingPlayerId?: number;
  /** 妮露当前状态（水环/水月） */
  nilouStance?: string;
  /** 兹白三尸：当前出牌阶段已打出牌数 */
  cardsPlayedThisPhase?: number;
  /** 纳西妲-比喻：选择的锦囊牌名 */
  metaphorCardName?: string;
}

/** 事件类型 */
export enum GameEvent {
  // 阶段事件
  PhaseChanged = 'PhaseChanged',
  TurnStarted = 'TurnStarted',
  TurnEnded = 'TurnEnded',
  RoundChanged = 'RoundChanged',

  // 卡牌事件
  CardPlayed = 'CardPlayed',
  CardResponded = 'CardResponded',
  CardDrawn = 'CardDrawn',
  CardDiscarded = 'CardDiscarded',
  CardEquipped = 'CardEquipped',
  CardMovedToJudge = 'CardMovedToJudge',
  CardRevealed = 'CardRevealed',
  CardsDealtToTable = 'CardsDealtToTable',

  // 状态事件
  HpChanged = 'HpChanged',
  PlayerDying = 'PlayerDying',
  PlayerDied = 'PlayerDied',
  PlayerRescued = 'PlayerRescued',
  ChainedStateChanged = 'ChainedStateChanged',
  PhaseSkipped = 'PhaseSkipped',

  // 交互事件
  PromptPlayCard = 'PromptPlayCard',
  PromptResponse = 'PromptResponse',
  PromptTarget = 'PromptTarget',
  PromptDiscard = 'PromptDiscard',
  PromptNullification = 'PromptNullification',

  // 游戏事件
  GameOver = 'GameOver',
  Log = 'Log',

  // 装备武器事件
  WeaponEffect = 'WeaponEffect',
  ArmorEffect = 'ArmorEffect',

  // 判定事件
  JudgeResult = 'JudgeResult',

  // 五谷丰登事件
  GraceCardPicked = 'GraceCardPicked',
  GraceCompleted = 'GraceCompleted',

  // 目标选中事件（用于黄光连线动画）
  CardTargeted = 'CardTargeted',

  // 顺手牵羊 / 过河拆桥 动画事件
  CardStolen = 'CardStolen',
  CardDismantled = 'CardDismantled',

  // 身份分配事件
  RolesAssigned = 'RolesAssigned',

  // 技能语音事件（PVP 服务端→客户端广播）
  SkillVoicePlay = 'SkillVoicePlay',
  // 出牌语音事件（PVP 服务端→客户端广播）
  CardVoicePlay = 'CardVoicePlay',
}

/** 事件数据 */
export interface GameEventData {
  type: GameEvent;
  data: Record<string, unknown>;
}

/** 事件监听器 */
export type EventListener = (event: GameEventData) => void;

/** 卡牌效果处理结果 */
export interface CardEffectResult {
  success: boolean;
  message?: string;
}
