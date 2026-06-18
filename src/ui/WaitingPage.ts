// ============================================================
// WaitingPage.ts — PVP 房间等待界面
// 逻辑：
//   始终显示全部8个槽位（真人 + AI占位 + 空位），各自显示准备状态
//   8人全准备 → 自动321倒计时 → 进入选将
// ============================================================

import { router, RouteState } from './router';
import { socketManager } from '../network/SocketManager';

interface SlotPlayer {
  index: number;
  accountName: string | null;
  avatar: string | null;
  nickname: string | null;
  ready: boolean;
  isHost: boolean;
  connected: boolean;
  isYou: boolean;
  heroId?: string;
}

export class WaitingPage {
  private el!: HTMLElement;
  private roomId = '';
  private isHost = false;
  private mySlotIndex = 0;
  private slots: SlotPlayer[] = [];
  private aiFill = 0;
  private myReady = false;
  private unsubs: Array<() => void> = [];
  private countdownTimer: number | null = null;
  private countdownActive = false;

  render(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'page waiting-page';
    container.innerHTML = `
      <div class="waiting-header">
        <button class="btn btn-ghost btn-sm" id="waiting-back">← 返回房间列表</button>
        <div style="flex:1;"></div>
        <div class="waiting-room-label">房间号</div>
      </div>
      <div class="waiting-container">
        <div class="waiting-room-id">
          <span class="room-id-badge" id="room-id-display">000000</span>
          <span class="room-host-badge" id="room-host-badge" style="display:none;">房主</span>
        </div>
        <div class="player-slots" id="player-slots"></div>
        <div class="waiting-status-bar">
          <span id="ready-count">等待准备...</span>
        </div>
        <!-- AI填充设置（仅房主可见，进入房间后可设置） -->
        <div class="ai-fill-row" id="ai-fill-row" style="display:none;text-align:center;margin:8px 0;">
          <span style="color:rgba(255,255,255,0.5);font-size:13px;">AI填充空位: </span>
          <select id="ai-fill-select" style="padding:4px 8px;border-radius:4px;background:rgba(255,255,255,0.05);color:#fff;border:1px solid rgba(255,255,255,0.15);">
            <option value="0">0</option><option value="1">1</option><option value="2">2</option>
            <option value="3">3</option><option value="4">4</option><option value="5">5</option>
            <option value="6">6</option><option value="7">7</option>
          </select>
          <span style="color:var(--text-dim);font-size:11px;margin-left:4px;">(需凑满8人)</span>
        </div>
        <!-- 倒计时遮罩 -->
        <div class="countdown-overlay" id="countdown-overlay" style="display:none;">
          <div class="countdown-number" id="countdown-number">3</div>
          <div class="countdown-text">即将开始选将...</div>
        </div>
        <div class="waiting-actions">
          <button class="btn btn-gold" id="btn-ready">准备</button>
          <button class="btn btn-ghost" id="btn-leave">离开房间</button>
        </div>
      </div>
    `;

    container.querySelector('#waiting-back')!.addEventListener('click', () => {
      this.cleanup();
      socketManager.emit('leave_room');
      router.navigate('match');
    });

    container.querySelector('#btn-leave')!.addEventListener('click', () => {
      this.cleanup();
      socketManager.emit('leave_room');
      router.navigate('match');
    });

    this.el = container;
    return container;
  }

  onEnter(state: RouteState): void {
    this.roomId = (state.params?.roomId as string) || '000000';
    this.isHost = (state.params?.isHost as boolean) || false;
    this.mySlotIndex = (state.params?.mySlotIndex as number) ?? 0;
    this.myReady = false;

    const display = this.el.querySelector('#room-id-display')!;
    display.textContent = this.roomId;

    const hostBadge = this.el.querySelector('#room-host-badge')! as HTMLElement;
    hostBadge.style.display = this.isHost ? 'inline' : 'none';

    // AI填充（仅房主可见）
    const aiFillRow = this.el.querySelector('#ai-fill-row')! as HTMLElement;
    const aiSelect = this.el.querySelector('#ai-fill-select')! as HTMLSelectElement;
    aiFillRow.style.display = this.isHost ? 'block' : 'none';

    if (this.isHost) {
      aiSelect.addEventListener('change', () => {
        this.aiFill = parseInt(aiSelect.value);
        socketManager.emit('set_ai_fill', { count: this.aiFill });
        // 更新显示
        setTimeout(() => this.renderSlots(), 100);
      });
    }

    // 准备按钮
    const readyBtn = this.el.querySelector('#btn-ready')! as HTMLButtonElement;
    const newReadyBtn = readyBtn.cloneNode(true) as HTMLButtonElement;
    readyBtn.parentNode!.replaceChild(newReadyBtn, readyBtn);

    newReadyBtn.addEventListener('click', () => {
      this.myReady = !this.myReady;
      socketManager.emit('toggle_ready', { ready: this.myReady });
      newReadyBtn.textContent = this.myReady ? '取消准备' : '准备';
      newReadyBtn.className = this.myReady ? 'btn btn-red' : 'btn btn-gold';
      this.renderSlots();
      this.updateCountdown();
    });

    // 监听房间更新
    this.unsubs.push(socketManager.on('room_update', (data: any) => {
      if (data.room) this.updateSlots(data.room);
    }));

    this.unsubs.push(socketManager.on('hero_select_start', (data: any) => {
      this.cleanup();
      router.navigate('game', {
        mode: 'pvp',
        roomId: this.roomId,
        isHost: this.isHost,
        mySlotIndex: this.mySlotIndex,
        heroCandidates: data.candidates,
        timeoutSec: data.timeoutSec,
        isMonarch: data.isMonarch || false,
        monarchHero: data.monarchHero || null,
      });
    }));

    this.unsubs.push(socketManager.on('hero_select_waiting', (data: any) => {
      this.cleanup();
      router.navigate('game', {
        mode: 'pvp',
        roomId: this.roomId,
        isHost: this.isHost,
        mySlotIndex: this.mySlotIndex,
        isWaitingForMonarch: true,
        monarchPlayerName: data.monarchPlayerName || '主公',
        timeoutSec: data.timeoutSec,
      });
    }));

    this.unsubs.push(socketManager.on('room_left', () => {
      router.navigate('match');
    }));
  }

  private updateSlots(roomData: any): void {
    const rawSlots = roomData.slots || [];
    this.aiFill = roomData.aiFill || 0;

    this.slots = rawSlots.map((s: any, i: number) => ({
      index: i,
      accountName: s.accountName || null,
      avatar: s.avatar || null,
      nickname: s.nickname || s.accountName || null,
      ready: s.ready || false,
      isHost: s.isHost || false,
      connected: s.connected || false,
      isYou: s.token === socketManager.token,  // 通过token判断
      heroId: s.heroId,
    }));

    // 同步自己的ready状态
    const me = this.slots.find(s => s.isYou);
    if (me) {
      this.myReady = me.ready;
      const readyBtn = this.el.querySelector('#btn-ready')! as HTMLButtonElement;
      readyBtn.textContent = this.myReady ? '取消准备' : '准备';
      readyBtn.className = this.myReady ? 'btn btn-red' : 'btn btn-gold';
    }

    this.renderSlots();

    // 更新AI选择框：只能选0 ~ (8-真人数量)
    const humanCount = this.slots.filter(s => s.accountName !== null).length;
    const maxAI = Math.max(0, 8 - humanCount);
    const aiSelect = this.el.querySelector('#ai-fill-select') as HTMLSelectElement;
    if (aiSelect) {
      aiSelect.innerHTML = '';
      for (let n = 0; n <= maxAI; n++) {
        const opt = document.createElement('option');
        opt.value = String(n);
        opt.textContent = String(n);
        if (n === this.aiFill) opt.selected = true;
        aiSelect.appendChild(opt);
      }
    }

    // 更新准备数：显示 当前x/8玩家（x人类xAI）
    const readyCount = this.slots.filter(s => s.ready && s.accountName !== null).length;
    const totalPlayers = humanCount + this.aiFill;
    const el2 = this.el.querySelector('#ready-count')!;
    el2.textContent = `${readyCount}/${humanCount} 真人已准备 · AI×${this.aiFill} · 合计${totalPlayers}/8人`;

    // 更新房间信息标题
    const roomLabel = this.el.querySelector('.waiting-room-label');
    if (roomLabel) {
      roomLabel.textContent = `房间 ${humanCount}人 + ${this.aiFill}AI = ${totalPlayers}/8`;
    }

    // 检查倒计时启动条件
    this.updateCountdown();
  }

  /** 始终显示全部8槽位（含真实玩家、AI占位、空位），各自显示准备状态 */
  private renderSlots(): void {
    const slotsEl = this.el.querySelector('#player-slots')!;
    slotsEl.innerHTML = '';

    for (let i = 0; i < 8; i++) {
      const s = this.slots[i];
      const isEmpty = (!s || !s.accountName);

      if (isEmpty) {
        // 空位 — 检查是否是AI填充位
        const realCount = this.slots.filter(sl => sl.accountName !== null).length;
        const aiIndex = i - realCount; // 相对于真人之后的AI编号
        const isAISlot = aiIndex >= 0 && aiIndex < this.aiFill;

        if (isAISlot) {
          // AI 占位：显示为 AI-1 ~ AI-7，已准备
          slotsEl.innerHTML += `
            <div class="player-slot occupied ready ai-slot">
              <div class="slot-icon">🤖</div>
              <div class="slot-name">AI-${aiIndex + 1}</div>
              <div class="slot-status">✓ 已准备（AI）</div>
            </div>
          `;
        } else {
          // 真正的空位
          slotsEl.innerHTML += `
            <div class="player-slot empty">
              <div class="slot-icon">⬜</div>
              <div class="slot-name">空位</div>
              <div class="slot-status">等待加入...</div>
            </div>
          `;
        }
      } else {
        // 真实玩家
        let cls = 'player-slot';
        if (s.isYou) cls += ' you';
        cls += ' occupied';
        if (s.ready) cls += ' ready';
        if (!s.connected && s.accountName) cls += ' disconnected';

        const displayName = s.nickname || s.accountName || '???';
        const avatarHtml = s.avatar
          ? `<img class="slot-avatar" src="${s.avatar}" alt="" />`
          : `<div class="slot-avatar-placeholder">👤</div>`;
        const hostIcon = s.isHost ? ' 👑' : '';
        let status = '';
        if (!s.connected) status = '⚠ 断线';
        else if (s.ready) status = '✓ 已准备';
        else status = '未准备';

        slotsEl.innerHTML += `
          <div class="${cls}">
            ${avatarHtml}
            <div class="slot-name">${displayName}${hostIcon}</div>
            <div class="slot-status">${status}</div>
          </div>
        `;
      }
    }
  }

  /** 检查是否满足倒计时启动条件，自动触发321倒计时 */
  private updateCountdown(): void {
    if (!this.myReady) {
      this.cancelCountdown();
      return;
    }

    const realSlots = this.slots.filter(s => s.accountName !== null);
    const allRealReady = realSlots.every(s => s.ready);
    const totalPlayers = realSlots.length + this.aiFill;

    const shouldStart = allRealReady && totalPlayers >= 8 && !this.countdownActive;

    if (shouldStart) {
      this.startCountdown();
    } else if (!allRealReady || totalPlayers < 8) {
      this.cancelCountdown();
    }
  }

  /** 启动321倒计时 */
  private startCountdown(): void {
    this.cancelCountdown(); // 清除旧计时器
    this.countdownActive = true;

    const overlay = this.el.querySelector('#countdown-overlay')! as HTMLElement;
    const numberEl = this.el.querySelector('#countdown-number')! as HTMLElement;
    overlay.style.display = 'flex';
    let count = 3;

    numberEl.textContent = String(count);
    numberEl.style.animation = 'none';
    void (numberEl as any).offsetHeight; // reflow
    numberEl.style.animation = 'countPulse 0.8s ease';

    this.countdownTimer = window.setInterval(() => {
      count--;
      if (count <= 0) {
        // 倒计时结束 — 房主触发开始选将
        this.cancelCountdown();
        if (this.isHost) {
          socketManager.emit('start_hero_select');
        }
        return;
      }
      numberEl.textContent = String(count);
      numberEl.style.animation = 'none';
      void (numberEl as any).offsetHeight;
      numberEl.style.animation = 'countPulse 0.8s ease';
    }, 1000);
  }

  /** 取消倒计时 */
  private cancelCountdown(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.countdownActive = false;
    const overlay = this.el.querySelector('#countdown-overlay')! as HTMLElement;
    overlay.style.display = 'none';
  }

  private cleanup(): void {
    this.cancelCountdown();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  show(): void { this.el.classList.add('active'); }
  hide(): void { this.el.classList.remove('active'); }
}
