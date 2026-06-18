// ============================================================
// GamePage.ts — 游戏主界面（选将 + 战斗 + 真实卡牌 + 动画 + 点击交互）
// ============================================================

import { router, RouteState } from './router';
import {
  PlayerState, GamePhase, RoleType, GameContextSnapshot,
  GameEvent, Card, IPlayerDriver, EquipmentType, GenderType,
  ZoneSelection, SuitType, MagicTimeType, ElementType, Faction
} from '../core/types';
import { getRoleChineseName, getHandLimit, getWeaponRange } from '../core/Player';
import { getCardDetail, isSlash, getCardColor, getMagicSubType, ColorType } from '../core/Card';
import { socketManager } from '../network/SocketManager';
import { getDistance } from '../core/DistanceCalc';

import { CARD_DATA } from '../data/CardData';
import { EventBus } from '../core/EventBus';
import { DeckManager } from '../core/DeckManager';
import { CardEffectManager } from '../core/CardEffectManager';
import { DamageSystem } from '../core/DamageSystem';
import { EquipEffectManager } from '../core/EquipEffectManager';
import { GameFlowController } from '../core/GameFlowController';
import { DelayedAIDriver } from '../ai/DelayedAIDriver';
import { SkillManager } from '../core/skills/SkillManager';
import { HeroData, ALL_HEROES, getGods, getNonGods, getHeroById } from '../data/heroes';
import { PVELevel, getLevelById, getCandidatePool, pickAIAllyHeroes, getTotalPlayers, getChapterForLevel, savePVEStar, getPVEStarRecords } from '../data/PVELevels';
// ======================== 常量 ========================
const SUIT_SYMBOL: Record<string, string> = {
  Spade: '♠', Heart: '♥', Club: '♣', Diamond: '♦', None: '',
};
const SUIT_COLOR: Record<string, string> = {
  Spade: '#222', Heart: '#c1272d', Club: '#222', Diamond: '#c1272d', None: '#888',
};
const NUMBER_TEXT: Record<number, string> = {
  1: 'A', 11: 'J', 12: 'Q', 13: 'K',
};
const ANIM_DURATION = 400; // ms

// 卡牌名称到文件名映射（某些卡牌的Resources/Cards下的PNG文件名不同）
const CARD_FILE_NAME_MAP: Record<string, string> = {
  '青釭剑': '青缸剑',
  '+1马': '骅骝',   // fallback
  '-1马': '赤兔',   // fallback
};

// ======================== 全局AI延迟（PVE模式，运行时可通过设置面板调整） ========================
let globalAiDelayMs = 1600; // 默认1.6秒（推荐速度）

// ======================== 人类玩家 Web UI Driver（点击交互版） ========================
class HumanWebUIDriver {
  readonly playerId: number;
  private gamePage: GamePage;
  // 共享的Promise resolve
  private resolveMap: Map<string, (value: any) => void> = new Map();
  // 当前交互类型（用于防冲突）
  private currentInteraction: string | null = null;
  /** PVP 模式下的 socket respond 回调（与 PVE Promise 并存，点击时同时触发两者） */
  private pvpRespond: ((v: any) => void) | null = null;

  constructor(playerId: number, gamePage: GamePage) {
    this.playerId = playerId;
    this.gamePage = gamePage;
  }

  /** PVP 模式注入 socket respond 回调；关闭时传 null */
  setPVPRespond(r: ((v: any) => void) | null) {
    this.pvpRespond = r;
  }

  private setResolve(key: string, resolve: (value: any) => void) {
    // 如果已有未解决的Promise，先强制resolve避免卡死
    if (this.resolveMap.has(key)) {
      const oldResolve = this.resolveMap.get(key)!;
      this.resolveMap.delete(key);
      // 对之前的卡死Promise做默认resolve
      // 注意：playCard不强制resolve为-1，因为-1会结束出牌阶段
      // 改为忽略旧promise（它会被GC回收）
      if (key === 'playCard') {
        // 不resolve旧promise，直接丢弃（旧UI状态已被clearHighlights清理）
      } else if (key === 'target') oldResolve(null);
      else if (key === 'response') oldResolve(null);
      else if (key === 'zone') oldResolve(null);
      else if (key === 'discard') oldResolve(0);
      else if (key === 'nullify') oldResolve(false);
      else if (key === 'showCard') oldResolve(0);
      else if (key === 'selectCard') oldResolve(-1);
    }
    this.currentInteraction = key;
    this.resolveMap.set(key, resolve);
  }
  private clearResolve(key: string) {
    this.resolveMap.delete(key);
    if (this.currentInteraction === key) {
      this.currentInteraction = null;
    }
  }

  async promptPlayCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return new Promise(resolve => {
      this.setResolve('playCard', resolve);
      this.gamePage.clearHighlights();
      this.gamePage.highlightPlayableCards(state, ctx);
      // 兹白：显示当前第几张牌
      const zibaiHint = state.heroId === 'zibai' && ctx.cardsPlayedThisPhase !== undefined
        ? ` (第${ctx.cardsPlayedThisPhase + 1}张)` : '';
      this.gamePage.showPrompt(`出牌阶段 - 点击手牌出牌，或点"结束出牌"${zibaiHint}`);
    });
  }
  async promptTarget(state: PlayerState, validTargets: number[], reason: string, ctx: GameContextSnapshot): Promise<number | null> {
    return new Promise(resolve => {
      this.setResolve('target', resolve);
      this.gamePage.clearHighlights();
      this.gamePage.highlightTargets(validTargets, reason);
      this.gamePage.showPrompt(`选择目标 - ${reason}`);
    });
  }
  async promptResponse(state: PlayerState, cardName: string, ctx: GameContextSnapshot): Promise<Card | null> {
    return new Promise(resolve => {
      // 30秒超时保护
      const timer = setTimeout(() => {
        if (this.resolveMap.has('response')) {
          this.clearResolve('response');
          this.gamePage.clearHighlights();
          this.gamePage.hidePrompt();
          this.gamePage.hideResponseButtons();
          resolve(null);
        }
      }, 30000);
      // 先清理之前可能残留的交互状态
      this.gamePage.clearHighlights();
      this.gamePage.hidePrompt();
      this.setResolve('response', (card: Card | null) => {
        clearTimeout(timer);
        resolve(card);
      });
      let validCards: Card[];
      if (cardName.startsWith('花色:')) {
        const suit = cardName.split(':')[1];
        validCards = state.handCards.filter(c => c.suit === suit);
      } else if (cardName === '杀') {
        validCards = state.handCards.filter(c => isSlash(c));
      } else {
        validCards = state.handCards.filter(c => c.name === cardName);
      }
      this.gamePage.clearHighlights();
      this.gamePage.highlightResponseCards(validCards, cardName);
    });
  }
  async promptZone(state: PlayerState, targetId: number, ctx: GameContextSnapshot): Promise<ZoneSelection | null> {
    return new Promise(resolve => {
      this.setResolve('zone', resolve);
      const target = ctx.players.find(p => p.id === targetId)!;
      this.gamePage.clearHighlights();
      this.gamePage.highlightZones(target);
      this.gamePage.showPrompt(`选择 ${target.name} 的区域（手牌/装备/判定区）`);
    });
  }
  async promptZhanBa(state: PlayerState, ctx: GameContextSnapshot): Promise<[number, number] | null> {
    return new Promise(resolve => {
      this.gamePage.showZhanBaPrompt(state, (v) => { this.pvpRespond?.(v); resolve(v); });
    });
  }
  async promptDiscard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return new Promise(resolve => {
      this.setResolve('discard', resolve);
      this.gamePage.clearHighlights();
      const limit = getHandLimit(state);
      const excess = state.handCards.length - limit;
      this.gamePage.highlightDiscardCards(state, excess, limit);
      this.gamePage.showPrompt(`弃牌阶段 - 还需弃置 ${excess} 张牌（手牌 ${state.handCards.length}/${limit}）`);
    });
  }
  async promptNullification(state: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const hasNullify = state.handCards.some(c => c.name === '无懈可击');
    if (!hasNullify) return false;

    // 益类锦囊（五谷丰登、桃园结义、无中生有）不无懈
    const cardName = ctx.nullifyCardName || '';
    const BENEFICIAL = ['五谷丰登', '桃园结义', '无中生有'];
    if (BENEFICIAL.includes(cardName)) return false;

    // 如果锦囊来源是己方盟友且不是自己，不无懈（别坑队友，但自己的延迟判定牌可无懈）
    const sourceId = ctx.nullifySourceId;
    if (sourceId !== undefined && sourceId !== state.id) {
      const source = ctx.players.find(p => p.id === sourceId);
      if (source && !this.isHostile(state, source)) return false;
    }

    return new Promise(resolve => {
      this.setResolve('nullify', resolve);
      this.gamePage.clearHighlights();
      this.gamePage.highlightNullifyCards(state);
      if (!this.gamePage.graceOverlay) {
        this.gamePage.showPrompt('是否打出【无懈可击】？点击无懈可击打出，否则12秒后自动跳过');
      }
      setTimeout(() => { if (this.resolveMap.has('nullify')) { this.clearResolve('nullify'); resolve(false); this.gamePage.clearHighlights(); this.gamePage.restoreGraceOverlayZIndex(); } }, 12000);
    });
  }

  /** 判断对方是否是敌对阵营（基于身份） */
  private isHostile(me: PlayerState, other: PlayerState): boolean {
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
      return new Promise(resolve => {
        this.setResolve('selectCard', resolve);
        this.gamePage.clearHighlights();
        this.gamePage.highlightSelectableCards(state, arg2 as Card[]);
        this.gamePage.showPrompt('选择一张牌使用');
      });
    } else {
      // 新式: (state, title, filter, ctx) — 根据filter过滤手牌后选择（有取消按钮）
      const filter = arg3 as ((c: Card) => boolean);
      const validCards = state.handCards.filter(filter);
      if (validCards.length === 0) return -1;
      return new Promise(resolve => {
        this.setResolve('selectCard', resolve);
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
          this.clearResolve('selectCard');
          resolve(-1);
          this.gamePage.clearHighlights();
          this.gamePage.hidePrompt();
          cancelBtn.remove();
        };
        this.gamePage.promptBarEl.appendChild(cancelBtn);
      });
    }
  }
  async promptYesNo(title: string): Promise<boolean> {
    return new Promise(resolve => {
      this.gamePage.showYesNoPrompt(title, (v) => { this.pvpRespond?.(v); resolve(v); });
    });
  }
  async promptRansackHand(
    state: PlayerState,
    targetId: number,
    ctx: GameContextSnapshot
  ): Promise<number> {
    return new Promise(resolve => {
      const target = ctx.players.find(p => p.id === targetId);
      if (!target || target.handCards.length === 0) { this.pvpRespond?.(-1); resolve(-1); return; }
      this.gamePage.showRansackHandPrompt(target, (v) => { this.pvpRespond?.(v); resolve(v); });
    });
  }
  async promptDiscardMulti(
    state: PlayerState,
    count: number,
    ctx: GameContextSnapshot
  ): Promise<number[]> {
    return new Promise(resolve => {
      this.gamePage.showDiscardMultiPrompt(state, count, (v) => { this.pvpRespond?.(v); resolve(v); });
    });
  }
  async promptIronChainMode(state: PlayerState, ctx: GameContextSnapshot): Promise<'recast' | 'chain'> {
    return new Promise(resolve => {
      this.gamePage.showIronChainPrompt((v) => { this.pvpRespond?.(v); resolve(v); });
    });
  }
  async promptAmazingGrace(state: PlayerState, tableCards: Card[], ctx: GameContextSnapshot): Promise<number> {
    return new Promise(resolve => {
      this.gamePage.showGraceCards(tableCards, (v) => { this.pvpRespond?.(v); resolve(v); });
    });
  }

  /** 五谷丰登结束后清理 */
  clearGraceWindow(): void {
    this.gamePage.clearGraceCards();
  }
  async promptShowCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return new Promise(resolve => {
      this.setResolve('showCard', resolve);
      this.gamePage.clearHighlights();
      this.gamePage.highlightShowCards(state);
      this.gamePage.showPrompt('火攻 - 选择一张手牌展示');
    });
  }
  async promptGenderWeapon(state: PlayerState, attackerName: string, ctx: GameContextSnapshot): Promise<'discard' | 'draw'> {
    return new Promise(resolve => {
      this.gamePage.showGenderWeaponPrompt(attackerName, (v) => { this.pvpRespond?.(v); resolve(v); });
    });
  }
  /** 温迪-自由：选择新的体力上限 */
  async promptVentiFree(state: PlayerState): Promise<number> {
    return new Promise(resolve => {
      this.gamePage.showVentiFreePrompt(state, (v) => { this.pvpRespond?.(v); resolve(v); });
    });
  }

  // ========== 供GamePage调用的公共接口 ==========
  // PVP 双通道：所有 resolveXxx 先触发 pvpRespond（socket 响应），再正常 resolve Promise
  resolvePlayCard(index: number) {
    this.pvpRespond?.(index);
    const r = this.resolveMap.get('playCard');
    if (r) { this.clearResolve('playCard'); r(index); }
  }
  resolveSelectCard(index: number) {
    this.pvpRespond?.(index);
    const r = this.resolveMap.get('selectCard');
    if (r) { this.clearResolve('selectCard'); r(index); }
  }
  resolveTarget(targetId: number | null) {
    this.pvpRespond?.(targetId);
    const r = this.resolveMap.get('target');
    if (r) { this.clearResolve('target'); r(targetId); }
  }
  resolveResponse(card: Card | null) {
    this.pvpRespond?.(card);
    const r = this.resolveMap.get('response');
    if (r) { this.clearResolve('response'); r(card); }
  }
  resolveZone(sel: ZoneSelection | null) {
    this.pvpRespond?.(sel);
    const r = this.resolveMap.get('zone');
    if (r) { this.clearResolve('zone'); r(sel); }
  }
  resolveDiscard(index: number) {
    this.pvpRespond?.(index);
    const r = this.resolveMap.get('discard');
    if (r) { this.clearResolve('discard'); r(index); }
  }
  resolveNullify(value: boolean) {
    this.pvpRespond?.(value);
    const r = this.resolveMap.get('nullify');
    if (r) { this.clearResolve('nullify'); r(value); }
  }
  resolveShowCard(index: number) {
    this.pvpRespond?.(index);
    const r = this.resolveMap.get('showCard');
    if (r) { this.clearResolve('showCard'); r(index); }
  }
  getResolveKey(key: string): boolean { return this.resolveMap.has(key); }
}

// ======================== GamePage 主类 ========================
export class GamePage {
  private el!: HTMLElement;
  private mode: 'pve' | 'pvp' = 'pve';
  private roomId = '';
  private chapterId = '';
  private levelId = 0;
  private logEntries: string[] = [];
  private isGameOver = false;
  private gameStarted = false;
  private bgmAudio: HTMLAudioElement | null = null;

  
  private bgmVolume = 0.3;
  /** 背景壁纸轮播 */
  private wallpaperRegionBase: number = 10; // 默认蒙德：10-19
  private wallpaperLastMinute: number = -1;
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
  /** PVE 闯关模式：座位布局（pveSeatIndex → playerId 映射） */
  private pveSeatMap: Map<number, number> = new Map();
  private isBgmOn = true;
  private bgmBattlePath: string | null = null; // 战斗BGM路径
  private bgmSwitchTimer: any = null; // 切换到战斗BGM的定时器

  // ======== PVP 联机模式 ========
  private pvpOnline = false; // true = 服务器驱动模式已激活
  private pvpMyPlayerId = -1; // PVP 中自己的 playerId（来自 game_start）
  private pvpRequestId: string | null = null; // 当前 prompt 的 requestId
  private pvpUnsubs: Array<() => void> = []; // socket 事件注销回调

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
  private sidebarSkillsEl!: HTMLElement;
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
            <button class="btn btn-ghost btn-sm" id="game-back-btn">← 返回</button>
            <button class="btn btn-ghost btn-sm" id="game-settings-btn">⚙ 设置</button>
          </div>
          <div class="game-phase" id="game-phase">等待开始...</div>
          <div class="game-top-right">
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
      <!-- 右侧栏：日志 + 聊天 + 技能信息 -->
      <div class="game-sidebar" id="game-sidebar">
        <div class="log-panel">
          <h4>📜 游戏记录</h4>
          <div class="log-content" id="log-content"></div>
        </div>
        <div class="chat-panel">
          <h4>💬 聊天</h4>
          <div class="chat-placeholder">聊天功能将在后续版本实现</div>
        </div>
        <!-- 技能区（右侧栏） -->
        <div class="sidebar-section" id="sidebar-skill-section">
          <h4>✨ 武将技能</h4>
          <div class="sidebar-skills-grid" id="sidebar-skills"></div>
        </div>
      </div>
      <!-- 选将界面 -->
      <div class="hero-select-overlay" id="hero-select" style="display:none;"></div>
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
    // 侧栏技能区
    this.sidebarSkillsEl = this.el.querySelector('#sidebar-skills')!;
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
    });
    const volumeSlider = this.el.querySelector('#settings-volume')! as HTMLInputElement;
    const volumeLabel = this.el.querySelector('#volume-label')!;
    volumeSlider.addEventListener('input', () => {
      const vol = parseInt(volumeSlider.value) / 100;
      this.bgmVolume = vol;
      volumeLabel.textContent = Math.round(vol * 100) + '%';
      if (this.bgmAudio) this.bgmAudio.volume = vol;
    });
    // AI出牌时间
    const aiDelaySelect = this.el.querySelector('#settings-ai-delay')! as HTMLSelectElement;
    aiDelaySelect.addEventListener('change', () => {
      globalAiDelayMs = parseInt(aiDelaySelect.value);
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
    document.body.appendChild(overlay);
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

  /** 根据主公地区切换BGM并启动背景壁纸轮播 */
  private switchBGMForMonarch(): void {
    // PVE模式：使用主将(Ally)的地区；PVP模式：使用主公的地区
    const anchor = this.players.find(p => (p as any).faction === 'Ally')
      || this.players.find(p => p.role === RoleType.Monarch)
      || this.players[0];
    if (!anchor) return;
    const region = anchor.region;

    // 根据主公地区确定壁纸编号范围
    this.wallpaperRegionBase = this.getWallpaperBaseForRegion(region);
    this.wallpaperLastMinute = -1;
    // 缓存 cross-fade 元素
    this.wallpaperCrossEl = this.el.querySelector('#game-bg-cross')! as HTMLElement;

    // 初始壁纸
    const bgEl = this.el.querySelector('#game-bg')! as HTMLElement;
    const firstWallpaper = `Resources/Backgrounds/${this.wallpaperRegionBase}.png`;
    bgEl.style.backgroundImage = `url('${firstWallpaper}')`;
    this.wallpaperCrossEl.style.backgroundImage = `url('${firstWallpaper}')`;
    this.wallpaperCrossEl.style.opacity = '0';

    // 启动壁纸轮播（依赖计时器）
    this.wallpaperLastMinute = 0;

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

  /** 根据地区获取壁纸编号基础值 */
  private getWallpaperBaseForRegion(region: string): number {
    switch (region) {
      case '蒙德': return 10;
      case '璃月': return 20;
      case '稻妻': return 30;
      case '须弥': return 40;
      case '枫丹': return 50;
      case '纳塔': return 60;
      case '挪德卡莱': return 70;
      default: return 10; // 默认蒙德
    }
  }

  /** 根据主公地区加载对应壁纸（PVP 模式专用） */
  private loadWallpaperForRegion(region: string): void {
    this.wallpaperRegionBase = this.getWallpaperBaseForRegion(region);
    this.wallpaperLastMinute = -1;
    this.wallpaperCrossEl = this.el.querySelector('#game-bg-cross')! as HTMLElement;

    const bgEl = this.el.querySelector('#game-bg')! as HTMLElement;
    const firstWallpaper = `Resources/Backgrounds/${this.wallpaperRegionBase}.png`;
    bgEl.style.backgroundImage = `url('${firstWallpaper}')`;
    this.wallpaperCrossEl.style.backgroundImage = `url('${firstWallpaper}')`;
    this.wallpaperCrossEl.style.opacity = '0';
    this.wallpaperLastMinute = 0;
  }

  /** 壁纸随机播放序列（每10张一组，随机打乱后依次播放，播完再洗牌） */
  private wallpaperShuffle: number[] = [];
  private wallpaperShuffleIdx = 0;

  /** 每分钟切换壁纸（由计时器调用） */
  private tickWallpaper(): void {
    if (this.wallpaperRegionBase <= 0) return;
    const minute = Math.floor(this.timerSeconds / 60);
    if (minute === this.wallpaperLastMinute) return;
    this.wallpaperLastMinute = minute;

    // 每秒检查，但同一分钟只切一次
    // 随机序列：如果当前序列为空或已播完，重新 Fisher-Yates 洗牌
    if (this.wallpaperShuffle.length === 0 || this.wallpaperShuffleIdx >= this.wallpaperShuffle.length) {
      this.wallpaperShuffle = Array.from({ length: 10 }, (_, i) => this.wallpaperRegionBase + i);
      for (let i = this.wallpaperShuffle.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.wallpaperShuffle[i], this.wallpaperShuffle[j]] = [this.wallpaperShuffle[j], this.wallpaperShuffle[i]];
      }
      this.wallpaperShuffleIdx = 0;
    }
    const wallpaperNum = this.wallpaperShuffle[this.wallpaperShuffleIdx++];
    const newBgUrl = `url('Resources/Backgrounds/${wallpaperNum}.png')`;
    const bgEl = this.el.querySelector('#game-bg')! as HTMLElement;
    const crossEl = this.wallpaperCrossEl;

    // 交叉淡入淡出
    crossEl.style.backgroundImage = newBgUrl;
    crossEl.style.opacity = '0.65';
    bgEl.style.opacity = '0';

    // 1.2秒后完成切换
    setTimeout(() => {
      bgEl.style.backgroundImage = newBgUrl;
      bgEl.style.opacity = '0.65';
      crossEl.style.opacity = '0';
    }, 1200);
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
    // 通知服务器离开旧房间（PVP 模式下避免留在旧 Socket.IO 房间收到旧事件）
    if (this.pvpOnline || this.mode === 'pvp') {
      socketManager.emit('leave_room');
    }

    this.mode = (state.params?.mode as 'pve' | 'pvp') || 'pve';
    this.roomId = (state.params?.roomId as string) || '';
    this.chapterId = (state.params?.chapterId as string) || '';
    this.levelId = (state.params?.levelId as number) || 0;
    this.isGameOver = false;
    this.gameStarted = false;
    this.logEntries = [];
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
    this.heroSelectEl.style.display = 'none';

    const bgEl = this.el.querySelector('#game-bg')! as HTMLElement;
    bgEl.style.backgroundImage = '';
    const crossEl = this.el.querySelector('#game-bg-cross')! as HTMLElement;
    crossEl.style.backgroundImage = '';
    crossEl.style.opacity = '0';

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
    const isMonarch = params.isMonarch as boolean;
    const isWaitingForMonarch = params.isWaitingForMonarch as boolean;
    const heroCandidates = params.heroCandidates as string[];
    const monarchHero = params.monarchHero as any;
    const monarchPlayerName = (params.monarchPlayerName as string) || '主公';
    const timeoutSec = (params.timeoutSec as number) || 30;
    this.pvpOnline = true;

    // 先设置 Socket 事件监听（game_start / game_event / prompt / game_over）
    this.initPVPOnline();

    this.heroSelectEl.style.display = 'flex';
    this.heroSelectEl.innerHTML = '';

    if (isWaitingForMonarch) {
      // 非主公，等待主公先选
      this.heroSelectEl.innerHTML = `
        <div class="hero-select-panel">
          <h2>👑 ${monarchPlayerName} 正在选将中...</h2>
          <p style="text-align:center;color:var(--text-secondary);">请稍候，主公正在挑选武将</p>
          <div class="hero-select-hint">⏳ 请等待...</div>
        </div>
      `;
      // 监听主公选将结果 → 只更新主公展示信息（候选列表由 hero_select_start 提供）
      this.pvpUnsubs.push(socketManager.on('hero_select_monarch_picked', (data: any) => {
        const monarchName = data.heroName || data.name || '主公';
        this.heroSelectEl.innerHTML = `
          <div class="hero-select-panel">
            <h2>👑 主公选择了 ${monarchName}！</h2>
            <p style="text-align:center;color:var(--text-secondary);">正在为你分配候选武将...</p>
            <div class="hero-select-hint">⏳ 请等待...</div>
          </div>
        `;
      }));
      // 监听 hero_select_start（携带候选列表 + 主公信息）
      this.pvpUnsubs.push(socketManager.on('hero_select_start', (data: any) => {
        if (data.isMonarch) return; // 自己是主公的场景不在这里处理
        this.heroSelectEl.innerHTML = '';
        const candidates = data.candidates || [];
        const monarch = data.monarchHero || monarchHero;
        this.renderPVPCandidateUI(candidates, monarch, false, data.timeoutSec || timeoutSec);
      }));
    } else if (isMonarch) {
      // 主公选将：6候选
      this.renderPVPCandidateUI(heroCandidates || [], null, true, timeoutSec);
    } else {
      // 非主公，已有候选和主公信息
      this.renderPVPCandidateUI(heroCandidates || [], monarchHero, false, timeoutSec);
    }
  }

  /** PVP选将倒计时定时器 */
  private pvpHeroSelectTimer: ReturnType<typeof setInterval> | null = null;

  /** 渲染PVP选将候选UI */
  private renderPVPCandidateUI(candidateIds: string[], monarchData: any | null, isMonarch: boolean, timeoutSec: number = 30): void {
    // 清除旧的选将倒计时
    if (this.pvpHeroSelectTimer) {
      clearInterval(this.pvpHeroSelectTimer);
      this.pvpHeroSelectTimer = null;
    }

    // 将 heroId 转为 HeroData
    const candidates = candidateIds.map(id => getHeroById(id)).filter(Boolean) as HeroData[];

    // 主公武将卡片展示（非主公时显示）
    let monarchCardHtml = '';
    if (!isMonarch && monarchData) {
      const imgSrc = `Resources/Characters/${monarchData.heroName || monarchData.name}.png`;
      monarchCardHtml = `
        <div class="monarch-hero-display" style="display:inline-flex;align-items:center;gap:12px;padding:8px 16px;border-radius:8px;background:rgba(255,215,0,0.15);border:1px solid rgba(255,215,0,0.4);margin-bottom:12px;">
          <div style="width:60px;height:80px;border-radius:6px;overflow:hidden;border:2px solid gold;">
            <img src="${imgSrc}" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<div style=\\'display:flex;align-items:center;justify-content:center;height:100%;font-size:24px;\\'>👑</div>'">
          </div>
          <div style="text-align:left;">
            <div style="font-size:16px;font-weight:bold;color:gold;">👑 ${monarchData.heroName || monarchData.name || '???'}</div>
            <div style="font-size:12px;color:var(--text-secondary);">${monarchData.heroRegion || monarchData.region || ''} · ${monarchData.heroElement || monarchData.element || ''}</div>
          </div>
        </div>
      `;
    }

    const title = isMonarch ? '👑 你是主公！请选择武将' : `🎭 请选择你的武将`;

    // 主公选将时，将候选分为神/非神两栏
    let candidatesHtml = '';
    if (isMonarch && candidates.length === 6) {
      candidatesHtml = `
        <div style="margin-bottom:4px;font-size:13px;color:#ffd700;font-weight:bold;">✦ 七神</div>
        <div class="hero-cards-row" id="pvp-candidates-gods" style="margin-bottom:16px;"></div>
        <div style="margin-bottom:4px;font-size:13px;color:var(--text-secondary);font-weight:bold;">✧ 非神</div>
        <div class="hero-cards-row" id="pvp-candidates-nongods"></div>
      `;
    } else {
      candidatesHtml = `<div class="hero-cards-row" id="pvp-candidates"></div>`;
    }

    this.heroSelectEl.innerHTML = `
      <div class="hero-select-panel">
        <h2>${title}</h2>
        ${monarchCardHtml}
        <p style="text-align:center;color:var(--text-secondary);margin-bottom:8px;">从以下武将中选择一位</p>
        ${candidatesHtml}
        <div class="hero-select-hint">点击武将卡牌进行选择</div>
        <div id="pvp-hero-select-timer" style="text-align:center;margin-top:12px;font-size:18px;font-weight:bold;color:#ff6b6b;">⏱️ ${timeoutSec}s</div>
      </div>
    `;

    // 倒计时
    let remaining = timeoutSec;
    const timerEl = this.heroSelectEl.querySelector('#pvp-hero-select-timer') as HTMLElement | null;
    this.pvpHeroSelectTimer = setInterval(() => {
      remaining--;
      if (timerEl) {
        timerEl.textContent = `⏱️ ${remaining}s`;
        timerEl.style.color = remaining <= 10 ? '#ff4444' : '#ff6b6b';
      }
      if (remaining <= 0) {
        if (this.pvpHeroSelectTimer) {
          clearInterval(this.pvpHeroSelectTimer);
          this.pvpHeroSelectTimer = null;
        }
        // 超时自动选择第一个候选
        if (candidates.length > 0) {
          const autoHero = candidates[0];
          if (isMonarch) {
            socketManager.emit('select_monarch_hero', { heroId: autoHero.id });
          } else {
            socketManager.emit('select_hero', { heroId: autoHero.id });
          }
          this.heroSelectEl.innerHTML = `
            <div class="hero-select-panel">
              <h2>⏰ 超时自动选择 ${autoHero.name}</h2>
              <p style="text-align:center;color:var(--text-secondary);">等待其他玩家选将完成...</p>
              <div class="hero-select-hint">⏳ 游戏即将开始</div>
            </div>
          `;
        }
      }
    }, 1000);

    // 将候选卡片插入到对应容器中
    const insertCard = (hero: HeroData, containerId: string) => {
      const container = this.heroSelectEl.querySelector('#' + containerId);
      if (!container) return;
      const card = this.createHeroCard(hero);
      card.addEventListener('click', () => {
        // 清除倒计时
        if (this.pvpHeroSelectTimer) {
          clearInterval(this.pvpHeroSelectTimer);
          this.pvpHeroSelectTimer = null;
        }
        // 发送选将结果到服务器
        if (isMonarch) {
          socketManager.emit('select_monarch_hero', { heroId: hero.id });
        } else {
          socketManager.emit('select_hero', { heroId: hero.id });
        }
        this.heroSelectEl.innerHTML = `
          <div class="hero-select-panel">
            <h2>✅ 已选择 ${hero.name}</h2>
            <p style="text-align:center;color:var(--text-secondary);">等待其他玩家选将完成...</p>
            <div class="hero-select-hint">⏳ 游戏即将开始</div>
          </div>
        `;
      });
      container.appendChild(card);
    };

    // 主公候选分为神/非神两栏，非主公全部放一栏
    if (isMonarch && candidates.length === 6) {
      const godCandidates = candidates.filter(h => h.isGod);
      const nonGodCandidates = candidates.filter(h => !h.isGod);
      for (const hero of godCandidates) insertCard(hero, 'pvp-candidates-gods');
      for (const hero of nonGodCandidates) insertCard(hero, 'pvp-candidates-nongods');
    } else {
      for (const hero of candidates) insertCard(hero, 'pvp-candidates');
    }
  }

  /** 初始化PVP联机模式的Socket.IO事件监听 */
  private initPVPOnline(): void {
    this.pvpUnsubs.push(socketManager.on('game_start', (data: any) => this.handlePVPGameStart(data)));
    this.pvpUnsubs.push(socketManager.on('game_event', (data: any) => this.handlePVPGameEvent(data)));
    this.pvpUnsubs.push(socketManager.on('prompt', (data: any) => this.handlePVPPrompt(data)));
    this.pvpUnsubs.push(socketManager.on('game_over', (data: any) => this.handlePVPGameOver(data)));
  }

  /** PVP 游戏开始：初始化玩家数据和UI */
  private handlePVPGameStart(data: any): void {
    this.pvpMyPlayerId = data.yourPlayerId;
    this.humanPlayerIdx = data.yourPlayerId; // 复用 humanPlayerIdx 用于渲染一致性
    this.gameStarted = true;

    // 将服务器的玩家数据映射为本地 PlayerState
    this.players = data.players.map((p: any) => this.mapServerPlayerToLocal(p));

    // 创建 HumanWebUIDriver（PVP 模式下仅用于UI交互，不驱动本地游戏循环）
    this.humanDriver = new HumanWebUIDriver(this.pvpMyPlayerId, this);

    // 隐藏选将界面
    this.heroSelectEl.style.display = 'none';

    // 加载壁纸和BGM（根据主公地区，与PVE一致）
    this.switchBGMForMonarch();

    // 启动计时器（PVP模式也需要）
    this.startTimer();

    // 初始化牌堆数量（从服务端数据中获取）
    if (data.drawPileCount !== undefined) {
      this.deckCountEl.textContent = String(data.drawPileCount);
    }

    // 渲染初始战场
    this.renderBattlefield();
    this.renderHandCards();
    this.addLog('游戏开始！PVP 联机模式');
  }

  /** 将服务器发来的玩家数据映射为本地 PlayerState 格式 */
  private mapServerPlayerToLocal(p: any): PlayerState {
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
    };
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

  /** PVP 游戏事件处理：与 PVE 的 registerUIEventListeners 对齐，
   *  正确分发各事件类型：Log 用中文消息、UI 更新、动画等。 */
  private handlePVPGameEvent(data: any): void {
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
        break;
      }
      case 'TurnStarted': {
        this.phaseEl.textContent = `${eventData.playerName || ''}`;
        this.roundLabelEl.textContent = String(eventData.round || 0);
        this.roundNumEl.textContent = String(eventData.turn || 0);
        if (eventData.playerId !== undefined) {
          this.currentTurnPlayerId = eventData.playerId as number;
        }
        this.renderBattlefield();
        break;
      }
      case 'PhaseChanged': {
        const phaseNames: Record<string, string> = {
          'Prepare': '准备阶段', 'Judging': '判定阶段', 'Draw': '摸牌阶段',
          'Play': '出牌阶段', 'Discard': '弃牌阶段', 'End': '回合结束',
        };
        const phaseName = phaseNames[eventData.phase as string] || String(eventData.phase);
        this.phaseEl.textContent = phaseName;
        this.renderBattlefield();
        break;
      }
      case 'CardPlayed': {
        this.renderBattlefield();
        this.renderHandCards();
        // 非自己出牌时播放动画
        const playerId = eventData.playerId as number;
        const card = eventData.card as any;
        if (playerId !== undefined && playerId !== this.selfId && card) {
          this.animateCardPlayed(playerId, card.name, card.suit, card.number);
        }
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
        // 弃牌动画
        const discardPid = eventData.playerId as number;
        const discardCard = eventData.card as any;
        const discardCardName = (eventData.cardName as string) || discardCard?.name;
        const discardSuit = (eventData.suit as string) || discardCard?.suit;
        const discardNumber = (eventData.number as number) ?? discardCard?.number;
        if (discardCardName && discardPid !== undefined) {
          if (discardPid === this.selfId) {
            this.animateDiscard(discardCardName, discardSuit, discardNumber);
          } else {
            this.animateCardPlayed(discardPid, discardCardName, discardSuit, discardNumber);
          }
        }
        break;
      }
      case 'CardResponded': {
        this.renderBattlefield();
        this.renderHandCards();
        const respPid = eventData.playerId as number;
        const respCard = eventData.card as any;
        if (respPid !== undefined) {
          if (respPid === this.selfId) {
            // 自己响应出牌也显示飞出动画
            this.animateDiscard(respCard?.name || (eventData.cardName as string) || '', respCard?.suit, respCard?.number);
          } else {
            this.animateCardPlayed(respPid, respCard?.name || (eventData.cardName as string) || '', respCard?.suit, respCard?.number);
          }
        }
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
        const dismPid = eventData.playerId as number;
        const dismCardName = eventData.cardName as string;
        const dismSuit = eventData.suit as string;
        const dismNumber = eventData.number as number;
        if (dismPid !== undefined && dismCardName) {
          this.animateCardDismantled(dismPid, dismCardName, dismSuit, dismNumber);
        }
        break;
      }
      case 'CardMovedToJudge': {
        this.renderBattlefield();
        break;
      }
      case 'CardEquipped': {
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
        setTimeout(() => this.clearGraceCards(), 1200);
        break;
      }
      case 'HpChanged':
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
      case 'GameOver': {
        this.phaseEl.textContent = '游戏结束';
        this.renderBattlefield();
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

  /** PVP Prompt 处理：接收服务器prompt，调用 HumanWebUIDriver 展示UI，通过socket回应 */
  private handlePVPPrompt(promptData: any): void {
    const { requestId, type, data } = promptData;
    this.pvpRequestId = requestId;

    // 设置 PVP 回应回调：点击 → socket.respond → 清空回调
    this.humanDriver.setPVPRespond((result: any) => {
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
        this.players[myIdx] = this.mapServerPlayerToLocal(data.state);
      }
      // 重新渲染手牌，确保 DOM 与最新 state 同步（击杀反贼摸3牌等场景）
      this.renderHandCards();
    }

    // 根据类型调用 HumanWebUIDriver 的对应方法
    try {
      switch (type) {
        case 'playCard':
          this.humanDriver.promptPlayCard(data.state, data.ctx);
          break;
        case 'target':
          this.humanDriver.promptTarget(
            data.state || this.players[this.pvpMyPlayerId],
            data.validTargets || [],
            data.reason || '选择目标',
            data.ctx
          );
          break;
        case 'response':
          this.humanDriver.promptResponse(data.state, data.cardName, data.ctx);
          break;
        case 'zone':
          this.humanDriver.promptZone(data.state, data.targetId, data.ctx);
          break;
        case 'zhanba':
          this.humanDriver.promptZhanBa(data.state, data.ctx);
          break;
        case 'discard':
          this.humanDriver.promptDiscard(data.state, data.ctx);
          break;
        case 'nullify':
          this.humanDriver.promptNullification(data.state, data.ctx);
          break;
        case 'armorTrigger':
          this.humanDriver.promptArmorTrigger(data.state, data.armorName, data.ctx);
          break;
        case 'weaponEffect':
          this.humanDriver.promptWeaponEffect(data.state, data.weaponName, data.ctx);
          break;
        case 'ironChainMode':
          this.humanDriver.promptIronChainMode(data.state, data.ctx);
          break;
        case 'amazingGrace':
          this.humanDriver.promptAmazingGrace(data.state, data.tableCards || [], data.ctx);
          break;
        case 'showCard':
          this.humanDriver.promptShowCard(data.state, data.ctx);
          break;
        case 'genderWeapon':
          this.humanDriver.promptGenderWeapon(data.state, data.attackerName, data.ctx);
          break;
        case 'yesNo':
          this.humanDriver.promptYesNo(data.question || '是否确认？');
          break;
        case 'ransackHand':
          this.humanDriver.promptRansackHand(data.state, data.targetId, data.ctx);
          break;
        case 'discardMulti':
          this.humanDriver.promptDiscardMulti(data.state, data.count, data.ctx);
          break;
        case 'selectCard':
          this.humanDriver.promptSelectCard(data.state, data.title || '选择一张牌', data.ctx);
          break;
        default:
          console.warn(`[PVP] 未处理的 prompt 类型: ${type}`);
          socketManager.respond(requestId, null);
          this.humanDriver.setPVPRespond(null);
          this.pvpRequestId = null;
      }
    } catch (err) {
      console.error(`[PVP] prompt 处理错误:`, err);
      socketManager.respond(requestId, null);
      this.humanDriver.setPVPRespond(null);
      this.pvpRequestId = null;
    }
  }

  /** PVP 游戏结束：显示结算界面 */
  private handlePVPGameOver(data: any): void {
    this.isGameOver = true;
    this.phaseEl.textContent = '游戏结束';
    this.stopTimer();
    this.renderBattlefield();

    // 游戏结束，身份全部公开：用服务端发来的真实身份更新本地 players
    if (data.playerRoles) {
      for (const p of this.players) {
        const realRole = data.playerRoles[p.id];
        if (realRole && p.role !== realRole) {
          (p as any).role = realRole;
        }
      }
    }

    const winner = data.winner || '未知';
    const expData = {
      killStats: data.killStats,
      expByPlayerId: data.expByPlayerId,
      escapedPlayerIds: data.escapedPlayerIds,
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

    setTimeout(() => this.showResultModal(winner, expData), 500);

    // 清理 PVP 监听
    this.cleanupPVPListeners();
  }

  /** 清理 PVP Socket 监听 */
  private cleanupPVPListeners(): void {
    for (const unsub of this.pvpUnsubs) unsub();
    this.pvpUnsubs = [];
    this.humanDriver?.setPVPRespond(null);
    this.pvpRequestId = null;
  }

  /** PVE闯关模式选将：支持动态人数+逐人选将+禁选池 */
  private showPVEHeroSelect(): void {
    const level = this.pveLevel;
    if (!level) { this.addLog('错误：未加载关卡数据'); return; }
    this.pvePickedHeroes = [];
    this.pvePickIndex = 0;
    this.heroSelectEl.style.display = 'flex';
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
    const totalPlayers = getTotalPlayers(level);
    const seatLayout = this.getPVESeatLayout(totalPlayers);
    this.pveSeatMap = new Map();
    for (let i = 0; i < seatLayout.length; i++) this.pveSeatMap.set(seatLayout[i], i);
    this.humanPlayerIdx = 0;
    const players: PlayerState[] = [];
    let pid = 0;
    for (let i = 0; i < allyHeroIds.length; i++) {
      const h = getHeroById(allyHeroIds[i])!;
      players.push(this.makePVEPlayer(pid++, h, i===0?'你':`副将${i}`, Faction.Ally, seatLayout[i]));
    }
    for (let i = 0; i < enemyHeroIds.length; i++) {
      const h = getHeroById(enemyHeroIds[i])!;
      players.push(this.makePVEPlayer(pid++, h, h.name, Faction.Enemy, seatLayout[allyHeroIds.length+i]));
    }
    this.players = players;
    this.heroesPicked = players.map(p => getHeroById(p.heroId)!);
    this.heroSelectEl.style.display = 'none';

    // PVE：根据关卡所属章节设置背景和BGM（而非英雄地区）
    const chapter = getChapterForLevel(this.levelId);
    if (chapter) {
      this.wallpaperRegionBase = this.getWallpaperBaseForRegion(chapter.region);
      this.wallpaperLastMinute = -1;
      this.wallpaperCrossEl = this.el.querySelector('#game-bg-cross')! as HTMLElement;
      const bgEl = this.el.querySelector('#game-bg')! as HTMLElement;
      const firstWallpaper = `Resources/Backgrounds/${this.wallpaperRegionBase}.png`;
      bgEl.style.backgroundImage = `url('${firstWallpaper}')`;
      this.wallpaperCrossEl.style.backgroundImage = `url('${firstWallpaper}')`;
      this.wallpaperCrossEl.style.opacity = '0';
      this.wallpaperLastMinute = 0;
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
  private makePVEPlayer(id: number, hero: HeroData, playerName: string, faction: Faction, seatIdx: number): PlayerState {
    return { id, playerName, heroId: hero.id, name: hero.name, region: hero.region, gender: hero.gender==='male'?GenderType.Male:GenderType.Female, role: RoleType.None, faction, pveSeatIndex: seatIdx, maxHp: hero.maxHp, hp: hero.maxHp, handCards: [], equipZone: { [EquipmentType.None]: null, [EquipmentType.Weapon]: null, [EquipmentType.Armor]: null, [EquipmentType.OffensiveHorse]: null, [EquipmentType.DefensiveHorse]: null } as Record<EquipmentType, Card | null>, judgeZone: [], isFlipped: false, isChained: false, isDead: false, skipDrawPhase: false, skipPlayPhase: false, skipDiscardPhase: false, slashUsedCount: 0, nextSlashDamageBonus: 0, wineUsedThisTurn: false };
  }

  /** PVE动态座位布局 */
  private getPVESeatLayout(totalPlayers: number): number[] {
    switch (totalPlayers) {
      case 8: return [0, 1, 2, 3, 4, 5, 6, 7];
      case 7: return [0, 1, 2, 3, 5, 6, 7];       // 对角(4)不填
      case 6: return [0, 1, 2, 3, 5, 7];           // 左右隔2位(4,6)不填
      case 5: return [0, 1, 3, 5, 7];               // 左右隔1位(2,6)+对角(4)不填
      case 4: return [0, 3, 5, 7];                  // 左右隔1位(1,6)+左右隔2位(2,4)不填
      case 3: return [0, 3, 5];                     // 自己+左右隔2位(1,7)不填
      case 2: return [0, 4];                        // 自己+对角(1,2,3,5,6,7)不填
      default: return [0, 1, 2, 3, 4, 5, 6, 7];
    }
  }

  private createHeroCard(hero: HeroData): HTMLElement {
    const card = document.createElement('div');
    card.className = 'hero-card';
    const genderIcon = hero.gender === 'male' ? '♂' : '♀';
    const godBadge = hero.isGod ? '<span class="hero-god-badge">神</span>' : '';
    const imgSrc = `Resources/Characters/${hero.name}.png`;
    card.innerHTML = `
      <div class="hero-card-img"><img src="${imgSrc}" onerror="this.parentElement.textContent='${hero.name.charAt(0)}'"></div>
      <div class="hero-card-name">${hero.name}${godBadge}</div>
      <div class="hero-card-title">${hero.title}</div>
      <div class="hero-card-region">${hero.region} · ${hero.element} · ${genderIcon}</div>
      <div class="hero-card-hp">❤️ ${hero.maxHp}血</div>
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

    this.heroSelectEl.style.display = 'none';
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
        drivers.set(p.id, new DelayedAIDriver(p.id, () => globalAiDelayMs) as any as IPlayerDriver);
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
    damageSystem.onTransmitChain = async (target, damage, sourceCard, source) => {
      cardEffectManager.transmitChainedDamage(target, damage, sourceCard, source, false);
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
      cardEffectManager, damageSystem, equipManager, drivers
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
          const success = await this.skillManager!.executeActiveSkill(me, 'nahida_metaphor', ctx2);
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
      const success = await this.skillManager.executeActiveSkill(me, skillId, ctx);
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
    this.eventBus.on(GameEvent.Log, (e) => {
      this.addLog(e.data.message as string);
    });
    this.eventBus.on(GameEvent.TurnStarted, (e) => {
      this.phaseEl.textContent = `${(e.data as any).playerName || ''}`;
      this.roundLabelEl.textContent = String(e.data.round || 0);
      this.roundNumEl.textContent = String(e.data.turn || 0);
      this.currentTurnPlayerId = (e.data as any).playerId ?? this.players[this.humanPlayerIdx].id;
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
      // 【技能钩子】回合结束 - 枫原万叶落叶等
      const playerId = e.data.playerId as number;
      if (playerId !== undefined && this.skillManager) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
          const ctx = {
            players: this.players,
            roundCount: this.flowController?.roundCount || 0,
            currentTurn: this.flowController?.currentTurnInRound || 0,
            currentPlayerId: player.id,
            gameOverWinner: null,
            drawPileCount: this.deck?.drawPileCount || 0,
            discardPileCount: this.deck?.discardPile?.length || 0,
          };
          this.skillManager.onTurnEnd(player, ctx);
        }
      }
    });
    this.eventBus.on(GameEvent.PhaseChanged, (e) => {
      const phaseNames: Record<string, string> = {
        'Prepare': '准备阶段', 'Judging': '判定阶段', 'Draw': '摸牌阶段',
        'Play': '出牌阶段', 'Discard': '弃牌阶段', 'End': '回合结束',
      };
      const phaseName = phaseNames[e.data.phase as string] || String(e.data.phase);
      this.phaseEl.textContent = phaseName;
      // PVE 模式下 deck 存在时更新计数
      if (this.deck) this.deckCountEl.textContent = String(this.deck.drawPileCount);
      // 弃牌阶段结束时的视觉反馈
      if (e.data.phase === 'End') {
        this.phaseEl.classList.add('phase-flash');
        setTimeout(() => this.phaseEl.classList.remove('phase-flash'), 600);
      }
      this.renderBattlefield();
    });
    this.eventBus.on(GameEvent.HpChanged, () => this.renderBattlefield());
    this.eventBus.on(GameEvent.CardPlayed, (e) => {
      this.renderBattlefield();
      this.renderHandCards();
      // 其他玩家打牌动画（自己打牌手牌区已更新，无需额外飞出动画）
      const playerId = e.data.playerId as number;
      const card = e.data.card as Card;
      if (playerId !== undefined && playerId !== this.selfId && card) {
        this.animateCardPlayed(playerId, card.name, card.suit, card.number);
      }
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
      // 弃牌动画：只有自己弃牌时显示弃牌动画，其他玩家使用座位飞出动画
      const playerId = e.data.playerId as number;
      const card = e.data.card as Card | undefined;
      const cardName = (e.data.cardName as string) || card?.name;
      const suit = (e.data.suit as string) || card?.suit;
      const number = (e.data.number as number) ?? card?.number;
      if (cardName && playerId !== undefined) {
        if (playerId === this.selfId) {
          this.animateDiscard(cardName, suit, number);
        } else {
          this.animateCardPlayed(playerId, cardName, suit, number);
        }
      }
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
      const playerId = e.data.playerId as number;
      const card = e.data.card as Card | undefined;
      if (playerId !== undefined) {
        if (playerId === this.selfId) {
          this.animateDiscard(card?.name || (e.data.cardName as string) || '', card?.suit, card?.number);
        } else {
          this.animateCardPlayed(playerId, card?.name || (e.data.cardName as string) || '', card?.suit, card?.number);
        }
      }
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
    // 过河拆桥弃置动画：被拆的牌从目标座位飞向弃牌堆
    this.eventBus.on(GameEvent.CardDismantled, (e) => {
      const playerId = e.data.playerId as number;
      const cardName = e.data.cardName as string;
      const suit = e.data.suit as string;
      const number = e.data.number as number;
      if (playerId !== undefined && cardName) {
        this.animateCardDismantled(playerId, cardName, suit, number);
      }
    });
    this.eventBus.on(GameEvent.CardEquipped, () => { this.renderBattlefield(); this.renderHandCards(); });
    this.eventBus.on(GameEvent.CardMovedToJudge, () => this.renderBattlefield());
    this.eventBus.on(GameEvent.ChainedStateChanged, () => this.renderBattlefield());
    this.eventBus.on(GameEvent.PlayerDied, () => this.renderBattlefield());
    this.eventBus.on(GameEvent.PlayerRescued, () => this.renderBattlefield());

    this.eventBus.on(GameEvent.GameOver, (e) => {
      this.isGameOver = true;
      this.phaseEl.textContent = '游戏结束';
      this.renderBattlefield();
      const winner = e.data.winner as string;

      // PVE 闯关：先计算星级（在异步exp上传之前，否则return会跳过）
      if (this.pveLevel && winner === '友方阵营') {
        this.computeAndSavePVEStars();
      }

      if (this.flowController) {
        const expData = this.computeLocalPVPExp(winner);
        // PVE 模式：不进行经验上报，直接显示结算
        if (this.pveLevel) {
          setTimeout(() => this.showResultModal(winner, expData), 500);
        } else {
          const me = this.getHumanPlayer();
          if (me) {
            const myExp = expData.expByPlayerId[me.id];
            if (myExp && myExp.totalExp > 0) {
              if (socketManager.isConnected) {
                socketManager.emitWithAck('add_exp', { totalExp: myExp.totalExp }).then((ack: any) => {
                  if (ack?.success) { myExp.oldLevel = ack.oldLevel; myExp.newLevel = ack.newLevel; myExp.leveledUp = ack.leveledUp; }
                  else { this.applyLocalExpFallback(myExp); }
                  setTimeout(() => this.showResultModal(winner, expData), 500);
                }).catch(() => { this.applyLocalExpFallback(myExp); setTimeout(() => this.showResultModal(winner, expData), 500); });
                return;
              } else { this.applyLocalExpFallback(myExp); }
            }
          }
          setTimeout(() => this.showResultModal(winner, expData), 500);
        }
      } else {
        setTimeout(() => this.showResultModal(winner), 500);
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
      setTimeout(() => this.clearGraceCards(), 1200);
    });
  }

  async startGame(): Promise<void> {
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
      this.addLog('游戏循环已结束。');
      this.stopTimer();
    }).catch((err) => {
      console.error('游戏循环异常:', err);
      this.addLog(`游戏异常终止: ${err?.message || err}`);
      this.stopTimer();
    });
  }

  // ======================== 计时器 ========================

  private startTimer(): void {
    this.timerSeconds = 0;
    this.updateTimerDisplay();
    this.timerInterval = setInterval(() => {
      this.timerSeconds++;
      this.updateTimerDisplay();
      this.tickWallpaper();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
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
        setTimeout(() => card.remove(), ANIM_DURATION + i * 150 + 300);
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
      setTimeout(() => card.remove(), 900 + i * 200);
    }
  }

  /** 所有玩家打出牌时的动画：明牌（显示卡牌PNG）从座位飞到中央，带花色点数 */
  private animateCardPlayed(playerId: number, cardName: string, suit?: string, number?: number): void {
    // 找到对应座位
    let seatEl: Element | null;
    if (playerId === this.selfId) {
      seatEl = this.el.querySelector('#seat-self .seat-card');
    } else {
      seatEl = this.el.querySelector(`.seat-card[data-player-id="${playerId}"]`);
    }
    if (!seatEl) {
      // fallback: 使用中央动画
      this.animateDiscard(cardName, suit, number);
      return;
    }

    const rect = seatEl.getBoundingClientRect();
    const seatCX = rect.left + rect.width / 2;
    const seatCY = rect.top + rect.height / 2;

    const fileName = CARD_FILE_NAME_MAP[cardName] || cardName;
    const imgSrc = `Resources/Cards/${fileName}.png`;
    const suitSym = SUIT_SYMBOL[suit || ''] || '';
    const numText = NUMBER_TEXT[number || 0] || String(number || '');
    const suitColor = SUIT_COLOR[suit || ''] || '#888';

    const card = document.createElement('div');
    card.className = 'anim-card flying-from-seat';
    card.style.left = `${seatCX}px`;
    card.style.top = `${seatCY}px`;
    card.style.position = 'fixed';
    card.style.zIndex = '200';
    card.innerHTML = `<img src="${imgSrc}" alt="${cardName}" 
      onerror="this.parentElement.textContent='${cardName.substring(0,2)}'"
      style="width:100%;height:100%;object-fit:cover;border-radius:4px;">
      <div class="anim-card-suit-info">
        <span style="color:${suitColor}">${suitSym}</span><span style="color:${suitColor}">${numText}</span>
      </div>`;
    this.animLayer.appendChild(card);
    setTimeout(() => card.remove(), 2200);
  }

  /** 弃牌动画：明牌飞到中央区（显示卡牌PNG），带花色点数 */
  animateDiscard(cardName: string, suit?: string, number?: number): void {
    const fileName = CARD_FILE_NAME_MAP[cardName] || cardName;
    const imgSrc = `Resources/Cards/${fileName}.png`;
    const suitSym = SUIT_SYMBOL[suit || ''] || '';
    const numText = NUMBER_TEXT[number || 0] || String(number || '');
    const suitColor = SUIT_COLOR[suit || ''] || '#888';

    const card = document.createElement('div');
    card.className = 'anim-card flying-discard';
    card.style.left = '50%';
    card.style.bottom = '22%';
    card.style.transform = 'translateX(-50%)';
    card.innerHTML = `<img src="${imgSrc}" alt="${cardName}"
      onerror="this.parentElement.textContent='${cardName.substring(0,2)}'"
      style="width:100%;height:100%;object-fit:cover;border-radius:4px;">
      <div class="anim-card-suit-info">
        <span style="color:${suitColor}">${suitSym}</span><span style="color:${suitColor}">${numText}</span>
      </div>`;
    this.animLayer.appendChild(card);
    setTimeout(() => card.remove(), 2500);
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
    document.body.appendChild(card);
    setTimeout(() => card.remove(), 2000);
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
    document.body.appendChild(card);
    setTimeout(() => card.remove(), 1800);
  }

  /** 过河拆桥动画：牌从目标座位飞向弃牌堆 */
  private animateCardDismantled(playerId: number, cardName: string, suit?: string, number?: number): void {
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
    card.className = 'anim-card flying-dismantled';
    card.style.left = `${seatCX}px`;
    card.style.top = `${seatCY}px`;
    card.style.position = 'fixed';
    card.style.zIndex = '300';
    card.innerHTML = `<img src="${imgSrc}" alt="${cardName}"
      onerror="this.parentElement.textContent='${cardName.substring(0,2)}'"
      style="width:100%;height:100%;object-fit:cover;border-radius:4px;">
      <div class="anim-card-suit-info">
        <span style="color:${suitColor}">${suitSym}</span><span style="color:${suitColor}">${numText}</span>
      </div>`;
    document.body.appendChild(card);
    setTimeout(() => card.remove(), 1800);
  }

  /** 判定动画：卡背→翻转→正面+结果标记 */
  animateJudge(cardName: string, suit: string, number: number, judgeResult: boolean, idx: number = 0): Promise<void> {
    return new Promise(resolve => {
      const fileName = CARD_FILE_NAME_MAP[cardName] || cardName;
      const imgSrc = `Resources/Cards/${fileName}.png`;
      const suitSym = SUIT_SYMBOL[suit] || '';
      const numText = NUMBER_TEXT[number] || String(number || '');
      const suitColor = SUIT_COLOR[suit] || '#888';

      // 每个判定牌间隔 2.3s * idx（前一个动画 2s + 0.3s 间隔）
      const delayMs = idx * 2300;

      setTimeout(() => {
        const overlay = document.createElement('div');
        overlay.className = 'judge-anim-overlay';
        overlay.style.zIndex = `${1050 + idx}`;
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
          <div class="judge-anim-result">${judgeResult ? '✅' : '❌'}</div>
        `;
        document.body.appendChild(overlay);

        const inner = overlay.querySelector('.judge-anim-inner')! as HTMLElement;
        const result = overlay.querySelector('.judge-anim-result')! as HTMLElement;

        // 阶段1：0.3s后翻转
        setTimeout(() => {
          inner.classList.add('flipped');
        }, 300);

        // 阶段2：翻转完成后显示结果
        setTimeout(() => {
          result.classList.add('show');
        }, 1000);

        // 阶段3：全部消失后resolve
        setTimeout(() => {
          overlay.remove();
          resolve();
        }, 2000);
      }, delayMs);
    });
  }

  /** 选择目标金光动画：从手牌区射向目标座位 */
  showTargetBeam(targetPlayerId: number): void {
    // 使用范围查询（this.el）避免全局匹配到重复元素，与 getSeatElement 保持一致
    let seatEl: Element | null;
    if (targetPlayerId === this.selfId) {
      seatEl = this.el.querySelector('#seat-self .seat-card');
    } else {
      seatEl = this.el.querySelector(`.seat-card[data-player-id="${targetPlayerId}"]`);
    }
    if (!seatEl) return;
    const seatRect = seatEl.getBoundingClientRect();
    const targetCX = seatRect.left + seatRect.width / 2;
    const targetCY = seatRect.top + seatRect.height / 2;

    // 从手牌区中央发出
    const handRect = this.handCardsEl.getBoundingClientRect();
    const handCX = handRect.left + handRect.width / 2;
    const handCY = handRect.top + handRect.height / 2;

    const dx = targetCX - handCX;
    const dy = targetCY - handCY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    const beam = document.createElement('div');
    beam.className = 'target-beam';
    beam.style.left = `${handCX}px`;
    beam.style.top = `${handCY}px`;
    beam.style.width = '6px';
    beam.style.height = `${dist}px`;
    beam.style.transform = `rotate(${angle + 90}deg)`;
    beam.style.transformOrigin = 'top center';
    beam.dataset.beamTarget = String(targetPlayerId);
    document.body.appendChild(beam);
    // 3秒后自动清除（防止残留）
    setTimeout(() => beam.remove(), 3000);
  }

  /** 两个座位之间的黄光连线（source→target），用于出牌时的视觉效果 */
  showTargetBeamBetween(sourceId: number, targetId: number): void {
    const sourceSeat = this.getSeatElement(sourceId);
    const targetSeat = this.getSeatElement(targetId);
    if (!sourceSeat || !targetSeat) return;

    const sRect = sourceSeat.getBoundingClientRect();
    const tRect = targetSeat.getBoundingClientRect();
    const sCX = sRect.left + sRect.width / 2;
    const sCY = sRect.top + sRect.height / 2;
    const tCX = tRect.left + tRect.width / 2;
    const tCY = tRect.top + tRect.height / 2;

    const dx = tCX - sCX;
    const dy = tCY - sCY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    const beam = document.createElement('div');
    beam.className = 'card-target-beam';
    beam.style.left = `${sCX}px`;
    beam.style.top = `${sCY}px`;
    beam.style.width = `${dist}px`;
    beam.style.height = '4px';
    beam.style.transform = `rotate(${angle}deg)`;
    beam.style.transformOrigin = 'left center';
    document.body.appendChild(beam);

    // 1.2秒后自动清除
    setTimeout(() => beam.remove(), 1200);
  }

  /** 获取座位的 DOM 元素 */
  private getSeatElement(playerId: number): Element | null {
    if (playerId === this.selfId) {
      return this.el.querySelector('#seat-self .seat-card');
    }
    return this.el.querySelector(`.seat-card[data-player-id="${playerId}"]`);
  }

  /** 清除所有金光 */
  clearTargetBeams(): void {
    document.querySelectorAll('.target-beam').forEach(el => el.remove());
  }

  // ======================== 高亮系统（供HumanWebUIDriver调用） ========================

  /** 高亮可打出的手牌（含契约对象的牌） */
  highlightPlayableCards(state: PlayerState, ctx: GameContextSnapshot): void {
    this.clearHighlights();
    this.actionBarEl.style.display = 'flex';
    this.playEndBtnEl.style.display = 'inline-block';
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
    this.actionBarEl.appendChild(btn);
  }

  /** 隐藏"确认出牌"按钮 */
  private hidePlayConfirmButton(): void {
    const existing = this.actionBarEl.querySelector('#play-confirm-btn');
    if (existing) existing.remove();
  }

  private canPlayCard(card: Card, state: PlayerState, ctx: GameContextSnapshot): boolean {
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
  highlightResponseCards(validCards: Card[], cardName: string): void {
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
    this.showResponseButtons(cardName);
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
  private showResponseButtons(cardName: string): void {
    let btnBar = this.el.querySelector('#response-btn-bar') as HTMLElement | null;
    if (!btnBar) {
      btnBar = document.createElement('div');
      btnBar.id = 'response-btn-bar';
      btnBar.className = 'response-btn-bar';
      this.actionBarEl.parentElement?.insertBefore(btnBar, this.actionBarEl);
    }
    btnBar.style.display = 'flex';
    btnBar.innerHTML = `
      <span class="response-hint">需响应: ${cardName}</span>
      <button class="btn-response-confirm" id="response-play-btn" disabled>✦ 打出</button>
      <button class="btn-response-pass" id="response-pass-btn">放弃响应</button>
    `;
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
  highlightDiscardCards(state: PlayerState, excess: number = 0, limit: number = 0): void {
    this.clearHighlights();
    const cards = this.handCardsEl.querySelectorAll('.game-card');
    cards.forEach((el, i) => {
      el.classList.add('playable');
      (el as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        this.clearHighlights();
        this.humanDriver.resolveDiscard(i);
        this.hidePrompt();
      };
    });

    // 显示弃牌阶段操作栏，提示还需弃置的牌数
    if (excess > 0) {
      this.actionBarEl.style.display = 'flex';
      // 创建一个提示标签显示弃牌进度
      const existingLabel = this.actionBarEl.querySelector('.discard-progress-label');
      if (!existingLabel) {
        const label = document.createElement('span');
        label.className = 'discard-progress-label';
        label.textContent = `还需弃置 ${excess} 张`;
        this.actionBarEl.appendChild(label);
      } else {
        existingLabel.textContent = `还需弃置 ${excess} 张`;
      }
    }
  }

  /** 高亮无懈可击 */
  highlightNullifyCards(state: PlayerState): void {
    this.clearHighlights();
    // 如果有五谷丰登窗口打开，将无懈可击选项嵌入弹窗左下角
    if (this.graceOverlay) {
      this.renderGraceNullifySection(state);
      return;
    }
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

      // 不再注册点击空白区域自动放弃的全局监听器，只保留"放弃打出"按钮和超时
    }
  }

  restoreGraceOverlayZIndex(): void {
    if (this.graceOverlay) {
      this.graceOverlay.style.display = '';
    }
  }

  private nullifyPassBar: HTMLElement | null = null;

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

  private hideNullifyPassButton(): void {
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
    // 在目标座位卡上高亮（不添加targetable类避免与目标选择冲突）
    const seatEl = this.el.querySelector(`.seat-card[data-player-id="${target.id}"]`);
    if (seatEl) {
      seatEl.classList.add('zone-highlight');


      if (target.handCards.length > 0) {
        const handZone = document.createElement('div');
        handZone.className = 'zone-selector zone-hand';
        handZone.textContent = `手牌(${target.handCards.length})`;
        handZone.onclick = (e) => { e.stopPropagation(); this.cancelGlobalHandler(); this.humanDriver.resolveZone({ zone: 'hand', index: 0 }); this.hidePrompt(); this.clearHighlights(); };
        seatEl.appendChild(handZone);
      }
      const equipSlots = Object.entries(target.equipZone).filter(([, v]) => v !== null);
      if (equipSlots.length > 0) {
        const equipZone = document.createElement('div');
        equipZone.className = 'zone-selector zone-equip';
        equipZone.textContent = `装备(${equipSlots.length})`;
        equipZone.onclick = (e) => { 
          e.stopPropagation(); this.cancelGlobalHandler(); this.hidePrompt(); this.clearHighlights();
          if (equipSlots.length === 1) {
            this.humanDriver.resolveZone({ zone: 'equip', index: 0 });
          } else {
            this.showZoneDetailSelect(target, 'equip', equipSlots as [string, Card][]);
          }
        };
        seatEl.appendChild(equipZone);
      }
      if (target.judgeZone.length > 0) {
        const judgeZone = document.createElement('div');
        judgeZone.className = 'zone-selector zone-judge';
        judgeZone.textContent = `判定(${target.judgeZone.length})`;
        judgeZone.onclick = (e) => { 
          e.stopPropagation(); this.cancelGlobalHandler(); this.hidePrompt(); this.clearHighlights();
          if (target.judgeZone.length === 1) {
            this.humanDriver.resolveZone({ zone: 'judge', index: 0 });
          } else {
            this.showZoneDetailSelect(target, 'judge', target.judgeZone.map((c, i) => [`judge_${i}`, c]));
          }
        };
        seatEl.appendChild(judgeZone);
      }
    }
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
    // 清理弃牌进度标签
    const discardLabel = this.actionBarEl.querySelector('.discard-progress-label');
    if (discardLabel) discardLabel.remove();
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
    this.promptBarEl.textContent = text;
    this.promptBarEl.style.display = 'block';
  }
  hidePrompt(): void {
    this.promptBarEl.style.display = 'none';
  }

  showYesNoPrompt(title: string, resolve: (v: boolean) => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.innerHTML = `
      <div class="game-modal">
        <h3>${title}</h3>
        <div style="display:flex;gap:12px;justify-content:center;margin-top:16px;">
          <button class="btn btn-gold btn-sm" id="yn-yes">发动</button>
          <button class="btn btn-ghost btn-sm" id="yn-no">不发动</button>
        </div>
      </div>
    `;
    overlay.querySelector('#yn-yes')!.addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.querySelector('#yn-no')!.addEventListener('click', () => { overlay.remove(); resolve(false); });
    document.body.appendChild(overlay);
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
        overlay.remove();
        resolve(cardName);
      });
    });
    overlay.querySelector('#metaphor-cancel')!.addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });
    document.body.appendChild(overlay);
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
    overlay.querySelector('#ic-recast')!.addEventListener('click', () => { overlay.remove(); resolve('recast'); });
    overlay.querySelector('#ic-chain')!.addEventListener('click', () => { overlay.remove(); resolve('chain'); });
    document.body.appendChild(overlay);
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
    confirmBtn.addEventListener('click', () => { overlay.remove(); resolve(selected); });
    overlay.querySelector('#venti-cancel')!.addEventListener('click', () => { overlay.remove(); resolve(currentHp); });
    document.body.appendChild(overlay);
  }

  /** 顺手牵羊/过河拆桥：从目标手牌区主动选牌 */
  showRansackHandPrompt(target: PlayerState, resolve: (idx: number) => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.style.pointerEvents = 'auto';
    // 不能看到对手手牌内容：只显示背面编号
    const cards = target.handCards.map((_c, i) => {
      return `
        <button class="target-btn ransack-card-btn" data-idx="${i}" style="text-align:left;width:100%;pointer-events:auto;">
          🂠 手牌 #${i + 1}
        </button>`;
    }).join('');
    overlay.innerHTML = `
      <div class="game-modal" style="max-width:420px;max-height:70vh;overflow-y:auto;pointer-events:auto;">
        <h3>选择 ${target.name} 的一张手牌</h3>
        <div class="target-list" style="pointer-events:auto;">${cards}</div>
        <div style="text-align:center;margin-top:12px;">
          <button class="btn btn-ghost btn-sm" id="ransack-cancel" style="pointer-events:auto;">取消</button>
        </div>
      </div>
    `;
    overlay.querySelectorAll('.ransack-card-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const idx = parseInt((btn as HTMLElement).dataset.idx || '-1');
        overlay.remove();
        resolve(idx);
      });
    });
    overlay.querySelector('#ransack-cancel')!.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      overlay.remove();
      resolve(-1);
    });
    // 点击遮罩空白区域不做任何事，必须点击牌或取消按钮
    overlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.stopPropagation();
      }
    });
    document.body.appendChild(overlay);
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
            <span style="color:${color};font-weight:bold;">${suitSym}${numText}</span>
            ${getCardDetail(c)}
            ${sel ? ' ✅' : ''}
          </button>`;
      }).join('');

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
          if (selected.size === 2) {
            setTimeout(() => {
              const arr = Array.from(selected);
              overlay.remove();
              resolve([arr[0], arr[1]]);
            }, 300);
          }
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
    document.body.appendChild(overlay);

    refreshCards();

    let interval: any = setInterval(() => {
      const confirmBtn = overlay.querySelector('#zhanba-confirm')! as HTMLButtonElement;
      if (selected.size >= 2) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '确认合成 ✓';
      } else {
        confirmBtn.disabled = true;
        confirmBtn.textContent = `确认合成 (已选${selected.size}/2)`;
      }
    }, 100);

    overlay.querySelector('#zhanba-confirm')!.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (selected.size !== 2) return;
      const arr = Array.from(selected);
      overlay.remove();
      clearInterval(interval);
      resolve([arr[0], arr[1]]);
    });

    overlay.querySelector('#zhanba-cancel')!.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      overlay.remove();
      clearInterval(interval);
      resolve(null);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.stopPropagation();
        overlay.remove();
        clearInterval(interval);
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
      Weapon: '武器', Armor: '防具', AttackMount: '进攻马', DefenseMount: '防御马', Treasure: '宝物',
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
          <span style="color:${color};font-weight:bold;">${suitSym}${numText}</span>
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
    document.body.appendChild(overlay);

    overlay.querySelectorAll('.zone-detail-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        const idx = parseInt((btn as HTMLElement).dataset.idx || '0');
        overlay.remove();
        this.humanDriver.resolveZone({ zone, index: idx });
      });
    });

    overlay.querySelector('#zone-detail-cancel')!.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      overlay.remove();
      this.humanDriver.resolveZone(null);
    });

    // 点击遮罩空白区域不做任何事，必须点击牌或取消按钮
    overlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.stopPropagation();
      }
    });
  }

  /** 贯石斧：选择多张牌弃置 */
  showDiscardMultiPrompt(state: PlayerState, count: number, resolve: (indices: number[]) => void): void {
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
    const equipBtns = equipCards.map(([slot, c], i) =>
      cardHtml(c, state.handCards.length + i, `装备-${slot}`)
    ).join('');

    overlay.innerHTML = `
      <div class="game-modal" style="max-width:420px;max-height:75vh;overflow-y:auto;">
        <h3>贯石斧 - 选择 ${count} 张牌弃置</h3>
        <p style="color:#aaa;font-size:13px;">已选: <span id="dm-sel-count">0</span>/${count}</p>
        <div class="target-list">${handBtns}${equipBtns}</div>
        <div style="text-align:center;margin-top:12px;display:flex;gap:12px;justify-content:center;">
          <button class="btn btn-gold btn-sm" id="dm-confirm" disabled>确认</button>
          <button class="btn btn-ghost btn-sm" id="dm-cancel">取消</button>
        </div>
      </div>
    `;

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
        overlay.remove();
        resolve(Array.from(selected));
      }
    });
    overlay.querySelector('#dm-cancel')!.addEventListener('click', () => { overlay.remove(); resolve([]); });
    document.body.appendChild(overlay);
  }

  public graceOverlay: HTMLElement | null = null;
  private graceResolve: ((i: number) => void) | null = null;
  private allGraceCards: Card[] = [];
  // cardId -> pickerName 的映射
  private gracePickedMap: Map<number, string> = new Map();
  private isGraceHumanTurn = false;

  /** 五谷丰登：一开始就展示所有牌 */
  private initGraceWindow(tableCards: Card[], allPlayerNames: string[]): void {
    this.allGraceCards = tableCards;
    this.gracePickedMap.clear();
    this.isGraceHumanTurn = false;

    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.id = 'grace-overlay';
    let cardsHtml = '';
    tableCards.forEach((c, i) => {
      cardsHtml += `<div class="grace-card-item" data-card-id="${c.id}" data-index="${i}">
        ${this.renderCardHtml(c)}
        <div class="grace-pick-label"></div>
      </div>`;
    });
    overlay.innerHTML = `
      <div class="game-modal grace-modal">
        <h3>🌾 五谷丰登</h3>
        <div class="grace-cards-row" id="grace-cards-row">${cardsHtml}</div>
        <div class="grace-status" id="grace-status">等待玩家选牌...</div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.graceOverlay = overlay;
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
      statusEl.textContent = `${pickerName} 已选择`;
    }
  }

  showGraceCards(tableCards: Card[], resolve: (i: number) => void): void {
    this.allGraceCards = tableCards;
    this.graceResolve = resolve;
    this.isGraceHumanTurn = true;

    if (!this.graceOverlay || !this.graceOverlay.parentElement) {
      // 窗口不存在时（AI玩家被直接调用），创建fallback
      const overlay = document.createElement('div');
      overlay.className = 'game-modal-overlay';
      overlay.id = 'grace-overlay-fallback';
      let cardsHtml = '';
      tableCards.forEach((c, i) => {
        cardsHtml += `<div class="grace-card-item" data-card-id="${c.id}" data-index="${i}">
          ${this.renderCardHtml(c)}
          <div class="grace-pick-label"></div>
        </div>`;
      });
      overlay.innerHTML = `
        <div class="game-modal grace-modal">
          <h3>🌾 五谷丰登 - 选择一张牌</h3>
          <div class="grace-cards-row">${cardsHtml}</div>
        </div>
      `;
      this.bindGraceCardClicks(overlay);
      document.body.appendChild(overlay);
      this.graceOverlay = overlay;
    }

    // 更新已选状态
    this.updateGracePickedVisuals();
    // 重新绑定未选牌的点击事件
    this.bindGraceCardClicks(this.graceOverlay);
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
    this.removeGraceNullifySection();
    if (this.graceOverlay) {
      this.graceOverlay.remove();
      this.graceOverlay = null;
    }
    this.graceResolve = null;
    this.gracePickedMap.clear();
    this.allGraceCards = [];
    this.isGraceHumanTurn = false;
  }

  /** 在五谷丰登弹窗内渲染无懈可击选项 */
  private renderGraceNullifySection(state: PlayerState): void {
    if (!this.graceOverlay) return;
    const nullifyCards = state.handCards.filter(c => c.name === '无懈可击');
    const modal = this.graceOverlay.querySelector('.grace-modal') as HTMLElement | null;
    if (!modal) return;

    // 移除旧的无懈区域
    this.removeGraceNullifySection();

    if (nullifyCards.length === 0) {
      this.humanDriver.resolveNullify(false);
      return;
    }

    const section = document.createElement('div');
    section.id = 'grace-nullify-section';
    section.className = 'grace-nullify-section';

    // 标题
    const title = document.createElement('div');
    title.className = 'grace-nullify-title';
    title.textContent = '是否使用【无懈可击】？';
    section.appendChild(title);

    // 卡牌容器
    const cardsRow = document.createElement('div');
    cardsRow.className = 'grace-nullify-cards';
    nullifyCards.forEach((card, i) => {
      const cardEl = document.createElement('div');
      cardEl.className = 'grace-nullify-card';
      cardEl.title = '点击打出无懈可击';
      cardEl.innerHTML = this.renderCardHtml(card);
      cardEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.humanDriver.resolveNullify(true);
        this.removeGraceNullifySection();
      });
      cardsRow.appendChild(cardEl);
    });
    section.appendChild(cardsRow);

    // "不打"按钮
    const skipBtn = document.createElement('button');
    skipBtn.className = 'grace-nullify-skip';
    skipBtn.textContent = '不打';
    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.humanDriver.resolveNullify(false);
      this.removeGraceNullifySection();
    });
    section.appendChild(skipBtn);

    modal.appendChild(section);

    // 8秒超时自动跳过
    setTimeout(() => {
      if (this.graceOverlay?.querySelector('#grace-nullify-section')) {
        this.humanDriver.resolveNullify(false);
        this.removeGraceNullifySection();
      }
    }, 8000);
  }

  private removeGraceNullifySection(): void {
    const existing = document.querySelector('#grace-nullify-section');
    if (existing) existing.remove();
  }

  /** 人物信息弹窗 */
  showHeroInfoPopup(player: PlayerState): void {
    const hero = getHeroById(player.heroId);
    if (!hero) return;

    const roleName = getRoleChineseName(player.role);
    const imgSrc = `Resources/Characters/${player.name}.png`;
    const equipSummary = this.getEquipSummary(player);
    const skillsHtml = hero.skills
      ? hero.skills.map(s => `<div class="hero-info-skill"><strong>${s.name}</strong>：${s.desc}</div>`).join('')
      : '<div class="hero-info-skill">暂无技能描述</div>';

    const overlay = document.createElement('div');
    overlay.className = 'game-modal-overlay';
    overlay.id = 'hero-info-overlay';
    overlay.innerHTML = `
      <div class="hero-info-popup">
        <button class="hero-info-close" id="hero-info-close">✕</button>
        <div class="hero-info-layout">
          <div class="hero-info-img">
            <img src="${imgSrc}" alt="${player.name}" onerror="this.style.display='none';this.parentElement.querySelector('.char-fallback').style.display='flex';">
            <div class="char-fallback" style="display:none;width:100%;height:100%;">${player.name.charAt(0)}</div>
          </div>
          <div class="hero-info-detail">
            <h2>${player.name}${hero.isGod ? ' <span style="color:var(--gold);">★神</span>' : ''}</h2>
            <div class="hero-info-subtitle">${hero.title} · ${hero.region} · ${hero.gender === 'male' ? '♂男' : '♀女'}</div>
            <div class="hero-info-meta">
              <span class="hero-info-tag">${roleName}</span>
              <span class="hero-info-tag">❤ ${player.hp}/${player.maxHp}血</span>
              <span class="hero-info-tag">🃏 ${player.handCards.length}张</span>
            </div>
            <div class="hero-info-equip">装备：${equipSummary}</div>
            <div class="hero-info-skills-title">技能</div>
            <div class="hero-info-skills">${skillsHtml}</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#hero-info-close')!.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
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
    overlay.querySelector('#gw-discard')!.addEventListener('click', () => { overlay.remove(); resolve('discard'); });
    overlay.querySelector('#gw-draw')!.addEventListener('click', () => { overlay.remove(); resolve('draw'); });
    document.body.appendChild(overlay);
  }

  // ======================== 战场渲染 ========================

  /** 获取当前人类玩家（PVE用随机索引，PVP保持在索引1） */
  private getHumanPlayer(): PlayerState | undefined {
    if (!this.players || this.players.length === 0) return undefined;
    return this.players[this.humanPlayerIdx];
  }

  /** 根据人类玩家索引计算座位布局（逆时针一圈，人类在右下 self 位置） */
  private getBattlefieldLayout(): { top: PlayerState[]; left: PlayerState[]; right: PlayerState[]; self: PlayerState } {
    if (this.pveLevel && this.players.length > 0) return this.getPVEBattlefieldLayout();
    const hIdx = this.humanPlayerIdx;
    const p = this.players;
    // 逆时针布局：self(右下) → right(下往上+1,+2) → top(右到左+3,+4,+5) → left(上往下+6,+7)
    // top行从左到右应接 leftCol → 接 rightCol，即 +5,+4,+3（非3,4,5）
    return {
      right: [p[(hIdx + 2) % 8], p[(hIdx + 1) % 8]],
      top:   [p[(hIdx + 5) % 8], p[(hIdx + 4) % 8], p[(hIdx + 3) % 8]],
      left:  [p[(hIdx + 6) % 8], p[(hIdx + 7) % 8]],
      self:  p[hIdx],
    };
  }
  private getPVEBattlefieldLayout(): { top: PlayerState[]; left: PlayerState[]; right: PlayerState[]; self: PlayerState } {
    const seatMap = new Map<number, PlayerState>();
    for (const p of this.players) { const si = (p as any).pveSeatIndex; if (si !== undefined) seatMap.set(si, p); }
    const hSeat = (this.getHumanPlayer()! as any).pveSeatIndex || 0;
    const layout = { top: [] as PlayerState[], left: [] as PlayerState[], right: [] as PlayerState[], self: this.getHumanPlayer()! };
    // top行按从左到右：r=5,4,3（而非3,4,5，之前顺序反了）
    for (const slot of [{k:'right',r:1},{k:'right',r:2},{k:'top',r:5},{k:'top',r:4},{k:'top',r:3},{k:'left',r:6},{k:'left',r:7}]) {
      const p = seatMap.get((hSeat + slot.r) % 8);
      if (p) { if (slot.k==='right') layout.right.push(p); else if (slot.k==='left') layout.left.push(p); else layout.top.push(p); }
    }
    layout.right.reverse(); return layout;
  }

  private renderBattlefield(): void {
    if (!this.players || this.players.length < 1) return;

    const isPVE = !!this.pveLevel;
    const layout = this.getBattlefieldLayout();
    const topRow = this.el.querySelector('#top-row')!;
    const leftCol = this.el.querySelector('#left-col')!;
    const rightCol = this.el.querySelector('#right-col')!;
    const selfSeat = this.el.querySelector('#seat-self')!;

    // PVE模式：补齐空位为null占位符，确保8个座位框架始终显示
    if (isPVE) {
      while (layout.top.length < 3) layout.top.push(null as any);
      while (layout.left.length < 2) layout.left.push(null as any);
      while (layout.right.length < 2) layout.right.push(null as any);
    }

    topRow.innerHTML = layout.top.map(p => p ? this.renderSeatCard(p) : this.renderEmptySeat()).join('');
    leftCol.innerHTML = layout.left.map(p => p ? this.renderSeatCard(p) : this.renderEmptySeat()).join('');
    rightCol.innerHTML = layout.right.map(p => p ? this.renderSeatCard(p) : this.renderEmptySeat()).join('');
    selfSeat.innerHTML = this.renderSeatCard(layout.self);

    // 绑定点击事件
    this.el.querySelectorAll('.seat-card').forEach(el => {
      el.addEventListener('click', (e) => {
        const pid = parseInt((el as HTMLElement).dataset.playerId || '-1');
        // zone-highlight状态下的点击由highlightZones中的zone-selector处理
        if (el.classList.contains('zone-highlight')) return;
        if (el.classList.contains('targetable') && pid >= 0) {
          e.stopPropagation();
          this.clearHighlights();
          this.humanDriver.resolveTarget(pid);
          this.hidePrompt();
          return;
        }
        // 点击角色图片区域显示人物信息弹窗
        const target = e.target as HTMLElement;
        if (target.closest('.seat-char-img') && pid >= 0) {
          e.stopPropagation();
          // pid 是 player.id，而非数组索引；用 findIndex 间接寻址
          const playerIdx = this.players.findIndex(p => p.id === pid);
          if (playerIdx >= 0) this.showHeroInfoPopup(this.players[playerIdx]);
        }
      });
    });

    this.renderHandCards();
    this.renderEquipDisplay();
    this.renderSkills();
  }

  /** PVE空座位占位符（结构与renderSeatCard外层一致：div.seat > div.seat-card） */
  private renderEmptySeat(): string {
    return `<div class="seat"><div class="seat-card empty-seat" style="opacity:0.25;pointer-events:none;">
      <div class="seat-char-img" style="display:flex;align-items:center;justify-content:center;min-height:80px;">
        <div style="font-size:28px;color:#555;">—</div>
      </div>
      <div class="seat-name" style="color:#555;">空位</div>
      <div class="seat-role" style="color:#555;">—</div>
      <div class="seat-hp"><div class="seat-hp-fill" style="width:0%"></div></div>
    </div></div>`;
  }

  private renderSeatCard(player: PlayerState): string {
    const isDead = player.isDead;
    const humanPlayer = this.getHumanPlayer();
    const isHuman = player.id === humanPlayer?.id;
    const hero = getHeroById(player.heroId);
    const hpPercent = player.maxHp > 0 ? Math.max(0, (player.hp / player.maxHp) * 100) : 0;
    const hpClass = hpPercent > 60 ? 'high' : hpPercent > 30 ? 'medium' : 'low';
    // PVE模式显示友方/敌方，PVP显示身份
    const faction = (player as any).faction;
    const roleName = faction ? (faction === 'Ally' ? '友方' : '敌方') : getRoleChineseName(player.role);
    const chainIcon = player.isChained ? ' ⛓️' : '';
    const regionLabel = hero ? hero.region : '';
    const elementLabel = hero ? hero.element : '';
    const playerLabel = isHuman ? ' (你)' : ` · ${player.playerName}`;

    const judgeInfo = player.judgeZone.length > 0
      ? `<div class="seat-judge">判定: ${player.judgeZone.map(c => {
          const jSuit = SUIT_SYMBOL[c.suit] || '';
          const jNum = NUMBER_TEXT[c.number] || String(c.number);
          return `${c.name} ${jSuit}${jNum}`;
        }).join(',')}</div>`
      : '';

    // 状态标记
    const statusMarks = this.getStatusMarks(player);

    // 角色图片
    const imgSrc = `Resources/Characters/${player.name}.png`;
    const imgFallback = player.name.charAt(0);

    // 装备区域
    const equipHtml = this.getEquipSummaryHtml(player);

    const isCurrentTurn = player.id === this.currentTurnPlayerId && !isDead;
    const flippedMark = player.isFlipped ? '<div class="seat-flipped">翻面</div>' : '';
    return `
      <div class="seat">
        <div class="seat-card${isDead ? ' dead' : ''}${isHuman ? ' human' : ' ai'}${isCurrentTurn ? ' current-turn' : ''}${player.isFlipped ? ' flipped' : ''}"
             data-player-id="${player.id}">
          <div class="seat-char-img">
            ${flippedMark}
            <img src="${imgSrc}" alt="${player.name}"
                 onerror="this.style.display='none';this.parentElement.querySelector('.char-fallback').style.display='flex';"
                 loading="lazy">
            <div class="char-fallback" style="display:none;">${imgFallback}</div>
          </div>
          <div class="seat-name">${player.name}${playerLabel}${chainIcon}</div>
          <div class="seat-role">${roleName} · ${regionLabel} · ${elementLabel}</div>
          <div class="seat-hp">
            <div class="seat-hp-fill ${hpClass}" style="width:${hpPercent}%"></div>
          </div>
          <div class="seat-info-panel">
            <div class="seat-info-row">
              <span class="seat-info-label">❤️</span>
              <span class="seat-info-value">${player.hp}/${player.maxHp}</span>
            </div>
            <div class="seat-info-row">
              <span class="seat-info-label">🃏</span>
              <span class="seat-info-value">${player.handCards.length}张</span>
            </div>
            <div class="seat-info-row seat-equip-row">
              <span class="seat-info-label">⚔</span>
              <span class="seat-info-value">${equipHtml || '无'}</span>
            </div>
          </div>
          ${statusMarks}
          ${judgeInfo}
        </div>
      </div>
    `;
  }

  /** 获取角色状态标记HTML */
  private getStatusMarks(player: PlayerState): string {
    if (!this.skillManager) return '';
    const marks: string[] = [];

    // 从skillManager获取玩家数据
    // 通过 (skillManager as any) 访问内部数据
    const data = (this.skillManager as any).getData?.(player.id) || {};

    // 玉璋标记
    if (data.jadeCount > 0) {
      marks.push(`<span class="status-mark jade" title="玉璋标记">🛡${data.jadeCount}</span>`);
    }

    // 无想标记（雷电将军）
    if (data.musouCount > 0) {
      marks.push(`<span class="status-mark musou" title="无想标记">⚡${data.musouCount}</span>`);
    }

    // 空月标记（哥伦比娅-少女）
    if (data.emptyMoonCount > 0) {
      marks.push(`<span class="status-mark moon" title="空月标记">🌙${data.emptyMoonCount}</span>`);
    }

    // 霜月标记（哥伦比娅-月神）
    if (data.frostMoonCount > 0) {
      marks.push(`<span class="status-mark frost" title="霜月标记">❄${data.frostMoonCount}</span>`);
    }

    // 烟花标记
    if (data.hasFireworkMark) {
      marks.push(`<span class="status-mark firework" title="烟花标记">🎆</span>`);
    }

    // 契约关系（钟离）
    if (data.contractPartnerId !== undefined) {
      const partner = this.players.find(p => p.id === data.contractPartnerId);
      if (partner) {
        marks.push(`<span class="status-mark contract" title="契约关系">🤝${partner.name}</span>`);
      }
    }

    // 领袖激活（玛薇卡）
    if (data.leaderActive) {
      const taken = data.leaderDamageTaken || 0;
      marks.push(`<span class="status-mark leader" title="领袖（已受${taken}/2伤害）">👑${taken}/2</span>`);
    }

    // 幽蝶激活（胡桃）
    if (data.butterflyActive) {
      marks.push(`<span class="status-mark butterfly" title="幽蝶激活-伤害+1">🦋</span>`);
    }

    // 妮露状态
    if (data.nilouStance) {
      const stanceIcon = data.nilouStance === '水环' ? '💧' : '🌊';
      marks.push(`<span class="status-mark nilou" title="莲步-${data.nilouStance}">${stanceIcon}${data.nilouStance}</span>`);
    }

    // 枫原万叶-枫数量
    if (data.mapleLeaves && data.mapleLeaves.length > 0) {
      marks.push(`<span class="status-mark maple" title="枫">🍁${data.mapleLeaves.length}</span>`);
    }

    // 魈-封印花色
    if (data.sealedSuits) {
      const sealed = Object.keys(data.sealedSuits).filter(k => data.sealedSuits[k]);
      if (sealed.length > 0) {
        const suitIcons: Record<string, string> = { Spade: '♠', Heart: '♥', Club: '♣', Diamond: '♦' };
        const icons = sealed.map(s => suitIcons[s] || s).join('');
        marks.push(`<span class="status-mark sealed" title="封印花色">🚫${icons}</span>`);
      }
    }

    // 艾尔海森-知论牌
    if (data.knowledgeCards && data.knowledgeCards.length > 0) {
      marks.push(`<span class="status-mark knowledge" title="知论牌">📚${data.knowledgeCards.length}</span>`);
    }

    // 迪希雅-佣兵保护中
    if (data.mercenaryActive) {
      const target = this.players.find(p => p.id === data.mercenaryTargetId);
      if (target) {
        marks.push(`<span class="status-mark mercenary" title="佣兵-保护${target.name}">🛡️</span>`);
      }
    }

    // 迪希雅-被保护者显示标记
    for (const p of this.players) {
      if (p.isDead || p.id === player.id) continue;
      const pData = (this.skillManager as any).getData?.(p.id) || {};
      if (pData.mercenaryActive && pData.mercenaryTargetId === player.id) {
        marks.push(`<span class="status-mark protected" title="${p.name}的佣兵保护中">🛡️</span>`);
        break;
      }
    }

    if (marks.length === 0) return '';

    return `<div class="seat-status-marks">${marks.join('')}</div>`;
  }

  private suitDetail(c: Card): string {
    const suitSym = SUIT_SYMBOL[c.suit] || '';
    const numText = NUMBER_TEXT[c.number] || String(c.number);
    return `${suitSym}${numText}`;
  }

  private getEquipSummary(player: PlayerState): string {
    const parts: string[] = [];
    if (player.equipZone[EquipmentType.Weapon]) {
      const c = player.equipZone[EquipmentType.Weapon]!;
      parts.push(`⚔${c.name}(${this.suitDetail(c)})`);
    }
    if (player.equipZone[EquipmentType.Armor]) {
      const c = player.equipZone[EquipmentType.Armor]!;
      parts.push(`🛡${c.name}(${this.suitDetail(c)})`);
    }
    if (player.equipZone[EquipmentType.OffensiveHorse]) {
      const c = player.equipZone[EquipmentType.OffensiveHorse]!;
      parts.push(`🐴${c.name}(${this.suitDetail(c)})`);
    }
    if (player.equipZone[EquipmentType.DefensiveHorse]) {
      const c = player.equipZone[EquipmentType.DefensiveHorse]!;
      parts.push(`🐴${c.name}(${this.suitDetail(c)})`);
    }
    return parts.length > 0 ? parts.join(' ') : '无装备';
  }

  private getEquipSummaryHtml(player: PlayerState): string {
    const parts: string[] = [];
    if (player.equipZone[EquipmentType.Weapon]) {
      const c = player.equipZone[EquipmentType.Weapon]!;
      parts.push(`${c.name}(${this.suitDetail(c)})`);
    }
    if (player.equipZone[EquipmentType.Armor]) {
      const c = player.equipZone[EquipmentType.Armor]!;
      parts.push(`${c.name}(${this.suitDetail(c)})`);
    }
    if (player.equipZone[EquipmentType.OffensiveHorse]) {
      const c = player.equipZone[EquipmentType.OffensiveHorse]!;
      parts.push(`${c.name}(${this.suitDetail(c)})`);
    }
    if (player.equipZone[EquipmentType.DefensiveHorse]) {
      const c = player.equipZone[EquipmentType.DefensiveHorse]!;
      parts.push(`${c.name}(${this.suitDetail(c)})`);
    }
    return parts.length > 0 ? parts.join('·') : '';
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
    if (!this.skillManager || me.heroId !== 'lyneya') return;
    const topCard = (this.skillManager as any).getLyneyaTopCard?.(me);
    if (!topCard) return;

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
        const suitSym = SUIT_SYMBOL[s.card.suit] || '';
        const numText = NUMBER_TEXT[s.card.number] || String(s.card.number);
        return `<div class="equip-slot filled" title="${s.card.name}（${suitSym}${numText}）">
          <img src="${imgSrc}" alt="${s.card.name}" onerror="this.parentElement.textContent='${s.card.name.substring(0,2)}'">
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
      if (this.sidebarSkillsEl) this.sidebarSkillsEl.innerHTML = '';
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
    const skillInfos = this.skillManager?.getSkills(me, ctx) || hero.skills.map(s => ({
      id: `${me.heroId}_${s.name}`, name: s.name, description: s.desc, type: 'passive' as const, usable: () => false,
    }));

    // 底部右侧技能区：显示所有技能（主动可点击，被动/触发/限定显示标签）
    if (this.skillAreaEl) {
      if (skillInfos.length > 0) {
        this.skillAreaEl.innerHTML = skillInfos.map((si: { id: string; name: string; description: string; type: string; usable: (p: any, c: any) => boolean }) => {
          const isActive = si.type === 'active';
          const canUse = isActive && si.usable(me, ctx);
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
          const canUse = isActive && si.usable(me, ctx);
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

    // 侧栏技能详情（所有技能）
    if (this.sidebarSkillsEl) {
      const maxSlots = 5;
      let html = `<div class="sidebar-hero-info">
        <span class="hero-name-label">${me.name}</span>
        <span class="hero-element-label">${hero.element}</span>
        <span class="hero-hp-label">❤️ ${me.hp}/${me.maxHp}</span>
      </div>`;
      for (let i = 0; i < maxSlots; i++) {
        if (i < skillInfos.length) {
          const si = skillInfos[i];
          html += `<div class="skill-slot ${si.type === 'active' ? 'usable' : 'dim'}"
            data-skill-id="${si.id}" title="${si.description}">
            <span class="skill-name">${si.name}</span>
            <span class="skill-type-tag">${si.type === 'passive' ? '被动' : si.type === 'limited' ? '限定' : si.type === 'trigger' ? '触发' : '主动'}</span>
          </div>`;
        } else {
          html += `<div class="skill-slot empty-skill"></div>`;
        }
      }
      this.sidebarSkillsEl.innerHTML = html;
    }
  }

  /** 技能点击回调 */
  public onSkillClick: ((skillId: string) => void) | null = null;

  private skillManager: any = null;
  setSkillManager(sm: any): void { this.skillManager = sm; }

  // ======================== 日志系统 ========================
  addLog(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    const safeMessage = message ?? '';
    this.logEntries.push(`[${timestamp}] ${safeMessage}`);
    if (this.logContentEl) {
      // 仅在用户已在底部（或接近底部）时自动滚动到底部
      const el = this.logContentEl;
      const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      this.logContentEl.innerHTML = this.logEntries.map(m =>
        `<div>${this.escapeHtml(m)}</div>`
      ).join('');
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

  /** 本地经验兜底保存（服务器不可用或未登录时使用 localStorage） */
  private applyLocalExpFallback(myExp: { baseExp: number; bonusExp: number; totalExp: number; oldLevel: number; newLevel: number; leveledUp: boolean; escaped: boolean }): void {
    try {
      const LOCAL_EXP_KEY = 'genshin_card_local_exp';
      let stored: { totalExp: number; level: number } = { totalExp: 0, level: 1 };
      const raw = localStorage.getItem(LOCAL_EXP_KEY);
      if (raw) {
        try { stored = JSON.parse(raw); } catch (_) { /* ignore */ }
      }
      const oldLevel = stored.level;
      stored.totalExp += myExp.totalExp;
      // 简化等级计算：1-55级每级100，之后指数增长
      let newLevel = 1;
      let cumulative = 0;
      for (let lv = 1; lv < 60; lv++) {
        const need = lv <= 55 ? lv * 100 : 56000 + (lv - 56) * 1000;
        cumulative += need;
        if (stored.totalExp >= cumulative) newLevel = lv + 1;
        else break;
      }
      newLevel = Math.min(60, newLevel);
      stored.level = newLevel;
      localStorage.setItem(LOCAL_EXP_KEY, JSON.stringify(stored));
      myExp.oldLevel = oldLevel;
      myExp.newLevel = newLevel;
      myExp.leveledUp = newLevel > oldLevel;
      // 尝试在下次连接服务器时同步
      if (socketManager.isConnected) {
        socketManager.emitWithAck('add_exp', { totalExp: myExp.totalExp }).then((ack: any) => {
          if (ack?.success) {
            myExp.oldLevel = ack.oldLevel;
            myExp.newLevel = ack.newLevel;
            myExp.leveledUp = ack.leveledUp;
            // 同步成功后清除本地记录
            localStorage.removeItem(LOCAL_EXP_KEY);
          }
        }).catch(() => {});
      }
    } catch (_) {
      // localStorage 不可用，静默失败
    }
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
  showResultModal(winner: string, gameOverData?: { killStats?: Record<number, any>; expByPlayerId?: Record<number, any>; escapedPlayerIds?: number[] }): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay result-modal';

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
                       winner.includes('主公') || winner.includes('忠臣') ? 'MonarchMinister' : '';

    // 阵营排序权重：主→忠→反→内（按用户要求顺序）
    const roleOrder: Record<string, number> = { Monarch: 0, Minister: 1, Rebel: 2, Traitor: 3 };

    // 判断玩家是否属于胜利方
    const isWinner = (p: PlayerState): boolean => {
      if (winFaction === 'Rebel') return p.role === 'Rebel';
      if (winFaction === 'Traitor') return p.role === 'Traitor';
      if (winFaction === 'MonarchMinister') return p.role === 'Monarch' || p.role === 'Minister';
      return !p.isDead;
    };

    // 排序：胜利方优先 → 同阵营按经验降序
    const sorted = [...this.players].sort((a, b) => {
      const aWin = isWinner(a) ? 0 : 1;
      const bWin = isWinner(b) ? 0 : 1;
      if (aWin !== bWin) return aWin - bWin;
      // 同胜利方：先按角色排序（主→忠→反→内）
      const roleDiff = (roleOrder[a.role] || 9) - (roleOrder[b.role] || 9);
      if (roleDiff !== 0) return roleDiff;
      // 同阵营按经验降序
      const aExp = expByPid[a.id]?.totalExp ?? 0;
      const bExp = expByPid[b.id]?.totalExp ?? 0;
      return bExp - aExp;
    });

    const isPVE = !!this.pveLevel;
    const killCols = !isPVE && hasExp ? `<th>杀主</th><th>杀忠</th><th>杀反</th><th>杀内</th>` : (isPVE ? `<th>杀敌数</th>` : '');
    const expHeader = !isPVE && hasExp ? `<th>基础经验</th><th>击杀加成</th><th>获得经验</th>` : '';

    // PVE星星标题
    let starTitle = '';
    if (isPVE) {
      const records = getPVEStarRecords();
      const stars = records[this.levelId] || 0;
      starTitle = `<div class="result-winner" style="font-size:24px;">${'⭐'.repeat(stars)}${'☆'.repeat(3 - stars)} ${stars === 3 ? '三星通关！' : stars === 2 ? '二星通关' : '一星通关'}</div>`;
    }

    overlay.innerHTML = `
      <div class="modal-box">
        <div class="result-title win">🎉 游戏结束</div>
        ${isPVE ? starTitle : `<div class="result-winner">胜利方：${winner}</div>`}
        <div class="result-detail">
          <p>模式：${this.mode === 'pve' ? 'PVE 闯关' : 'PVP 联机'}</p>
        </div>
        <table class="result-table">
          <thead>
            <tr><th>玩家</th><th>武将</th><th>身份</th><th>体力</th><th>状态</th>${killCols}${expHeader}</tr>
          </thead>
          <tbody>
            ${sorted.map(p => {
              const hero = getHeroById(p.heroId);
              const roleName = isPVE ? ((p as any).faction === 'Ally' ? '友方' : (p as any).faction === 'Enemy' ? '敌方' : '—') : getRoleChineseName(p.role);
              const escaped = escapedPlayerIds.has(p.id);
              const status = escaped ? '🏳️ 逃跑' : (p.isDead ? '💀 阵亡' : '✅ 存活');
              const isHuman = p.id === this.humanPlayerIdx;
              const factionTag = (p as any).faction;
              const rowClass = isPVE ? (factionTag === 'Ally' ? 'winner-row' : 'loser-row') : (escaped ? 'escaped-row' : (isWinner(p) ? 'winner-row' : 'loser-row'));
              const ks = killStats[p.id] ?? { monarch: 0, minister: 0, rebel: 0, traitor: 0 };
              const killHtml = isPVE ? `<td>${ks.monarch + ks.minister + ks.rebel + ks.traitor}</td>` : (hasExp ? `<td>${ks.monarch}</td><td>${ks.minister}</td><td>${ks.rebel}</td><td>${ks.traitor}</td>` : '');
              const ep = expByPid[p.id];
              const expHtml = isPVE ? '' : (ep
                ? (ep.escaped
                    ? `<td>—</td><td>—</td><td style="color:var(--accent-red);font-weight:bold;">0 (逃跑)</td>`
                    : `<td>${ep.baseExp}</td><td style="color:${ep.bonusExp >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${ep.bonusExp >= 0 ? '+' + ep.bonusExp : ep.bonusExp}</td><td style="color:var(--gold);font-weight:bold;">${ep.baseExp + ep.bonusExp}${ep.leveledUp ? ` ⬆Lv.${ep.newLevel}` : ''}</td>`)
                : hasExp ? `<td>—</td><td>—</td><td>—</td>` : '');
              return `
                <tr class="${rowClass}">
                  <td>${p.playerName}${isHuman ? ' (你)' : ''}</td>
                  <td>${p.name}</td>
                  <td>${roleName}</td>
                  <td>${p.hp}/${p.maxHp}</td>
                  <td>${status}</td>
                  ${killHtml}${expHtml}
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button class="btn btn-ghost" id="result-close">关闭</button>
          <button class="btn btn-gold" id="result-back">${this.mode === 'pve' ? '返回章节' : '返回房间'}</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); this.goBack(); } });
    overlay.querySelector('#result-close')!.addEventListener('click', () => { overlay.remove(); this.goBack(); });
    overlay.querySelector('#result-back')!.addEventListener('click', () => {
      overlay.remove();
      this.goBack();
    });
    document.body.appendChild(overlay);
  }

  private cleanupGame(): void {
    // 中止游戏循环
    this.flowController?.abort();
    this.eventBus?.clear();
    this.stopBGM();
    this.stopTimer();
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
    // 重置壁纸序列，确保下局游戏重新随机 Fisher-Yates 洗牌
    this.wallpaperShuffle = [];
    this.wallpaperShuffleIdx = 0;
  }

  show(): void { this.el.classList.add('active'); }
  hide(): void { this.el.classList.remove('active'); }
}
