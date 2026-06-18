// ============================================================
// WebUIDriver.ts — 网页 UI 驱动（实现 IPlayerDriver）
// 通过 Promise 等待用户在网页上的交互
// ============================================================

import {
  IPlayerDriver, PlayerState, Card, GameContextSnapshot, ZoneSelection
} from '../core/types';
import { getCardDetail, isSlash, getCardColor } from '../core/Card';
import { getWeaponRange, getRoleChineseName, getHandLimit } from '../core/Player';
import { getDistance } from '../core/DistanceCalc';

/**
 * WebUIDriver 负责：
 * 1. 渲染游戏状态到 DOM
 * 2. 当轮到人类玩家时，通过 Promise 等待用户的交互
 * 3. 实现 IPlayerDriver 接口
 */
export class WebUIDriver implements IPlayerDriver {
  readonly playerId: number;

  private resolvePromise: ((value: any) => void) | null = null;
  private container: HTMLElement;

  constructor(playerId: number, container: HTMLElement) {
    this.playerId = playerId;
    this.container = container;
  }

  // ======================== 渲染方法 ========================

  /** 渲染完整游戏状态 */
  renderGameState(ctx: GameContextSnapshot): void {
    this.container.innerHTML = '';
    this.container.className = 'game-container';

    // 顶部信息栏
    const header = this.createHeader(ctx);
    this.container.appendChild(header);

    // 牌堆信息
    const deckInfo = this.createDeckInfo(ctx);
    this.container.appendChild(deckInfo);

    // 场上玩家
    const field = this.createField(ctx);
    this.container.appendChild(field);

    // 日志区
    const logArea = this.createLogArea();
    this.container.appendChild(logArea);
  }

  private createHeader(ctx: GameContextSnapshot): HTMLElement {
    const div = document.createElement('div');
    div.className = 'game-header';
    div.innerHTML = `
      <span class="round-info">第 ${ctx.roundCount} 轮 | 第 ${ctx.currentTurn} 回合</span>
      <span class="deck-info">牌堆: ${ctx.drawPileCount} | 弃牌: ${ctx.discardPileCount}</span>
      ${ctx.gameOverWinner ? `<span class="game-over-banner">游戏结束: ${ctx.gameOverWinner}</span>` : ''}
    `;
    return div;
  }

  private createDeckInfo(ctx: GameContextSnapshot): HTMLElement {
    const div = document.createElement('div');
    div.className = 'deck-area';
    div.innerHTML = `
      <div class="deck-pile">
        <div class="card-back">牌堆<br>${ctx.drawPileCount}</div>
      </div>
      <div class="discard-pile">
        <div class="card-back discard">弃牌<br>${ctx.discardPileCount}</div>
      </div>
    `;
    return div;
  }

  private createField(ctx: GameContextSnapshot): HTMLElement {
    const field = document.createElement('div');
    field.className = 'field';

    for (const player of ctx.players) {
      const card = this.createPlayerCard(player, ctx);
      field.appendChild(card);
    }

    return field;
  }

  private createPlayerCard(player: PlayerState, ctx: GameContextSnapshot): HTMLElement {
    const div = document.createElement('div');
    const isCurrent = player.id === ctx.currentPlayerId;
    const isHuman = player.id === this.playerId;
    const isDead = player.isDead;

    div.className = `player-card ${isCurrent ? 'current' : ''} ${isDead ? 'dead' : ''} ${isHuman ? 'human' : 'ai'}`;

    // 血条
    const hpPercent = Math.max(0, (player.hp / player.maxHp) * 100);
    const hpColor = hpPercent > 50 ? '#4caf50' : hpPercent > 25 ? '#ff9800' : '#f44336';

    let chainIcon = player.isChained ? ' ⛓️' : '';

    div.innerHTML = `
      <div class="player-name">
        ${isHuman ? '👤 ' : '🤖 '}${player.name}${chainIcon}
        ${isCurrent ? '<span class="current-badge">当前</span>' : ''}
      </div>
      <div class="player-role">${getRoleChineseName(player.role)}</div>
      <div class="hp-bar-container">
        <div class="hp-bar" style="width:${hpPercent}%; background:${hpColor}"></div>
        <span class="hp-text">${player.hp}/${player.maxHp}</span>
      </div>
      <div class="equip-icons">
        ${this.renderEquipIcons(player)}
      </div>
      <div class="hand-count">手牌: ${player.handCards.length}</div>
      ${player.judgeZone.length > 0 ? `<div class="judge-count">判定: ${player.judgeZone.map(c => c.name).join(', ')}</div>` : ''}
    `;

    return div;
  }

  private renderEquipIcons(player: PlayerState): string {
    const icons: string[] = [];
    if (player.equipZone.Weapon) icons.push(`🗡️${player.equipZone.Weapon.name}`);
    if (player.equipZone.Armor) icons.push(`🛡️${player.equipZone.Armor.name}`);
    if (player.equipZone.DefensiveHorse) icons.push('🐴+1');
    if (player.equipZone.OffensiveHorse) icons.push('🐴-1');
    return icons.join(' ') || '无装备';
  }

  private createLogArea(): HTMLElement {
    let logDiv = document.getElementById('game-log');
    if (!logDiv) {
      logDiv = document.createElement('div');
      logDiv.id = 'game-log';
      logDiv.className = 'game-log';
      this.container.appendChild(logDiv);
    }
    return logDiv;
  }

  /** 渲染手牌选择界面（人类玩家回合） */
  renderHandCards(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return new Promise(resolve => {
      // 先清理旧的手牌区
      const oldHand = document.getElementById('hand-card-area');
      if (oldHand) oldHand.remove();

      const handArea = document.createElement('div');
      handArea.id = 'hand-card-area';
      handArea.className = 'hand-card-area';

      const title = document.createElement('div');
      title.className = 'hand-title';
      const zibaiHint = state.heroId === 'zibai' && ctx.cardsPlayedThisPhase !== undefined
        ? ` — 第${ctx.cardsPlayedThisPhase + 1}张` : '';
      title.textContent = `🎴 你的手牌 (上限: ${getHandLimit(state)})${zibaiHint} - 点击出牌`;
      handArea.appendChild(title);

      const cardsDiv = document.createElement('div');
      cardsDiv.className = 'hand-cards';

      for (let i = 0; i < state.handCards.length; i++) {
        const card = state.handCards[i];
        const cardEl = this.createCardElement(card, i, state);
        cardEl.addEventListener('click', () => {
          resolve(i);
        });
        cardsDiv.appendChild(cardEl);
      }

      // 丈八蛇矛按钮
      const weapon = state.equipZone.Weapon;
      if (weapon?.name === '丈八蛇矛' && state.handCards.length >= 2) {
        const zhanBaBtn = document.createElement('button');
        zhanBaBtn.className = 'card-btn zhanba-btn';
        zhanBaBtn.textContent = '⚔️ 丈八蛇矛合成杀';
        zhanBaBtn.addEventListener('click', () => resolve(-2));
        cardsDiv.appendChild(zhanBaBtn);
      }

      // 结束出牌按钮
      const endBtn = document.createElement('button');
      endBtn.className = 'card-btn end-btn';
      endBtn.textContent = '✅ 结束出牌';
      endBtn.addEventListener('click', () => resolve(-1));
      cardsDiv.appendChild(endBtn);

      handArea.appendChild(cardsDiv);
      this.container.appendChild(handArea);
    });
  }

  private createCardElement(card: Card, index: number, state: PlayerState): HTMLElement {
    const el = document.createElement('div');
    el.className = 'card-item';

    const suitSymbol: Record<string, string> = {
      Heart: '♥', Diamond: '♦', Spade: '♠', Club: '♣'
    };
    const isRed = card.suit === 'Heart' || card.suit === 'Diamond';
    const suitColor = isRed ? '#e53935' : '#1a1a2e';

    el.innerHTML = `
      <div class="card-corner top-left" style="color:${suitColor}">
        <span class="card-number">${this.formatNumber(card.number)}</span>
        <span class="card-suit">${suitSymbol[card.suit] || ''}</span>
      </div>
      <div class="card-name" style="color:${suitColor}">${card.name}</div>
      <div class="card-type">${this.getTypeLabel(card)}</div>
    `;

    return el;
  }

  private formatNumber(n: number): string {
    if (n === 1) return 'A';
    if (n === 11) return 'J';
    if (n === 12) return 'Q';
    if (n === 13) return 'K';
    return n.toString();
  }

  private getTypeLabel(card: Card): string {
    if (card.type === 'Basic') return '基本';
    if (card.type === 'Magic') {
      const subType = card.name === '乐不思蜀' || card.name === '闪电' || card.name === '兵粮寸断'
        ? '延时' : '锦囊';
      return subType;
    }
    if (card.type === 'Equipment') return '装备';
    return '';
  }

  // ======================== IPlayerDriver 实现 ========================

  async promptPlayCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    this.renderGameState(ctx);
    return this.renderHandCards(state, ctx);
  }

  async promptTarget(
    state: PlayerState,
    validTargets: number[],
    reason: string,
    ctx: GameContextSnapshot
  ): Promise<number | null> {
    return new Promise(resolve => {
      this.renderGameState(ctx);

      const modal = this.createModal(`选择目标 - ${reason}`);
      const list = document.createElement('div');
      list.className = 'target-list';

      const targets = ctx.players.filter(p => validTargets.includes(p.id));
      for (const t of targets) {
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.textContent = `${t.name} (${getRoleChineseName(t.role)}) HP:${t.hp}/${t.maxHp}`;
        btn.addEventListener('click', () => {
          modal.remove();
          resolve(t.id);
        });
        list.appendChild(btn);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'target-btn cancel';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => {
        modal.remove();
        resolve(null);
      });
      list.appendChild(cancelBtn);

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptResponse(
    state: PlayerState,
    cardName: string,
    ctx: GameContextSnapshot
  ): Promise<Card | null> {
    // 对于人类玩家，展示手牌并等待选择
    return new Promise(resolve => {
      this.renderGameState(ctx);

      // 格式化标题：花色提示转为符号显示
      let displayName = cardName;
      if (cardName.startsWith('花色:')) {
        const parts = cardName.split(':');
        displayName = `花色 ${parts[1]}`; // 花色 ♥
      }
      const modal = this.createModal(`需要响应: ${displayName}`);
      const list = document.createElement('div');
      list.className = 'target-list';

      let validCards: Card[];
      const nilouStance = ctx.nilouStance || '水环';
      if (cardName.startsWith('花色:')) {
        const parts = cardName.split(':');
        // 格式：花色:显示符号:原始花色 或 花色:原始花色（兼容旧格式）
        const suit = parts.length >= 3 ? parts[2] : parts[1];
        validCards = state.handCards.filter(c => c.suit === suit);
      } else if (cardName === '杀') {
        validCards = state.handCards.filter(c => 
          isSlash(c) || this.isNilouStanceConvert(state, c, '杀', nilouStance)
        );
      } else if (cardName === '闪') {
        validCards = state.handCards.filter(c => 
          c.name === '闪' || this.isNilouStanceConvert(state, c, '闪', nilouStance)
        );
      } else {
        validCards = state.handCards.filter(c => c.name === cardName);
      }

      for (const card of validCards) {
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        const isConverted = !isSlash(card) && this.isNilouStanceConvert(state, card, '杀', nilouStance);
        const isDodgeConverted = card.name !== '闪' && this.isNilouStanceConvert(state, card, '闪', nilouStance);
        if (isConverted || isDodgeConverted) {
          btn.textContent = `🔄 ${getCardDetail(card)} (当${isConverted ? '杀' : '闪'}使用)`;
        } else {
          btn.textContent = getCardDetail(card);
        }
        btn.addEventListener('click', () => {
          modal.remove();
          resolve(card);
        });
        list.appendChild(btn);
      }

      const passBtn = document.createElement('button');
      passBtn.className = 'target-btn cancel';
      passBtn.textContent = '不出';
      passBtn.addEventListener('click', () => {
        modal.remove();
        resolve(null);
      });
      list.appendChild(passBtn);

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  /** 判断妮露的牌是否可以当指定的牌使用 */
  private isNilouStanceConvert(state: PlayerState, card: Card, targetName: string, stance: string): boolean {
    if (state.heroId !== 'nilou') return false;
    if (targetName === '闪' && stance === '水环') {
      return card.suit === 'Spade' || card.suit === 'Club';
    }
    if (targetName === '杀' && stance === '水月') {
      return card.suit === 'Heart' || card.suit === 'Diamond';
    }
    return false;
  }

  async promptZone(
    state: PlayerState,
    targetId: number,
    ctx: GameContextSnapshot
  ): Promise<ZoneSelection | null> {
    return new Promise(resolve => {
      const target = ctx.players.find(p => p.id === targetId)!;
      this.renderGameState(ctx);

      const modal = this.createModal(`选择 ${target.name} 的区域`);
      const list = document.createElement('div');
      list.className = 'target-list';

      if (target.handCards.length > 0) {
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.textContent = `手牌区 (${target.handCards.length}张，盲抽)`;
        btn.addEventListener('click', () => { modal.remove(); resolve({ zone: 'hand', index: 0 }); });
        list.appendChild(btn);
      }

      const equipSlots = Object.entries(target.equipZone).filter(([, v]) => v !== null);
      if (equipSlots.length > 0) {
        for (let i = 0; i < equipSlots.length; i++) {
          const [slot, card] = equipSlots[i];
          const btn = document.createElement('button');
          btn.className = 'target-btn';
          btn.textContent = `装备区: ${getCardDetail(card!)}`;
          btn.addEventListener('click', () => { modal.remove(); resolve({ zone: 'equip', index: i }); });
          list.appendChild(btn);
        }
      }

      if (target.judgeZone.length > 0) {
        for (let i = 0; i < target.judgeZone.length; i++) {
          const btn = document.createElement('button');
          btn.className = 'target-btn';
          btn.textContent = `判定区: ${getCardDetail(target.judgeZone[i])}`;
          btn.addEventListener('click', () => { modal.remove(); resolve({ zone: 'judge', index: i }); });
          list.appendChild(btn);
        }
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'target-btn cancel';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => { modal.remove(); resolve(null); });
      list.appendChild(cancelBtn);

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptZhanBa(state: PlayerState, ctx: GameContextSnapshot): Promise<[number, number] | null> {
    // 简化：选前两张非杀牌
    const nonSlashes = state.handCards.filter(c => !isSlash(c));
    if (nonSlashes.length >= 2) {
      return [state.handCards.indexOf(nonSlashes[0]), state.handCards.indexOf(nonSlashes[1])];
    }
    return [0, 1];
  }

  async promptDiscard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return new Promise(resolve => {
      this.renderGameState(ctx);

      const modal = this.createModal(`弃牌阶段 - 手牌(${state.handCards.length})超过上限(${getHandLimit(state)})`);
      const list = document.createElement('div');
      list.className = 'target-list';

      for (let i = 0; i < state.handCards.length; i++) {
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.textContent = `弃置: ${getCardDetail(state.handCards[i])}`;
        btn.addEventListener('click', () => { modal.remove(); resolve(i); });
        list.appendChild(btn);
      }

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptNullification(state: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    return new Promise(resolve => {
      const hasNullify = state.handCards.some(c => c.name === '无懈可击');
      if (!hasNullify) { resolve(false); return; }

      this.renderGameState(ctx);
      const modal = this.createModal('是否打出【无懈可击】？');
      const list = document.createElement('div');
      list.className = 'target-list';

      const yesBtn = document.createElement('button');
      yesBtn.className = 'target-btn';
      yesBtn.textContent = '打出【无懈可击】';
      yesBtn.addEventListener('click', () => { modal.remove(); resolve(true); });
      list.appendChild(yesBtn);

      const noBtn = document.createElement('button');
      noBtn.className = 'target-btn cancel';
      noBtn.textContent = '不打';
      noBtn.addEventListener('click', () => { modal.remove(); resolve(false); });
      list.appendChild(noBtn);

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptArmorTrigger(state: PlayerState, armorName: string, ctx: GameContextSnapshot): Promise<boolean> {
    return new Promise(resolve => {
      this.renderGameState(ctx);
      const modal = this.createModal(`是否发动【${armorName}】？`);
      const list = document.createElement('div');
      list.className = 'target-list';

      const yesBtn = document.createElement('button');
      yesBtn.className = 'target-btn';
      yesBtn.textContent = '发动';
      yesBtn.addEventListener('click', () => { modal.remove(); resolve(true); });
      list.appendChild(yesBtn);

      const noBtn = document.createElement('button');
      noBtn.className = 'target-btn cancel';
      noBtn.textContent = '不发动';
      noBtn.addEventListener('click', () => { modal.remove(); resolve(false); });
      list.appendChild(noBtn);

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptWeaponEffect(state: PlayerState, weaponName: string, ctx: GameContextSnapshot): Promise<boolean> {
    return new Promise(resolve => {
      this.renderGameState(ctx);
      const modal = this.createModal(`是否发动【${weaponName}】效果？`);
      const list = document.createElement('div');
      list.className = 'target-list';

      const yesBtn = document.createElement('button');
      yesBtn.className = 'target-btn';
      yesBtn.textContent = '发动';
      yesBtn.addEventListener('click', () => { modal.remove(); resolve(true); });
      list.appendChild(yesBtn);

      const noBtn = document.createElement('button');
      noBtn.className = 'target-btn cancel';
      noBtn.textContent = '不发动';
      noBtn.addEventListener('click', () => { modal.remove(); resolve(false); });
      list.appendChild(noBtn);

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptIronChainMode(state: PlayerState, ctx: GameContextSnapshot): Promise<'recast' | 'chain'> {
    return new Promise(resolve => {
      this.renderGameState(ctx);
      const modal = this.createModal('铁索连环 - 选择模式');
      const list = document.createElement('div');
      list.className = 'target-list';

      const recastBtn = document.createElement('button');
      recastBtn.className = 'target-btn';
      recastBtn.textContent = '重铸（摸1张牌）';
      recastBtn.addEventListener('click', () => { modal.remove(); resolve('recast'); });
      list.appendChild(recastBtn);

      const chainBtn = document.createElement('button');
      chainBtn.className = 'target-btn';
      chainBtn.textContent = '连环（选择目标）';
      chainBtn.addEventListener('click', () => { modal.remove(); resolve('chain'); });
      list.appendChild(chainBtn);

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptAmazingGrace(state: PlayerState, tableCards: Card[], ctx: GameContextSnapshot): Promise<number> {
    return new Promise(resolve => {
      this.renderGameState(ctx);
      const modal = this.createModal('五谷丰登 - 选择一张牌');
      const list = document.createElement('div');
      list.className = 'target-list';

      for (let i = 0; i < tableCards.length; i++) {
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.textContent = getCardDetail(tableCards[i]);
        btn.addEventListener('click', () => { modal.remove(); resolve(i); });
        list.appendChild(btn);
      }

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptShowCard(state: PlayerState, ctx: GameContextSnapshot): Promise<number> {
    return new Promise(resolve => {
      this.renderGameState(ctx);
      const modal = this.createModal('火攻 - 选择一张手牌展示');
      const list = document.createElement('div');
      list.className = 'target-list';

      for (let i = 0; i < state.handCards.length; i++) {
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.textContent = `展示: ${getCardDetail(state.handCards[i])}`;
        btn.addEventListener('click', () => { modal.remove(); resolve(i); });
        list.appendChild(btn);
      }

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptGenderWeapon(state: PlayerState, attackerName: string, ctx: GameContextSnapshot): Promise<'discard' | 'draw'> {
    return new Promise(resolve => {
      this.renderGameState(ctx);
      const modal = this.createModal(`雌雄双股剑 - ${attackerName} 对你发动效果`);
      const list = document.createElement('div');
      list.className = 'target-list';

      const discardBtn = document.createElement('button');
      discardBtn.className = 'target-btn';
      discardBtn.textContent = '弃置一张手牌';
      discardBtn.addEventListener('click', () => { modal.remove(); resolve('discard'); });
      list.appendChild(discardBtn);

      const drawBtn = document.createElement('button');
      drawBtn.className = 'target-btn';
      drawBtn.textContent = `让 ${attackerName} 摸一张牌`;
      drawBtn.addEventListener('click', () => { modal.remove(); resolve('draw'); });
      list.appendChild(drawBtn);

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  // ======================== 辅助 ========================

  private createModal(title: string): HTMLElement {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal-content"><h3>${title}</h3></div>`;
    return modal;
  }

  /** 添加日志 */
  addLog(message: string): void {
    const logDiv = document.getElementById('game-log');
    if (logDiv) {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      entry.textContent = message;
      logDiv.appendChild(entry);
      logDiv.scrollTop = logDiv.scrollHeight;
    }
  }

  async promptSelectCard(
    state: PlayerState,
    title: string,
    filter: (card: Card) => boolean,
    ctx: GameContextSnapshot
  ): Promise<number> {
    return new Promise(resolve => {
      this.renderGameState(ctx);
      const modal = this.createModal(title);
      const list = document.createElement('div');
      list.className = 'target-list';

      for (let i = 0; i < state.handCards.length; i++) {
        const card = state.handCards[i];
        if (!filter(card)) continue;
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.textContent = getCardDetail(card);
        btn.addEventListener('click', () => { modal.remove(); resolve(i); });
        list.appendChild(btn);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'target-btn cancel';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => { modal.remove(); resolve(-1); });
      list.appendChild(cancelBtn);

      modal.appendChild(list);
      this.container.appendChild(modal);
    });
  }

  async promptYesNo(question: string): Promise<boolean> {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-box" style="text-align:center;">
          <p style="font-size:18px;">${question}</p>
          <div style="display:flex;gap:12px;justify-content:center;margin-top:20px;">
            <button class="btn btn-gold" id="yesno-yes">是</button>
            <button class="btn btn-ghost" id="yesno-no">否</button>
          </div>
        </div>
      `;
      overlay.querySelector('#yesno-yes')!.addEventListener('click', () => { overlay.remove(); resolve(true); });
      overlay.querySelector('#yesno-no')!.addEventListener('click', () => { overlay.remove(); resolve(false); });
      document.body.appendChild(overlay);
    });
  }
}
