// ============================================================
// GamePage.ts — 游戏主界面（选将 + 战斗 + 真实卡牌 + 动画 + 点击交互）
// ============================================================

import { router, RouteState } from './router';
import {
  PlayerState, GamePhase, RoleType, GameContextSnapshot,
  GameEvent, Card, IPlayerDriver, EquipmentType, GenderType,
  ZoneSelection, SuitType, MagicTimeType, ElementType, Faction, CARD_SUITS, type CardSuit
} from '../core/types';
import { getRoleChineseName, getWeaponRange } from '../core/Player';
import { getCardDetail, isSlash, getCardColor, getMagicSubType, ColorType } from '../core/Card';
import { socketManager } from '../network/SocketManager';
import { ChatPanel } from './ChatPanel';
import { BattlePresentation, type BattleActionKind } from './BattlePresentation';
import { GameClock } from './GameClock';
import { getDistance } from '../core/DistanceCalc';

import { CARD_DATA } from '../data/CardData';
import { EventBus } from '../core/EventBus';
import { GameResolutionEnded, GameSession, GameSessionCancelled } from '../core/GameSession';
import { DeckManager } from '../core/DeckManager';
import { CardEffectManager } from '../core/CardEffectManager';
import { DamageSystem } from '../core/DamageSystem';
import { EquipEffectManager } from '../core/EquipEffectManager';
import { GameFlowController } from '../core/GameFlowController';
import { DelayedAIDriver } from '../ai/DelayedAIDriver';
import { SkillManager } from '../core/skills/SkillManager';
import { HeroData, ALL_HEROES, getGods, getNonGods, getHeroById } from '../data/heroes';
import { PVELevel, getLevelById, getCandidatePool, pickAIAllyHeroes, getChapterForLevel, savePVEStar, getPVEStarRecords } from '../data/PVELevels';
import { VoiceManager, VOICE_PLAY_EVENT, VoicePlayEventDetail } from '../audio/VoiceManager';
import { getPVEBattleBackgrounds, PVP_BACKGROUNDS, toCssImage } from './BackgroundAssets';
// ======================== 常量 ========================
const SUIT_SYMBOL: Record<string, string> = {
  Spade: '♠', Heart: '♥', Club: '♣', Diamond: '♦', None: '',
};
const SUIT_COLOR: Record<string, string> = {
  Spade: '#222', Heart: '#c1272d', Club: '#222', Diamond: '#c1272d', None: '#888',
};
const SUIT_LABEL: Record<CardSuit, string> = {
  [SuitType.Spade]: '黑桃',
  [SuitType.Heart]: '红桃',
  [SuitType.Club]: '梅花',
  [SuitType.Diamond]: '方块',
};
const NUMBER_TEXT: Record<number, string> = {
  1: 'A', 11: 'J', 12: 'Q', 13: 'K',
};
const ANIM_DURATION = 400; // ms
const TURN_PHASE_LABELS: Record<GamePhase, string> = {
  [GamePhase.Prepare]: '准备阶段',
  [GamePhase.Judging]: '判定阶段',
  [GamePhase.Draw]: '摸牌阶段',
  [GamePhase.Play]: '出牌阶段',
  [GamePhase.Discard]: '弃牌阶段',
  [GamePhase.End]: '回合结束',
};
const SEAT_EQUIPMENT_SLOTS = [
  { slot: EquipmentType.Weapon, label: '武器' },
  { slot: EquipmentType.Armor, label: '防具' },
  { slot: EquipmentType.OffensiveHorse, label: '进攻马' },
  { slot: EquipmentType.DefensiveHorse, label: '防御马' },
] as const;
const SEAT_ROLE_MARKS = {
  忠: '忠臣',
  反: '反贼',
  内: '内奸',
} as const;
type SeatRoleMark = keyof typeof SEAT_ROLE_MARKS;

function escapeSeatText(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

// 卡牌名称到文件名映射（某些卡牌的Resources/Cards下的PNG文件名不同）
const CARD_FILE_NAME_MAP: Record<string, string> = {
  '青釭剑': '青缸剑',
  '+1马': '骅骝',   // fallback
  '-1马': '赤兔',   // fallback
};

// ======================== 全局AI延迟（PVE模式，运行时可通过设置面板调整） ========================
import { cacheGet, cacheSave, syncAllSettings } from '../data/SettingsCache';
let globalAiDelayMs = 1600; // 默认1.6秒（推荐速度），从服务端同步后更新

// ======================== 人类玩家 Web UI Driver（点击交互版） ========================
export class HumanWebUIDriver {
  readonly playerId: number;
  private gamePage: GamePage;
  // 共享的Promise resolve
  private resolveMap: Map<string, (value: any) => void> = new Map();
  // 当前交互类型（用于防冲突）
  private currentInteraction: string | null = null;
  private cancelMap = new Map<string, () => void>();
  /** PVP 模式下的 socket respond 回调（与 PVE Promise 并存，点击时同时触发两者） */
  private pvpRespond: ((v: any) => void) | null = null;

  constructor(playerId: number, gamePage: GamePage, private session: GameSession = gamePage.session) {
    this.playerId = playerId;
    this.gamePage = gamePage;
    this.session.onDispose(() => {
      this.resolveMap.clear();
      this.cancelMap.clear();
      this.currentInteraction = null;
      this.pvpRespond = null;
    });
  }

  cancelInteraction(): void {
    this.pvpRespond = null;
    for (const cancel of [...this.cancelMap.values()]) cancel();
    this.currentInteraction = null;
  }

  /** PVP 模式注入 socket respond 回调；关闭时传 null */
  setPVPRespond(r: ((v: any) => void) | null) {
    this.pvpRespond = r;
  }

  /** Keep callback panels and hand selection under the same request lifetime. */
  private waitForInput<T>(key: string, defaultValue: T,
    show: (finish: (value: T) => void) => void | (() => void)): Promise<T> {
    const respond = this.pvpRespond;
    return this.session.wait<T>(resolve => {
      // Replacing one input must not end an unrelated PVE play-card wait.
      this.cancelMap.get(key)?.();
      let settled = false;
      let release: void | (() => void);
      const remove = () => {
        if (this.resolveMap.get(key) !== complete) return;
        this.resolveMap.delete(key);
        this.cancelMap.delete(key);
        if (this.currentInteraction === key) this.currentInteraction = null;
      };
      const finish = (value: T, submit: boolean) => {
        if (settled) return;
        settled = true;
        remove();
        release?.();
        if (submit) {
          this.gamePage.stopPVPCountdown();
          respond?.(value);
        }
        resolve(value);
      };
      const complete = (value: T) => {
        if (!this.session.active || this.resolveMap.get(key) !== complete) return;
        // A retained callback must never submit to a replacement remote request.
        if (respond && respond !== this.pvpRespond) return;
        finish(value, true);
      };
      this.resolveMap.set(key, complete);
      this.cancelMap.set(key, () => finish(defaultValue, false));
      this.currentInteraction = key;
      try {
        this.gamePage.closeHeroInfoPopup();
        release = show(complete);
        if (settled) release?.();
      } catch (error) {
        settled = true;
        remove();
        throw error;
      }
      return () => {
        if (settled) return;
        settled = true;
        remove();
        release?.();
      };
    });
  }

  async promptPlayCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return this.waitForInput('playCard', -1, () => {
      this.gamePage.clearHighlights();
      this.gamePage.highlightPlayableCards(state, ctx);
      // 兹白：显示当前第几张牌
      const zibaiHint = state.heroId === 'zibai' && ctx.cardsPlayedThisPhase !== undefined
        ? ` (第${ctx.cardsPlayedThisPhase + 1}张)` : '';
      this.gamePage.showPrompt(`出牌阶段 - 点击手牌出牌，或点"结束出牌"${zibaiHint}`);
    });
  }
  async promptTarget(state: PlayerState, validTargets: number[], reason: string, ctx: GameContextSnapshot): Promise<number | null> {
    return this.waitForInput<number | null>('target', null, () => {
      this.gamePage.clearHighlights();
      this.gamePage.highlightTargets(validTargets, reason);
      this.gamePage.showPrompt(`选择目标 - ${reason}`);
    });
  }
  async promptResponse(state: PlayerState, cardName: string, ctx: GameContextSnapshot): Promise<Card | null> {
    return this.waitForInput<Card | null>('response', null, finish => {
      // 超时保护
      const timer = this.session.setTimeout(() => {
        if (this.resolveMap.get('response') === finish) {
          this.gamePage.clearHighlights();
          this.gamePage.hidePrompt();
          this.gamePage.hideResponseButtons();
          finish(null);
        }
      }, this.gamePage.getInteractionTimeoutMs(30000));
      // 先清理之前可能残留的交互状态
      this.gamePage.clearHighlights();
      this.gamePage.hidePrompt();
      let validCards: Card[];
      if (cardName.startsWith('花色:')) {
        const parts = cardName.split(':');
        const suit = parts[2] || parts[1]; // 格式: 花色:♥:Heart
        validCards = state.handCards.filter(c => c.suit === suit);
      } else if (cardName === '杀') {
        validCards = state.handCards.filter(c => isSlash(c));
        // 妮露-水月：红色牌可当杀
        const nilouStance = (ctx as any).nilouStance;
        if (state.heroId === 'nilou' && nilouStance === '水月') {
          const redCards = state.handCards.filter(c =>
            (c.suit === 'Heart' || c.suit === 'Diamond') && !validCards.some(v => v.id === c.id)
          );
          validCards.push(...redCards);
        }
      } else if (cardName === '闪') {
        validCards = state.handCards.filter(c => c.name === '闪');
        // 妮露-水环：黑色牌可当闪
        const nilouStance = (ctx as any).nilouStance;
        if (state.heroId === 'nilou' && nilouStance === '水环') {
          const blackCards = state.handCards.filter(c =>
            (c.suit === 'Spade' || c.suit === 'Club') && !validCards.some(v => v.id === c.id)
          );
          validCards.push(...blackCards);
        }
      } else {
        validCards = state.handCards.filter(c => c.name === cardName);
      }
      this.gamePage.clearHighlights();
      this.gamePage.startPVPCountdown(30);
      const dyingPlayer = ctx?.players?.find(player => player.id === ctx.dyingPlayerId);
      let hint = `需响应【${cardName}】`;
      if (dyingPlayer) {
        const action = dyingPlayer.id === state.id ? '自救' : `救援 ${dyingPlayer.name}`;
        hint = `打出【${cardName}】${action}`;
      }
      this.gamePage.highlightResponseCards(validCards, hint);
      return () => clearTimeout(timer);
    });
  }
  async promptZone(state: PlayerState, targetId: number, ctx: GameContextSnapshot): Promise<ZoneSelection | null> {
    return this.waitForInput<ZoneSelection | null>('zone', null, finish => {
      const target = ctx.players.find(p => p.id === targetId);
      if (!target) { finish(null); return; }
      this.gamePage.clearHighlights();
      this.gamePage.highlightZones(target);
      this.gamePage.showPrompt(`选择 ${target.name} 的区域（手牌/装备/判定区）`);
    });
  }
  async promptZhanBa(state: PlayerState, ctx: GameContextSnapshot): Promise<[number, number] | null> {
    return this.waitForInput<[number, number] | null>('zhanba', null,
      finish => this.gamePage.showZhanBaPrompt(state, finish));
  }
  async promptDiscard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return this.waitForInput('discard', 0, () => {
      this.gamePage.highlightDiscardCards(state, ctx?.discardHandLimit);
      return () => {
        this.gamePage.clearHighlights();
        this.gamePage.hidePrompt();
      };
    });
  }
  async promptNullification(state: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    return this.waitForInput('nullify', false, finish => {
      if (!state.handCards.some(c => c.name === '无懈可击')) { finish(false); return; }
      const timeoutMs = this.gamePage.getInteractionTimeoutMs(5000);
      const timer = this.session.setTimeout(() => {
        if (this.resolveMap.get('nullify') !== finish) return;
        this.gamePage.clearHighlights();
        this.gamePage.hidePrompt();
        this.gamePage.hideNullifyPassButton();
        this.resolveNullify(false);
      }, timeoutMs);
      this.gamePage.showPrompt('是否打出【无懈可击】？点击亮起的手牌，或选择放弃。');
      this.gamePage.startPVPCountdown(timeoutMs / 1000);
      this.gamePage.highlightNullifyCards(state);
      return () => clearTimeout(timer);
    });
  }

  /** 判断对方是否是敌对阵营（基于PVE faction或PVP身份） */
  private isHostile(me: PlayerState, other: PlayerState): boolean {
    // PVE模式：基于阵营（faction）判定敌友
    const myFaction = (me as any).faction as string | undefined;
    const otherFaction = (other as any).faction as string | undefined;
    if (myFaction && otherFaction) {
      return myFaction !== otherFaction;
    }
    // PVP模式：基于身份判定
    if (me.role === RoleType.None || other.role === RoleType.None) return true;
    if (me.role === RoleType.Monarch) {
      return other.role === RoleType.Rebel || other.role === RoleType.Traitor;
    }
    if (me.role === RoleType.Minister) {
      return other.role === RoleType.Rebel || other.role === RoleType.Traitor;
    }
    if (me.role === RoleType.Rebel) {
      return other.role === RoleType.Monarch || other.role === RoleType.Minister;
    }
    if (me.role === RoleType.Traitor) return true;
    return true;
  }
  async promptArmorTrigger(state: PlayerState, armorName: string, ctx: GameContextSnapshot): Promise<boolean> {
    return this.promptYesNo(`是否发动【${armorName}】？`);
  }
  async promptWeaponEffect(state: PlayerState, weaponName: string, ctx: GameContextSnapshot): Promise<boolean> {
    return this.promptYesNo(`是否发动【${weaponName}】效果？`);
  }
  // 兼容两种调用约定：旧式 (state, validCards:Card[], ctx) 和新式 (state, title:string, filter, ctx)
  async promptSelectCard(state: PlayerState, arg2: string | Card[], arg3?: any, arg4?: any): Promise<number> {
    if (Array.isArray(arg2)) {
      // 旧式: (state, validCards, ctx) — 选择任意符合条件的牌
      return this.waitForInput('selectCard', -1, finish => {
        if (arg2.length === 0) { finish(-1); return; }
        this.gamePage.clearHighlights();
        this.gamePage.highlightSelectableCards(state, arg2 as Card[]);
        this.gamePage.showPrompt('选择一张牌使用');
      });
    } else {
      // 新式: (state, title, filter, ctx) — 根据filter过滤手牌后选择（有取消按钮）
      // PVP 模式下 filter 无法序列化，arg3 可能是 ctx 对象而非函数
      const filterFn = typeof arg3 === 'function' ? arg3 as ((c: Card) => boolean) : undefined;
      const validCards = filterFn
        ? state.handCards.filter(filterFn)
        : [...state.handCards]; // PVP：无法传filter，显示所有手牌
      return this.waitForInput('selectCard', -1, finish => {
        if (validCards.length === 0) { finish(-1); return; }
        this.gamePage.clearHighlights();
        this.gamePage.highlightSelectableCards(state, validCards);
        this.gamePage.showPrompt(arg2 as string);
        // 添加取消按钮
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.className = 'btn btn-ghost btn-sm';
        cancelBtn.style.cssText = 'margin-left:8px;pointer-events:auto;';
        cancelBtn.onclick = (e) => {
          e.stopPropagation();
          if (this.resolveMap.get('selectCard') !== finish) return;
          finish(-1);
          this.gamePage.clearHighlights();
          this.gamePage.hidePrompt();
          cancelBtn.remove();
        };
        this.gamePage.promptBarEl.appendChild(cancelBtn);
        return () => cancelBtn.remove();
      });
    }
  }
  async promptYesNo(title: string): Promise<boolean> {
    return this.waitForInput('yesNo', false, finish => this.gamePage.showYesNoPrompt(title, finish));
  }
  async promptSuit(cardNumber: number, totalCards: number): Promise<CardSuit | null> {
    return this.waitForInput<CardSuit | null>('chooseSuit', null,
      finish => this.gamePage.showSuitPrompt(cardNumber, totalCards, finish));
  }
  async promptRansackHand(
    state: PlayerState,
    targetId: number,
    ctx: GameContextSnapshot
  ): Promise<number> {
    return this.waitForInput('ransackHand', -1, finish => {
      const target = ctx.players.find(p => p.id === targetId);
      if (!target || target.handCards.length === 0) { finish(-1); return; }
      this.gamePage.showRansackHandPrompt(target, finish);
    });
  }
  async promptDiscardMulti(
    state: PlayerState,
    count: number,
    ctx: GameContextSnapshot
  ): Promise<number[]> {
    return this.waitForInput<number[]>('discardMulti', [],
      finish => this.gamePage.showDiscardMultiPrompt(state, count, finish, ctx.discardPrompt));
  }
  async promptIronChainMode(state: PlayerState, ctx: GameContextSnapshot): Promise<'recast' | 'chain'> {
    return this.waitForInput<'recast' | 'chain'>('ironChainMode', 'recast',
      finish => this.gamePage.showIronChainPrompt(finish));
  }
  async promptAmazingGrace(state: PlayerState, tableCards: Card[], ctx: GameContextSnapshot): Promise<number> {
    return this.waitForInput('amazingGrace', 0,
      finish => this.gamePage.showGraceCards(tableCards, finish));
  }

  /** 五谷丰登结束后清理 */
  clearGraceWindow(): void {
    this.gamePage.clearGraceCards();
  }
  async promptShowCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return this.waitForInput('showCard', 0, () => {
      this.gamePage.clearHighlights();
      this.gamePage.highlightShowCards(state);
      this.gamePage.showPrompt('火攻 - 选择一张手牌展示');
    });
  }
  async promptGenderWeapon(state: PlayerState, attackerName: string, ctx: GameContextSnapshot): Promise<'discard' | 'draw'> {
    return this.waitForInput<'discard' | 'draw'>('genderWeapon', 'discard',
      finish => this.gamePage.showGenderWeaponPrompt(attackerName, finish));
  }
  /** 温迪-自由：选择新的体力上限 */
  async promptVentiFree(state: PlayerState): Promise<number> {
    return this.waitForInput('ventiFree', state.maxHp,
      finish => this.gamePage.showVentiFreePrompt(state, finish));
  }

  // ========== 供GamePage调用的公共接口 ==========
  // Only the matching live wait may submit a result; repeated/stale actions do nothing.
  resolvePlayCard(index: number) {
    this.resolveMap.get('playCard')?.(index);
  }
  resolveSelectCard(index: number) {
    this.resolveMap.get('selectCard')?.(index);
  }
  resolveTarget(targetId: number | null) {
    this.resolveMap.get('target')?.(targetId);
  }
  resolveResponse(card: Card | null) {
    this.resolveMap.get('response')?.(card);
  }
  resolveZone(sel: ZoneSelection | null) {
    this.resolveMap.get('zone')?.(sel);
  }
  resolveDiscard(index: number) {
    this.resolveMap.get('discard')?.(index);
  }
  resolveNullify(value: boolean) {
    this.resolveMap.get('nullify')?.(value);
  }
  resolveShowCard(index: number) {
    this.resolveMap.get('showCard')?.(index);
  }
  getResolveKey(key: string): boolean { return this.resolveMap.has(key); }
}

// ======================== GamePage 主类 ========================
export class GamePage {
  public session = new GameSession();
  private chatPanel: ChatPanel | null = null;
  private battlePresentation: BattlePresentation | null = null;
  private pendingDiscardAnimations = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly elapsedClock = new GameClock();
  private readonly countdownClock = new GameClock();
  private transientElements = new Set<HTMLElement>();
  private tableInteraction: HTMLElement | null = null;

  /** Effect decisions occupy the free table space, without covering seats or hand cards. */
  private mountTableInteraction(layer: HTMLElement): void {
    this.closeTableInteraction();
    if (!this.session.active) return;
    layer.className = 'table-interaction-layer';
    layer.removeAttribute('style');
    const panel = layer.firstElementChild as HTMLElement;
    panel.classList.remove('game-modal');
    panel.classList.add('table-interaction-panel');
    panel.removeAttribute('style');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', panel.querySelector('h3')?.textContent || '效果选择');
    const children = Array.from(panel.children);
    const actions = children.at(-1) as HTMLElement | undefined;
    if (actions?.querySelector('button') && !actions.matches('.target-list, [class$="grid"]')) {
      actions.classList.add('table-interaction-actions');
      actions.removeAttribute('style');
    }
    const body = document.createElement('div');
    body.className = 'table-interaction-body';
    for (const child of children) {
      if (child.tagName !== 'H3' && child !== actions) body.append(child);
    }
    if (body.childElementCount) panel.insertBefore(body, actions || null);
    this.tableInteraction = layer;
    this.gameMainEl.append(layer);
    this.gameMainEl.classList.add('has-table-interaction');
    this.positionTableInteraction();
    window.addEventListener('resize', this.positionTableInteraction);
  }

  /** Returns false for an expired or already submitted panel. */
  private closeTableInteraction(layer = this.tableInteraction): boolean {
    if (!layer || layer !== this.tableInteraction) return false;
    layer.remove();
    this.tableInteraction = null;
    this.gameMainEl?.classList.remove('has-table-interaction');
    window.removeEventListener('resize', this.positionTableInteraction);
    return this.session.active;
  }

  private positionTableInteraction = (): void => {
    const layer = this.tableInteraction;
    if (!layer) return;
    const bounds = this.gameMainEl.getBoundingClientRect();
    const field = this.battlefieldEl.getBoundingClientRect();
    const row = this.battlefieldEl.querySelector('#top-row')?.getBoundingClientRect();
    const hand = this.gameMainEl.querySelector('.player-zone')?.getBoundingClientRect();
    const top = (row?.bottom ?? field.top + 170) - bounds.top + 8;
    const bottom = (hand?.top ?? field.bottom) - bounds.top - 8;
    const panel = layer.firstElementChild as HTMLElement;
    panel.style.left = `${field.left - bounds.left + field.width / 2}px`;
    panel.style.top = `${(top + bottom) / 2}px`;
    panel.style.width = `${Math.max(220, Math.min(580, field.width - 360))}px`;
    panel.style.maxHeight = `${Math.max(100, bottom - top)}px`;
    layer.dataset.compact = String(bottom - top < 260);
  };

  private mountTransient(element: HTMLElement): void {
    if (!this.session.active) return;
    for (const old of this.transientElements) {
      if (!old.isConnected) this.transientElements.delete(old);
    }
    this.transientElements.add(element);
    document.body.appendChild(element);
  }
  private el!: HTMLElement;
  private mode: 'pve' | 'pvp' = 'pve';
  private roomId = '';
  private chapterId = '';
  private levelId = 0;
  private logEntries: string[] = [];
  private isGameOver = false;
  private gameStarted = false;
  private bgmAudio: HTMLAudioElement | null = null;

  
  private bgmVolume = cacheGet('bgmVolume', 30) / 100;
  /** 对局内背景轮换状态：PVE 使用旧版地区编号图池，PVP 使用 pvp1-10。 */
  private currentBattlefieldBackground = '';
  private wallpaperCandidates: string[] = [];
  private wallpaperPool: string[] = [];
  private wallpaperLastMinute = -1;
  private wallpaperCrossEl!: HTMLElement;
  /** PVE 模式下预分配的身份（先发身份，再选将） */
  private preAssignedRoles: RoleType[] | null = null;
  /** PVE 模式下人类玩家在 this.players 中的索引（随机 0-7） */
  private humanPlayerIdx: number = 1;
  /** PVE 闯关模式：当前关卡数据 */
  private pveLevel: PVELevel | null = null;
  /** PVE 闯关模式：已选武将列表（主将+副将） */
  private pvePickedHeroes: string[] = [];
  /** PVE 闯关模式：当前正在选第几个副将（0=主将，1=副将1...） */
  private pvePickIndex: number = 0;
  private isBgmOn = cacheGet('bgmEnabled', true);
  private bgmBattlePath: string | null = null; // 战斗BGM路径
  private bgmSwitchTimer: any = null; // 切换到战斗BGM的定时器

  // ======== PVP 联机模式 ========
  private pvpOnline = false; // true = 服务器驱动模式已激活
  private pvpMyPlayerId = -1; // PVP 中自己的 playerId（来自 game_start）
  private readonly seatRoleMarks = new Map<number, SeatRoleMark>();
  private seatRolePicker: HTMLElement | null = null;
  private seatRolePickerEvents: AbortController | null = null;
  private pvpRequestId: string | null = null; // 当前 prompt 的 requestId
  private pvpUnsubs: Array<() => void> = []; // socket 事件注销回调

  // PVP 操作读条倒计时
  private pvpCountdownBarEl!: HTMLElement;
  private pvpCountdownFillEl!: HTMLElement;
  private pvpCountdownTextEl!: HTMLElement;
  private pvpCountdownTimer: ReturnType<typeof setInterval> | null = null;
  private playCountdownBarEl!: HTMLElement;
  private playCountdownFillEl!: HTMLElement;
  private playCountdownTextEl!: HTMLElement;

  // 选将
  private heroesPicked: HeroData[] = [];
  private humanHeroPicked: HeroData | null = null;
  /** 非主公场景下 AI 主公选的武将（需保留到阵容构建） */
  private aiMonarchHero: HeroData | null = null;

  // 游戏核心
  private eventBus!: EventBus;
  private deck!: DeckManager;
  private players: PlayerState[] = [];
  private flowController!: GameFlowController;
  private humanDriver!: HumanWebUIDriver;
  private currentTurnPlayerId: number = 1;

  /** 获取"自己"的 playerId：始终等于人类玩家实际的 player.id */
  private get selfId(): number {
    const human = this.players[this.humanPlayerIdx];
    return human?.id ?? 1;
  }

  // DOM引用
  private logContentEl!: HTMLElement;
  private battlefieldEl!: HTMLElement;
  private phaseEl!: HTMLElement;
  private deckCountEl!: HTMLElement;
  private roundNumEl!: HTMLElement;
  private roundLabelEl!: HTMLElement;
  private timerEl!: HTMLElement;
  private timerSeconds: number = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private handCardsEl!: HTMLElement;
  private heroSelectEl!: HTMLElement;
  private gameMainEl!: HTMLElement;
  public promptBarEl!: HTMLElement;
  private equipDisplayEl!: HTMLElement;
  private skillAreaEl!: HTMLElement;
  private playEndBtnEl!: HTMLElement;
  private actionBarEl!: HTMLElement;

  // 动画层
  private animLayer!: HTMLElement;

  // 出牌阶段选牌状态
  private selectedCardIndex: number = -1;
  private selectedCardState: PlayerState | null = null;
  private selectedCardCtx: GameContextSnapshot | null = null;

  render(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'page game-page';
    container.innerHTML = `
      <div class="game-bg" id="game-bg"></div>
      <div class="game-bg-cross" id="game-bg-cross"></div>
      <div id="game-main-area">
        <div class="game-top-bar">
          <div class="game-top-left">
            <button class="btn btn-ghost btn-sm" id="game-back-btn">← 返回旅途</button>
            <button class="btn btn-ghost btn-sm" id="game-settings-btn">⚙ 设置</button>
          </div>
          <div class="game-phase" id="game-phase">等待开始...</div>
          <div class="game-top-right">
            <span class="pvp-board-connection" id="pvp-board-connection" role="status">联机中</span>
            <!-- PVP 操作读条倒计时（仅PVP模式显示） -->
            <div class="pvp-countdown-bar" id="pvp-countdown-bar" style="display:none;">
              <div class="pvp-countdown-fill" id="pvp-countdown-fill"></div>
              <span class="pvp-countdown-text" id="pvp-countdown-text">操作剩余 10 秒</span>
            </div>
            <span class="deck-remaining">⏱ <span class="count" id="game-timer">00:00</span></span>
            <span class="deck-remaining" style="margin-left:12px;">牌堆：<span class="count" id="deck-count">160</span></span>
            <span style="margin-left:12px;">第 <span id="round-label">0</span> 轮 · 第 <span id="round-num">0</span> 回合</span>
          </div>
        </div>
        <div class="battlefield" id="battlefield">
          <div class="seat-top-row" id="top-row"></div>
          <div class="seat-left-col" id="left-col"></div>
          <div class="seat-right-col" id="right-col"></div>
          <div class="seat-self" id="seat-self"></div>
        </div>
        <!-- 动画层 -->
        <div class="anim-layer" id="anim-layer"></div>
        <!-- 底部玩家区域：装备(左) + 手牌(中) + 技能(右) 三列并列 -->
        <div class="player-zone" id="player-zone">
          <div class="play-countdown" id="play-countdown" role="progressbar" aria-label="出牌剩余时间"
               aria-valuemin="0" aria-valuemax="100" style="display:none;">
            <div class="play-countdown-track"><div class="play-countdown-fill" id="play-countdown-fill"></div></div>
            <span class="play-countdown-text" id="play-countdown-text"></span>
          </div>
          <div class="equip-area" id="equip-display"></div>
          <div class="hand-main-area">
            <div class="hand-cards-scroll">
              <div class="hand-cards-row" id="hand-cards"></div>
            </div>
          </div>
          <div class="skill-area" id="skill-area"></div>
        </div>
        <!-- 操作按钮 -->
        <div class="action-bar" id="action-bar" style="display:none;">
          <button class="btn-play-end" id="play-end-btn">取消出牌</button>
        </div>
        <!-- 浮动提示条 -->
        <div class="prompt-bar" id="prompt-bar" style="display:none;"></div>
      </div>
      <!-- 右侧栏：日志 + 旅伴频道 -->
      <div class="game-sidebar" id="game-sidebar">
        <div class="log-panel">
          <h4>对局纪事 <span class="sidebar-caption">BATTLE LOG</span></h4>
          <div class="log-content" id="log-content"></div>
        </div>
        <section class="chat-panel" aria-label="旅伴频道"></section>
      </div>
      <!-- 选将界面 -->
      <div class="hero-select-overlay" id="hero-select" hidden></div>
      <!-- 设置弹窗 -->
      <div class="settings-overlay" id="settings-overlay" style="display:none;">
        <div class="settings-modal">
          <h3>⚙ 游戏设置</h3>
          <div class="settings-body">
            <div class="settings-row">
              <span>背景音乐</span>
              <div class="toggle-switch on" id="settings-bgm-toggle"></div>
            </div>
            <div class="settings-row">
              <span>音量</span>
              <input type="range" min="0" max="100" value="30" class="volume-slider" id="settings-volume" />
              <span id="volume-label">30%</span>
            </div>
            <div class="settings-row">
              <span>角色语音</span>
              <div class="toggle-switch on" id="settings-voice-toggle"></div>
            </div>
            <div class="settings-row">
              <span>语音音量</span>
              <input type="range" min="0" max="100" value="70" class="volume-slider" id="settings-voice-volume" />
              <span id="voice-volume-label">70%</span>
            </div>
            <div class="settings-row">
              <span>AI出牌时间</span>
              <select class="settings-select" id="settings-ai-delay">
                <option value="300">0.3秒（极速）</option>
                <option value="500">0.5秒（高速）</option>
                <option value="800">0.8秒（快速）</option>
                <option value="1200">1.2秒（中等）</option>
                <option value="1600" selected>1.6秒（推荐）</option>
                <option value="2000">2.0秒（慢速）</option>
                <option value="2500">2.5秒（较慢）</option>
                <option value="3000">3.0秒（悠闲）</option>
                <option value="5000">5.0秒（极慢）</option>
              </select>
            </div>
          </div>
          <div style="text-align:center;margin-top:16px;">
            <button class="btn btn-gold" id="settings-close">关闭</button>
          </div>
        </div>
      </div>
    `;
    this.el = container;
    this.cacheElements();
    this.bindSettings();
    return container;
  }

  private cacheElements(): void {
    this.battlefieldEl = this.el.querySelector('#battlefield')!;
    this.phaseEl = this.el.querySelector('#game-phase')!;
    this.deckCountEl = this.el.querySelector('#deck-count')!;
    this.timerEl = this.el.querySelector('#game-timer')!;
    this.roundNumEl = this.el.querySelector('#round-num')!;
    this.roundLabelEl = this.el.querySelector('#round-label')!;
    this.logContentEl = this.el.querySelector('#log-content')!;
    this.handCardsEl = this.el.querySelector('#hand-cards')!;
    this.heroSelectEl = this.el.querySelector('#hero-select')!;
    this.gameMainEl = this.el.querySelector('#game-main-area')!;
    this.promptBarEl = this.el.querySelector('#prompt-bar')!;
    this.equipDisplayEl = this.el.querySelector('#equip-display')!;
    this.skillAreaEl = this.el.querySelector('#skill-area')!;
    this.playEndBtnEl = this.el.querySelector('#play-end-btn')!;
    this.actionBarEl = this.el.querySelector('#action-bar')!;
    this.animLayer = this.el.querySelector('#anim-layer')!;
    // PVP 倒计时条
    this.pvpCountdownBarEl = this.el.querySelector('#pvp-countdown-bar')!;
    this.pvpCountdownFillEl = this.el.querySelector('#pvp-countdown-fill')!;
    this.pvpCountdownTextEl = this.el.querySelector('#pvp-countdown-text')!;
    this.playCountdownBarEl = this.el.querySelector('#play-countdown')!;
    this.playCountdownFillEl = this.el.querySelector('#play-countdown-fill')!;
    this.playCountdownTextEl = this.el.querySelector('#play-countdown-text')!;
  }

  private bindSettings(): void {
    this.el.querySelector('#game-back-btn')!.addEventListener('click', () => {
      if (this.gameStarted && !this.isGameOver) {
        this.showConfirmBack();
      } else {
        this.goBack();
      }
    });
    const settingsOverlay = this.el.querySelector('#settings-overlay')! as HTMLElement;
    this.el.querySelector('#game-settings-btn')!.addEventListener('click', () => {
      // 同步设置面板UI与当前状态
      const bgmToggle = this.el.querySelector('#settings-bgm-toggle')!;
      bgmToggle.classList.toggle('on', this.isBgmOn);
      const volumeSlider = this.el.querySelector('#settings-volume')! as HTMLInputElement;
      volumeSlider.value = String(Math.round(this.bgmVolume * 100));
      const volumeLabel = this.el.querySelector('#volume-label')!;
      volumeLabel.textContent = Math.round(this.bgmVolume * 100) + '%';
      const aiDelaySelect = this.el.querySelector('#settings-ai-delay')! as HTMLSelectElement;
      aiDelaySelect.value = String(globalAiDelayMs);
      const voiceToggle = this.el.querySelector('#settings-voice-toggle')!;
      voiceToggle.classList.toggle('on', VoiceManager.getInstance().isEnabled);
      const voiceVolumeSlider = this.el.querySelector('#settings-voice-volume')! as HTMLInputElement;
      voiceVolumeSlider.value = String(Math.round(VoiceManager.getInstance().getVolume() * 100));
      const voiceVolumeLabel = this.el.querySelector('#voice-volume-label')!;
      voiceVolumeLabel.textContent = Math.round(VoiceManager.getInstance().getVolume() * 100) + '%';
      settingsOverlay.style.display = 'flex';
    });
    this.el.querySelector('#settings-close')!.addEventListener('click', () => {
      settingsOverlay.style.display = 'none';
    });
    settingsOverlay.addEventListener('click', e => {
      if (e.target === settingsOverlay) settingsOverlay.style.display = 'none';
    });
    const bgmToggle = this.el.querySelector('#settings-bgm-toggle')!;
    bgmToggle.addEventListener('click', () => {
      this.isBgmOn = !this.isBgmOn;
      bgmToggle.classList.toggle('on', this.isBgmOn);
      if (this.bgmAudio) this.bgmAudio.muted = !this.isBgmOn;
      cacheSave('bgmEnabled', this.isBgmOn, (d) => socketManager.emit('save_settings', d));
    });
    const volumeSlider = this.el.querySelector('#settings-volume')! as HTMLInputElement;
    const volumeLabel = this.el.querySelector('#volume-label')!;
    volumeSlider.addEventListener('input', () => {
      const vol = parseInt(volumeSlider.value) / 100;
      this.bgmVolume = vol;
      volumeLabel.textContent = Math.round(vol * 100) + '%';
      if (this.bgmAudio) this.bgmAudio.volume = vol;
      cacheSave('bgmVolume', parseInt(volumeSlider.value), (d) => socketManager.emit('save_settings', d));
    });
    // AI出牌时间
    const aiDelaySelect = this.el.querySelector('#settings-ai-delay')! as HTMLSelectElement;
    aiDelaySelect.addEventListener('change', () => {
      globalAiDelayMs = parseInt(aiDelaySelect.value);
      cacheSave('aiDelay', parseInt(aiDelaySelect.value), (d) => socketManager.emit('save_settings', d));
    });
    // 角色语音开关
    const voiceToggle = this.el.querySelector('#settings-voice-toggle')!;
    const voiceMgr = VoiceManager.getInstance();
    voiceToggle.classList.toggle('on', voiceMgr.isEnabled);
    voiceToggle.addEventListener('click', () => {
      const newState = !voiceMgr.isEnabled;
      voiceMgr.setEnabled(newState);
      voiceToggle.classList.toggle('on', newState);
    });
    // 语音音量
    const voiceVolumeSlider = this.el.querySelector('#settings-voice-volume')! as HTMLInputElement;
    const voiceVolumeLabel = this.el.querySelector('#voice-volume-label')!;
    voiceVolumeSlider.value = String(Math.round(voiceMgr.getVolume() * 100));
    voiceVolumeLabel.textContent = Math.round(voiceMgr.getVolume() * 100) + '%';
    voiceVolumeSlider.addEventListener('input', () => {
      const vol = parseInt(voiceVolumeSlider.value) / 100;
      voiceMgr.setVolume(vol);
      voiceVolumeLabel.textContent = Math.round(vol * 100) + '%';
    });
  }

  private showConfirmBack(): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    let msg = this.mode === 'pve'
      ? '确定放弃挑战吗？'
      : '确定退出对局吗？';
    overlay.innerHTML = `
      <div class="game-modal">
        <h3>⚠ 确认离开</h3>
        <p style="text-align:center;color:var(--text-secondary);margin:12px 0;">${msg}</p>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button class="btn btn-ghost" id="confirm-cancel">继续游戏</button>
          <button class="btn btn-red" id="confirm-leave">确认离开</button>
        </div>
      </div>
    `;
    overlay.querySelector('#confirm-cancel')!.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#confirm-leave')!.addEventListener('click', () => {
      overlay.remove();
      this.goBack();
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    this.mountTransient(overlay);
  }

  private goBack(): void {
    this.cleanupGame();
    if (this.mode === 'pve') {
      router.navigate('chapters');
    } else {
      // PVP：断开房间并返回匹配页
      socketManager.emit('leave_room');
      router.navigate('match');
    }
  }

  // ======================== 背景音乐 ========================
  /**
   * BGM系统架构：
   * 1. 选将阶段：播放 0.启动.mp3 （单次）
   * 2. 游戏开始后：循环播放国家"平时"BGM，直到累计≥5分钟
   * 3. 5分钟后：当前曲目播完后，无限循环"战斗"BGM
   */
  private startBGM(): void {
    try {
      // 选将阶段：播放启动音乐
      const startupPath = 'Resources/Musics/0.启动.mp3';
      this.bgmAudio = new Audio(startupPath);
      this.bgmAudio.loop = false; // 启动音乐不循环
      this.bgmAudio.volume = this.bgmVolume;
      this.bgmAudio.muted = !this.isBgmOn;
      this.bgmAudio.play().catch(() => {});
    } catch (e) {}
  }

  /** 设置当前对局背景；背景图本身保持完全不透明。 */
  private applyBattlefieldBackground(path: string): void {
    this.currentBattlefieldBackground = path;
    this.wallpaperCrossEl = this.el.querySelector('#game-bg-cross')! as HTMLElement;
    const bgEl = this.el.querySelector('#game-bg')! as HTMLElement;
    const image = toCssImage(path);
    this.el.style.setProperty('--game-cover-image', image);
    bgEl.style.backgroundImage = image;
    bgEl.style.opacity = '1';
    this.wallpaperCrossEl.style.backgroundImage = image;
    this.wallpaperCrossEl.style.opacity = '0';
  }

  /** 初始化一个不重复随机图池；首张立即显示，之后由对局计时器每分钟切换。 */
  private startWallpaperCycle(backgrounds: readonly string[]): void {
    this.wallpaperCandidates = [...backgrounds];
    this.wallpaperPool = [...backgrounds];
    this.wallpaperLastMinute = 0;
    const first = this.takeRandomWallpaper();
    if (first) this.applyBattlefieldBackground(first);
  }

  private takeRandomWallpaper(): string | null {
    if (this.wallpaperPool.length === 0) {
      this.wallpaperPool = [...this.wallpaperCandidates];
    }
    if (this.wallpaperPool.length === 0) return null;
    const index = Math.floor(Math.random() * this.wallpaperPool.length);
    return this.wallpaperPool.splice(index, 1)[0];
  }

  /** 每分钟从当前模式图池切换一张；一轮内不会重复。 */
  private tickWallpaper(): void {
    if (this.wallpaperCandidates.length === 0) return;
    const minute = Math.floor(this.timerSeconds / 60);
    if (minute === this.wallpaperLastMinute) return;
    this.wallpaperLastMinute = minute;

    const next = this.takeRandomWallpaper();
    if (!next) return;
    const image = toCssImage(next);
    const bgEl = this.el.querySelector('#game-bg')! as HTMLElement;
    const crossEl = this.wallpaperCrossEl;

    // 新图覆盖式淡入，底图始终保持不透明，避免切换过程中露出白底。
    crossEl.style.backgroundImage = image;
    crossEl.getBoundingClientRect();
    crossEl.style.opacity = '1';
    this.session.setTimeout(() => {
      this.currentBattlefieldBackground = next;
      this.el.style.setProperty('--game-cover-image', image);
      bgEl.style.backgroundImage = image;
      bgEl.style.opacity = '1';
      crossEl.style.opacity = '0';
    }, 1200);
  }

  /** 根据主公地区切换BGM；背景图池由游戏模式独立决定。 */
  private switchBGMForMonarch(monarchRegion?: string): void {
    // PVE模式：使用主将(Ally)的地区；PVP模式：使用主公的地区
    const anchor = this.players.find(p => (p as any).faction === 'Ally')
      || this.players.find(p => p.role === RoleType.Monarch)
      || this.players[0];
    if (!anchor) return;
    // PVP 优先采用 game_start 中由服务端明确下发的主公地区。
    const region = monarchRegion || anchor.region;

    if (!this.currentBattlefieldBackground) {
      const backgrounds = this.mode === 'pvp'
        ? PVP_BACKGROUNDS
        : getPVEBattleBackgrounds(region);
      this.startWallpaperCycle(backgrounds);
    }

    // 获取该国家的平时和战斗BGM路径
    const { peacetime, battle } = this.getBgmForRegion(region);
    this.bgmBattlePath = battle;

    // 停止启动BGM，开始播放平时BGM（不循环，手动管理）
    if (this.bgmAudio) {
      this.bgmAudio.pause();
      this.bgmAudio = null;
    }

    this.playPeacetimeBGM(peacetime, Date.now());
  }

  /** 播放平时BGM，5分钟后切换战斗BGM */
  private playPeacetimeBGM(path: string, startTime: number): void {
    try {
      if (this.bgmAudio) {
        this.bgmAudio.pause();
        this.bgmAudio = null;
      }
      this.bgmAudio = new Audio(path);
      this.bgmAudio.loop = false;
      this.bgmAudio.volume = this.bgmVolume;
      this.bgmAudio.muted = !this.isBgmOn;
      
      this.bgmAudio.addEventListener('ended', () => {
        const elapsed = Date.now() - startTime;
        if (elapsed < 5 * 60 * 1000) {
          // 未满5分钟，再放一遍
          this.playPeacetimeBGM(path, startTime);
        } else {
          // 已满5分钟，切换战斗BGM
          this.startBattleBGM();
        }
      }, { once: true });
      
      this.bgmAudio.play().catch(() => {});
    } catch (e) {}
  }

  /** 开始无限循环战斗BGM */
  private startBattleBGM(): void {
    try {
      if (!this.bgmBattlePath) return;
      if (this.bgmAudio) {
        this.bgmAudio.pause();
        this.bgmAudio = null;
      }
      this.bgmAudio = new Audio(this.bgmBattlePath);
      this.bgmAudio.loop = true;
      this.bgmAudio.volume = this.bgmVolume;
      this.bgmAudio.muted = !this.isBgmOn;
      this.bgmAudio.play().catch(() => {});
    } catch (e) {}
  }

  /** 获取国家对应的平时和战斗BGM路径 */
  private getBgmForRegion(region: string): { peacetime: string; battle: string } {
    const bgmMap: Record<string, { peacetime: string; battle: string }> = {
      '蒙德': {
        peacetime: 'Resources/Musics/1.平时.蒙德.3\'47\'\'.让风告诉你.mp3',
        battle: 'Resources/Musics/1.战斗.蒙德.3\'15\'\'.光辉的涨落.mp3',
      },
      '璃月': {
        peacetime: 'Resources/Musics/2.平时.璃月.4\'34\'\'.Liyue.mp3',
        battle: 'Resources/Musics/2.战斗.璃月.4\'18\'\'.疾如猛火.mp3',
      },
      '稻妻': {
        peacetime: 'Resources/Musics/3.平时.稻妻.5\'28\'\'.寂远无妄之国.mp3',
        battle: 'Resources/Musics/3.战斗.稻妻.4\'18\'\'.斩雾破竹.mp3',
      },
      '须弥': {
        peacetime: 'Resources/Musics/4.平时.须弥.1\'47\'\'.喧繁之港.mp3',
        battle: 'Resources/Musics/4.战斗.须弥.4\'07\'\'.狮尾之舞.mp3',
      },
      '枫丹': {
        peacetime: 'Resources/Musics/5.平时.枫丹.2\'46\'\'.柔灯港.mp3',
        battle: 'Resources/Musics/5.战斗.枫丹.2\'32\'\'.轻涟.mp3',
      },
      '纳塔': {
        peacetime: 'Resources/Musics/6.平时.纳塔.5\'10\'\'.回声之子.mp3',
        battle: 'Resources/Musics/6.战斗.纳塔.3\'45\'\'.炽火之舞.mp3',
      },
      '挪德卡莱': {
        peacetime: 'Resources/Musics/7.平时.挪德卡莱.2\'43\'\'.如生之不竭.mp3',
        battle: 'Resources/Musics/7.战斗.挪德卡莱.3\'14\'\'.永夜与破晓的誓刃.mp3',
      },
    };
    return bgmMap[region] || bgmMap['蒙德'];
  }

  private stopBGM(): void {
    if (this.bgmAudio) { this.bgmAudio.pause(); this.bgmAudio = null; }
    if (this.bgmSwitchTimer) { clearTimeout(this.bgmSwitchTimer); this.bgmSwitchTimer = null; }
  }

  // ======================== 页面生命周期 ========================
  onEnter(state: RouteState): void {
    // 先清理上一局残留状态（防止旧 PVP 监听器泄露到新对局）
    this.cleanupGame();
    this.session = new GameSession();
    this.battlePresentation = new BattlePresentation(this.gameMainEl, this.battlefieldEl, this.session,
      playerId => {
        const player = this.players.find(p => p.id === playerId);
        if (!player) return undefined;
        const hero = getHeroById(player.heroId);
        return { name: player.name, imageSrc: `Resources/Characters/${player.name}.png`, element: hero?.element };
      },
      playerId => this.getSeatElement(playerId) as HTMLElement | null);
    this.mode = (state.params?.mode as 'pve' | 'pvp') || 'pve';
    this.el.dataset.mode = this.mode;
    // 注意：不要在此 emit leave_room —— onEnter 是进入新游戏，不是离开

    this.roomId = (state.params?.roomId as string) || '';
    this.chatPanel = new ChatPanel(this.el.querySelector('.chat-panel')!, this.roomId, this.mode === 'pvp' && !!this.roomId);
    this.chapterId = (state.params?.chapterId as string) || '';
    this.levelId = (state.params?.levelId as number) || 0;
    this.isGameOver = false;
    this.gameStarted = false;
    this.logEntries = [];
    this.logContentEl.replaceChildren();
    this.heroesPicked = [];
    this.humanHeroPicked = null;
    this.aiMonarchHero = null;

    // PVE闯关模式：加载关卡数据
    this.pveLevel = null;
    this.pvePickedHeroes = [];
    this.pvePickIndex = 0;
    if (this.mode === 'pve' && this.levelId > 0) {
      this.pveLevel = getLevelById(this.levelId) || null;
      if (!this.pveLevel) {
        console.error(`[PVE] 未找到关卡 ID=${this.levelId}`);
        router.navigate('chapters');
        return;
      }
    }

    this.el.querySelector('#top-row')!.innerHTML = '';
    this.el.querySelector('#left-col')!.innerHTML = '';
    this.el.querySelector('#right-col')!.innerHTML = '';
    this.el.querySelector('#seat-self')!.innerHTML = '';
    this.handCardsEl.innerHTML = '';
    this.heroSelectEl.hidden = true;

    const bgEl = this.el.querySelector('#game-bg')! as HTMLElement;
    bgEl.style.backgroundImage = '';
    const crossEl = this.el.querySelector('#game-bg-cross')! as HTMLElement;
    crossEl.style.backgroundImage = '';
    crossEl.style.opacity = '0';

    this.currentBattlefieldBackground = '';
    if (this.mode === 'pvp') {
      this.startWallpaperCycle(PVP_BACKGROUNDS);
    } else {
      const chapter = getChapterForLevel(this.levelId);
      this.startWallpaperCycle(getPVEBattleBackgrounds(chapter?.region || '蒙德'));
    }

    this.startBGM();

    if (this.mode === 'pvp' && this.roomId) {
      // PVP 联机模式：由服务器驱动游戏
      this.showPVPHeroSelect(state);
    } else {
      // PVE 本地模式：客户端驱动游戏
      this.showPVEHeroSelect();
    }
  }

  // ======================== PVP 联机模式（服务器驱动） ========================

  /** PVP 选将入口：根据 WaitingPage 传递的路由参数决定选将流程 */
  private showPVPHeroSelect(state: RouteState): void {
    const params = state.params || {};
    const isMonarch = params.isMonarch === true;
    const heroCandidates = (params.heroCandidates as string[] | undefined) || [];
    const monarchHero = params.monarchHero as { heroId?: string; heroName?: string } | undefined;
    const timeoutSec = Number(params.timeoutSec) || 30;
    this.pvpOnline = true;

    this.initPVPOnline();
    this.heroSelectEl.hidden = false;

    if (params.isWaitingForMonarch !== true) {
      this.renderPVPCandidateUI(heroCandidates, monarchHero, isMonarch, timeoutSec);
      return;
    }

    const monarchPlayer = (params.monarchPlayerName as string) || '主公';
    this.renderPVPSelectionStatus('等待主公选将', `${monarchPlayer}选定后，你将收到候选武将。`);
    const stopMonarchPreview = socketManager.on('hero_select_monarch_picked', data => {
      const name = data.heroName || '主公';
      this.renderPVPSelectionStatus('主公已选将', `已选 ${name}，正在分配你的候选武将。`);
    });
    const stopCandidateWait = socketManager.on('hero_select_start', data => {
      if (data.isMonarch || this.gameStarted) return;
      stopMonarchPreview();
      stopCandidateWait();
      this.renderPVPCandidateUI(data.candidates || [], data.monarchHero || monarchHero, false, data.timeoutSec || timeoutSec);
    });
    this.pvpUnsubs.push(stopMonarchPreview, stopCandidateWait);
  }

  private pvpHeroSelectTimer: ReturnType<typeof setInterval> | null = null;

  private stopPVPHeroSelectTimer(): void {
    if (!this.pvpHeroSelectTimer) return;
    clearInterval(this.pvpHeroSelectTimer);
    this.pvpHeroSelectTimer = null;
  }

  private renderPVPSelectionStatus(title: string, description: string, hero?: HeroData): void {
    this.heroSelectEl.innerHTML = `
      <section class="hero-select-panel pvp-hero-select pvp-selection-status" aria-live="polite">
        ${hero ? `<img class="pvp-selection-portrait" src="Resources/Characters/${escapeSeatText(hero.name)}.png" alt="" onerror="this.hidden=true">` : ''}
        <h2 tabindex="-1">${escapeSeatText(title)}</h2>
        <p>${escapeSeatText(description)}</p>
      </section>
    `;
    if (hero) this.heroSelectEl.querySelector<HTMLElement>('h2')?.focus();
  }

  private renderPVPCandidateUI(
    candidateIds: string[],
    monarchData: { heroId?: string; heroName?: string } | undefined,
    isMonarch: boolean,
    timeoutSec: number,
  ): void {
    this.stopPVPHeroSelectTimer();
    const candidates = candidateIds.map(getHeroById).filter((hero): hero is HeroData => hero !== undefined);
    if (candidates.length === 0) {
      this.renderPVPSelectionStatus('等待候选武将', '候选武将由房间分配。');
      return;
    }
    const monarch = monarchData?.heroId ? getHeroById(monarchData.heroId) : undefined;
    const monarchName = monarch?.name || monarchData?.heroName;
    const showGroups = isMonarch && candidates.length === 6;
    const groups = showGroups
      ? [{ label: '七神', heroes: candidates.filter(hero => hero.isGod) },
         { label: '其他武将', heroes: candidates.filter(hero => !hero.isGod) }]
      : [{ label: '候选武将', heroes: candidates }];
    this.heroSelectEl.innerHTML = `
      <section class="hero-select-panel pvp-hero-select ${showGroups ? 'pvp-hero-select-wide' : ''}" aria-labelledby="pvp-selection-title">
        <header class="pvp-selection-header">
          <div class="pvp-selection-heading">
            <h2 id="pvp-selection-title" tabindex="-1">${isMonarch ? '主公选将' : '选择武将'}</h2>
            <p>选择一名武将，超时后自动选将。</p>
          </div>
          <div class="pvp-selection-deadline" aria-label="选将倒计时" role="timer">
            <span id="pvp-hero-select-timer">${timeoutSec} 秒</span>
            <progress max="100" value="100" aria-hidden="true"></progress>
          </div>
        </header>
        ${!isMonarch && monarchName ? `
          <div class="pvp-monarch-reference">
            ${monarch ? `<img src="Resources/Characters/${escapeSeatText(monarch.name)}.png" alt="" onerror="this.hidden=true">` : ''}
            <div><span>主公已选</span><strong>${escapeSeatText(monarchName)}</strong></div>
          </div>
        ` : ''}
        <div class="pvp-selection-groups">
          ${groups.map(group => `<section class="pvp-selection-group" aria-label="${group.label}">
            ${showGroups ? `<h3>${group.label}</h3>` : ''}
            <div class="hero-cards-row"></div>
          </section>`).join('')}
        </div>
      </section>
    `;

    let submitted = false;
    const selectHero = (hero: HeroData, automatic = false) => {
      if (submitted || this.gameStarted || !this.session.active) return;
      submitted = true;
      this.stopPVPHeroSelectTimer();
      this.renderPVPSelectionStatus(
        automatic ? `已自动选择 ${hero.name}` : `已选择 ${hero.name}`,
        '等待其他玩家完成选将。',
        hero,
      );
      socketManager.emit(isMonarch ? 'select_monarch_hero' : 'select_hero', { heroId: hero.id });
    };
    const rows = this.heroSelectEl.querySelectorAll('.hero-cards-row');
    groups.forEach((group, index) => {
      for (const hero of group.heroes) {
        const button = this.createHeroCard(hero, 'button');
        button.addEventListener('click', () => selectHero(hero));
        rows[index].appendChild(button);
      }
    });
    this.heroSelectEl.scrollTop = 0;
    this.heroSelectEl.querySelector<HTMLElement>('#pvp-selection-title')?.focus({ preventScroll: true });

    const heroClock = new GameClock();
    heroClock.start(timeoutSec * 1000);
    const timer = this.heroSelectEl.querySelector<HTMLElement>('#pvp-hero-select-timer')!;
    const progress = this.heroSelectEl.querySelector<HTMLProgressElement>('progress')!;
    const updateClock = () => {
      const remaining = heroClock.remainingSeconds;
      timer.textContent = `${remaining} 秒`;
      timer.parentElement?.classList.toggle('is-urgent', remaining <= 10);
      progress.value = heroClock.percent;
      if (remaining === 0) selectHero(candidates[0], true);
    };
    this.pvpHeroSelectTimer = this.session.setInterval(updateClock, 250);
    updateClock();
  }

  /** 初始化PVP联机模式的Socket.IO事件监听 */
  private initPVPOnline(): void {
    console.log('[DEBUG:select] initPVPOnline: 注册game_start/prompt等handler');
    const connection = this.el.querySelector<HTMLElement>('#pvp-board-connection')!;
    const showConnection = (text: string, state: 'online' | 'offline' | 'returned') => {
      connection.textContent = text;
      connection.dataset.state = state;
    };
    showConnection(socketManager.isConnected ? '联机中' : '连接中断', socketManager.isConnected ? 'online' : 'offline');
    this.pvpUnsubs.push(socketManager.on('game_start', (data: any) => {
      showConnection('联机中', 'online');
      console.log('[DEBUG:select] ★★★ game_start 收到！data:', JSON.stringify(data).substring(0, 200));
      this.handlePVPGameStart(data);
    }));
    this.pvpUnsubs.push(socketManager.on('game_event', (data: any) => this.handlePVPGameEvent(data)));
    this.pvpUnsubs.push(socketManager.on('prompt', (data: any) => this.handlePVPPrompt(data)));
    this.pvpUnsubs.push(socketManager.on('prompt_closed', (data: any) => this.closePVPInteraction(data.requestId)));
    this.pvpUnsubs.push(socketManager.on('__disconnected', () => {
      showConnection('连接中断', 'offline');
      this.closePVPInteraction(this.pvpRequestId);
      this.showPrompt('连接已断开，正在重新连接服务器…');
    }));
    this.pvpUnsubs.push(socketManager.on('__reconnected', () => {
      showConnection('连接已恢复', 'returned');
      this.showPrompt('连接已恢复；若原对局由 AI 接替，请返回房间列表重新进入。');
    }));
    this.pvpUnsubs.push(socketManager.on('game_over', (data: any) => this.handlePVPGameOver(data)));
  }

  /** PVP 游戏开始：初始化玩家数据和UI */
  private handlePVPGameStart(data: any): void {
    this.stopPVPHeroSelectTimer();
    this.closeSeatRolePicker();
    this.seatRoleMarks.clear();
    this.pvpMyPlayerId = data.yourPlayerId;
    this.humanPlayerIdx = data.yourPlayerId; // 复用 humanPlayerIdx 用于渲染一致性
    this.gameStarted = true;

    // 将服务器的玩家数据映射为本地 PlayerState
    this.players = data.players.map((p: any) => this.mapServerPlayerToLocal(p));

    // 创建 HumanWebUIDriver（PVP 模式下仅用于UI交互，不驱动本地游戏循环）
    this.humanDriver = new HumanWebUIDriver(this.pvpMyPlayerId, this);

    // PVP 也初始化本地 deck/eventBus/damageSystem，使 SkillManager.executeActiveSkill 可用
    // （与 PVE initGameCore 一致，但不创建 GameFlowController）
    this.eventBus = new EventBus();
    this.deck = new DeckManager(this.eventBus);
    this.deck.init(CARD_DATA);
    const driversMap = new Map<number, IPlayerDriver>();
    driversMap.set(this.pvpMyPlayerId, this.humanDriver as any as IPlayerDriver);
    const damageSystem = new DamageSystem(this.deck, this.eventBus, driversMap, this.players);
    this.skillManager = new SkillManager(this.deck, this.eventBus, damageSystem, driversMap, this.players);

    // 隐藏选将界面
    this.heroSelectEl.hidden = true;

    // PVP 背景使用独立的 pvp1-10 图池，BGM 仍根据主公地区选择。
    this.switchBGMForMonarch(data.monarchRegion as string | undefined);

    // 启动计时器（PVP模式也需要）
    this.startTimer();

    // 初始化牌堆数量（从服务端数据中获取）
    if (data.drawPileCount !== undefined) {
      this.deckCountEl.textContent = String(data.drawPileCount);
    }

    // 注册技能语音动画监听（PVP 也需要）
    this.setupVoiceAnimationListener();

    // 设置技能点击回调（PVP模式，与initGameCore中PVE的一致）
    this.onSkillClick = async (skillId: string) => {
      const me = this.players[this.humanPlayerIdx];
      if (!me || !this.skillManager) return;
      if (skillId === 'nilou_water_moon') { this.highlightNilouConvertCards(me, 'red'); return; }
      if (skillId === 'nilou_water_ring') { this.highlightNilouConvertCards(me, 'black'); return; }
      const ctx = {
        players: this.players,
        roundCount: 0,
        currentTurn: 0,
        currentPlayerId: me.id,
        gameOverWinner: null,
        drawPileCount: this.deck?.drawPileCount || 0,
        discardPileCount: this.deck?.discardPile?.length || 0,
      };
      const success = await this.executeUISkill(me, skillId, ctx);
      if (success) {
        this.renderBattlefield();
        this.renderHandCards();
        this.renderSkills();
        this.highlightPlayableCards(me, ctx);
      }
    };

    // 渲染初始战场
    this.renderBattlefield();
    this.renderHandCards();
    this.addLog('游戏开始！PVP 联机模式');
  }

  /** 将服务器发来的玩家数据映射为本地 PlayerState 格式 */
  private mapServerPlayerToLocal(p: any): PlayerState {
    // 保留服务端注入的全部技能标记字段
    const extraMarks: any = {};
    for (const key of [
      '_jadeCount', '_musouCount', '_emptyMoonCount', '_frostMoonCount',
      '_hasFireworkMark', '_sealedSuits', '_contractPartnerId',
      '_leaderActive', '_leaderDamageTaken', '_butterflyActive',
      '_nilouStance', '_mapleLeaves', '_knowledgeCards',
      '_mercenaryActive', '_mercenaryTargetId', '_iceFeatherCount', '_nautilusCount',
      '_frostMoonOwner', 'frostMoonPartnerId'
    ]) {
      if (p[key] !== undefined) extraMarks[key] = p[key];
    }
    return {
      id: p.id,
      playerName: p.playerName || `玩家${p.id + 1}`,
      heroId: p.heroId,
      name: p.name || p.heroId,
      region: p.region || '',
      gender: p.gender === 'male' ? GenderType.Male : p.gender === 'female' ? GenderType.Female : GenderType.None,
      role: p.role === 'Unknown' ? RoleType.None : (p.role as RoleType),
      maxHp: p.maxHp || 4,
      hp: p.hp ?? p.maxHp ?? 4,
      handCards: (p.handCards || []).map((c: any) => this.mapServerCardToLocal(c)),
      attachedCardCount: p.attachedCardCount ?? 0,
      equipZone: {
        [EquipmentType.None]: null,
        [EquipmentType.Weapon]: p.equipZone?.Weapon ? this.mapServerCardToLocal(p.equipZone.Weapon) : null,
        [EquipmentType.Armor]: p.equipZone?.Armor ? this.mapServerCardToLocal(p.equipZone.Armor) : null,
        [EquipmentType.OffensiveHorse]: p.equipZone?.OffensiveHorse ? this.mapServerCardToLocal(p.equipZone.OffensiveHorse) : null,
        [EquipmentType.DefensiveHorse]: p.equipZone?.DefensiveHorse ? this.mapServerCardToLocal(p.equipZone.DefensiveHorse) : null,
      },
      judgeZone: (p.judgeZone || []).map((c: any) => this.mapServerCardToLocal(c)),
      isFlipped: p.isFlipped || false,
      isChained: p.isChained || false,
      isDead: p.isDead || false,
      skipDrawPhase: p.skipDrawPhase || false,
      skipPlayPhase: p.skipPlayPhase || false,
      skipDiscardPhase: p.skipDiscardPhase || false,
      wineUsedThisTurn: p.wineUsedThisTurn || false,
      slashUsedCount: p.slashUsedCount || 0,
      nextSlashDamageBonus: p.nextSlashDamageBonus || 0,
      ...extraMarks,
    } as any;
  }

  /** 将服务器发来的 Card 数据映射为本地 Card 格式 */
  private mapServerCardToLocal(c: any): Card {
    return {
      id: c.id ?? 0,
      name: c.name || '',
      suit: c.suit || 'None',
      number: c.number ?? 0,
      type: c.type || '',
      description: c.description || '',
      cardSource: null, // 服务器已脱敏，无 cardSource
    } as Card;
  }

  private showTurnPhase(phase: string, playerId = this.currentTurnPlayerId): void {
    const heroName = this.players.find(player => player.id === playerId)?.name;
    const phaseName = TURN_PHASE_LABELS[phase as GamePhase] || phase;
    this.phaseEl.textContent = heroName ? `${heroName}：${phaseName}` : phaseName;
    this.phaseEl.dataset.phase = phase;
  }

  /** PVP 游戏事件处理：与 PVE 的 registerUIEventListeners 对齐，
   *  正确分发各事件类型：Log 用中文消息、UI 更新、动画等。 */
  private handlePVPGameEvent(data: any): void {
    if (this.isGameOver) return;
    const eventType = data.type || data.eventType || '';
    const eventData = data.data || {};

    // 跳过 Prompt 类内部事件（由 handlePVPPrompt 独立处理）
    if (eventType.startsWith('Prompt')) return;

    // 更新玩家数据（任何事件都可能携带最新的 players 快照）
    if (data.data?.players) {
      this.players = data.data.players.map((p: any) => this.mapServerPlayerToLocal(p));
    }

    // 更新牌堆数量（PVP 模式下从服务端事件中获取）
    if (data.data?.drawPileCount !== undefined) {
      this.deckCountEl.textContent = String(data.data.drawPileCount);
    }

    // 按事件类型分发 UI 处理（与 PVE registerUIEventListeners 对齐）
    switch (eventType) {
      case 'Log': {
        // 服务端 GameEvent.Log 事件自带中文 message，直接展示
        const msg = eventData.message as string;
        if (msg) this.addLog(msg);
        this.refreshSeatAttachedCounts();
        break;
      }
      case 'TurnStarted': {
        this.stopPVPCountdown(); // 新回合计清除残留读条
        this.roundLabelEl.textContent = String(eventData.round || 0);
        this.roundNumEl.textContent = String(eventData.turn || 0);
        if (eventData.playerId !== undefined) {
          this.currentTurnPlayerId = eventData.playerId as number;
        }
        this.showTurnPhase(GamePhase.Prepare);
        this.renderBattlefield();
        break;
      }
      case 'PhaseChanged': {
        this.stopPVPCountdown(); // 阶段切换清除残留读条
        this.showTurnPhase(String(eventData.phase), eventData.playerId);
        this.renderBattlefield();
        break;
      }
      case 'TurnEnded': {
        this.showTurnPhase(GamePhase.End, eventData.playerId);
        this.renderBattlefield();
        this.renderHandCards();
        break;
      }
      case 'CardPlayed': {
        this.renderBattlefield();
        this.renderHandCards();
        this.presentBattleCard('play', eventData);
        break;
      }
      case 'CardDrawn': {
        this.renderBattlefield();
        this.renderHandCards();
        // 摸牌动画
        const drawPid = eventData.playerId as number;
        const drawCount = eventData.count as number;
        if (drawPid !== undefined && drawCount > 0) {
          this.animateDraw(drawPid, drawCount);
        }
        break;
      }
      case 'CardDiscarded': {
        this.renderBattlefield();
        this.renderHandCards();
        this.presentBattleCard('discard', eventData);
        break;
      }
      case 'CardResponded': {
        this.renderBattlefield();
        this.renderHandCards();
        this.presentBattleCard('response', eventData);
        break;
      }
      case 'CardRevealed': {
        const revealPid = eventData.playerId as number;
        const revealCardName = eventData.cardName as string;
        const revealCard = eventData.card as any;
        if (revealPid !== undefined && revealCardName) {
          this.animateRevealCard(revealPid, revealCardName, revealCard?.suit, revealCard?.number);
        }
        break;
      }
      case 'CardStolen': {
        const stealSource = eventData.sourceId as number;
        const stealTarget = eventData.targetId as number;
        const stealCardName = eventData.cardName as string;
        if (stealSource !== undefined && stealTarget !== undefined && stealCardName) {
          this.animateCardStolen(stealSource, stealTarget, stealCardName);
        }
        break;
      }
      case 'CardDismantled': {
        this.presentBattleCard('discard', eventData);
        break;
      }
      case 'JudgeResult': {
        // PVP判定牌动画
        const jCardName = eventData.cardName as string;
        const jSuit = eventData.suit as string || '';
        const jNumber = eventData.number as number || 0;
        const jTriggered = eventData.triggered as boolean;
        const jIdx = (eventData.judgeIndex as number) || 0;
        if (jCardName) {
          this.animateJudge(jCardName, jSuit, jNumber, jTriggered, jIdx);
        }
        this.renderBattlefield();
        break;
      }
      case 'CardMovedToJudge': {
        this.releasePlayedCard(eventData);
        this.renderBattlefield();
        break;
      }
      case 'CardEquipped': {
        this.releasePlayedCard(eventData);
        this.renderBattlefield();
        this.renderHandCards();
        break;
      }
      case 'CardsDealtToTable': {
        // 五谷丰登：展示牌桌上的牌
        const cards = eventData.cards as Card[];
        const allPlayerNames = (eventData.allPlayerNames as string[]) || [];
        if (cards && cards.length > 0) {
          this.initGraceWindow(cards, allPlayerNames);
        }
        break;
      }
      case 'GraceCardPicked': {
        const cardId = eventData.cardId as number;
        const pickerName = eventData.pickerName as string;
        if (cardId > 0 && pickerName) {
          this.onGraceCardPicked(cardId, pickerName);
        }
        break;
      }
      case 'GraceCompleted': {
        // 延迟关闭，让玩家看到最后的结果
        this.completeGraceTable();
        break;
      }
      case 'HpChanged': {
        this.renderBattlefield();
        this.showHpFeedback(eventData);
        break;
      }
      case 'PlayerDying':
      case 'PlayerDied':
      case 'PlayerRescued':
      case 'ChainedStateChanged':
      case 'PhaseSkipped': {
        this.renderBattlefield();
        break;
      }
      case 'CardTargeted': {
        // 攻击连线动画
        const sourceId = eventData.sourceId as number;
        const targetId = eventData.targetId as number;
        if (sourceId !== undefined && targetId !== undefined) {
          this.showTargetBeamBetween(sourceId, targetId);
        }
        break;
      }
      case 'RolesAssigned': {
        // 身份分配完毕（已有 Log 事件输出中文消息，此处仅刷新 UI）
        this.renderBattlefield();
        break;
      }
      case 'SkillVoicePlay': {
        // PVP 语音：服务端广播的技能语音事件，本地播放
        const vHeroId = eventData.heroId as string;
        const vSkillName = eventData.skillName as string;
        const vPlayerId = eventData.playerId as number | undefined;
        if (vHeroId && vSkillName) {
          VoiceManager.getInstance().playSkillVoice(vHeroId, vSkillName, vPlayerId);
        }
        break;
      }
      case 'CardVoicePlay': {
        // PVP 出牌语音：服务端广播的出牌语音事件，本地播放
        const cvGender = eventData.gender as string;
        const cvCardName = eventData.cardName as string;
        if (cvCardName) {
          VoiceManager.getInstance().playCardVoice(cvGender, cvCardName);
        }
        break;
      }
      case 'GameOver': {
        this.finishBattle();
        break;
      }
      default: {
        // 兜底：如果有 message 则显示，否则跳过
        const msg = eventData.message as string;
        if (msg) this.addLog(msg);
        this.renderBattlefield();
        this.renderHandCards();
        break;
      }
    }
  }

  // ======================== PVP 操作读条倒计时 ========================

  /** 需要显示倒计时的 PVP prompt 类型 */
  private static readonly PVP_COUNTDOWN_PROMPT_TYPES = new Set([
    'playCard', 'discard', 'target', 'response', 'nullify',
    'showCard', 'yesNo', 'chooseSuit', 'zone', 'ransackHand', 'discardMulti', 'selectCard',
    'amazingGrace', 'zhanba', 'armorTrigger', 'weaponEffect', 'ironChainMode', 'genderWeapon',
  ]);

  /** Preserve the server request deadline when a driver also asks to display its timer. */
  public startPVPCountdown(durationSec = 15, promptType = ''): void {
    if (this.mode === 'pvp' && this.pvpRequestId && this.countdownClock.running) return;
    this.stopPVPCountdown();
    this.countdownClock.start(Math.max(0, durationSec) * 1000);
    const isPlay = promptType === 'playCard';
    this.pvpCountdownBarEl.style.display = isPlay ? 'none' : 'block';
    this.playCountdownBarEl.style.display = isPlay ? 'block' : 'none';
    const fill = isPlay ? this.playCountdownFillEl : this.pvpCountdownFillEl;
    const text = isPlay ? this.playCountdownTextEl : this.pvpCountdownTextEl;
    const update = () => {
      const percent = this.countdownClock.percent;
      const label = `${isPlay ? '出牌' : '操作'}剩余 ${this.countdownClock.remainingSeconds} 秒`;
      fill.style.width = percent + '%';
      text.textContent = label;
      fill.classList.toggle('safe', percent > 50);
      fill.classList.toggle('warning', percent > 25 && percent <= 50);
      if (isPlay) {
        this.playCountdownBarEl.setAttribute('aria-valuenow', String(Math.round(percent)));
        this.playCountdownBarEl.setAttribute('aria-valuetext', label);
      }
      if (!this.countdownClock.remainingMs && this.pvpCountdownTimer) {
        clearInterval(this.pvpCountdownTimer);
        this.pvpCountdownTimer = null;
      }
    };
    update();
    if (this.countdownClock.remainingMs) this.pvpCountdownTimer = this.session.setInterval(update, 100);
  }

  public getInteractionTimeoutMs(fallbackMs: number): number {
    return this.mode === 'pvp' && this.pvpRequestId && this.countdownClock.running
      ? this.countdownClock.remainingMs : fallbackMs;
  }

  public stopPVPCountdown(): void {
    if (this.pvpCountdownTimer) clearInterval(this.pvpCountdownTimer);
    this.pvpCountdownTimer = null;
    this.countdownClock.stop();
    this.pvpCountdownBarEl.style.display = 'none';
    this.playCountdownBarEl.style.display = 'none';
  }

  private closePVPInteraction(requestId: string | null): void {
    if (!requestId || requestId !== this.pvpRequestId) return;
    this.closeBattleInteraction();
  }

  private closeBattleInteraction(): void {
    this.pvpRequestId = null;
    this.humanDriver?.cancelInteraction();
    this.closeTableInteraction();
    this.stopPVPCountdown();
    this.clearHighlights();
    this.hidePrompt();
    this.hideResponseButtons();
    this.hideNullifyPassButton();
    this.graceResolve = null;
    this.isGraceHumanTurn = false;
    this.graceOverlay?.classList.remove('is-picking');
    for (const element of this.transientElements) {
      if (element.classList.contains('game-modal-overlay')) { element.remove(); this.transientElements.delete(element); }
    }
  }

  /** PVP Prompt 处理：接收服务器prompt，调用 HumanWebUIDriver 展示UI，通过socket回应 */
  private async handlePVPPrompt(promptData: any): Promise<void> {
    const session = this.session;
    if (!session.active || this.isGameOver || !this.humanDriver) return;
    const { requestId, type, data } = promptData;
    this.closeSeatRolePicker();
    this.closePVPInteraction(this.pvpRequestId);
    this.pvpRequestId = requestId;

    // 设置 PVP 回应回调：点击 → socket.respond → 清空回调 → 停止倒计时
    this.humanDriver.setPVPRespond((result: any) => {
      if (!session.active || this.pvpRequestId !== requestId) return;
      this.stopPVPCountdown();
      let serverResult = result;
      if (type === 'response' && result && typeof result === 'object' && result.name) {
        // 发送 { id, name, suit, number } 让服务器通过 id 匹配手牌中的对应 Card
        serverResult = { id: result.id, name: result.name, suit: result.suit, number: result.number };
      }
      socketManager.respond(requestId, serverResult);
      this.humanDriver.setPVPRespond(null);
      this.pvpRequestId = null;
    });

    // 更新自己的玩家数据（prompt 带有最新的 state）
    if (data.state) {
      const myIdx = this.players.findIndex(p => p.id === this.pvpMyPlayerId);
      if (myIdx >= 0) {
        this.players[myIdx] = this.mapServerPlayerToLocal({
          ...data.state,
          attachedCardCount: this.players[myIdx].attachedCardCount,
        });
      }
      // 重新渲染手牌，确保 DOM 与最新 state 同步（击杀反贼摸3牌等场景）
      this.renderHandCards();
    }

    // 根据类型调用 HumanWebUIDriver 的对应方法
    try {
      if (GamePage.PVP_COUNTDOWN_PROMPT_TYPES.has(type)) this.startPVPCountdown(promptData.timeoutSec || 10, type);
      switch (type) {
        case 'playCard':
          await this.humanDriver.promptPlayCard(data.state, data.ctx);
          break;
        case 'target':
          await this.humanDriver.promptTarget(
            data.state || this.players[this.pvpMyPlayerId],
            data.validTargets || [],
            data.reason || '选择目标',
            data.ctx
          );
          break;
        case 'response':
          await this.humanDriver.promptResponse(data.state, data.cardName, data.ctx);
          break;
        case 'zone':
          await this.humanDriver.promptZone(data.state, data.targetId, data.ctx);
          break;
        case 'zhanba':
          await this.humanDriver.promptZhanBa(data.state, data.ctx);
          break;
        case 'discard':
          await this.humanDriver.promptDiscard(data.state, data.ctx);
          break;
        case 'nullify':
          await this.humanDriver.promptNullification(data.state, data.ctx);
          break;
        case 'armorTrigger':
          await this.humanDriver.promptArmorTrigger(data.state, data.armorName, data.ctx);
          break;
        case 'weaponEffect':
          await this.humanDriver.promptWeaponEffect(data.state, data.weaponName, data.ctx);
          break;
        case 'ironChainMode':
          await this.humanDriver.promptIronChainMode(data.state, data.ctx);
          break;
        case 'amazingGrace':
          await this.humanDriver.promptAmazingGrace(data.state, data.tableCards || [], data.ctx);
          break;
        case 'showCard':
          await this.humanDriver.promptShowCard(data.state, data.ctx);
          break;
        case 'genderWeapon':
          await this.humanDriver.promptGenderWeapon(data.state, data.attackerName, data.ctx);
          break;
        case 'yesNo':
          await this.humanDriver.promptYesNo(data.question || '是否确认？');
          break;
        case 'chooseSuit':
          await this.humanDriver.promptSuit(data.cardNumber, data.totalCards);
          break;
        case 'ransackHand':
          await this.humanDriver.promptRansackHand(data.state, data.targetId, data.ctx);
          break;
        case 'discardMulti':
          await this.humanDriver.promptDiscardMulti(data.state, data.count, data.ctx);
          break;
        case 'selectCard':
          // filter 无法序列化，客户端无法验证；服务端 RemotePlayerDriver 会自行校验
          await this.humanDriver.promptSelectCard(data.state, data.title || '选择一张牌', undefined, data.ctx);
          break;
        default:
          console.warn(`[PVP] 未处理的 prompt 类型: ${type}`);
          socketManager.respond(requestId, null);
          this.humanDriver.setPVPRespond(null);
          this.pvpRequestId = null;
      }
    } catch (err) {
      if (!session.active || err instanceof GameSessionCancelled || this.pvpRequestId !== requestId) return;
      console.error(`[PVP] prompt 处理错误:`, err);
      socketManager.respond(requestId, null);
      this.humanDriver.setPVPRespond(null);
      this.pvpRequestId = null;
    }
  }

  private finishBattle(): void {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.phaseEl.textContent = '游戏结束';
    delete this.phaseEl.dataset.phase;
    this.currentTurnPlayerId = -1;
    this.stopTimer();
    this.stopBGM();
    this.chatPanel?.finish();
    this.closeBattleInteraction();
    this.closeSeatRolePicker();
    this.clearGraceCards();
    this.renderBattlefield();
    this.renderHandCards();
    this.renderSkills();
  }

  /** PVP 游戏结束：显示结算界面 */
  private handlePVPGameOver(data: any): void {
    this.finishBattle();
    // 游戏结束，身份全部公开：用服务端发来的真实身份更新本地 players
    if (data.playerRoles) {
      for (const p of this.players) {
        const realRole = data.playerRoles[p.id];
        if (realRole && p.role !== realRole) {
          (p as any).role = realRole;
        }
      }
    }
    this.renderBattlefield();

    const winner = data.error ? 'aborted' : data.winner || '未知';
    const expData = {
      killStats: data.killStats,
      expByPlayerId: data.expByPlayerId,
      escapedPlayerIds: data.escapedPlayerIds,
      settlementPending: data.settlementPending === true,
    };

    // 同步本地账号经验值（服务端已通过 addExpByAccountId 写库）
    if (data.expByPlayerId) {
      const myExp = data.expByPlayerId[this.pvpMyPlayerId];
      if (myExp && myExp.totalExp > 0 && socketManager.account) {
        socketManager.setAccount({
          ...socketManager.account,
          exp: myExp.totalExp,
          level: myExp.newLevel || socketManager.account.level,
        });
      }
    }

    this.session.setTimeout(() => this.showResultModal(winner, expData), 500);

    // 清理 PVP 监听
    this.cleanupPVPListeners();
  }

  /** 清理 PVP Socket 监听 */
  private cleanupPVPListeners(): void {
    for (const unsub of this.pvpUnsubs) unsub();
    this.pvpUnsubs = [];
    this.humanDriver?.setPVPRespond(null);
    this.pvpRequestId = null;
    this.stopPVPCountdown();
  }

  /** PVE闯关模式选将：支持动态人数+逐人选将+禁选池 */
  private showPVEHeroSelect(): void {
    const level = this.pveLevel;
    if (!level) { this.addLog('错误：未加载关卡数据'); return; }
    this.pvePickedHeroes = [];
    this.pvePickIndex = 0;
    this.heroSelectEl.hidden = false;
    this.showPVEPickStep();
  }

  /** PVE选将步骤 */
  private showPVEPickStep(): void {
    const level = this.pveLevel!;
    const isMain = this.pvePickIndex === 0;
    const stepLabel = isMain ? '主将' : `副将${this.pvePickIndex}`;
    const pool = getCandidatePool(level, this.pvePickedHeroes);
    const pickedInfo = this.pvePickedHeroes.map((hid, i) => {
      const h = getHeroById(hid); return h ? `<span style="color:gold;">${i===0?'👑':'⚔️'}${h.name}</span>` : hid;
    }).join('、') || '无';
    const candidates = pool.map(id => getHeroById(id)).filter(Boolean) as HeroData[];
    this.heroSelectEl.innerHTML = `<div class="hero-select-panel">
      <h2>⚔️ ${level.name}</h2>
      <p style="text-align:center;color:var(--text-secondary);">选择${stepLabel} · 我方${level.allyCount}人 vs 敌方${level.enemyCount}人</p>
      <p style="text-align:center;color:var(--accent-green);font-size:13px;">已选：${pickedInfo}</p>
      <p style="text-align:center;color:#ff9800;font-size:12px;">禁选：${level.bannedHeroes.map(id=>getHeroById(id)?.name||id).join('、')}</p>
      <div class="hero-select-subtitle">${isMain?'选择主将':`选择副将${this.pvePickIndex}（${this.pvePickIndex+1}/${level.allyCount}）`}</div>
      <div class="hero-cards-row" id="pve-candidates"></div>
      <div class="hero-select-hint">点击武将卡牌进行选择（共${candidates.length}位可选）</div></div>`;
    const container = this.heroSelectEl.querySelector('#pve-candidates')!;
    for (const hero of candidates) {
      const card = this.createHeroCard(hero);
      card.addEventListener('click', () => {
        this.pvePickedHeroes.push(hero.id); this.pvePickIndex++;
        if (this.pvePickIndex >= level.allyCount) this.finishPVEHeroSelect();
        else this.showPVEPickStep();
      });
      container.appendChild(card);
    }
  }

  /** PVE选将完成 */
  private finishPVEHeroSelect(): void {
    const level = this.pveLevel!;
    const allyHeroIds = this.pvePickedHeroes;
    const enemyHeroIds = level.enemyHeroes;
    this.humanPlayerIdx = 0;
    const players: PlayerState[] = [];
    let pid = 0;
    for (let i = 0; i < allyHeroIds.length; i++) {
      const h = getHeroById(allyHeroIds[i])!;
      players.push(this.makePVEPlayer(pid++, h, i===0?'你':`副将${i}`, Faction.Ally));
    }
    for (let i = 0; i < enemyHeroIds.length; i++) {
      const h = getHeroById(enemyHeroIds[i])!;
      players.push(this.makePVEPlayer(pid++, h, h.name, Faction.Enemy));
    }
    this.players = players;
    this.heroesPicked = players.map(p => getHeroById(p.heroId)!);
    this.heroSelectEl.hidden = true;

    // PVE：入口使用新地区封面，对局内仍按章节地区轮换旧版编号背景。
    const chapter = getChapterForLevel(this.levelId);
    if (chapter) {
      this.startWallpaperCycle(getPVEBattleBackgrounds(chapter.region));
      const { peacetime, battle } = this.getBgmForRegion(chapter.region);
      this.bgmBattlePath = battle;
      if (this.bgmAudio) { this.bgmAudio.pause(); this.bgmAudio = null; }
      this.playPeacetimeBGM(peacetime, Date.now());
    }

    this.initGameCore();
    this.renderBattlefield();
    this.startGame();
  }

  /** 创建PVE玩家 */
  private makePVEPlayer(id: number, hero: HeroData, playerName: string, faction: Faction): PlayerState {
    return { id, playerName, heroId: hero.id, name: hero.name, region: hero.region, gender: hero.gender==='male'?GenderType.Male:GenderType.Female, role: RoleType.None, faction, maxHp: hero.maxHp, hp: hero.maxHp, handCards: [], equipZone: { [EquipmentType.None]: null, [EquipmentType.Weapon]: null, [EquipmentType.Armor]: null, [EquipmentType.OffensiveHorse]: null, [EquipmentType.DefensiveHorse]: null } as Record<EquipmentType, Card | null>, judgeZone: [], isFlipped: false, isChained: false, isDead: false, skipDrawPhase: false, skipPlayPhase: false, skipDiscardPhase: false, slashUsedCount: 0, nextSlashDamageBonus: 0, wineUsedThisTurn: false };
  }

  private createHeroCard(hero: HeroData, element: 'div' | 'button' = 'div'): HTMLElement {
    const card = document.createElement(element);
    card.className = 'hero-card';
    if (element === 'button') card.setAttribute('type', 'button');
    const block = element === 'button' ? 'span' : 'div';
    const genderIcon = hero.gender === 'male' ? '♂' : '♀';
    const godBadge = hero.isGod ? '<span class="hero-god-badge">神</span>' : '';
    const imgSrc = `Resources/Characters/${hero.name}.png`;
    card.innerHTML = `
      <${block} class="hero-card-img"><img src="${imgSrc}" alt="" onerror="this.parentElement.textContent='${hero.name.charAt(0)}'"></${block}>
      <${block} class="hero-card-name">${hero.name}${godBadge}</${block}>
      <${block} class="hero-card-title">${hero.title}</${block}>
      <${block} class="hero-card-region">${hero.region} · ${hero.element} · ${genderIcon}</${block}>
      <${block} class="hero-card-hp">❤️ ${hero.maxHp}血</${block}>
    `;
    return card;
  }

  private onHumanHeroPicked(): void {
    if (!this.humanHeroPicked) return;

    // PVE/PVP 统一逻辑：人类选完后，为7个AI分配武将
    // 关键：非主公场景下，主公位置必须使用 aiMonarchHero（页面已展示给玩家）
    const monarchIdx = this.preAssignedRoles
      ? this.preAssignedRoles.findIndex(r => r === RoleType.Monarch)
      : -1;
    const humanIsMonarch = this.humanPlayerIdx === monarchIdx;

    // 排除人类选的武将和主公选的武将（若不同）
    const excludedIds = new Set<string>([this.humanHeroPicked!.id]);
    if (!humanIsMonarch && this.aiMonarchHero) {
      excludedIds.add(this.aiMonarchHero.id);
    }
    const remaining = ALL_HEROES.filter(h => !excludedIds.has(h.id));
    const shuffledRemaining = [...remaining].sort(() => Math.random() - 0.5);

    // 构建8人阵容：主公位置用 aiMonarchHero，人类位置用 humanHeroPicked，其余从池中随机
    const lineup: HeroData[] = [];
    let cursor = 0;
    for (let i = 0; i < 8; i++) {
      if (i === this.humanPlayerIdx) {
        lineup.push(this.humanHeroPicked!);
      } else if (i === monarchIdx && !humanIsMonarch && this.aiMonarchHero) {
        lineup.push(this.aiMonarchHero);
      } else {
        // 从池中随机选3候选再随机取1
        const pool = shuffledRemaining.slice(cursor, cursor + 3);
        cursor += 3;
        if (pool.length === 0) {
          const fallback = shuffledRemaining.find(h => !lineup.includes(h) && !excludedIds.has(h.id));
          lineup.push(fallback || shuffledRemaining[cursor % shuffledRemaining.length]);
        } else {
          lineup.push(pool[Math.floor(Math.random() * pool.length)]);
        }
      }
    }

    this.heroesPicked = lineup;
    this.aiMonarchHero = null; // 已使用，清空

    this.heroSelectEl.hidden = true;
    this.initGameAfterHeroSelect();
  }

  // ======================== 初始化游戏核心 ========================
  private initGameAfterHeroSelect(): void {
    // 如果预分配了身份（showPVEHeroSelect 中设置），则直接使用；否则由 GameFlowController.assignRoles 分配
    const usePreAssigned = this.preAssignedRoles !== null;
    this.players = this.heroesPicked.map((hero, i) => {
      const isHuman = i === this.humanPlayerIdx;
      const playerName = isHuman ? '你' : `玩家${i + 1}`;
      const gender = hero.gender === 'male' ? GenderType.Male : GenderType.Female;
      let role = RoleType.None;
      let maxHp = hero.maxHp;
      if (usePreAssigned && i < this.preAssignedRoles!.length) {
        role = this.preAssignedRoles![i];
        // 主公体力上限+1 由 assignRoles 统一处理，此处不再重复
      }
      return {
        id: i, playerName, heroId: hero.id, name: hero.name, region: hero.region, gender,
        role, maxHp, hp: maxHp,
        handCards: [], equipZone: {
          [EquipmentType.None]: null,
          [EquipmentType.Weapon]: null,
          [EquipmentType.Armor]: null,
          [EquipmentType.OffensiveHorse]: null,
          [EquipmentType.DefensiveHorse]: null,
        },
        judgeZone: [], isFlipped: false, isChained: false, isDead: false,
        skipDrawPhase: false, skipPlayPhase: false, skipDiscardPhase: false,
        wineUsedThisTurn: false, slashUsedCount: 0, nextSlashDamageBonus: 0,
      } as PlayerState;
    });
    this.initGameCore();
    this.renderBattlefield();
    this.addLog(`游戏准备中... 模式：${this.mode === 'pve' ? 'PVE闯关' : 'PVP对战'}`);
    this.addLog('卡牌加载完毕：160张（三国杀标准牌堆）');
    this.addLog('8位武将就位，身份即将分配...');
    // 选将完成后自动启动游戏（不再依赖 main.ts 的 setTimeout，避免竞态条件）
    this.startGame();
  }

  private initGameCore(): void {
    this.eventBus = new EventBus();
    this.deck = new DeckManager(this.eventBus);
    this.deck.init(CARD_DATA);

    const humanPlayerId = this.players[this.humanPlayerIdx].id;
    this.humanDriver = new HumanWebUIDriver(humanPlayerId, this);
    const drivers = new Map<number, IPlayerDriver>();
    for (const p of this.players) {
      if (p.id === humanPlayerId) {
        drivers.set(p.id, this.humanDriver as any as IPlayerDriver);
      } else {
        drivers.set(p.id, new DelayedAIDriver(p.id, () => globalAiDelayMs, this.session) as any as IPlayerDriver);
      }
    }

    // 注意：EquipEffectManager 构造函数签名: (deck, eventBus, damageSystem, drivers, allPlayers)
    // 必须先创建 damageSystem 再传给 equipManager
    const damageSystem = new DamageSystem(this.deck, this.eventBus, drivers, this.players);
    const equipManager = new EquipEffectManager(this.deck, this.eventBus, damageSystem, drivers, this.players);
    const cardEffectManager = new CardEffectManager(
      this.deck, this.eventBus, damageSystem, equipManager, drivers, this.players
    );

    // 铁索连环传导：DamageSystem造成属性伤害后触发传导
    damageSystem.onTransmitChain = (target, damage, sourceCard, source) =>
      cardEffectManager.transmitChainedDamage(target, damage, sourceCard, source, false);
    // 娜维娅-刺玫：受到的伤害恒为1
    damageSystem.naviaRoseHandler = (target, damageRef) => {
      const oldVal = damageRef.value;
      this.skillManager.naviaRoseDamageLimit(damageRef);
      if (damageRef.value < oldVal) {
        this.eventBus.emit(GameEvent.Log, { message: `【刺玫】${target.name} 受到的伤害恒为1！` });
      }
    };
    damageSystem.equipBeforeDamageHandler = (target, damage, sourceCard) => {
      equipManager.handleArmorBeforeDamage(target, damage, sourceCard);
    };
    damageSystem.equipOnResponseHandler = (target, cardName, sourceCard, source) => {
      return equipManager.handleArmorOnResponse(target, cardName, sourceCard, source);
    };
    damageSystem.shouldIgnoreArmorHandler = (source) => {
      return equipManager.shouldIgnoreArmor(source);
    };
    damageSystem.zhanBaHandler = (player) => {
      return equipManager.tryZhanBaTransform(player);
    };

    this.flowController = new GameFlowController(
      this.players, this.deck, this.eventBus,
      cardEffectManager, damageSystem, equipManager, drivers, this.session
    );

    // 创建技能管理器
    this.skillManager = new SkillManager(
      this.deck, this.eventBus, damageSystem, drivers, this.players
    );

    // 注入 SkillManager 到各子系统
    damageSystem.skillManager = this.skillManager as any;
    cardEffectManager.skillManager = this.skillManager as any;
    this.skillManager.cardEffectManager = cardEffectManager as any;
    if (this.flowController) {
      this.flowController.skillManager = this.skillManager as any;
    }

    // 注册技能动画监听
    this.setupVoiceAnimationListener();

    // 设置技能点击回调
    this.onSkillClick = async (skillId: string) => {
      const me = this.players[this.humanPlayerIdx];
      if (!me || !this.skillManager) return;

      // 妮露-水月：点击后高亮红色手牌当杀使用
      if (skillId === 'nilou_water_moon') {
        this.highlightNilouConvertCards(me, 'red');
        return;
      }
      // 妮露-水环：点击后高亮黑色手牌当闪使用
      if (skillId === 'nilou_water_ring') {
        this.highlightNilouConvertCards(me, 'black');
        return;
      }
      // 玛薇卡-圣火：高亮普通杀让用户选择转化
      if (skillId === 'mavuika_holyFire') {
        this.highlightHolyFireCards(me);
        return;
      }
      // 丈八蛇矛：点击后触发合成虚拟杀流程
      if (skillId === 'equip_zhanba') {
        this.clearHighlights();
        this.humanDriver.resolvePlayCard(-2);
        this.hidePrompt();
        return;
      }
      // 纳西妲-比喻：弹窗选择非延时锦囊牌
      if (skillId === 'nahida_metaphor') {
        const magicCards = me.handCards.filter(c => c.type === 'Magic');
        if (magicCards.length === 0) return;
        this.showMetaphorPrompt(async (cardName) => {
          const ctx2 = {
            players: this.players,
            roundCount: this.flowController?.roundCount || 0,
            currentTurn: this.flowController?.currentTurnInRound || 0,
            currentPlayerId: me.id,
            gameOverWinner: null,
            drawPileCount: this.deck?.drawPileCount || 0,
            discardPileCount: this.deck?.discardPile?.length || 0,
            metaphorCardName: cardName ?? undefined,
          };
          const success = await this.executeUISkill(me, 'nahida_metaphor', ctx2);
          if (success) {
            this.renderBattlefield();
            this.renderHandCards();
            this.renderSkills();
            this.highlightPlayableCards(me, ctx2);
          }
        });
        return;
      }

      const ctx = {
        players: this.players,
        roundCount: this.flowController?.roundCount || 0,
        currentTurn: this.flowController?.currentTurnInRound || 0,
        currentPlayerId: me.id,
        gameOverWinner: null,
        drawPileCount: this.deck?.drawPileCount || 0,
        discardPileCount: this.deck?.discardPile?.length || 0,
      };
      const success = await this.executeUISkill(me, skillId, ctx);
      if (success) {
        this.renderBattlefield();
        this.renderHandCards();
        this.renderSkills();
        // 重新高亮手牌，恢复出牌能力（修复点击技能后无法出牌的bug）
        this.highlightPlayableCards(me, ctx);
      }
    };

    // 事件监听（UI 层，PVE/PVP 共用）
    this.registerUIEventListeners();
  }

  /** 注册 EventBus 事件监听器（UI 渲染 & 动画，PVE/PVP 共用路径） */
  private registerUIEventListeners(): void {
    const session = this.session;
    this.eventBus.on(GameEvent.Log, (e) => {
      this.refreshSeatAttachedCounts();
      // 支持 visibleTo 过滤：仅指定的玩家可见（凝光天权等技能播报）
      const visibleTo = e.data.visibleTo as number[] | undefined;
      if (visibleTo) {
        const selfId = this.getHumanPlayer()?.id;
        if (selfId === undefined || !visibleTo.includes(selfId)) return;
      }
      this.addLog(e.data.message as string);
    });
    this.eventBus.on(GameEvent.TurnStarted, (e) => {
      this.roundLabelEl.textContent = String(e.data.round || 0);
      this.roundNumEl.textContent = String(e.data.turn || 0);
      this.currentTurnPlayerId = (e.data.playerId as number | undefined) ?? this.players[this.humanPlayerIdx].id;
      this.showTurnPhase(GamePhase.Prepare);
      this.renderBattlefield();
      // 第一个回合开始时，根据主公地区切换BGM（仅PVP，PVE在finishPVEHeroSelect按章节设置）
      if (e.data.turn === 1 && e.data.round === 1 && !this.pveLevel) {
        this.switchBGMForMonarch();
      }
      // 【技能钩子】回合开始
      const playerId = e.data.playerId as number;
      if (playerId !== undefined && this.skillManager) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
          this.skillManager.resetTurnFlags(playerId);
        }
      }
    });
    this.eventBus.on(GameEvent.TurnEnded, (e) => {
      this.showTurnPhase(GamePhase.End, e.data.playerId as number);
    });
    this.eventBus.on(GameEvent.PhaseChanged, (e) => {
      this.showTurnPhase(String(e.data.phase), e.data.playerId as number | undefined);
      // PVE 模式下 deck 存在时更新计数
      if (this.deck) this.deckCountEl.textContent = String(this.deck.drawPileCount);
      // 弃牌阶段结束时的视觉反馈
      if (e.data.phase === 'End') {
        this.phaseEl.classList.add('phase-flash');
        this.session.setTimeout(() => this.phaseEl.classList.remove('phase-flash'), 600);
      }
      this.renderBattlefield();
    });
    this.eventBus.on(GameEvent.HpChanged, e => {
      this.renderBattlefield();
      this.showHpFeedback(e.data);
    });
    this.eventBus.on(GameEvent.CardPlayed, (e) => {
      this.renderBattlefield();
      this.renderHandCards();
      this.presentBattleCard('play', e.data);
    });
    this.eventBus.on(GameEvent.CardDrawn, (e) => {
      if (this.deck) this.deckCountEl.textContent = String(this.deck.drawPileCount);
      this.renderBattlefield();
      this.renderHandCards();
      // 摸牌动画：所有玩家都有
      const playerId = e.data.playerId as number;
      const count = e.data.count as number;
      if (count > 0) {
        this.animateDraw(playerId, count);
      }
    });
    this.eventBus.on(GameEvent.CardDiscarded, (e) => {
      if (this.deck) this.deckCountEl.textContent = String(this.deck.drawPileCount);
      this.renderBattlefield();
      this.renderHandCards();
      this.presentBattleCard('discard', e.data);
    });

    // 火攻展示牌动画
    this.eventBus.on(GameEvent.CardRevealed, (e) => {
      const playerId = e.data.playerId as number;
      const cardName = e.data.cardName as string;
      const card = e.data.card as Card | undefined;
      if (playerId !== undefined && cardName) {
        this.animateRevealCard(playerId, cardName, card?.suit, card?.number);
      }
    });
    this.eventBus.on(GameEvent.CardResponded, (e) => {
      this.renderBattlefield();
      this.renderHandCards();
      this.presentBattleCard('response', e.data);
    });
    this.eventBus.on(GameEvent.CardTargeted, (e) => {
      const sourceId = e.data.sourceId as number;
      const targetId = e.data.targetId as number;
      if (sourceId !== undefined && targetId !== undefined) {
        this.showTargetBeamBetween(sourceId, targetId);
      }
    });
    // 顺手牵羊飞入动画：被顺走的牌从目标座位飞向来源座位
    this.eventBus.on(GameEvent.CardStolen, (e) => {
      const sourceId = e.data.sourceId as number;
      const targetId = e.data.targetId as number;
      const cardName = e.data.cardName as string;
      if (sourceId !== undefined && targetId !== undefined && cardName) {
        this.animateCardStolen(sourceId, targetId, cardName);
      }
    });
    // Use the owner-bearing event to enrich the preceding anonymous deck discard.
    this.eventBus.on(GameEvent.CardDismantled, (e) => {
      this.presentBattleCard('discard', e.data);
    });
    this.eventBus.on(GameEvent.CardEquipped, (e) => {
      this.releasePlayedCard(e.data); this.renderBattlefield(); this.renderHandCards();
    });
    this.eventBus.on(GameEvent.CardMovedToJudge, (e) => {
      this.releasePlayedCard(e.data); this.renderBattlefield();
    });
    this.eventBus.on(GameEvent.ChainedStateChanged, () => this.renderBattlefield());
    this.eventBus.on(GameEvent.PlayerDied, () => this.renderBattlefield());
    this.eventBus.on(GameEvent.PlayerRescued, () => this.renderBattlefield());

    this.eventBus.on(GameEvent.GameOver, (e) => {
      this.finishBattle();
      const winner = e.data.winner as string;

      // PVE 闯关：先计算星级（在异步exp上传之前，否则return会跳过）
      if (this.pveLevel && winner === '友方阵营') {
        this.computeAndSavePVEStars();
      }

      if (this.flowController) {
        const expData = this.computeLocalPVPExp(winner);
        // PVE 模式：本地保存经验并更新 account，确保 HomePage 实时读取
        if (this.pveLevel) {
          const me = this.getHumanPlayer();
          if (me) {
            const myExp = expData.expByPlayerId[me.id];
            if (myExp && myExp.totalExp > 0) {
              this.applyLocalExpFallback(myExp);
            }
          }
          this.session.setTimeout(() => this.showResultModal(winner, expData), 500);
        } else {
          const me = this.getHumanPlayer();
          if (me) {
            const myExp = expData.expByPlayerId[me.id];
            if (myExp && myExp.totalExp > 0) {
              if (socketManager.isConnected) {
                socketManager.emitWithAck('add_exp', { totalExp: myExp.totalExp }).then((ack: any) => {
                  if (!session.active) return;
                  if (ack?.success) { myExp.oldLevel = ack.oldLevel; myExp.newLevel = ack.newLevel; myExp.leveledUp = ack.leveledUp; }
                  else { this.applyLocalExpFallback(myExp); }
                  this.session.setTimeout(() => this.showResultModal(winner, expData), 500);
                }).catch(() => { if (!session.active) return; this.applyLocalExpFallback(myExp); this.session.setTimeout(() => this.showResultModal(winner, expData), 500); });
                return;
              } else { this.applyLocalExpFallback(myExp); }
            }
          }
          this.session.setTimeout(() => this.showResultModal(winner, expData), 500);
        }
      } else {
        this.session.setTimeout(() => this.showResultModal(winner), 500);
      }
    });

    this.eventBus.on(GameEvent.PhaseSkipped, (e) => {
      this.addLog(`${e.data.playerId}: 跳过${e.data.phase}`);
    });
    this.eventBus.on(GameEvent.WeaponEffect, (e) => {
      this.addLog(`⚔️ 发动武器效果: ${e.data.name}`);
    });
    this.eventBus.on(GameEvent.ArmorEffect, (e) => {
      this.addLog(`🛡️ 发动防具效果: ${e.data.name}`);
    });
    this.eventBus.on(GameEvent.JudgeResult, (e) => {
      const cardName = e.data.cardName as string;
      const triggered = e.data.triggered as boolean;
      const suit = e.data.suit as string || '';
      const number = e.data.number as number || 0;
      const idx = (e.data.judgeIndex as number) || 0;
      if (cardName) {
        this.animateJudge(cardName, suit, number, triggered, idx);
      }
    });

    // 五谷丰登事件
    this.eventBus.on(GameEvent.CardsDealtToTable, (e) => {
      const cards = e.data.cards as Card[];
      const allPlayerNames = (e.data.allPlayerNames as string[]) || [];
      if (cards && cards.length > 0) {
        this.initGraceWindow(cards, allPlayerNames);
      }
    });
    this.eventBus.on(GameEvent.GraceCardPicked, (e) => {
      const cardId = e.data.cardId as number;
      const pickerName = e.data.pickerName as string;
      if (cardId > 0 && pickerName) {
        this.onGraceCardPicked(cardId, pickerName);
      }
    });
    this.eventBus.on(GameEvent.GraceCompleted, () => {
      // 延迟关闭，让玩家看到最后的结果
      this.completeGraceTable();
    });
  }

  async startGame(): Promise<void> {
    const session = this.session;
    if (this.gameStarted) return;
    this.gameStarted = true;
    this.addLog('========== 游戏开始 ==========');
    this.startTimer();
    if (!this.flowController) {
      this.addLog('错误：游戏控制器未初始化');
      return;
    }
    this.deckCountEl.textContent = String(this.deck.drawPileCount);
    let turnOrder: number[] | undefined;
    if (this.pveLevel?.turnOrder) {
      turnOrder = this.pveLevel.turnOrder.map(slot => {
        if (slot === 'main') return this.players[0]?.id;
        if (slot.startsWith('ally')) { const idx = parseInt(slot.replace('ally', ''), 10); return this.players[idx]?.id; }
        const ep = this.players.find(p => p.heroId === slot); return ep?.id;
      }).filter((id): id is number => id !== undefined && !isNaN(id));
    }
    this.flowController.startGame(this.players[this.humanPlayerIdx].id, turnOrder).then(() => {
      if (!session.active) return;
      this.addLog('游戏循环已结束。');
      this.stopTimer();
    }).catch((err) => {
      if (!session.active || err instanceof GameSessionCancelled) return;
      console.error('游戏循环异常:', err);
      this.addLog(`游戏异常终止: ${err?.message || err}`);
      this.stopTimer();
    });
  }

  // ======================== 计时器 ========================

  private startTimer(): void {
    this.stopTimer();
    this.elapsedClock.start();
    this.timerSeconds = 0;
    this.updateTimerDisplay();
    this.timerInterval = this.session.setInterval(() => {
      this.timerSeconds = this.elapsedClock.elapsedSeconds;
      this.updateTimerDisplay();
      this.tickWallpaper();
    }, 250);
  }

  private stopTimer(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = null;
    if (this.elapsedClock.running) {
      this.timerSeconds = this.elapsedClock.elapsedSeconds;
      this.elapsedClock.stop();
      this.updateTimerDisplay();
    }
  }

  private updateTimerDisplay(): void {
    const mins = Math.floor(this.timerSeconds / 60);
    const secs = this.timerSeconds % 60;
    this.timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // ======================== 动画系统 ========================
  /** 摸牌动画：从中央飞入对应玩家位置（暗牌-背面） */
  private animateDraw(playerId: number, count: number): void {
    if (playerId === this.selfId) {
      // 人类玩家：暗牌飞入手牌区（显示卡背）
      for (let i = 0; i < Math.min(count, 5); i++) {
        const card = document.createElement('div');
        card.className = 'anim-card flying-in card-back-anim';
        card.style.left = '50%';
        card.style.top = '25%';
        card.style.transform = 'translate(-50%, -50%)';
        card.style.animationDelay = `${i * 0.15}s`;
        this.animLayer.appendChild(card);
        this.session.setTimeout(() => card.remove(), ANIM_DURATION + i * 150 + 300);
      }
    } else {
      // 其他玩家：在座位处显示暗牌弹出
      this.animateOtherDraw(playerId, count);
    }
  }

  /** 其他玩家摸牌动画（暗牌-背面） */
  private animateOtherDraw(playerId: number, count: number): void {
    const seatEl = this.el.querySelector(`.seat-card[data-player-id="${playerId}"]`);
    if (!seatEl) return;
    for (let i = 0; i < Math.min(count, 5); i++) {
      const card = document.createElement('div');
      card.className = 'anim-card-back';
      card.style.animationDelay = `${i * 0.1}s`;
      seatEl.appendChild(card);
      this.session.setTimeout(() => card.remove(), 900 + i * 200);
    }
  }

  /** Route both modes through one bounded public-action display. */
  private releasePlayedCard(data: Record<string, any>): void {
    // Equipment and delayed tricks stay in play. Their eventual discard is a new action.
    if (data.card && !data.card.isVirtual) this._playedCardIds.delete(data.card.id);
  }

  /** Route both modes through one bounded public-action display. */
  private presentBattleCard(kind: BattleActionKind, data: Record<string, any>): void {
    if (!this.session.active) return;
    const card = data.card as Card | undefined;
    const id = card && !card.isVirtual ? card.id : undefined;
    if (kind === 'discard' && id !== undefined && this._playedCardIds.delete(id)) return;
    if (kind === 'discard' && data.cause === 'equipment-replaced') return;
    if (kind !== 'discard' && id !== undefined) {
      const pending = this.pendingDiscardAnimations.get(id);
      if (pending !== undefined) {
        clearTimeout(pending);
        this.pendingDiscardAnimations.delete(id);
      } else this._playedCardIds.add(id);
    }
    const show = () => {
      const cardName = (kind === 'response' ? data.cardName : undefined) || card?.name || data.cardName;
      if (!cardName) return;
      const faceName = card?.name || cardName;
      this.battlePresentation?.card({ kind, playerId: data.playerId ?? -1, cardName,
        imageSrc: 'Resources/Cards/' + (CARD_FILE_NAME_MAP[faceName] || faceName) + '.png',
        suit: data.suit || card?.suit, number: data.number ?? card?.number });
    };
    // Response effects may discard a physical card just before announcing its response.
    if (kind === 'discard' && id !== undefined) {
      const previous = this.pendingDiscardAnimations.get(id);
      if (previous !== undefined) clearTimeout(previous);
      this.pendingDiscardAnimations.set(id, this.session.setTimeout(() => {
        this.pendingDiscardAnimations.delete(id);
        show();
      }, 100));
    } else show();
  }

  /** 火攻展示牌动画：在目标座位上方展示明牌（带花色点数） */
  private animateRevealCard(playerId: number, cardName: string, suit?: string, number?: number): void {
    let seatEl: Element | null;
    if (playerId === this.selfId) {
      seatEl = this.el.querySelector('#seat-self .seat-card');
    } else {
      seatEl = this.el.querySelector(`.seat-card[data-player-id="${playerId}"]`);
    }
    if (!seatEl) return;

    const rect = seatEl.getBoundingClientRect();
    const seatCX = rect.left + rect.width / 2;
    const seatCY = rect.top + rect.height / 2;

    const fileName = CARD_FILE_NAME_MAP[cardName] || cardName;
    const imgSrc = `Resources/Cards/${fileName}.png`;
    const suitSym = SUIT_SYMBOL[suit || ''] || '';
    const numText = NUMBER_TEXT[number || 0] || String(number || '');
    const suitColor = SUIT_COLOR[suit || ''] || '#888';

    const card = document.createElement('div');
    card.className = 'anim-card reveal-card';
    card.style.left = `${seatCX}px`;
    card.style.top = `${seatCY}px`;
    card.style.position = 'fixed';
    card.style.zIndex = '250';
    card.innerHTML = `<img src="${imgSrc}" alt="${cardName}"
      onerror="this.parentElement.textContent='${cardName.substring(0,2)}'"
      style="width:100%;height:100%;object-fit:cover;border-radius:4px;">
      <div class="anim-card-suit-info">
        <span style="color:${suitColor}">${suitSym}</span><span style="color:${suitColor}">${numText}</span>
      </div>`;
    this.mountTransient(card);
    this.session.setTimeout(() => card.remove(), 2000);
  }

  /** 顺手牵羊动画：牌从目标座位飞入自己手牌区 */
  private animateCardStolen(sourceId: number, targetId: number, cardName: string): void {
    // 起始位置：目标（被顺的玩家）座位
    let targetSeatEl: Element | null;
    if (targetId === this.selfId) {
      targetSeatEl = this.el.querySelector('#seat-self .seat-card');
    } else {
      targetSeatEl = this.el.querySelector(`.seat-card[data-player-id="${targetId}"]`);
    }
    if (!targetSeatEl) return;

    // 终点位置：来源（顺牌的那方）座位
    let sourceSeatEl: Element | null;
    if (sourceId === this.selfId) {
      sourceSeatEl = this.el.querySelector('#seat-self .seat-card');
    } else {
      sourceSeatEl = this.el.querySelector(`.seat-card[data-player-id="${sourceId}"]`);
    }
    if (!sourceSeatEl) return;

    const targetRect = targetSeatEl.getBoundingClientRect();
    const targetCX = targetRect.left + targetRect.width / 2;
    const targetCY = targetRect.top + targetRect.height / 2;

    const sourceRect = sourceSeatEl.getBoundingClientRect();
    const sourceCX = sourceRect.left + sourceRect.width / 2;
    const sourceCY = sourceRect.top + sourceRect.height / 2;

    const fileName = CARD_FILE_NAME_MAP[cardName] || cardName;
    const imgSrc = `Resources/Cards/${fileName}.png`;

    const card = document.createElement('div');
    card.className = 'anim-card flying-stolen';
    card.style.left = `${targetCX}px`;
    card.style.top = `${targetCY}px`;
    card.style.position = 'fixed';
    card.style.zIndex = '300';
    card.style.setProperty('--to-x', `${sourceCX}px`);
    card.style.setProperty('--to-y', `${sourceCY}px`);
    card.innerHTML = `<img src="${imgSrc}" alt="${cardName}"
      onerror="this.parentElement.textContent='${cardName.substring(0,2)}'"
      style="width:100%;height:100%;object-fit:cover;border-radius:4px;">
      <div class="anim-card-suit-info">🂠</div>`;
    this.mountTransient(card);
    this.session.setTimeout(() => card.remove(), 1800);
  }

  /** 判定动画：卡背→翻转→正面+结果标记 */
  animateJudge(cardName: string, suit: string, number: number, judgeResult: boolean, idx: number = 0): Promise<void> {
    return this.session.wait(resolve => {
      const fileName = CARD_FILE_NAME_MAP[cardName] || cardName;
      const imgSrc = `Resources/Cards/${fileName}.png`;
      const suitSym = SUIT_SYMBOL[suit] || '';
      const numText = NUMBER_TEXT[number] || String(number || '');
      const suitColor = SUIT_COLOR[suit] || '#888';

      // 每个判定牌间隔 2.3s * idx（前一个动画 2s + 0.3s 间隔）
      const delayMs = idx * 2300;

      this.session.setTimeout(() => {
        const overlay = document.createElement('div');
        overlay.className = 'judge-anim-overlay';
        overlay.style.zIndex = `${1050 + idx}`;
        const table = this.battlefieldEl.getBoundingClientRect();
        overlay.style.left = `${table.left}px`;
        overlay.style.top = `${table.top}px`;
        overlay.style.width = `${table.width}px`;
        overlay.style.height = `${table.height}px`;
        overlay.style.right = 'auto';
        overlay.style.bottom = 'auto';
        overlay.dataset.result = judgeResult ? 'effective' : 'ineffective';
        overlay.innerHTML = `
          <div class="judge-anim-card">
            <div class="judge-anim-inner">
              <div class="judge-anim-front"></div>
              <div class="judge-anim-back">
                <img src="${imgSrc}" alt="${cardName}"
                  onerror="this.parentElement.style.background='#1a1a2e';this.parentElement.innerHTML+='<span style=color:#ccc;font-size:12px;>${cardName.substring(0,2)}</span>'">
                <div class="judge-card-overlay">
                  <span class="judge-suit-icon" style="color:${suitColor}">${suitSym}</span>
                  <span class="judge-number-text" style="color:${suitColor}">${numText}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="judge-anim-info">${suitSym}${numText} ${cardName}</div>
          <div class="judge-anim-result">${judgeResult ? '判定生效' : '判定未生效'}</div>
        `;
        this.mountTransient(overlay);

        const inner = overlay.querySelector('.judge-anim-inner')! as HTMLElement;
        const result = overlay.querySelector('.judge-anim-result')! as HTMLElement;

        // 阶段1：0.3s后翻转
        this.session.setTimeout(() => {
          inner.classList.add('flipped');
        }, 300);

        // 阶段2：翻转完成后显示结果
        this.session.setTimeout(() => {
          result.classList.add('show');
        }, 1000);

        // 阶段3：全部消失后resolve
        this.session.setTimeout(() => {
          overlay.remove();
          resolve();
        }, 2000);
      }, delayMs);
    });
  }

  /** 选择目标时，从手牌区连向座位。 */
  showTargetBeam(targetPlayerId: number): void {
    const target = this.getSeatElement(targetPlayerId);
    if (target) this.mountTargetBeam(this.handCardsEl, target, 'target-beam', 3000);
  }

  /** 出牌时，从出牌者连向目标。 */
  showTargetBeamBetween(sourceId: number, targetId: number): void {
    const source = this.getSeatElement(sourceId);
    const target = this.getSeatElement(targetId);
    if (source && target && source !== target) this.mountTargetBeam(source, target, 'card-target-beam', 1200);
  }

  private mountTargetBeam(source: Element, target: Element, className: string, lifetime: number): void {
    const start = source.getBoundingClientRect();
    const end = target.getBoundingClientRect();
    const x = start.left + start.width / 2;
    const y = start.top + start.height / 2;
    const dx = end.left + end.width / 2 - x;
    const dy = end.top + end.height / 2 - y;
    const beam = document.createElement('div');
    beam.className = className;
    beam.setAttribute('aria-hidden', 'true');
    beam.style.left = `${x}px`;
    beam.style.top = `${y}px`;
    beam.style.width = `${Math.hypot(dx, dy)}px`;
    beam.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    this.mountTransient(beam);
    this.session.setTimeout(() => {
      beam.remove();
      this.transientElements.delete(beam);
    }, lifetime);
  }

  /** 获取座位的 DOM 元素 */
  private getSeatElement(playerId: number): Element | null {
    if (playerId === this.selfId) {
      return this.el.querySelector('#seat-self .seat-card');
    }
    return this.el.querySelector(`.seat-card[data-player-id="${playerId}"]`);
  }

  /** 清除选目标时的连线。 */
  clearTargetBeams(): void {
    for (const beam of this.transientElements) {
      if (!beam.classList.contains('target-beam')) continue;
      beam.remove();
      this.transientElements.delete(beam);
    }
  }

  // ======================== 高亮系统（供HumanWebUIDriver调用） ========================

  /** 高亮可打出的手牌（含契约对象的牌） */
  highlightPlayableCards(state: PlayerState, ctx: GameContextSnapshot): void {
    this.clearHighlights();
    this.actionBarEl.style.display = 'flex';
    this.playEndBtnEl.style.display = 'inline-block';
    this.playEndBtnEl.textContent = '结束出牌';
    this.selectedCardIndex = -1;
    this.selectedCardState = state;
    this.selectedCardCtx = ctx;

    // 检查契约关系
    const myData = (this.skillManager as any)?.getData?.(state.id) || {};
    const contractPartnerId = myData.contractPartnerId;
    const players = ctx?.players ?? [];
    const partner = contractPartnerId !== undefined
      ? players.find(p => p.id === contractPartnerId && !p.isDead) : undefined;

    const cards = this.handCardsEl.querySelectorAll('.game-card');
    cards.forEach((el) => {
      const cardEl = el as HTMLElement;
      const cardIdx = parseInt(cardEl.dataset.cardIndex || '-1');
      const cardSource = cardEl.dataset.cardSource;

      if (cardSource === 'partner' && partner) {
        // 契约对象的牌：canPlayCard检查后，点击则从partner手牌移入自己手牌
        if (cardIdx >= 0 && cardIdx < partner.handCards.length) {
          const card = partner.handCards[cardIdx];
          if (this.canPlayCard(card, state, ctx)) {
            el.classList.add('playable');
            cardEl.onclick = (e) => {
              e.stopPropagation();
              this.clearHighlights();
              this.actionBarEl.style.display = 'none';
              // 把契约对象的牌移入自己手牌，直接出牌
              const [moved] = partner.handCards.splice(cardIdx, 1);
              state.handCards.push(moved);
              this.humanDriver?.resolvePlayCard(state.handCards.length - 1);
              this.hidePrompt();
            };
          } else {
            el.classList.add('dimmed');
          }
        }
        return;
      }

      // 自己的牌
      if (cardSource !== 'partner') {
        const card = state.handCards[cardIdx];
        if (!card) return;
        const score = this.canPlayCard(card, state, ctx);
        if (score) {
          el.classList.add('playable');
          cardEl.onclick = (e) => {
            e.stopPropagation();
            this.toggleCardSelection(cardIdx, cardEl, state, ctx);
          };
        } else {
          el.classList.add('dimmed');
        }
      }
    });

    this.playEndBtnEl.onclick = (e) => {
      e.stopPropagation();
      if (this.selectedCardIndex >= 0) {
        const selected = this.handCardsEl.querySelector<HTMLElement>(`.game-card[data-card-index="${this.selectedCardIndex}"]`);
        selected?.classList.remove('selected');
        selected?.classList.add('playable');
        this.selectedCardIndex = -1;
        this.hidePlayConfirmButton();
        this.playEndBtnEl.textContent = '结束出牌';
        return;
      }
      this.clearHighlights();
      this.actionBarEl.style.display = 'none';
      this.humanDriver?.resolvePlayCard(-1);
      this.hidePrompt();
    };
  }

  /** 切换卡片选中/取消选中 */
  private toggleCardSelection(cardIdx: number, cardEl: HTMLElement, _state: PlayerState, _ctx: GameContextSnapshot): void {
    if (this.selectedCardIndex === cardIdx) {
      // 取消选中：恢复 playable 状态
      cardEl.classList.remove('selected');
      cardEl.classList.add('playable');
      this.selectedCardIndex = -1;
      this.hidePlayConfirmButton();
      this.playEndBtnEl.textContent = '结束出牌';
      return;
    }

    // 取消之前的选中
    if (this.selectedCardIndex >= 0) {
      const prevEl = this.handCardsEl.querySelector(`.game-card[data-card-index="${this.selectedCardIndex}"]`);
      if (prevEl) {
        prevEl.classList.remove('selected');
        prevEl.classList.add('playable');
      }
    }

    // 选中当前卡片
    cardEl.classList.remove('playable');
    cardEl.classList.add('selected');
    this.selectedCardIndex = cardIdx;
    this.playEndBtnEl.textContent = '取消选择';
    this.showPlayConfirmButton();
  }

  /** 显示"确认出牌"按钮 */
  private showPlayConfirmButton(): void {
    this.hidePlayConfirmButton();
    const btn = document.createElement('button');
    btn.className = 'btn-play-confirm';
    btn.id = 'play-confirm-btn';
    btn.textContent = '✦ 确认出牌';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.selectedCardIndex < 0) return;
      const cardIdx = this.selectedCardIndex;
      this.clearHighlights();
      this.actionBarEl.style.display = 'none';
      this.humanDriver?.resolvePlayCard(cardIdx);
      this.hidePrompt();
    });
    this.actionBarEl.prepend(btn);
  }

  /** 隐藏"确认出牌"按钮 */
  private hidePlayConfirmButton(): void {
    const existing = this.actionBarEl.querySelector('#play-confirm-btn');
    if (existing) existing.remove();
  }

  private canPlayCard(card: Card, state: PlayerState, ctx: GameContextSnapshot): boolean {
    // 魈-降魔：封印花色不可打出（PVE查skillManager，PVP查_sealedSuits）
    if (this.skillManager?.isSuitSealed?.(card.suit)) return false;
    const pSealed = (state as any)._sealedSuits as Record<string, boolean> | undefined;
    if (pSealed && pSealed[card.suit]) return false;
    if (card.type === 'Equipment') return true;
    if (card.name === '桃') return state.hp < state.maxHp;
    if (card.name === '无中生有') return true;
    if (card.name === '酒') return !state.wineUsedThisTurn && state.nextSlashDamageBonus === 0;
    const players = ctx?.players ?? [];
    // 妮露-水月：红色手牌可以当杀
    if (this.skillManager?.getNilouStanceConvert?.(state, card) === '杀') {
      if (state.slashUsedCount >= 1 && state.equipZone[EquipmentType.Weapon]?.name !== '诸葛连弩') return false;
      const enemies = players.filter(p => !p.isDead && p.id !== state.id);
      return enemies.some(e => getWeaponRange(state) >= getDistance(state, e, players));
    }
    if (isSlash(card)) {
      if (state.slashUsedCount >= 1 && state.equipZone[EquipmentType.Weapon]?.name !== '诸葛连弩') return false;
      const enemies = players.filter(p => !p.isDead && p.id !== state.id);
      return enemies.some(e => getWeaponRange(state) >= getDistance(state, e, players));
    }
    // 借刀杀人：必须存在持有武器的角色才能打出
    if (card.name === '借刀杀人') {
      const weaponHolders = players.filter(p =>
        !p.isDead && p.equipZone[EquipmentType.Weapon] !== null
      );
      return weaponHolders.length > 0;
    }
    // 克洛琳德-决斗：高点数手牌当决斗打出
    if (this.skillManager?.getClorindeDuelConvert?.(state, card)) {
      return true; // 可以当决斗打出
    }
    // 默认：锦囊都可以尝试打出
    return card.type === 'Magic';
  }

  /** 妮露-水月/水环：点击技能后高亮对应颜色的手牌（当杀/闪使用） */
  private highlightNilouConvertCards(state: PlayerState, color: 'red' | 'black'): void {
    this.clearHighlights();
    const cards = this.handCardsEl.querySelectorAll('.game-card');
    let hasPlayable = false;
    cards.forEach((el, i) => {
      const card = state.handCards[i];
      if (!card) return;
      const isRed = card.suit === SuitType.Heart || card.suit === SuitType.Diamond;
      const isBlack = card.suit === SuitType.Spade || card.suit === SuitType.Club;
      const matches = (color === 'red' && isRed) || (color === 'black' && isBlack);
      if (matches) {
        el.classList.add('playable');
        hasPlayable = true;
        (el as HTMLElement).onclick = (e) => {
          e.stopPropagation();
          this.clearHighlights();
          // 判断当前处于出牌阶段还是响应阶段
          const responseBarActive = this.el.querySelector('#response-btn-bar') as HTMLElement | null;
          if (responseBarActive && responseBarActive.style.display !== 'none') {
            // 响应阶段：resolve response
            this.humanDriver.resolveResponse(state.handCards[i]);
            this.hideResponseButtons();
            this.cancelGlobalHandler();
          } else {
            // 出牌阶段：resolve playCard
            this.actionBarEl.style.display = 'none';
            this.humanDriver.resolvePlayCard(i);
          }
          this.hidePrompt();
        };
      } else {
        el.classList.add('dimmed');
      }
    });
    const hint = color === 'red' ? '选择红色手牌当【杀】使用' : '选择黑色手牌当【闪】使用';
    this.showPrompt(`【${color === 'red' ? '水月' : '水环'}】${hint}` + (hasPlayable ? '' : '（无可用的牌）'));
  }

  /** 高亮可供选择的卡牌（如青龙刀选择追击杀） */
  highlightSelectableCards(state: PlayerState, validCards: Card[]): void {
    this.renderHandCards();
    this.clearHighlights();
    const cards = this.handCardsEl.querySelectorAll('.game-card');
    cards.forEach((el) => {
      const cardEl = el as HTMLElement;
      const cardIdx = parseInt(cardEl.dataset.cardIndex || '-1');
      const cardSource = cardEl.dataset.cardSource;
      // 只检查玩家自己的牌（契约牌暂时不参与装备效果）
      if (cardSource === 'partner') {
        el.classList.add('dimmed');
        return;
      }
      if (cardIdx >= 0 && cardIdx < state.handCards.length) {
        const card = state.handCards[cardIdx];
        if (validCards.some(c => c.id === card.id)) {
          el.classList.add('playable');
          cardEl.onclick = (e) => {
            e.stopPropagation();
            this.clearHighlights();
            this.humanDriver.resolveSelectCard(cardIdx);
            this.hidePrompt();
          };
        } else {
          el.classList.add('dimmed');
        }
      }
    });
  }

  /** 高亮可选目标 */
  highlightTargets(validTargets: number[], reason: string): void {
    this.clearHighlights();
    this.clearTargetBeams();
    const allSeats = this.el.querySelectorAll('.seat-card');
    allSeats.forEach(el => {
      const pid = parseInt((el as HTMLElement).dataset.playerId || '-1');
      if (validTargets.includes(pid)) {
        el.classList.add('targetable');
        (el as HTMLElement).onclick = (e) => {
          e.stopPropagation();
          this.clearHighlights();
          this.clearTargetBeams();
          this.humanDriver.resolveTarget(pid);
          this.hidePrompt();
        };
      } else if (pid >= 0) {
        el.classList.add('dimmed');
      }
    });

    // 为每个可选目标发出金光
    for (const pid of validTargets) {
      this.showTargetBeam(pid);
    }

    // 点击其他区域不做任何事（只有点击有效目标才选择）
  }

  /** 高亮可响应的牌（含契约对象的牌）—— 统一使用与主动出牌一致的选牌+确认机制 */
  highlightResponseCards(validCards: Card[], hint: string): void {
    // 先刷新手牌显示，确保DOM与当前手牌状态一致
    this.renderHandCards();
    this.clearHighlights();
    this.selectedCardIndex = -1;
    (this as any)._selectedCardPartner = null;
    const me = this.getHumanPlayer()!;
    // 检查契约关系
    const myData = (this.skillManager as any)?.getData?.(me.id) || {};
    const contractPartnerId = myData.contractPartnerId;
    const partner = contractPartnerId !== undefined
      ? this.players.find(p => p.id === contractPartnerId && !p.isDead) : undefined;

    const cards = this.handCardsEl.querySelectorAll('.game-card');
    let hasPlayable = false;
    cards.forEach((el) => {
      const cardEl = el as HTMLElement;
      const cardIdx = parseInt(cardEl.dataset.cardIndex || '-1');
      const cardSource = cardEl.dataset.cardSource;

      if (cardSource === 'partner' && partner) {
        if (cardIdx >= 0 && cardIdx < partner.handCards.length) {
          const partnerCard = partner.handCards[cardIdx];
          if (validCards.some(c => c.id === partnerCard.id)) {
            el.classList.add('playable');
            hasPlayable = true;
            cardEl.onclick = (e) => {
              e.stopPropagation();
              this.toggleResponseCardSelection(cardIdx, cardEl, 'partner', partner);
            };
          } else {
            el.classList.add('dimmed');
          }
        }
        return;
      }

      // 自己的牌
      if (cardIdx >= 0 && validCards.some(c => c.id === me.handCards[cardIdx]?.id)) {
        el.classList.add('playable');
        hasPlayable = true;
        cardEl.onclick = (e) => {
          e.stopPropagation();
          this.toggleResponseCardSelection(cardIdx, cardEl, 'self', null);
        };
      } else {
        el.classList.add('dimmed');
      }
    });

    // 没有可用响应牌 → 自动放弃
    if (!hasPlayable) {
      this.clearHighlights();
      this.humanDriver.resolveResponse(null);
      this.hidePrompt();
      this.hideResponseButtons();
      return;
    }

    // 显示"打出"+"放弃响应"按钮条（打出默认禁用）
    this.showResponseButtons(hint);
  }

  /** 切换响应选中的牌（与 toggleCardSelection 保持一致） */
  private toggleResponseCardSelection(cardIdx: number, cardEl: HTMLElement, source: string, partner: PlayerState | null): void {
    // 点击同一张已选中的牌 → 取消选中
    if (this.selectedCardIndex === cardIdx && (this as any)._responseCardSource === source) {
      cardEl.classList.remove('selected');
      cardEl.classList.add('playable');
      this.selectedCardIndex = -1;
      (this as any)._responseCardSource = null;
      (this as any)._selectedCardPartner = null;
      this.updateResponsePlayButton();
      return;
    }

    // 取消之前选中的牌（如果有）
    if (this.selectedCardIndex >= 0) {
      const prevEl = this.handCardsEl.querySelector(`.game-card[data-card-index="${this.selectedCardIndex}"]`);
      if (prevEl) {
        prevEl.classList.remove('selected');
        prevEl.classList.add('playable');
      }
    }

    // 选中当前牌
    cardEl.classList.remove('playable');
    cardEl.classList.add('selected');
    this.selectedCardIndex = cardIdx;
    (this as any)._responseCardSource = source;
    (this as any)._selectedCardPartner = partner;
    this.updateResponsePlayButton();
  }

  /** 更新响应"打出"按钮的禁用状态 */
  private updateResponsePlayButton(): void {
    const btn = this.el.querySelector('#response-play-btn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = this.selectedCardIndex < 0;
  }

  /** 显示响应按钮条："打出"（默认禁用）+ "放弃响应" */
  private showResponseButtons(hint: string): void {
    let btnBar = this.el.querySelector('#response-btn-bar') as HTMLElement | null;
    if (!btnBar) {
      btnBar = document.createElement('div');
      btnBar.id = 'response-btn-bar';
      btnBar.className = 'response-btn-bar';
      this.actionBarEl.parentElement?.insertBefore(btnBar, this.actionBarEl);
    }
    btnBar.style.display = 'flex';
    btnBar.innerHTML = `
      <span class="response-hint"></span>
      <button class="btn-response-confirm" id="response-play-btn" disabled>✦ 打出</button>
      <button class="btn-response-pass" id="response-pass-btn">放弃响应</button>
    `;
    btnBar.querySelector('.response-hint')!.textContent = hint;
    // "打出"按钮
    btnBar.querySelector('#response-play-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.selectedCardIndex < 0) return;
      const cardIdx = this.selectedCardIndex;
      const me = this.getHumanPlayer()!;
      const source = (this as any)._responseCardSource;
      const partner = (this as any)._selectedCardPartner;
      this.clearHighlights();
      this.selectedCardIndex = -1;
      (this as any)._responseCardSource = null;
      (this as any)._selectedCardPartner = null;
      this.hideResponseButtons();
      this.cancelGlobalHandler();
      if (source === 'partner' && partner && cardIdx >= 0 && cardIdx < partner.handCards.length) {
        const [used] = partner.handCards.splice(cardIdx, 1);
        this.humanDriver.resolveResponse(used);
      } else {
        this.humanDriver.resolveResponse(me.handCards[cardIdx]);
      }
      this.hidePrompt();
    });
    // "放弃响应"按钮
    btnBar.querySelector('#response-pass-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearHighlights();
      this.selectedCardIndex = -1;
      (this as any)._responseCardSource = null;
      (this as any)._selectedCardPartner = null;
      this.humanDriver.resolveResponse(null);
      this.hidePrompt();
      this.hideResponseButtons();
      this.cancelGlobalHandler();
    });
  }

  /** 隐藏响应按钮 */
  hideResponseButtons(): void {
    const btnBar = this.el.querySelector('#response-btn-bar') as HTMLElement | null;
    if (btnBar) {
      btnBar.style.display = 'none';
    }
    this.selectedCardIndex = -1;
    (this as any)._responseCardSource = null;
    (this as any)._selectedCardPartner = null;
  }

  private globalCancelHandler: ((e: MouseEvent) => void) | null = null;

  private cancelGlobalHandler(): void {
    if (this.globalCancelHandler) {
      document.removeEventListener('click', this.globalCancelHandler);
      this.globalCancelHandler = null;
    }
  }

  /** 高亮可弃置的牌 */
  highlightDiscardCards(state: PlayerState, limit?: number): void {
    this.clearHighlights();
    const cards = this.handCardsEl.querySelectorAll('.game-card');
    cards.forEach((el, i) => {
      el.classList.add('playable');
      (el as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        this.humanDriver.resolveDiscard(i);
      };
    });

    if (limit === undefined) {
      this.showPrompt('选择一张手牌弃置');
      return;
    }
    const hand = document.createElement('span');
    hand.className = 'discard-prompt-hand';
    hand.textContent = `弃牌阶段 · 手牌 ${state.handCards.length}/${limit}`;
    const progress = document.createElement('span');
    progress.className = 'discard-prompt-progress';
    progress.textContent = `还需弃置 ${Math.max(0, state.handCards.length - limit)} 张`;
    this.promptBarEl.replaceChildren(hand, progress);
    this.promptBarEl.classList.add('is-discard-prompt');
    this.promptBarEl.style.display = 'flex';
  }

  /** 高亮无懈可击 */
  highlightNullifyCards(state: PlayerState): void {
    this.clearHighlights();
    let hasNullify = false;
    const cards = this.handCardsEl.querySelectorAll('.game-card');
    cards.forEach((el, i) => {
      const card = state.handCards[i];
      if (card && card.name === '无懈可击') {
        el.classList.add('playable');
        hasNullify = true;
        (el as HTMLElement).onclick = (e) => {
          e.stopPropagation();
          this.clearHighlights();
          this.humanDriver.resolveNullify(true);
          this.hidePrompt();
          this.hideNullifyPassButton();
          this.restoreGraceOverlayZIndex();
        };
      } else {
        el.classList.add('dimmed');
      }
    });
    // 没有无懈可击则自动跳过
    if (!hasNullify) {
      this.humanDriver.resolveNullify(false);
      this.hidePrompt();
      this.restoreGraceOverlayZIndex();
    } else {
      // 显示"放弃打出"红色按钮
      this.showNullifyPassButton();
    }
  }

  restoreGraceOverlayZIndex(): void {
    if (this.graceOverlay) {
      this.graceOverlay.style.display = '';
    }
  }

  private nullifyPassBar: HTMLElement | null = null;

  /** 已播放打出动画的卡牌ID集合——避免 CardDiscarded 再次触发相同动画 */
  private _playedCardIds: Set<number> = new Set();

  private showNullifyPassButton(): void {
    this.hideNullifyPassButton();
    const bar = document.createElement('div');
    bar.className = 'nullify-pass-bar';
    bar.id = 'nullify-pass-bar';
    bar.innerHTML = `<button class="btn-nullify-pass" id="nullify-pass-btn">放弃打出【无懈可击】</button>`;
    bar.querySelector('#nullify-pass-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearHighlights();
      this.humanDriver.resolveNullify(false);
      this.hidePrompt();
      this.hideNullifyPassButton();
    });
    this.actionBarEl.parentElement?.insertBefore(bar, this.actionBarEl);
    this.nullifyPassBar = bar;
  }

  public hideNullifyPassButton(): void {
    if (this.nullifyPassBar) {
      this.nullifyPassBar.remove();
      this.nullifyPassBar = null;
    }
    this.restoreGraceOverlayZIndex();
  }

  /** 高亮展示牌 */
  highlightShowCards(state: PlayerState): void {
    this.clearHighlights();
    const cards = this.handCardsEl.querySelectorAll('.game-card');
    cards.forEach((el, i) => {
      el.classList.add('playable');
      (el as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        this.clearHighlights();
        this.humanDriver.resolveShowCard(i);
        this.hidePrompt();
      };
    });
    // 如果手牌为空，自动选0
    if (state.handCards.length === 0) {
      this.humanDriver.resolveShowCard(0);
      this.hidePrompt();
    }
  }

  /** 高亮区域选择 */
  highlightZones(target: PlayerState): void {
    this.clearHighlights();
    this.el.querySelector(`.seat-card[data-player-id="${target.id}"]`)?.classList.add('zone-highlight');
    const equipment = Object.entries(target.equipZone).filter(([, card]) => card !== null) as [string, Card][];
    const zones: { zone: 'hand' | 'equip' | 'judge'; label: string; count: number }[] = [
      { zone: 'hand', label: '手牌', count: target.handCards.length },
      { zone: 'equip', label: '装备', count: equipment.length },
      { zone: 'judge', label: '判定', count: target.judgeZone.length },
    ];
    const layer = document.createElement('div');
    const panel = document.createElement('section');
    const title = document.createElement('h3');
    title.textContent = `选择 ${target.name} 的区域`;
    const choices = document.createElement('div');
    choices.className = 'table-zone-choices';
    const driver = this.humanDriver;
    for (const { zone, label, count } of zones) {
      if (!count) continue;
      const button = document.createElement('button');
      button.className = 'btn btn-gold btn-sm';
      button.textContent = `${label}（${count}）`;
      button.onclick = () => {
        if (!this.closeTableInteraction(layer)) return;
        this.cancelGlobalHandler(); this.hidePrompt(); this.clearHighlights();
        if (zone === 'equip' && count > 1) this.showZoneDetailSelect(target, zone, equipment);
        else if (zone === 'judge' && count > 1) this.showZoneDetailSelect(target, zone, target.judgeZone.map((card, index) => [`judge_${index}`, card]));
        else driver.resolveZone({ zone, index: 0 });
      };
      choices.append(button);
    }
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.textContent = '取消';
    cancel.onclick = () => {
      if (!this.closeTableInteraction(layer)) return;
      this.cancelGlobalHandler(); this.hidePrompt(); this.clearHighlights();
      driver.resolveZone(null);
    };
    choices.append(cancel);
    panel.append(title, choices); layer.append(panel);
    this.mountTableInteraction(layer);
  }

  /** 玛薇卡-圣火：高亮普通杀让用户选择转化 */
  highlightHolyFireCards(player: PlayerState): void {
    this.clearHighlights();
    this.renderHandCards();
    const normalSlashIndices: number[] = [];
    player.handCards.forEach((c, i) => {
      if (isSlash(c) && (!c.element || c.element === ElementType.None)) {
        normalSlashIndices.push(i);
      }
    });
    if (normalSlashIndices.length === 0) return;

    const cards = this.handCardsEl.querySelectorAll('.game-card');
    cards.forEach((el) => {
      const cardEl = el as HTMLElement;
      const cardIdx = parseInt(cardEl.dataset.cardIndex || '-1');
      if (normalSlashIndices.includes(cardIdx)) {
        el.classList.add('playable');
        cardEl.onclick = (e) => {
          e.stopPropagation();
          this.clearHighlights();
          // 将选中的杀转为火杀
          const card = player.handCards[cardIdx];
          card.element = ElementType.Pyro;
          this.addLog(`${player.name} 发动【圣火】，将 ${getCardDetail(card)} 转为【火杀】！`);
          this.renderBattlefield();
          this.renderHandCards();
          this.renderSkills();
          // 标记技能已使用
          (this.skillManager as any)?.getData?.(player.id)?.holyFireUsedThisTurn && ((this.skillManager as any).getData(player.id).holyFireUsedThisTurn = true);
          const ctx = {
            players: this.players,
            roundCount: this.flowController?.roundCount || 0,
            currentTurn: this.flowController?.currentTurnInRound || 0,
            currentPlayerId: player.id,
            gameOverWinner: null,
            drawPileCount: this.deck?.drawPileCount || 0,
            discardPileCount: this.deck?.discardPile?.length || 0,
          };
          this.highlightPlayableCards(player, ctx);
        };
      } else {
        el.classList.add('dimmed');
      }
    });
  }

  clearHighlights(): void {
    this.clearTargetBeams();
    this.el.querySelectorAll('.playable, .dimmed, .targetable, .zone-highlight, .zone-selector').forEach(el => {
      el.classList.remove('playable', 'dimmed', 'targetable', 'zone-highlight');
      (el as HTMLElement).onclick = null;
    });
    this.el.querySelectorAll('.selected').forEach(el => {
      el.classList.remove('selected');
      (el as HTMLElement).onclick = null;
    });
    this.el.querySelectorAll('.zone-selector').forEach(el => el.remove());
    this.playEndBtnEl.style.display = 'none';
    this.actionBarEl.style.display = 'none';
    this.hideResponseButtons();
    this.hideNullifyPassButton();
    // 清理选牌确认按钮
    this.hidePlayConfirmButton();
    // 清理全局取消处理器
    this.cancelGlobalHandler();
    // 重置选牌状态
    this.selectedCardIndex = -1;
    this.selectedCardState = null;
    this.selectedCardCtx = null;
  }

  // ======================== 提示系统 ========================
  showPrompt(text: string): void {
    this.promptBarEl.classList.remove('is-discard-prompt');
    this.promptBarEl.textContent = text;
    this.promptBarEl.style.display = 'block';
  }
  hidePrompt(): void {
    this.promptBarEl.classList.remove('is-discard-prompt');
    this.promptBarEl.style.display = 'none';
  }

  showYesNoPrompt(title: string, resolve: (v: boolean) => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.innerHTML = `
      <div class="game-modal">
        <h3>${title}</h3>
        <div style="display:flex;gap:12px;justify-content:center;margin-top:16px;">
          <button class="btn btn-gold btn-sm" id="yn-yes">确定</button>
          <button class="btn btn-ghost btn-sm" id="yn-no">取消</button>
        </div>
      </div>
    `;
    overlay.querySelector('#yn-yes')!.addEventListener('click', () => { if (!this.closeTableInteraction(overlay)) return; resolve(true); });
    overlay.querySelector('#yn-no')!.addEventListener('click', () => { if (!this.closeTableInteraction(overlay)) return; resolve(false); });
    this.mountTableInteraction(overlay);
  }

  showSuitPrompt(cardNumber: number, totalCards: number, resolve: (suit: CardSuit) => void): () => void {
    const layer = document.createElement('div');
    const panel = document.createElement('section');
    const title = document.createElement('h3');
    title.textContent = `【天权】请选择第 ${cardNumber} 张牌的花色（共 ${totalCards} 张）`;
    const choices = document.createElement('div');
    choices.className = 'table-suit-choices';
    for (const suit of CARD_SUITS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost';
      button.dataset.suit = suit;
      button.textContent = `${SUIT_SYMBOL[suit]} ${SUIT_LABEL[suit]}`;
      button.addEventListener('click', () => resolve(suit));
      choices.append(button);
    }
    panel.append(title, choices);
    layer.append(panel);
    this.mountTableInteraction(layer);
    return () => this.closeTableInteraction(layer);
  }

  /** 纳西妲-比喻：选择一张非延时锦囊牌 */
  showMetaphorPrompt(resolve: (cardName: string | null) => void): void {
    const nonDelayedMagicCards = [
      '南蛮入侵', '万箭齐发', '桃园结义', '五谷丰登',
      '无中生有', '过河拆桥', '顺手牵羊', '决斗',
      '火攻', '借刀杀人', '铁索连环', '无懈可击'
    ];
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.id = 'metaphor-overlay';
    overlay.innerHTML = `
      <div class="game-modal metaphor-modal">
        <h3>🌿 比喻 - 将全部锦囊牌当作一张非延时锦囊使用</h3>
        <p style="text-align:center;color:var(--text-secondary);margin-bottom:8px;">点击选择要模拟的锦囊牌（若无法选择目标则无效果，技能仍视为发动）</p>
        <div class="metaphor-cards-grid" id="metaphor-cards-grid">
          ${nonDelayedMagicCards.map(name => `
            <div class="metaphor-card-item" data-card="${name}">
              <span class="metaphor-card-name">${name}</span>
            </div>
          `).join('')}
        </div>
        <div style="text-align:center;margin-top:12px;">
          <button class="btn btn-ghost btn-sm" id="metaphor-cancel">取消（视为已发动）</button>
        </div>
      </div>
    `;
    overlay.querySelectorAll('.metaphor-card-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const cardName = (el as HTMLElement).dataset.card!;
        if (!this.closeTableInteraction(overlay)) return;
        resolve(cardName);
      });
    });
    overlay.querySelector('#metaphor-cancel')!.addEventListener('click', () => {
      if (!this.closeTableInteraction(overlay)) return;
      resolve(null);
    });
    this.mountTableInteraction(overlay);
  }

  showIronChainPrompt(resolve: (v: 'recast' | 'chain') => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.innerHTML = `
      <div class="game-modal">
        <h3>铁索连环 - 选择模式</h3>
        <div style="display:flex;gap:12px;justify-content:center;margin-top:16px;">
          <button class="btn btn-gold btn-sm" id="ic-recast">重铸（摸1张牌）</button>
          <button class="btn btn-gold btn-sm" id="ic-chain">连环（选择目标）</button>
        </div>
      </div>
    `;
    overlay.querySelector('#ic-recast')!.addEventListener('click', () => { if (!this.closeTableInteraction(overlay)) return; resolve('recast'); });
    overlay.querySelector('#ic-chain')!.addEventListener('click', () => { if (!this.closeTableInteraction(overlay)) return; resolve('chain'); });
    this.mountTableInteraction(overlay);
  }

  /** 温迪-自由：选择体力上限弹窗（含取消） */
  showVentiFreePrompt(state: PlayerState, resolve: (v: number) => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    const currentHp = state.maxHp;
    let selected = currentHp;
    // 生成 1-7 的选项按钮
    const buttons = [1, 2, 3, 4, 5, 6, 7].map(n => {
      const active = n === currentHp ? 'btn-gold' : 'btn-ghost';
      return `<button class="btn ${active} btn-sm venti-hp-opt" data-val="${n}">${n}血上限 → ${8 - n}手牌上限</button>`;
    }).join('');
    overlay.innerHTML = `
      <div class="game-modal" style="max-width:480px;">
        <h3>【自由】调整体力上限</h3>
        <p style="color:#aaa;font-size:13px;margin:8px 0;">体力上限与手牌上限之和恒为8</p>
        <div class="venti-hp-grid">${buttons}</div>
        <div style="text-align:center;margin-top:12px;display:flex;gap:12px;justify-content:center;">
          <button class="btn btn-gold btn-sm" id="venti-confirm">确认（${selected}血上限 / ${8 - selected}手牌上限）</button>
          <button class="btn btn-ghost btn-sm" id="venti-cancel">取消</button>
        </div>
      </div>
    `;
    const confirmBtn = overlay.querySelector('#venti-confirm')! as HTMLElement;
    overlay.querySelectorAll('.venti-hp-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = parseInt((btn as HTMLElement).dataset.val || '5');
        selected = val;
        confirmBtn.textContent = `确认（${selected}血上限 / ${8 - selected}手牌上限）`;
        overlay.querySelectorAll('.venti-hp-opt').forEach(b => {
          b.className = `btn btn-sm venti-hp-opt ${parseInt((b as HTMLElement).dataset.val || '5') === selected ? 'btn-gold' : 'btn-ghost'}`;
        });
      });
    });
    confirmBtn.addEventListener('click', () => { if (!this.closeTableInteraction(overlay)) return; resolve(selected); });
    overlay.querySelector('#venti-cancel')!.addEventListener('click', () => { if (!this.closeTableInteraction(overlay)) return; resolve(currentHp); });
    this.mountTableInteraction(overlay);
  }

  /** 顺手牵羊/过河拆桥：从目标手牌区主动选牌 */
  showRansackHandPrompt(target: PlayerState, resolve: (idx: number) => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.style.pointerEvents = 'auto';
    // 不能看到对手手牌内容：只显示背面编号
    const cards = target.handCards.map((_c, i) => {
      return `
        <button class="target-btn ransack-card-btn" data-idx="${i}" aria-label="手牌 #${i + 1}">
          <span class="ransack-card-back" aria-hidden="true">✦</span><span>手牌 #${i + 1}</span>
        </button>`;
    }).join('');
    overlay.innerHTML = `
      <div class="game-modal" style="max-width:420px;max-height:70vh;overflow-y:auto;pointer-events:auto;">
        <h3>选择 ${target.name} 的一张手牌</h3>
        <div class="target-list ransack-hand-list" style="pointer-events:auto;">${cards}</div>
        <div style="text-align:center;margin-top:12px;">
          <button class="btn btn-ghost btn-sm" id="ransack-cancel" style="pointer-events:auto;">随机选择</button>
        </div>
      </div>
    `;
    overlay.querySelectorAll('.ransack-card-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const idx = parseInt((btn as HTMLElement).dataset.idx || '-1');
        if (!this.closeTableInteraction(overlay)) return;
        resolve(idx);
      });
    });
    overlay.querySelector('#ransack-cancel')!.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.closeTableInteraction(overlay)) return;
      resolve(-1);
    });
    // 点击遮罩空白区域不做任何事，必须点击牌或取消按钮
    overlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.stopPropagation();
      }
    });
    this.mountTableInteraction(overlay);
  }

  /** 丈八蛇矛：选择两张手牌合成虚拟杀 */
  showZhanBaPrompt(state: PlayerState, resolve: (indices: [number, number] | null) => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.style.pointerEvents = 'auto';
    const selected = new Set<number>();

    const refreshCards = () => {
      const cardHtml = state.handCards.map((c, idx) => {
        const suitSym = SUIT_SYMBOL[c.suit] || '';
        const numText = NUMBER_TEXT[c.number] || String(c.number);
        const color = SUIT_COLOR[c.suit] || '#888';
        const sel = selected.has(idx);
        return `
          <button class="target-btn zhanba-card-btn" data-idx="${idx}"
            style="text-align:left;width:100%;pointer-events:auto;
              ${sel ? 'background:rgba(255,215,0,0.3);border:2px solid gold;' : ''}">
            <span style="color:${color};font-weight:bold;">${getCardDetail(c)}</span>
            ${sel ? ' ✅' : ''}
          </button>`;
      }).join('');

      const confirm = overlay.querySelector<HTMLButtonElement>('#zhanba-confirm')!;
      confirm.disabled = selected.size !== 2;
      confirm.textContent = `确认合成（${selected.size}/2）`;
      overlay.querySelector('.zhanba-card-list')!.innerHTML = cardHtml;
      overlay.querySelectorAll('.zhanba-card-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault();
          const idx = parseInt((btn as HTMLElement).dataset.idx || '-1');
          if (selected.has(idx)) {
            selected.delete(idx);
          } else if (selected.size < 2) {
            selected.add(idx);
          }
          refreshCards();
        });
      });
    };

    overlay.innerHTML = `
      <div class="game-modal" style="max-width:500px;max-height:70vh;overflow-y:auto;pointer-events:auto;">
        <h3>⚔ 丈八蛇矛 - 选择两张手牌合成【杀】</h3>
        <p style="font-size:12px;color:#aaa;">同色合成为对应花色【杀】，异色合成为无色【杀】</p>
        <div class="target-list zhanba-card-list" style="pointer-events:auto;"></div>
        <div style="text-align:center;margin-top:12px;display:flex;gap:8px;justify-content:center;">
          <button class="btn btn-primary btn-sm" id="zhanba-confirm" style="pointer-events:auto;" disabled>确认合成 (需选2张)</button>
          <button class="btn btn-ghost btn-sm" id="zhanba-cancel" style="pointer-events:auto;">取消</button>
        </div>
      </div>
    `;
    this.mountTableInteraction(overlay);

    refreshCards();
    overlay.querySelector('#zhanba-confirm')!.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (selected.size !== 2) return;
      const arr = Array.from(selected);
      if (!this.closeTableInteraction(overlay)) return;
      resolve([arr[0], arr[1]]);
    });

    overlay.querySelector('#zhanba-cancel')!.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (!this.closeTableInteraction(overlay)) return;
      resolve(null);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.stopPropagation();
        if (!this.closeTableInteraction(overlay)) return;
        resolve(null);
      }
    });
  }

  /** 装备区/判定区详细选择（顺手牵羊/过河拆桥用，需明示牌名） */
  showZoneDetailSelect(target: PlayerState, zone: 'equip' | 'judge', items: [string, Card][]): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.style.pointerEvents = 'auto';

    const equipTypeNames: Record<string, string> = {
      Weapon: '武器', Armor: '防具', OffensiveHorse: '进攻马', DefensiveHorse: '防御马', Treasure: '宝物',
    };

    const cardHtml = items.map(([slotKey, card], idx) => {
      const suitSym = SUIT_SYMBOL[card.suit] || '';
      const numText = NUMBER_TEXT[card.number] || String(card.number);
      const color = SUIT_COLOR[card.suit] || '#888';
      let label = getCardDetail(card);
      if (zone === 'equip') {
        label = `【${equipTypeNames[slotKey] || slotKey}】${getCardDetail(card)}`;
      } else {
        label = `【判定区 #${idx + 1}】${getCardDetail(card)}`;
      }
      return `
        <button class="target-btn zone-detail-btn" data-idx="${idx}" style="text-align:left;width:100%;pointer-events:auto;">
          ${label}
        </button>`;
    }).join('');

    overlay.innerHTML = `
      <div class="game-modal" style="max-width:420px;max-height:70vh;overflow-y:auto;pointer-events:auto;">
        <h3>选择 ${target.name} 的${zone === 'equip' ? '装备区' : '判定区'}牌</h3>
        <div class="target-list" style="pointer-events:auto;">${cardHtml}</div>
        <div style="text-align:center;margin-top:12px;">
          <button class="btn btn-ghost btn-sm" id="zone-detail-cancel" style="pointer-events:auto;">取消</button>
        </div>
      </div>
    `;
    this.mountTableInteraction(overlay);

    overlay.querySelectorAll('.zone-detail-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        const idx = parseInt((btn as HTMLElement).dataset.idx || '0');
        if (!this.closeTableInteraction(overlay)) return;
        this.humanDriver.resolveZone({ zone, index: idx });
      });
    });

    overlay.querySelector('#zone-detail-cancel')!.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (!this.closeTableInteraction(overlay)) return;
      this.humanDriver.resolveZone(null);
    });

    // 点击遮罩空白区域不做任何事，必须点击牌或取消按钮
    overlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.stopPropagation();
      }
    });
  }

  /** Shared discard selector: show the caller's effect and preserve the original card index space. */
  showDiscardMultiPrompt(state: PlayerState, count: number, resolve: (indices: number[]) => void,
    options: GameContextSnapshot['discardPrompt'] = {}): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    const selected = new Set<number>();

    const cardHtml = (c: Card, idx: number, label: string) => {
      const suitSym = SUIT_SYMBOL[c.suit] || '';
      const numText = NUMBER_TEXT[c.number] || String(c.number);
      const color = SUIT_COLOR[c.suit] || '#888';
      const sel = selected.has(idx);
      return `
        <button class="target-btn dm-card-btn${sel ? ' selected' : ''}" data-idx="${idx}" style="text-align:left;width:100%;">
          ${sel ? '✅ ' : ''}<span style="color:${color}">${suitSym}${numText}</span> ${c.name} <small style="color:#888;">(${label})</small>
        </button>`;
    };

    const handBtns = state.handCards.map((c, i) => cardHtml(c, i, '手牌')).join('');
    const equipCards = Object.entries(state.equipZone)
      .filter(([, v]) => v !== null) as [string, Card][];
    const equipBtns = options.handOnly ? '' : equipCards.map(([slot, c], i) =>
      options.excludedCardIds?.includes(c.id) ? '' : cardHtml(c, state.handCards.length + i, `装备-${slot}`)
    ).join('');

    overlay.innerHTML = `
      <div class="game-modal" style="max-width:420px;max-height:75vh;overflow-y:auto;">
        <h3></h3>
        <p style="color:#aaa;font-size:13px;">已选: <span id="dm-sel-count">0</span>/${count}</p>
        <div class="target-list">${handBtns}${equipBtns}</div>
        <div style="text-align:center;margin-top:12px;display:flex;gap:12px;justify-content:center;">
          <button class="btn btn-gold btn-sm" id="dm-confirm" disabled>确认</button>
          <button class="btn btn-ghost btn-sm" id="dm-cancel">自动选择</button>
        </div>
      </div>
    `;
    overlay.querySelector('h3')!.textContent = `${options.title || '弃牌'} - 选择 ${count} 张${options.handOnly ? '手牌' : '牌'}弃置`;

    const selCountEl = overlay.querySelector('#dm-sel-count')!;
    const confirmBtn = overlay.querySelector('#dm-confirm')! as HTMLButtonElement;

    const updateUI = () => {
      selCountEl.textContent = String(selected.size);
      confirmBtn.disabled = selected.size !== count;
      overlay.querySelectorAll('.dm-card-btn').forEach(btn => {
        const idx = parseInt((btn as HTMLElement).dataset.idx || '-1');
        if (selected.has(idx)) {
          btn.classList.add('selected');
          btn.innerHTML = btn.innerHTML.replace(/^(✅ )?/, '✅ ');
        } else {
          btn.classList.remove('selected');
          btn.innerHTML = btn.innerHTML.replace(/^✅ /, '');
        }
      });
    };

    overlay.querySelectorAll('.dm-card-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.idx || '-1');
        if (selected.has(idx)) {
          selected.delete(idx);
        } else if (selected.size < count) {
          selected.add(idx);
        }
        updateUI();
      });
    });

    confirmBtn.addEventListener('click', () => {
      if (selected.size === count) {
        if (!this.closeTableInteraction(overlay)) return;
        resolve(Array.from(selected));
      }
    });
    overlay.querySelector('#dm-cancel')!.addEventListener('click', () => { if (!this.closeTableInteraction(overlay)) return; resolve([]); });
    this.mountTableInteraction(overlay);
  }

  public graceOverlay: HTMLElement | null = null;
  private graceResolve: ((i: number) => void) | null = null;
  private allGraceCards: Card[] = [];
  // cardId -> pickerName 的映射
  private gracePickedMap: Map<number, string> = new Map();
  private isGraceHumanTurn = false;

  private completeGraceTable(): void {
    const completed = this.graceOverlay;
    this.session.setTimeout(() => {
      if (this.graceOverlay === completed) this.clearGraceCards();
    }, 1200);
  }

  /** 五谷丰登：一开始就展示所有牌 */
  private initGraceWindow(tableCards: Card[], allPlayerNames: string[]): void {
    this.clearGraceCards();
    this.allGraceCards = tableCards;
    this.gracePickedMap.clear();
    this.isGraceHumanTurn = false;

    const overlay = document.createElement('div');
    overlay.className = 'grace-table-layer';
    overlay.id = 'grace-overlay';
    overlay.setAttribute('aria-label', '五谷丰登公共牌桌');
    let cardsHtml = '';
    tableCards.forEach((c, i) => {
      cardsHtml += `<div class="grace-card-item" data-card-id="${c.id}" data-index="${i}">
        ${this.renderCardHtml(c)}
        <div class="grace-pick-label"></div>
      </div>`;
    });
    overlay.innerHTML = `
      <section class="grace-table-panel">
        <div class="grace-table-header"><h3>🌾 五谷丰登</h3><span>公共选牌 · 手牌可正常响应</span></div>
        <div class="grace-cards-row" id="grace-cards-row">${cardsHtml}</div>
        <div class="grace-status" id="grace-status">等待玩家选牌...</div>
      </section>
    `;
    this.gameMainEl.appendChild(overlay);
    this.gameMainEl.classList.add('has-grace-table');
    this.graceOverlay = overlay;
    this.positionGraceTable();
    window.addEventListener('resize', this.positionGraceTable);
  }

  private positionGraceTable = (): void => {
    const panel = this.graceOverlay?.querySelector<HTMLElement>('.grace-table-panel');
    if (!panel) return;
    const field = this.battlefieldEl.getBoundingClientRect();
    const root = this.gameMainEl.getBoundingClientRect();
    panel.style.left = (field.left - root.left + field.width / 2) + 'px';
    const row = this.battlefieldEl.querySelector('#top-row')?.getBoundingClientRect();
    const hand = this.el.querySelector('.player-zone')?.getBoundingClientRect();
    const gapTop = row ? row.bottom - root.top + 8 : field.top - root.top + 200;
    const gapBottom = hand ? hand.top - root.top - 8 : field.bottom - root.top;
    panel.style.top = ((gapTop + gapBottom) / 2) + 'px';
    this.graceOverlay!.dataset.compact = String(gapBottom - gapTop < 280);
    panel.style.width = Math.max(200, Math.min(660, field.width - 380)) + 'px';
  }

  /** 更新五谷丰登窗口中已选牌的状态 */
  private markGraceCardPicked(cardId: number, pickerName: string): void {
    if (!this.graceOverlay) return;
    this.gracePickedMap.set(cardId, pickerName);

    const cardEl = this.graceOverlay.querySelector(`.grace-card-item[data-card-id="${cardId}"]`) as HTMLElement | null;
    if (cardEl) {
      cardEl.classList.add('picked');
      const label = cardEl.querySelector('.grace-pick-label');
      if (label) {
        label.textContent = `${pickerName}已选`;
      }
    }
    // 更新状态提示
    const statusEl = this.graceOverlay.querySelector('#grace-status');
    if (statusEl) {
      statusEl.textContent = cardId < 0 ? `${pickerName} 跳过选牌` : `${pickerName} 已选择`;
    }
  }

  showGraceCards(tableCards: Card[], resolve: (i: number) => void): void {
    this.allGraceCards = tableCards;
    this.graceResolve = resolve;
    this.isGraceHumanTurn = true;

    if (!this.graceOverlay || !this.graceOverlay.parentElement) {
      this.initGraceWindow(tableCards, []);
      this.graceResolve = resolve;
      this.isGraceHumanTurn = true;
    }
    const status = this.graceOverlay?.querySelector('#grace-status');
    if (status) status.textContent = '轮到你选牌 · 点击一张公共牌';
    this.graceOverlay?.classList.add('is-picking');
    // 更新已选状态
    this.updateGracePickedVisuals();
    // 重新绑定未选牌的点击事件
    if (this.graceOverlay) this.bindGraceCardClicks(this.graceOverlay);
  }

  private updateGracePickedVisuals(): void {
    if (!this.graceOverlay) return;
    const items = this.graceOverlay.querySelectorAll('.grace-card-item');
    items.forEach(el => {
      const cardId = parseInt((el as HTMLElement).dataset.cardId || '0');
      const pickerName = this.gracePickedMap.get(cardId);
      if (pickerName) {
        el.classList.add('picked');
        const label = el.querySelector('.grace-pick-label');
        if (label) label.textContent = `${pickerName}已选`;
      }
    });
  }

  private bindGraceCardClicks(overlay: HTMLElement): void {
    overlay.querySelectorAll('.grace-card-item:not(.picked)').forEach(el => {
      // 先移除旧事件（通过克隆节点）
      const newEl = el.cloneNode(true) as HTMLElement;
      el.parentNode?.replaceChild(newEl, el);
      newEl.addEventListener('click', () => {
        const cardId = parseInt(newEl.dataset.cardId || '0');
        if (this.graceResolve) {
          const resolve = this.graceResolve;
          this.graceResolve = null;
          this.isGraceHumanTurn = false;
          this.graceOverlay?.classList.remove('is-picking');
          this.stopPVPCountdown();
          // 通过 cardId 在 allGraceCards 中查找真实索引（而非用 data-index，因为过滤后索引会变）
          const realIdx = this.allGraceCards.findIndex(c => c.id === cardId);
          resolve(realIdx >= 0 ? realIdx : 0);
        }
      });
    });
  }

  /** 外部事件：某张牌被选走 */
  onGraceCardPicked(cardId: number, pickerName: string): void {
    this.markGraceCardPicked(cardId, pickerName);
    // 更新可选牌状态
    this.updateGracePickedVisuals();
    if (this.graceOverlay && !this.isGraceHumanTurn) {
      // AI选牌后也更新点击事件（人类玩家选牌前需要）
      this.bindGraceCardClicks(this.graceOverlay);
    }
  }

  /** 五谷丰登结束后清理窗口 */
  clearGraceCards(): void {
    window.removeEventListener('resize', this.positionGraceTable);
    if (this.graceOverlay) {
      this.graceOverlay.remove();
      this.graceOverlay = null;
    }
    this.gameMainEl?.classList.remove('has-grace-table');
    this.graceResolve = null;
    this.gracePickedMap.clear();
    this.allGraceCards = [];
    this.isGraceHumanTurn = false;
  }

  /** 展示当前角色、公开状态与技能。 */
  showHeroInfoPopup(player: PlayerState, section?: string): void {
    const hero = getHeroById(player.heroId);
    if (!hero || !this.session.active) return;
    this.closeSeatRolePicker();
    this.closeHeroInfoPopup();

    const name = escapeSeatText(player.name);
    const equipment = SEAT_EQUIPMENT_SLOTS.map(({ slot, label }) => {
      const card = player.equipZone[slot];
      return `<li><span>${label}</span><strong>${card ? escapeSeatText(this.seatCardName(card)) : '空置'}</strong></li>`;
    }).join('');
    const conditions = this.getSeatConditions(player).map(label => `<li>${escapeSeatText(label)}</li>`).join('');
    const skills = hero.skills?.map(skill => `
      <article class="hero-dossier-skill">
        <h4>${escapeSeatText(skill.name)}</h4>
        <p>${escapeSeatText(skill.desc)}</p>
      </article>
    `).join('') || '<p class="hero-dossier-muted">暂无技能说明</p>';

    const isSelf = player.id === this.getHumanPlayer()?.id;
    const account = isSelf ? socketManager.account : null;
    const stats = (account as (typeof account & {
      stats?: Record<string, { games: number; wins: number } | number>;
    }))?.stats;
    const totalGames = Number(stats?.totalGames) || 0;
    const totalWins = Number(stats?.totalWins) || 0;
    const winRate = totalGames > 0 ? Math.round(totalWins * 100 / totalGames) : 0;
    const roleRates = ([
      ['monarch', '主公'], ['minister', '忠臣'], ['rebel', '反贼'], ['traitor', '内奸'],
    ] as const).map(([key, label]) => {
      const role = stats?.[key];
      const rate = typeof role === 'object' && role.games > 0 ? Math.round(role.wins * 100 / role.games) : 0;
      return `<span>${label} ${rate}%</span>`;
    }).join('');
    const playerLabel = escapeSeatText(player.playerName || player.name);
    const accountAvatar = account?.avatar
      ? `<img class="hero-dossier-avatar" src="${escapeSeatText(account.avatar)}" alt="" onerror="this.hidden=true">`
      : '';

    const dialog = document.createElement('dialog');
    dialog.className = 'hero-dossier';
    dialog.id = 'hero-info-overlay';
    dialog.setAttribute('aria-labelledby', 'hero-dossier-title');
    dialog.innerHTML = `
      <header class="hero-dossier-header">
        <div>
          <h2 id="hero-dossier-title">${name}${hero.isGod ? '<span class="hero-dossier-god">神</span>' : ''}</h2>
          <p>${escapeSeatText([hero.title, hero.region, hero.element, hero.gender === 'male' ? '男' : '女'].filter(Boolean).join(' · '))}</p>
        </div>
        <button type="button" class="hero-dossier-close" id="hero-info-close" aria-label="关闭角色详情">×</button>
      </header>
      <div class="hero-dossier-scroll" tabindex="0" aria-label="角色详情内容">
        <div class="hero-dossier-layout">
          <aside class="hero-dossier-aside">
            <div class="hero-dossier-art">
              <img src="Resources/Characters/${name}.png" alt="${name}" onerror="this.hidden=true;this.nextElementSibling.hidden=false">
              <span hidden>${name}</span>
            </div>
            <div class="hero-dossier-player">
              ${accountAvatar}
              <div><strong>${playerLabel}${isSelf ? '（你）' : ''}</strong>
                <span>${escapeSeatText(this.getSeatRoleLabel(player))}${account ? ` · Lv.${Number(account.level) || 1}` : ''}</span>
              </div>
            </div>
            <dl class="hero-dossier-metrics">
              <div><dt>体力</dt><dd>${player.hp}/${player.maxHp}</dd></div>
              <div><dt>手牌</dt><dd>${player.handCards.length} 张</dd></div>
              <div><dt>武将牌扣置</dt><dd>${this.getSeatAttachedCardCount(player)} 张</dd></div>
            </dl>
            ${account ? `<section class="hero-dossier-record">
              <h3>玩家战绩</h3>
              <p>${totalGames} 场 · ${totalWins} 胜 · 胜率 ${winRate}%</p>
              <div class="hero-dossier-rates">${roleRates}</div>
              <p>PVE 累计 ${Object.values(getPVEStarRecords()).reduce((sum, value) => sum + value, 0)} 星</p>
            </section>` : ''}
          </aside>
          <div class="hero-dossier-detail">
            <section data-dossier-section="equipment">
              <h3>装备</h3>
              <ul class="hero-dossier-equipment">${equipment}</ul>
            </section>
            <section data-dossier-section="conditions">
              <h3>状态与判定</h3>
              ${conditions ? `<ul class="hero-dossier-conditions">${conditions}</ul>` : '<p class="hero-dossier-muted">当前无状态或判定牌</p>'}
            </section>
            <section>
              <h3>角色技能</h3>
              <div class="hero-dossier-skills">${skills}</div>
            </section>
          </div>
        </div>
      </div>
    `;
    this.mountTransient(dialog);
    const close = dialog.querySelector<HTMLButtonElement>('#hero-info-close')!;
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      this.transientElements.delete(dialog);
    }, { once: true });
    dialog.showModal();
    close.focus({ preventScroll: true });
    if (section === 'equipment' || section === 'conditions') {
      dialog.querySelector(`[data-dossier-section="${section}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  closeHeroInfoPopup(): void {
    const dialog = document.getElementById('hero-info-overlay') as HTMLDialogElement | null;
    if (!dialog) return;
    dialog.close();
    dialog.remove();
    this.transientElements.delete(dialog);
  }

  showGenderWeaponPrompt(attackerName: string, resolve: (v: 'discard' | 'draw') => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.innerHTML = `
      <div class="game-modal">
        <h3>雌雄双股剑 - ${attackerName} 对你发动效果</h3>
        <div style="display:flex;gap:12px;justify-content:center;margin-top:16px;">
          <button class="btn btn-gold btn-sm" id="gw-discard">弃置一张手牌</button>
          <button class="btn btn-gold btn-sm" id="gw-draw">让 ${attackerName} 摸一张牌</button>
        </div>
      </div>
    `;
    overlay.querySelector('#gw-discard')!.addEventListener('click', () => { if (!this.closeTableInteraction(overlay)) return; resolve('discard'); });
    overlay.querySelector('#gw-draw')!.addEventListener('click', () => { if (!this.closeTableInteraction(overlay)) return; resolve('draw'); });
    this.mountTableInteraction(overlay);
  }

  // ======================== 战场渲染 ========================

  /** 玩家换座后仍按身份标识找到本机角色。 */
  private getHumanPlayer(): PlayerState | undefined {
    if (this.pveLevel) return this.players.find(player => player.id === 0);
    if (this.mode === 'pvp' && this.pvpMyPlayerId >= 0) return this.players.find(player => player.id === this.pvpMyPlayerId);
    return this.players[this.humanPlayerIdx];
  }

  private getBattlefieldLayout(self: PlayerState): { top: PlayerState[]; left: PlayerState[]; right: PlayerState[] } {
    const players = this.players;
    const selfIndex = players.indexOf(self);
    const otherSeats = players.slice(selfIndex + 1).concat(players.slice(0, selfIndex));
    const sideSeats = players.length >= 7 ? 2 : players.length >= 4 ? 1 : 0;
    const endOfTop = otherSeats.length - sideSeats;
    // 玩家数组与距离计算使用同一座次。右侧由下往上，顶部由右往左，左侧由上往下。
    return {
      right: otherSeats.slice(0, sideSeats).reverse(),
      top: otherSeats.slice(sideSeats, endOfTop).reverse(),
      left: otherSeats.slice(endOfTop),
    };
  }
  private renderBattlefield(): void {
    const self = this.getHumanPlayer();
    if (!self) return;
    const layout = this.getBattlefieldLayout(self);
    this.battlefieldEl.classList.toggle('pve-compact-layout', !!this.pveLevel && this.players.length < 8);
    const topRow = this.el.querySelector('#top-row')!;
    const leftCol = this.el.querySelector('#left-col')!;
    const rightCol = this.el.querySelector('#right-col')!;
    const selfSeat = this.el.querySelector('#seat-self')!;

    topRow.innerHTML = layout.top.map(player => this.renderSeatCard(player)).join('');
    leftCol.innerHTML = layout.left.map(player => this.renderSeatCard(player)).join('');
    rightCol.innerHTML = layout.right.map(player => this.renderSeatCard(player)).join('');
    selfSeat.innerHTML = this.renderSeatCard(self);

    // 绑定点击事件
    this.el.querySelectorAll('.seat-card').forEach(el => {
      el.addEventListener('click', (e) => {
        const pid = parseInt((el as HTMLElement).dataset.playerId || '-1');
        const target = e.target as HTMLElement;
        if (target.closest('[data-seat-role-player]')) {
          e.stopPropagation();
          const player = this.players.find(p => p.id === pid);
          if (player) this.openSeatRolePicker(player);
          return;
        }
        // zone-highlight状态下的点击由highlightZones中的zone-selector处理
        if (el.classList.contains('zone-highlight')) return;
        if (el.classList.contains('targetable') && pid >= 0) {
          e.stopPropagation();
          this.clearHighlights();
          this.humanDriver.resolveTarget(pid);
          this.hidePrompt();
          return;
        }
        const detail = target.closest<HTMLElement>('[data-seat-detail]');
        if (!detail || pid < 0) return;
        const player = this.players.find(p => p.id === pid);
        if (player) this.showHeroInfoPopup(player, detail.dataset.seatDetail);
      });
    });

    this.positionSeatRolePicker();
    this.renderHandCards();
    this.renderEquipDisplay();
    this.renderSkills();
  }

  private getSeatRoleLabel(player: PlayerState): string {
    if (this.mode === 'pve') {
      if (player.faction === Faction.Ally) return '友';
      if (player.faction === Faction.Enemy) return '敌';
    }
    if (this.canMarkSeatRole(player)) {
      const mark = this.seatRoleMarks.get(player.id);
      return mark ? `推测：${SEAT_ROLE_MARKS[mark]}` : '未知';
    }
    return getRoleChineseName(player.role);
  }

  private canMarkSeatRole(player: PlayerState): boolean {
    return this.mode === 'pvp' && !this.isGameOver && !player.isDead
      && player.id !== this.pvpMyPlayerId && player.role !== RoleType.Monarch;
  }

  private getSeatRoleButtonLabel(player: PlayerState): string {
    return `标记${player.name}的身份（${this.getSeatRoleLabel(player)}）`;
  }

  private getSeatRoleButton(playerId: number): HTMLButtonElement | null {
    return this.el.querySelector<HTMLButtonElement>(`[data-seat-role-player="${playerId}"]`);
  }

  private openSeatRolePicker(player: PlayerState): void {
    const alreadyOpen = this.seatRolePicker?.dataset.playerId === String(player.id);
    this.closeSeatRolePicker();
    if (alreadyOpen || !this.session.active || !this.canMarkSeatRole(player)) return;

    const picker = document.createElement('div');
    picker.className = 'seat-role-picker';
    picker.dataset.playerId = String(player.id);
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', `标记${player.name}的身份`);
    const usePopover = typeof picker.showPopover === 'function';
    if (usePopover) picker.setAttribute('popover', 'manual');
    const mark = this.seatRoleMarks.get(player.id);
    picker.innerHTML = `
      <strong>身份标记</strong>
      <div class="seat-role-options">
        ${(Object.keys(SEAT_ROLE_MARKS) as SeatRoleMark[]).map(option =>
          `<button type="button" data-mark="${option}" aria-pressed="${option === mark}" title="${SEAT_ROLE_MARKS[option]}">${option}</button>`
        ).join('')}
        <button type="button" data-mark="" class="seat-role-clear">清除标记</button>
      </div>`;

    const events = new AbortController();
    this.seatRolePicker = picker;
    this.seatRolePickerEvents = events;
    this.mountTransient(picker);
    if (usePopover) picker.showPopover();
    this.positionSeatRolePicker();
    this.getSeatRoleButton(player.id)?.setAttribute('aria-expanded', 'true');
    (picker.querySelector<HTMLButtonElement>('[aria-pressed="true"]') || picker.querySelector('button'))?.focus({ preventScroll: true });

    picker.addEventListener('click', event => {
      const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mark]');
      const currentPlayer = this.players.find(candidate => candidate.id === player.id);
      if (!option || !currentPlayer || !this.canMarkSeatRole(currentPlayer)) return;
      const value = option.dataset.mark as SeatRoleMark | '';
      if (value) this.seatRoleMarks.set(player.id, value);
      else this.seatRoleMarks.delete(player.id);
      const trigger = this.getSeatRoleButton(player.id);
      if (trigger) {
        trigger.dataset.mark = value;
        trigger.textContent = value || '？';
        trigger.title = this.getSeatRoleButtonLabel(currentPlayer);
        trigger.setAttribute('aria-label', trigger.title);
      }
      this.closeSeatRolePicker(true);
    }, { signal: events.signal });
    document.addEventListener('pointerdown', event => {
      const target = event.target as HTMLElement;
      if (!picker.contains(target) && !this.getSeatRoleButton(player.id)?.contains(target)) this.closeSeatRolePicker();
    }, { signal: events.signal });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.closeSeatRolePicker(true);
    }, { capture: true, signal: events.signal });
    window.addEventListener('resize', this.positionSeatRolePicker, { signal: events.signal });
    this.el.addEventListener('scroll', this.positionSeatRolePicker, { passive: true, signal: events.signal });
  }

  private positionSeatRolePicker = (): void => {
    const picker = this.seatRolePicker;
    if (!picker) return;
    const trigger = this.getSeatRoleButton(Number(picker.dataset.playerId));
    if (!trigger) {
      this.closeSeatRolePicker();
      return;
    }
    const anchor = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    if (anchor.right <= 0 || anchor.left >= viewportWidth || anchor.bottom <= 0 || anchor.top >= viewportHeight) {
      this.closeSeatRolePicker();
      return;
    }
    picker.style.left = `${Math.max(8, Math.min(anchor.left, viewportWidth - picker.offsetWidth - 8))}px`;
    picker.style.top = `${anchor.bottom + picker.offsetHeight + 6 < viewportHeight ? anchor.bottom + 5 : Math.max(8, anchor.top - picker.offsetHeight - 5)}px`;
  };

  private closeSeatRolePicker(restoreFocus = false): void {
    const picker = this.seatRolePicker;
    if (!picker) return;
    this.seatRolePicker = null;
    this.seatRolePickerEvents?.abort();
    this.seatRolePickerEvents = null;
    picker.remove();
    this.transientElements.delete(picker);
    const trigger = this.getSeatRoleButton(Number(picker.dataset.playerId));
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  }

  private renderSeatRoleChip(player: PlayerState): string {
    if (!this.canMarkSeatRole(player)) {
      const roleLabel = escapeSeatText(this.getSeatRoleLabel(player));
      const identity = this.mode === 'pvp' && roleLabel !== '未知'
        ? `data-role="${player.role}"` : `data-faction="${player.faction || ''}"`;
      return `<span class="seat-role-chip" ${identity}>${roleLabel}</span>`;
    }
    const label = escapeSeatText(this.getSeatRoleButtonLabel(player));
    const mark = this.seatRoleMarks.get(player.id) || '';
    const expanded = this.seatRolePicker?.dataset.playerId === String(player.id);
    return `<button type="button" class="seat-role-chip seat-role-mark" data-seat-role-player="${player.id}"
      data-mark="${mark}" aria-haspopup="dialog" aria-expanded="${expanded}" aria-label="${label}" title="${label}">${mark || '？'}</button>`;
  }

  private seatCardName(card: Card): string {
    return `${card.name} ${this.suitDetail(card)}`;
  }

  private getSeatAttachedCardCount(player: PlayerState): number {
    return player.attachedCardCount ?? this.skillManager?.getAttachedCardCount?.(player) ?? 0;
  }

  /** 技能存入或取回扣置牌可能只发纪事，直接更新座位计数以保留当前交互。 */
  private refreshSeatAttachedCounts(): void {
    this.battlefieldEl?.querySelectorAll<HTMLElement>('.seat-card').forEach(seat => {
      const player = this.players.find(p => p.id === Number(seat.dataset.playerId));
      const badge = seat.querySelector<HTMLElement>('.seat-attached-count');
      if (!player || !badge) return;
      const count = this.getSeatAttachedCardCount(player);
      if (badge.dataset.count === String(count)) return;
      badge.dataset.count = String(count);
      badge.textContent = `扣置 ${count} 张`;
      badge.hidden = count === 0;
      const hand = seat.querySelector<HTMLElement>('.seat-hand-number');
      if (hand) {
        hand.textContent = `${player.handCards.length} 手牌`;
        hand.setAttribute('aria-label', `手牌 ${player.handCards.length} 张`);
      }
      if (player.id === this.getHumanPlayer()?.id) this.renderHandCards();
    });
  }

  private renderEquipRank(card: Card): string {
    return `<span class="equip-card-rank" data-suit="${card.suit}" aria-hidden="true">${this.suitDetail(card)}</span>`;
  }

  private renderSeatCard(player: PlayerState): string {
    const isHuman = player.id === this.getHumanPlayer()?.id;
    const hero = getHeroById(player.heroId);
    const name = escapeSeatText(player.name);
    const owner = isHuman ? '你' : escapeSeatText(player.playerName || player.name);
    const hpPercent = player.maxHp > 0 ? Math.min(100, Math.max(0, player.hp / player.maxHp * 100)) : 0;
    const hpClass = hpPercent > 60 ? 'high' : hpPercent > 30 ? 'medium' : 'low';
    const currentTurn = player.id === this.currentTurnPlayerId && !player.isDead;
    const lifeClass = player.isDead ? 'fallen' : player.hp <= 0 ? 'dying' : 'acting';
    const lifeLabel = player.isDead ? '已退场' : player.hp <= 0 ? '濒死 · 待援' : currentTurn ? '当前回合' : '';
    const equipment = SEAT_EQUIPMENT_SLOTS.map(({ slot, label }) => {
      const card = player.equipZone[slot];
      const detail = escapeSeatText(card ? `${label}：${this.seatCardName(card)}` : `${label}：空置`);
      return `<button type="button" class="seat-summary seat-equip-cell${card ? ' has-items' : ''}"
                data-seat-detail="equipment" title="${detail}" aria-label="${name}的${detail}">
        <span class="seat-equip-name">${escapeSeatText(card?.name || label)}</span>${card ? this.renderEquipRank(card) : ''}
      </button>`;
    }).join('');
    const conditions = this.getSeatConditions(player);
    const conditionDetail = escapeSeatText(conditions.join('\n') || '无');
    const attachedCount = this.getSeatAttachedCardCount(player);
    return `
      <div class="seat">
        <div class="seat-card${player.isDead ? ' dead' : ''}${isHuman ? ' human' : ' ai'}${currentTurn ? ' current-turn' : ''}${!player.isDead && player.hp <= 1 ? ' critical-hp' : ''}"
             data-player-id="${player.id}">
          <div class="seat-portrait">
            <button type="button" class="seat-char-img" data-seat-detail="overview" aria-label="查看${name}详情">
              <img src="Resources/Characters/${name}.png" alt="${name}"
                   onerror="this.hidden=true;this.nextElementSibling.hidden=false" loading="lazy">
              <span class="seat-art-fallback" hidden>${name}</span>
            </button>
            ${this.renderSeatRoleChip(player)}
            ${lifeLabel ? `<span class="seat-state-label ${lifeClass}">${lifeLabel}</span>` : ''}
          </div>
          <div class="seat-identity">
            <strong class="seat-name" title="${name}">${name}</strong>
            <span class="seat-owner" title="${owner}">${owner}${hero?.element ? ` · ${escapeSeatText(hero.element)}` : ''}</span>
          </div>
          <div class="seat-meter">
            <span class="seat-hp-number" aria-label="体力 ${player.hp}/${player.maxHp}"><span aria-hidden="true">♥</span> ${player.hp}/${player.maxHp}</span>
            <div class="seat-hp" aria-hidden="true"><div class="seat-hp-fill ${hpClass}" style="width:${hpPercent}%"></div></div>
            <span class="seat-card-counts">
              <span class="seat-attached-count" data-count="${attachedCount}" title="扣置在武将牌上的牌"${attachedCount ? '' : ' hidden'}>扣置 ${attachedCount} 张</span>
              <span class="seat-hand-number" title="手牌" aria-label="手牌 ${player.handCards.length} 张">${player.handCards.length} 手牌</span>
            </span>
          </div>
          <div class="seat-summary-tray">
            <div class="seat-equip-grid" role="group" aria-label="装备">${equipment}</div>
            <button type="button" class="seat-summary${conditions.length ? ' has-items' : ''}"
                    data-seat-detail="conditions" title="${conditionDetail}" aria-label="${name}的状态：${conditionDetail}">
              <span class="seat-summary-label">状态</span>
              <span class="seat-summary-value">${escapeSeatText(conditions[0] || '无')}</span>
              ${conditions.length > 1 ? `<span class="seat-summary-count">+${conditions.length - 1}</span>` : ''}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /** 卡片摘要与详情共用同一份公开状态。 */
  private getSeatConditions(player: PlayerState): string[] {
    const data = this.skillManager?.getData(player.id) || {};
    const publicData = player as PlayerState & Record<string, any>;
    const conditions: string[] = [];
    if (player.isFlipped) conditions.push('翻面');
    if (player.isChained) conditions.push('铁索连环');
    for (const card of player.judgeZone) conditions.push(`判定 · ${this.seatCardName(card)}`);

    const counters: [string, number][] = [
      ['玉璋标记', data.jadeCount || publicData._jadeCount || 0],
      ['无想标记', data.musouCount || publicData._musouCount || 0],
      ['空月标记', data.emptyMoonCount || publicData._emptyMoonCount || 0],
      ['霜月标记', data.frostMoonCount || publicData._frostMoonCount || 0],
      ['枫', data.mapleLeaves?.length || publicData._mapleLeaves || 0],
      ['知论牌', data.knowledgeCards?.length || publicData._knowledgeCards || 0],
      ['冰翎标记', data.iceFeatherCount || publicData._iceFeatherCount || 0],
    ];
    for (const [label, count] of counters) {
      if (count > 0) conditions.push(`${label} ${count}`);
    }
    if (data.hasFireworkMark || publicData._hasFireworkMark) conditions.push('烟花标记');
    if (data.leaderActive || publicData._leaderActive) {
      conditions.push(`领袖（已受 ${data.leaderDamageTaken || publicData._leaderDamageTaken || 0}/2 点伤害）`);
    }
    if (data.butterflyActive || publicData._butterflyActive) conditions.push('幽蝶（伤害 +1）');
    const stance = data.nilouStance || publicData._nilouStance;
    if (stance) conditions.push(`莲步 · ${stance}`);
    const partner = this.players.find(p => p.id === (data.contractPartnerId ?? publicData._contractPartnerId));
    if (partner) conditions.push(`契约 · ${partner.name}`);
    const sealedSuits = data.sealedSuits || publicData._sealedSuits;
    const sealed = Array.isArray(sealedSuits)
      ? sealedSuits
      : Object.keys(sealedSuits || {}).filter(suit => sealedSuits[suit]);
    if (sealed.length) conditions.push(`封印花色 · ${sealed.map(suit => SUIT_SYMBOL[suit] || suit).join(' ')}`);
    if (data.mercenaryActive || publicData._mercenaryActive) {
      const target = this.players.find(p => p.id === (data.mercenaryTargetId ?? publicData._mercenaryTargetId));
      if (target) conditions.push(`佣兵 · 保护${target.name}`);
    }
    for (const other of this.players) {
      if (other.id === player.id || other.isDead) continue;
      const otherData = this.skillManager?.getData(other.id) || {};
      const publicOther = other as PlayerState & Record<string, any>;
      if ((otherData.mercenaryActive || publicOther._mercenaryActive)
          && (otherData.mercenaryTargetId ?? publicOther._mercenaryTargetId) === player.id) {
        conditions.push(`受${other.name}的佣兵保护`);
      }
    }
    return conditions;
  }

  private suitDetail(c: Card): string {
    const suitSym = SUIT_SYMBOL[c.suit] || '';
    const numText = NUMBER_TEXT[c.number] || String(c.number);
    return `${suitSym}${numText}`;
  }

  /** 渲染手牌（真实卡牌图片 - 底部横排大卡牌） */
  private renderHandCards(): void {
    const me = this.getHumanPlayer()!;
    if (!me) return;

    this.handCardsEl.innerHTML = '';

    // 检查契约关系
    const myData = (this.skillManager as any)?.getData?.(me.id) || {};
    const contractPartnerId = myData.contractPartnerId;
    let partner: PlayerState | undefined;
    if (contractPartnerId !== undefined) {
      partner = this.players.find(p => p.id === contractPartnerId);
    }

    if (partner && (partner.handCards.length > 0 || me.handCards.length > 0)) {
      // 契约模式：两个独立可滚动的面板，左右分区不重叠
      const wrapper = document.createElement('div');
      wrapper.className = 'contract-hand-wrapper';
      wrapper.style.cssText = 'display:flex;width:100%;gap:0;height:100%;';

      // ===== 左面板：自己的牌 =====
      const leftPanel = document.createElement('div');
      leftPanel.className = 'contract-panel contract-panel-self';
      leftPanel.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;border-right:2px solid var(--border-color);';
      const leftHeader = document.createElement('div');
      leftHeader.className = 'contract-panel-header';
      leftHeader.textContent = '我的手牌';
      leftHeader.style.cssText = 'font-size:10px;color:var(--text-secondary);text-align:center;padding:2px 0;flex-shrink:0;background:rgba(255,255,255,.03);';
      leftPanel.appendChild(leftHeader);
      const leftScroll = document.createElement('div');
      leftScroll.className = 'contract-panel-scroll';
      leftScroll.style.cssText = 'display:flex;gap:4px;overflow-x:auto;overflow-y:hidden;align-items:center;flex:1;padding:2px 4px;scrollbar-width:thin;';
      me.handCards.forEach((card, i) => {
        const cardEl = document.createElement('div');
        cardEl.className = 'game-card';
        cardEl.dataset.cardIndex = String(i);
        cardEl.dataset.cardSource = 'self';
        cardEl.innerHTML = this.renderCardHtml(card);
        leftScroll.appendChild(cardEl);
      });
      // 莉奈娅-谶鸟：牌堆顶可见
      this.appendLyneyaTopCard(leftScroll, me);
      leftPanel.appendChild(leftScroll);
      wrapper.appendChild(leftPanel);

      // ===== 右面板：契约对象的牌 =====
      const rightPanel = document.createElement('div');
      rightPanel.className = 'contract-panel contract-panel-partner';
      rightPanel.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;background:rgba(255,152,0,.04);';
      const rightHeader = document.createElement('div');
      rightHeader.className = 'contract-panel-header';
      rightHeader.textContent = `契约 · ${partner.name}的手牌`;
      rightHeader.style.cssText = 'font-size:10px;color:#ff9800;text-align:center;padding:2px 0;flex-shrink:0;background:rgba(255,152,0,.06);';
      rightPanel.appendChild(rightHeader);
      const rightScroll = document.createElement('div');
      rightScroll.className = 'contract-panel-scroll';
      rightScroll.style.cssText = 'display:flex;gap:4px;overflow-x:auto;overflow-y:hidden;align-items:center;flex:1;padding:2px 4px;scrollbar-width:thin;';
      partner.handCards.forEach((card, i) => {
        const cardEl = document.createElement('div');
        cardEl.className = 'game-card contract-partner-card';
        cardEl.dataset.cardIndex = String(i);
        cardEl.dataset.cardSource = 'partner';
        cardEl.innerHTML = this.renderCardHtml(card);
        cardEl.style.position = 'relative';
        // 添加契约角标
        const badge = document.createElement('div');
        badge.className = 'contract-partner-badge';
        badge.textContent = '🤝';
        badge.style.cssText = 'position:absolute;top:1px;right:1px;font-size:10px;z-index:3;pointer-events:none;';
        cardEl.appendChild(badge);
        rightScroll.appendChild(cardEl);
      });
      rightPanel.appendChild(rightScroll);
      wrapper.appendChild(rightPanel);

      this.handCardsEl.appendChild(wrapper);
    } else {
      // 常规模式：只显示自己的牌
      me.handCards.forEach((card, i) => {
        const cardEl = document.createElement('div');
        cardEl.className = 'game-card';
        cardEl.dataset.cardIndex = String(i);
        cardEl.dataset.cardSource = 'self';
        cardEl.innerHTML = this.renderCardHtml(card);
        this.handCardsEl.appendChild(cardEl);
      });
      // 莉奈娅-谶鸟：牌堆顶可见
      this.appendLyneyaTopCard(this.handCardsEl, me);
    }
  }

  /** 莉奈娅-谶鸟：在手牌区最右边显示牌堆顶牌（仅可见，不可打出） */
  private appendLyneyaTopCard(parent: HTMLElement, me: PlayerState): void {
    if (me.heroId !== 'lyneya') return;
    // 优先使用 GamePage 的 skillManager，如果没有则尝试 flowController 的
    const sm = this.skillManager || (this.flowController as any)?.skillManager;
    if (!sm) return;
    const topCard = (sm as any).getLyneyaTopCard?.(me);
    if (!topCard) return;

    // 取出已有的谶鸟牌，避免重复添加
    const existing = parent.querySelector('.omen-card');
    if (existing) existing.remove();

    const cardEl = document.createElement('div');
    cardEl.className = 'game-card omen-card';
    cardEl.dataset.cardSource = 'omen';
    cardEl.style.cssText = 'opacity:0.55;border:1px dashed var(--gold-dim);cursor:default;pointer-events:none;';
    cardEl.innerHTML = this.renderCardHtml(topCard);
    // 添加谶鸟标记
    const badge = document.createElement('div');
    badge.className = 'omen-bird-badge';
    badge.textContent = '🐦';
    badge.style.cssText = 'position:absolute;top:1px;right:1px;font-size:10px;z-index:3;pointer-events:none;';
    cardEl.style.position = 'relative';
    cardEl.appendChild(badge);
    parent.appendChild(cardEl);
  }

  /** 渲染单张卡牌的HTML（使用Resources/Cards下的真实图片） */
  private renderCardHtml(card: Card): string {
    const fileName = CARD_FILE_NAME_MAP[card.name] || card.name;
    const cardImgSrc = `Resources/Cards/${fileName}.png`;
    const suitImgSrc = `Resources/Suits/${card.suit}.png`;
    const numText = NUMBER_TEXT[card.number] || String(card.number);
    const suitSym = SUIT_SYMBOL[card.suit] || '';
    const suitColor = SUIT_COLOR[card.suit] || '#888';
    const typeLabel = card.type === 'Basic' ? '基本' : card.type === 'Magic' ? '锦囊' : '装备';

    return `
      <div class="card-img-wrap">
        <img src="${cardImgSrc}" alt="${card.name}" class="card-bg-img"
             onerror="this.style.display='none';this.parentElement.querySelector('.card-fallback').style.display='flex';">
        <div class="card-fallback" style="display:none;">
          <div class="card-fb-name">${card.name}</div>
        </div>
      </div>
      <div class="card-overlay">
        <span class="card-suit-icon" style="color:${suitColor}">${suitSym}</span>
        <span class="card-number-text" style="color:${suitColor}">${numText}</span>
      </div>
      <div class="card-type-badge">${typeLabel}</div>
    `;
  }

  /** 渲染装备区（底部player-zone内） */
  private renderEquipDisplay(): void {
    const me = this.getHumanPlayer()!;
    if (!me) return;

    const slots: { label: string; card: Card | null; key: EquipmentType }[] = [
      { label: '武器', card: me.equipZone[EquipmentType.Weapon], key: EquipmentType.Weapon },
      { label: '防具', card: me.equipZone[EquipmentType.Armor], key: EquipmentType.Armor },
      { label: '+1马', card: me.equipZone[EquipmentType.DefensiveHorse], key: EquipmentType.DefensiveHorse },
      { label: '-1马', card: me.equipZone[EquipmentType.OffensiveHorse], key: EquipmentType.OffensiveHorse },
    ];

    this.equipDisplayEl.innerHTML = slots.map(s => {
      if (s.card) {
        const fileName = CARD_FILE_NAME_MAP[s.card.name] || s.card.name;
        const imgSrc = `Resources/Cards/${fileName}.png`;
        const detail = escapeSeatText(this.seatCardName(s.card));
        return `<div class="equip-slot filled" title="${detail}">
          <img src="${imgSrc}" alt="${detail}">
          ${this.renderEquipRank(s.card)}
        </div>`;
      }
      return `<div class="equip-slot empty"><span>${s.label}</span></div>`;
    }).join('');
  }

  /** 渲染技能区（底部右侧独立技能列：显示所有技能） */
  private renderSkills(): void {
    const me = this.getHumanPlayer()!;
    if (!me) return;

    const hero = getHeroById(me.heroId);
    if (!hero || !hero.skills) {
      if (this.skillAreaEl) this.skillAreaEl.innerHTML = '';
      return;
    }

    const ctx = {
      players: this.players,
      roundCount: this.flowController?.roundCount || 0,
      currentTurn: this.flowController?.currentTurnInRound || 0,
      currentPlayerId: this.currentTurnPlayerId,
      gameOverWinner: null,
      drawPileCount: this.deck?.drawPileCount || 0,
      discardPileCount: this.deck?.discardPile?.length || 0,
    };

    // 通过skillManager获取技能可用性（如果已初始化）
    const sm = this.skillManager || (this.flowController as any)?.skillManager;
    const skillInfos = sm?.getSkills(me, ctx) || hero.skills.map(s => {
      // PVP模式或无skillManager时，根据hero数据构建技能信息
      // type从SkillManager的注册反查，fallback中使用hero.skills的name匹配常用类型
      const knownTypes: Record<string, string> = {
        '自由': 'active', '高天': 'trigger', '吟游': 'active',
        '契约': 'trigger', '玉璋': 'passive', '闲游': 'active',
        '永恒': 'passive', '御决': 'active', '无想': 'trigger',
        '幻梦': 'trigger', '智慧': 'passive', '比喻': 'active', '囚笼': 'trigger',
        '歌颂': 'trigger', '罪舞': 'trigger', '独舞': 'active',
        '战争': 'passive', '圣火': 'active', '领袖': 'trigger',
        '少女': 'trigger', '月神': 'trigger',
        '天权': 'active', '回火': 'active', '代理': 'active', '炸鱼': 'active',
        '知论': 'active', '庇笛': 'active', '狐魅': 'active', '军师': 'active',
        '佣兵': 'active', '红枫': 'active', '赤鬼': 'active', '工匠': 'active',
        '祝福': 'active', '超越': 'active', '调停': 'active', '北风': 'active',
        '远征': 'active', '写信': 'active', '破镜': 'active', '炼金': 'active',
      };
      const skillType = knownTypes[s.name] || 'trigger';
      return {
        id: `${me.heroId}_${s.name}`, name: s.name, description: s.desc,
        type: skillType,
        usable: (p: any, c: any) => {
          // PVP/无SkillManager时：当前是玩家回合且技能是active类型即可用
          if (skillType === 'active' && c && p.id === c.currentPlayerId) return true;
          return false;
        },
      };
    });

    // 底部右侧技能区：显示所有技能（主动可点击，被动/触发/限定显示标签）
    if (this.skillAreaEl) {
      if (skillInfos.length > 0) {
        this.skillAreaEl.innerHTML = skillInfos.map((si: { id: string; name: string; description: string; type: string; usable: (p: any, c: any) => boolean }) => {
          const isActive = si.type === 'active';
          const canUse = !this.isGameOver && isActive && si.usable(me, ctx);
          const typeLabel = si.type === 'passive' ? '被动' :
            si.type === 'limited' ? '限定' :
            si.type === 'trigger' ? '触发' : '';
          return `<div class="skill-btn ${isActive ? (canUse ? 'active' : 'dim') : 'dim'}"
            data-skill-id="${si.id}" title="${si.description}">
            <span>${si.name}</span>
            ${typeLabel ? `<span class="skill-passive-tag">${typeLabel}</span>` : ''}
          </div>`;
        }).join('');
        // 丈八蛇矛：装备技能入口（移至技能区）
        const zhanbaWeapon = me.equipZone[EquipmentType.Weapon];
        if (zhanbaWeapon?.name === '丈八蛇矛' && me.handCards.length >= 2) {
          skillInfos.push({
            id: 'equip_zhanba', name: '丈八', description: '将两张手牌当【杀】使用或打出',
            type: 'active', usable: () => true,
          } as any);
        }
        this.skillAreaEl.innerHTML = skillInfos.map((si: { id: string; name: string; description: string; type: string; usable: (p: any, c: any) => boolean }) => {
          const isActive = si.type === 'active';
          const canUse = !this.isGameOver && isActive && si.usable(me, ctx);
          const typeLabel = si.type === 'passive' ? '被动' :
            si.type === 'limited' ? '限定' :
            si.type === 'trigger' ? '触发' : '';
          return `<div class="skill-btn ${isActive ? (canUse ? 'active' : 'dim') : 'dim'}"
            data-skill-id="${si.id}" title="${si.description}">
            <span>${si.name}</span>
            ${typeLabel ? `<span class="skill-passive-tag">${typeLabel}</span>` : ''}
          </div>`;
        }).join('');
        // 绑定主动技能点击
        this.skillAreaEl.querySelectorAll('.skill-btn.active').forEach(el => {
          (el as HTMLElement).addEventListener('click', (e) => {
            e.stopPropagation();
            const skillId = (el as HTMLElement).dataset.skillId;
            if (skillId && this.onSkillClick) {
              this.onSkillClick(skillId);
            }
          });
        });
      } else {
        this.skillAreaEl.innerHTML = '';
      }
    }

  }

  /** 技能点击回调 */
  /** Only an active match may refresh the shared page after an asynchronous skill. */
  private async executeUISkill(player: PlayerState, skillId: string, ctx: GameContextSnapshot): Promise<boolean> {
    const session = this.session;
    if (!session.active || this.isGameOver || !this.skillManager) return false;
    try {
      const success = await this.skillManager.executeActiveSkill(player, skillId, ctx);
      return session.active && !this.isGameOver && success;
    } catch (error) {
      if (!(error instanceof GameSessionCancelled || error instanceof GameResolutionEnded)) console.error('[Skill]', error);
      return false;
    }
  }

  public onSkillClick: ((skillId: string) => void) | null = null;

  private skillManager: any = null;
  setSkillManager(sm: any): void { this.skillManager = sm; }

  // ======================== 日志系统 ========================
  addLog(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    const safeMessage = message ?? '';
    this.logEntries.push(`[${timestamp}] ${safeMessage}`);
    if (this.logEntries.length > 500) this.logEntries.shift();
    if (this.logContentEl) {
      // 仅在用户已在底部（或接近底部）时自动滚动到底部
      const el = this.logContentEl;
      const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      const entry = document.createElement('div');
      entry.className = 'battle-log-entry';
      entry.dataset.kind = /阵亡|濒死|伤害|失去.*生命/.test(safeMessage) ? 'damage'
        : /回复|救援成功|脱离濒死/.test(safeMessage) ? 'heal'
        : /【.*】/.test(safeMessage) ? 'skill'
        : /第.*轮|游戏开始|游戏结束/.test(safeMessage) ? 'phase' : 'normal';
      const time = document.createElement('time');
      time.textContent = timestamp;
      const body = document.createElement('span');
      body.textContent = safeMessage;
      entry.append(time, body);
      el.append(entry);
      while (el.childElementCount > 500) el.firstElementChild?.remove();
      if (wasAtBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** PVP 本地模式经验值计算（与服务端 GameHost 保持一致的公式） */
  private computeLocalPVPExp(winner: string): { killStats: Record<number, any>; expByPlayerId: Record<number, any>; escapedPlayerIds: number[] } {
    const killStats: Record<number, { monarch: number; minister: number; rebel: number; traitor: number }> = {};
    const expByPlayerId: Record<number, { baseExp: number; bonusExp: number; totalExp: number; oldLevel: number; newLevel: number; leveledUp: boolean; escaped: boolean }> = {};

    // 从 flowController 获取击杀统计
    if (this.flowController) {
      for (const [pid, stats] of this.flowController.killStats) {
        killStats[pid] = { ...stats };
      }
    }

    // 为所有玩家计算经验值
    for (const p of this.players) {
      const roleStr = p.role;
      const baseExp = GamePage.calcBaseExp(roleStr, winner);
      const ks = killStats[p.id] ?? { monarch: 0, minister: 0, rebel: 0, traitor: 0 };
      const bonusExp = GamePage.calcKillExp(roleStr, ks);
      const totalExp = baseExp + bonusExp;
      expByPlayerId[p.id] = {
        baseExp, bonusExp, totalExp,
        oldLevel: 0, newLevel: 0, leveledUp: false, escaped: false,
      };
    }

    return { killStats, expByPlayerId, escapedPlayerIds: [] };
  }

  /** 根据身份和胜利方计算基础经验（与服务端 GameHost.calcBaseExp 一致） */
  private static calcBaseExp(role: RoleType | string, winner: string | null): number {
    if (!winner) return 20;
    const roleStr = typeof role === 'string' ? role : String(role);
    if (winner.includes('内奸')) {
      if (roleStr === 'Traitor' || role === RoleType.Traitor) return 100;
      return 20;
    }
    if (winner.includes('反贼')) {
      if (roleStr === 'Rebel' || role === RoleType.Rebel) return 40;
      return 20;
    }
    // 主忠阵营胜利
    if (roleStr === 'Monarch' || role === RoleType.Monarch) return 75;
    if (roleStr === 'Minister' || role === RoleType.Minister) return 50;
    return 20; // 内奸在主忠阵营胜利中失败
  }

  /** 根据击杀统计计算额外经验（与服务端 GameHost.calcKillExp 一致） */
  private static calcKillExp(role: RoleType | string, stats: { monarch: number; minister: number; rebel: number; traitor: number }): number {
    const roleStr = typeof role === 'string' ? role : String(role);
    let bonus = 0;
    if (roleStr === 'Monarch' || role === RoleType.Monarch) {
      if (stats.rebel) bonus += 3;
      if (stats.traitor) bonus += 2;
      if (stats.minister) bonus -= 5;
    } else if (roleStr === 'Minister' || role === RoleType.Minister) {
      if (stats.rebel) bonus += 3;
      if (stats.traitor) bonus += 2;
      if (stats.monarch) bonus -= 5;
    } else if (roleStr === 'Rebel' || role === RoleType.Rebel) {
      if (stats.minister) bonus += 3;
      if (stats.traitor) bonus += 3;
      if (stats.monarch) bonus += 5;
    } else if (roleStr === 'Traitor' || role === RoleType.Traitor) {
      bonus += (stats.monarch + stats.minister + stats.rebel + stats.traitor) * 3;
    }
    return bonus;
  }

  /** 经验值上报到服务端 */
  private applyLocalExpFallback(myExp: { baseExp: number; bonusExp: number; totalExp: number; oldLevel: number; newLevel: number; leveledUp: boolean; escaped: boolean }): void {
    if (socketManager.isConnected) {
      socketManager.emitWithAck('add_exp', { totalExp: myExp.totalExp }).then((ack: any) => {
        if (ack?.success) {
          myExp.oldLevel = ack.oldLevel;
          myExp.newLevel = ack.newLevel;
          myExp.leveledUp = ack.leveledUp;
        }
      }).catch(() => {});
    }
  }

  /** 从累计经验计算等级 */
  private calcLevelFromTotalExp(totalExp: number): number {
    let level = 1;
    let cumulative = 0;
    for (let lv = 1; lv < 60; lv++) {
      const need = lv <= 55 ? lv * 100 : 56000 + (lv - 56) * 1000;
      cumulative += need;
      if (totalExp >= cumulative) level = lv + 1;
      else break;
    }
    return Math.min(60, level);
  }

  /** PVE 闯关：计算星级并保存 */
  private computeAndSavePVEStars(): void {
    if (!this.pveLevel) return;
    const alliesAlive = this.players.filter(p => (p as any).faction === 'Ally' && !p.isDead).length;
    const dead = this.pveLevel.allyCount - alliesAlive;
    let stars = 1;
    if (dead === 0) stars = 3;
    else if (dead === 1) stars = 2;
    savePVEStar(this.levelId, stars);
    this.addLog(`⭐ PVE 关卡完成！获得 ${stars} 星评价（存活${alliesAlive}/${this.pveLevel.allyCount}人）`);
  }

  // ======================== 结算弹窗 ========================
  showResultModal(winner: string, gameOverData?: { killStats?: Record<number, any>; expByPlayerId?: Record<number, any>; escapedPlayerIds?: number[]; settlementPending?: boolean }): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay result-modal';
    const isPVP = this.mode === 'pvp';
    if (isPVP) overlay.classList.add('pvp-result');

    const killStats: Record<number, { monarch: number; minister: number; rebel: number; traitor: number }> = {};
    const expByPid: Record<number, { baseExp: number; bonusExp: number; totalExp: number; oldLevel: number; newLevel: number; leveledUp: boolean; escaped: boolean }> = {};
    const escapedPlayerIds: Set<number> = new Set(gameOverData?.escapedPlayerIds ?? []);
    if (gameOverData) {
      if (gameOverData.killStats) Object.assign(killStats, gameOverData.killStats);
      if (gameOverData.expByPlayerId) Object.assign(expByPid, gameOverData.expByPlayerId);
    }
    const hasExp = Object.keys(expByPid).length > 0;

    // 判定胜利方阵营
    const winFaction = winner.includes('反贼') ? 'Rebel' :
                       winner.includes('内奸') ? 'Traitor' :
                       winner.includes('主公') || winner.includes('忠臣') || winner === '主忠阵营' ? 'MonarchMinister' : '';

    // 阵营排序权重：主→忠→反→内（同阵营主公在忠臣前面）
    const roleOrder: Record<string, number> = { Monarch: 0, Minister: 1, Rebel: 2, Traitor: 3 };

    // 判断玩家是否属于胜利方
    const isWinner = (p: PlayerState): boolean => {
      if (winFaction === 'Rebel') return p.role === 'Rebel';
      if (winFaction === 'Traitor') return p.role === 'Traitor';
      if (winFaction === 'MonarchMinister') return p.role === 'Monarch' || p.role === 'Minister';
      return !p.isDead;
    };

    // 排序：胜利方优先 → 同阵营主忠按角色序（主→忠）→ 再按经验降序
    const sorted = [...this.players].sort((a, b) => {
      const aWin = isWinner(a) ? 0 : 1;
      const bWin = isWinner(b) ? 0 : 1;
      if (aWin !== bWin) return aWin - bWin;
      // 同胜负组：先按大阵营（主忠→反贼→内奸），再同身份按经验降序
      const aRoleOrd = roleOrder[a.role] ?? 9;
      const bRoleOrd = roleOrder[b.role] ?? 9;
      if (aRoleOrd !== bRoleOrd) return aRoleOrd - bRoleOrd;
      // 同角色按经验降序
      const aExp = expByPid[a.id]?.totalExp ?? 0;
      const bExp = expByPid[b.id]?.totalExp ?? 0;
      return bExp - aExp;
    });

    const isPVE = !!this.pveLevel;
    const me = this.getHumanPlayer();
    const interrupted = winner === 'aborted' || !winFaction;
    const myExp = me ? expByPid[me.id] : undefined;
    const resultTitle = interrupted ? '对局未完成' : me && isWinner(me) ? '对局胜利' : '对局结束';
    const experience = myExp
      ? `本局经验 +${Math.max(0, myExp.baseExp + myExp.bonusExp)}${myExp.leveledUp ? ` · 升至 Lv.${myExp.newLevel}` : ''}`
      : gameOverData?.settlementPending ? '经验正在结算' : '';
    const killCols = !isPVE && hasExp ? `<th>杀主</th><th>杀忠</th><th>杀反</th><th>杀内</th>` : (isPVE ? `<th>杀敌数</th>` : '');
    const expHeader = !isPVE && hasExp ? `<th>基础经验</th><th>击杀加成</th><th>获得经验</th>` : '';

    // PVE星星标题
    let starTitle = '';
    if (isPVE) {
      const pveWin = winner === '友方阵营';
      if (pveWin) {
        const records = getPVEStarRecords();
        const stars = records[this.levelId] || 0;
        starTitle = `<div class="result-winner" style="font-size:24px;">${'⭐'.repeat(stars)}${'☆'.repeat(3 - stars)} ${stars === 3 ? '三星通关！' : stars === 2 ? '二星通关' : '一星通关'}</div>`;
      } else {
        starTitle = `<div class="result-winner" style="font-size:24px;color:#f44336;">💀 挑战失败</div>`;
      }
    }

    overlay.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="result-title">
        ${isPVP ? `<header class="pvp-result-header">
          <div><p>PVP 对局结算</p><h2 id="result-title">${resultTitle}</h2>
            ${interrupted ? '' : `<p>获胜阵营 <strong>${escapeSeatText(winner)}</strong></p>`}
          </div>
          ${experience ? `<strong class="pvp-result-experience">${escapeSeatText(experience)}</strong>` : ''}
        </header>` : `<div id="result-title" class="result-title win">🎉 游戏结束</div>
          ${isPVE ? starTitle : `<div class="result-winner">胜利方：${escapeSeatText(winner)}</div>`}
          <div class="result-detail"><p>模式：PVE 闯关</p></div>`}
        ${isPVP ? '<div class="pvp-result-scroll" role="region" aria-label="对局明细" tabindex="0">' : ''}
        <table class="result-table">
          <thead>
            <tr><th>玩家</th><th>武将</th><th>身份</th><th>体力</th><th>状态</th>${killCols}${expHeader}</tr>
          </thead>
          <tbody>
            ${sorted.map(p => {
              const roleName = isPVE ? ((p as any).faction === 'Ally' ? '友方' : (p as any).faction === 'Enemy' ? '敌方' : '—') : getRoleChineseName(p.role);
              const escaped = escapedPlayerIds.has(p.id);
              const playerWin = (!isPVP || !interrupted) && isWinner(p);
              const status = escaped ? '🏳️ 逃跑' : (p.isDead ? '💀 阵亡' : (playerWin ? '✅ 胜利' : '✅ 存活'));
              const isHuman = p.id === me?.id;
              const factionTag = (p as any).faction;
              const rowClass = isPVE ? (factionTag === 'Ally' ? 'winner-row' : 'loser-row') : (escaped ? 'escaped-row' : (playerWin ? 'winner-row' : 'loser-row'));
              const ks = killStats[p.id] ?? { monarch: 0, minister: 0, rebel: 0, traitor: 0 };
              const killHtml = isPVE ? `<td>${ks.monarch + ks.minister + ks.rebel + ks.traitor}</td>` : (hasExp ? `<td>${ks.monarch}</td><td>${ks.minister}</td><td>${ks.rebel}</td><td>${ks.traitor}</td>` : '');
              const ep = expByPid[p.id];
              const expHtml = isPVE ? '' : (ep
                ? (ep.escaped
                    ? `<td>—</td><td>—</td><td style="color:var(--accent-red);font-weight:bold;">0 (逃跑)</td>`
                    : `<td>${ep.baseExp}</td><td style="color:${ep.bonusExp >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${ep.bonusExp >= 0 ? '+' + ep.bonusExp : ep.bonusExp}</td><td style="color:var(--gold);font-weight:bold;">${ep.baseExp + ep.bonusExp}${ep.leveledUp ? ` ⬆Lv.${ep.newLevel}` : ''}</td>`)
                : hasExp ? `<td>—</td><td>—</td><td>—</td>` : '');
              return `
                <tr class="${rowClass}${isHuman ? ' self-row' : ''}">
                  <td>${escapeSeatText(p.playerName || p.name)}${isHuman ? '（你）' : ''}</td>
                  <td>${escapeSeatText(p.name)}</td>
                  <td>${roleName}</td>
                  <td>${p.hp}/${p.maxHp}</td>
                  <td>${status}</td>
                  ${killHtml}${expHtml}
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        ${isPVP ? '</div>' : ''}
        <div style="display:flex;gap:12px;justify-content:center;">
          ${isPVE ? '<button class="btn btn-ghost" id="result-close">关闭</button>' : ''}
          <button class="btn btn-gold" id="result-back">${this.mode === 'pve' ? '返回章节' : '返回匹配大厅'}</button>
        </div>
      </div>
    `;
    // PVP 结算只允许点击明确的返回按钮离开，避免误触遮罩退出。
    overlay.addEventListener('click', e => {
      if (e.target !== overlay) return;
      e.stopPropagation();
      if (isPVE) {
        overlay.remove();
        this.goBack();
      }
    });
    overlay.querySelector('#result-close')?.addEventListener('click', () => { overlay.remove(); this.goBack(); });
    overlay.querySelector('#result-back')!.addEventListener('click', () => {
      overlay.remove();
      this.goBack();
    });
    this.mountTransient(overlay);
    if (isPVP) overlay.querySelector<HTMLButtonElement>('#result-back')?.focus({ preventScroll: true });
  }

  // ======================== 技能动画 ========================

  private hpFeedback = new Map<string, { element: HTMLElement; amount: number; revision: number }>();

  /** Presentation only: aggregate rapid changes of the same kind without changing rule timing. */
  private showHpFeedback(data: Record<string, unknown>): void {
    const playerId = data.playerId as number;
    const delta = Number(data.delta);
    if (!this.session.active || !Number.isFinite(delta) || delta === 0) return;
    const seat = this.getSeatElement(playerId);
    if (!seat) return;
    const healing = delta > 0;
    const key = `${playerId}:${healing ? 'heal' : data.isDamage === false ? 'loss' : 'damage'}`;
    let feedback = this.hpFeedback.get(key);
    if (!feedback) {
      const element = document.createElement('div');
      element.className = `combat-feedback ${healing ? 'healing' : 'damage'}`;
      element.setAttribute('role', 'status');
      feedback = { element, amount: 0, revision: 0 };
      this.hpFeedback.set(key, feedback);
      this.mountTransient(element);
    }
    feedback.amount += Math.abs(delta);
    const revision = ++feedback.revision;
    const number = document.createElement('strong');
    number.textContent = `${healing ? '+' : '−'}${feedback.amount}`;
    const label = document.createElement('span');
    label.textContent = healing ? '体力回复' : data.isDamage === false ? '体力流失' : '受到伤害';
    feedback.element.replaceChildren(number, label);
    const rect = seat.getBoundingClientRect();
    const bounds = this.battlefieldEl.getBoundingClientRect();
    const width = feedback.element.offsetWidth;
    const left = Math.max(bounds.left + 4, Math.min(rect.left + rect.width / 2 - width / 2, bounds.right - width - 4));
    feedback.element.style.left = `${left}px`;
    feedback.element.style.top = `${Math.max(8, Math.min(rect.top + rect.height * .34 + (healing ? 34 : 0), window.innerHeight - 85))}px`;
    this.session.setTimeout(() => {
      if (this.hpFeedback.get(key)?.revision !== revision) return;
      feedback!.element.remove();
      this.transientElements.delete(feedback!.element);
      this.hpFeedback.delete(key);
    }, 1200);
  }

  private voiceAnimListener: ((e: Event) => void) | null = null;
  private skillAnnouncements = new Map<number, {
    element: HTMLElement;
    skills: Map<string, number>;
    revision: number;
  }>();

  private setupVoiceAnimationListener(): void {
    if (this.voiceAnimListener) return;
    this.voiceAnimListener = (e: Event) => {
      const detail = (e as CustomEvent<VoicePlayEventDetail>).detail;
      this.showSkillFloatAnimation(detail.playerId, detail.skillName);
    };
    document.addEventListener(VOICE_PLAY_EVENT, this.voiceAnimListener);
  }

  private cleanupVoiceAnimationListener(): void {
    if (this.voiceAnimListener) {
      document.removeEventListener(VOICE_PLAY_EVENT, this.voiceAnimListener);
      this.voiceAnimListener = null;
    }
  }

  /** Skill notices share the same lifetime and table layer as card actions. */
  private showSkillFloatAnimation(playerId: number, skillName: string): void {
    this.battlePresentation?.skill(playerId, skillName);
  }

  private cleanupGame(): void {
    this.heroSelectEl.hidden = true;
    this.closeSeatRolePicker();
    this.seatRoleMarks.clear();
    this.closeTableInteraction();
    this.chatPanel?.dispose();
    this.chatPanel = null;
    // 中止游戏循环
    this.flowController?.abort();
    this.battlePresentation?.dispose();
    this.battlePresentation = null;
    this.session.dispose();
    this.pendingDiscardAnimations.clear();
    this._playedCardIds.clear();
    this.eventBus?.clear();
    this.stopBGM();
    this.stopTimer();
    this.stopPVPCountdown();
    this.cancelGlobalHandler();
    this.onSkillClick = null;
    this.clearGraceCards();
    for (const element of this.transientElements) element.remove();
    this.transientElements.clear();
    this.skillAnnouncements.clear();
    this.hpFeedback.clear();
    this.animLayer?.replaceChildren();
    this.clearHighlights();
    this.hidePrompt();
    this.hideResponseButtons();
    this.el.querySelector<HTMLElement>('#settings-overlay')!.style.display = 'none';
    this.cleanupVoiceAnimationListener();
    this.gameStarted = false;
    this.isGameOver = true;
    // 清理选将倒计时
    if (this.pvpHeroSelectTimer) {
      clearInterval(this.pvpHeroSelectTimer);
      this.pvpHeroSelectTimer = null;
    }
    // PVP 清理
    this.cleanupPVPListeners();
    this.pvpOnline = false;
    // 下局会根据模式重新选择背景
    this.currentBattlefieldBackground = '';
    this.wallpaperCandidates = [];
    this.wallpaperPool = [];
    this.wallpaperLastMinute = -1;
    // 彻底清除游戏对象引用，防止下局数据残留
    this.flowController = null as any;
    this.skillManager = null as any;
    this.players = [];
    this.deck = null as any;
    this.eventBus = null as any;
    this.humanDriver = null as any;
    this.pvpRequestId = null;
    // 注意：不要在这里 emit leave_room！
    // cleanupGame 在 onEnter 时也会被调用，leave_room 会把玩家踢出刚进入的房间
    // leave_room 应只在主动退出时发送（handlePVPGameOver 中处理）
  }

  show(): void { this.el.classList.add('active'); }
  hide(): void {
    const leavingRoom = this.pvpOnline && this.roomId;
    this.cleanupGame();
    this.el.classList.remove('active');
    if (leavingRoom) socketManager.emit('leave_room');
  }
}
