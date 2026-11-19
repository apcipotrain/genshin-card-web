import { router, RouteState } from './router';
import { socketManager } from '../network/SocketManager';
import type { PublicRoom, PublicRoomSlot } from '../network/RoomProtocol';
import { getRandomPVPBackground, toCssImage } from './BackgroundAssets';
import { uiIcon } from './icons';

export class WaitingPage {
  private el!: HTMLElement;
  private roomId = '';
  private isHost = false;
  private mySlotIndex = -1;
  private slots: PublicRoomSlot[] = [];
  private aiFill = 0;
  private unsubs: Array<() => void> = [];
  private countdownTimer: number | null = null;
  private secondsToSelection: number | null = null;
  private awaitingSelection = false;
  private errorMessage = '';

  render(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'page waiting-page pvp-waiting';
    container.innerHTML = `
      <header class="pvp-waiting-nav">
        <button type="button" class="pvp-waiting-back" id="waiting-back">
          ${uiIcon('arrow')}离开房间
        </button>
      </header>
      <section class="pvp-waiting-panel" aria-labelledby="pvp-room-name">
        <header class="pvp-waiting-room">
          <div>
            <p class="pvp-waiting-mode">${uiIcon('swords')}PVP · 八人身份对局</p>
            <h1 id="pvp-room-name">等待房间</h1>
          </div>
          <dl class="pvp-room-number">
            <dt>房间号</dt>
            <dd id="room-id-display">—</dd>
          </dl>
        </header>
        <div class="pvp-waiting-roster">
          <div class="pvp-roster-heading">
            <h2 id="pvp-roster-heading">玩家席位</h2>
            <p id="pvp-room-count"></p>
          </div>
          <ul class="pvp-room-slots" id="player-slots" role="list" aria-labelledby="pvp-roster-heading"></ul>
        </div>
        <footer class="pvp-waiting-actions">
          <div class="pvp-waiting-progress" role="status">
            <strong id="ready-count"></strong>
            <p id="pvp-ready-hint"></p>
          </div>
          <div class="pvp-waiting-controls">
            <label class="pvp-ai-fill" id="ai-fill-row" hidden>
              <span>AI 补位</span>
              <select id="ai-fill-select"></select>
            </label>
            <button type="button" class="pvp-ready-button" id="btn-ready">准备</button>
          </div>
        </footer>
      </section>
    `;
    const leaveRoom = () => {
      this.cleanup();
      socketManager.emit('leave_room');
      router.navigate('match');
    };
    container.querySelector('#waiting-back')!.addEventListener('click', leaveRoom);
    container.querySelector('#ai-fill-select')!.addEventListener('change', event => {
      if (!this.isHost || !socketManager.isConnected) return;
      this.errorMessage = '';
      const count = Number((event.currentTarget as HTMLSelectElement).value);
      if (count < this.aiFill) this.cancelCountdown();
      socketManager.emit('set_ai_fill', { count });
    });
    container.querySelector('#btn-ready')!.addEventListener('click', () => {
      const me = this.getLocalSlot();
      if (!me || !socketManager.isConnected) return;
      this.errorMessage = '';
      if (me.ready) this.cancelCountdown();
      socketManager.emit('toggle_ready', { ready: !me.ready });
    });

    this.el = container;
    return container;
  }

  onEnter(state: RouteState): void {
    this.cleanup();
    this.el.style.setProperty('--pvp-background-image', toCssImage(getRandomPVPBackground()));
    this.roomId = (state.params?.roomId as string) || '';
    this.isHost = (state.params?.isHost as boolean) || false;
    this.mySlotIndex = (state.params?.mySlotIndex as number) ?? -1;
    this.slots = [];
    this.aiFill = 0;
    this.errorMessage = '';
    this.el.querySelector('#room-id-display')!.textContent = this.roomId || '—';
    this.el.querySelector('#pvp-room-name')!.textContent = '等待房间';

    this.unsubs.push(socketManager.on('room_update', (data: { room: PublicRoom | null }) => {
      if (data.room) this.updateSlots(data.room);
    }));
    this.unsubs.push(socketManager.on('__disconnected', () => {
      this.cancelCountdown();
      this.renderProgress();
    }));
    this.unsubs.push(socketManager.on('error_msg', (data?: { reason?: string }) => {
      this.cancelCountdown();
      this.errorMessage = data?.reason || '房间操作失败，请重试。';
      this.renderProgress();
    }));

    this.unsubs.push(socketManager.on('hero_select_start', data => {
      this.enterHeroSelection({
        heroCandidates: data.candidates,
        timeoutSec: data.timeoutSec,
        isMonarch: data.isMonarch || false,
        monarchHero: data.monarchHero || null,
      });
    }));
    this.unsubs.push(socketManager.on('hero_select_waiting', data => {
      this.enterHeroSelection({
        isWaitingForMonarch: true,
        monarchPlayerName: data.monarchPlayerName || '主公',
        timeoutSec: data.timeoutSec,
      });
    }));
    this.unsubs.push(socketManager.on('room_left', () => router.navigate('match')));

    const room = state.params?.room as PublicRoom | undefined;
    if (room) this.updateSlots(room);
    else this.renderRoom();
  }

  private enterHeroSelection(params: NonNullable<RouteState['params']>): void {
    this.cleanup();
    router.navigate('game', {
      mode: 'pvp',
      roomId: this.roomId,
      isHost: this.isHost,
      mySlotIndex: this.mySlotIndex,
      ...params,
    });
  }

  private getLocalSlot(): PublicRoomSlot | undefined {
    return this.slots.find(slot => slot.occupied && slot.index === this.mySlotIndex);
  }

  private updateSlots(room: PublicRoom): void {
    if (room.id !== this.roomId) return;
    this.errorMessage = '';
    this.slots = room.slots;
    this.aiFill = Math.min(room.aiFill, 8 - this.slots.filter(slot => slot.occupied).length);
    this.isHost = this.getLocalSlot()?.isHost ?? false;
    this.el.querySelector('#pvp-room-name')!.textContent = room.name;
    this.renderRoom();
  }

  private renderRoom(): void {
    const list = this.el.querySelector('#player-slots')!;
    const slots = Array.from({ length: 8 }, (_, index) => this.slots.find(slot => slot.index === index));
    let aiRemaining = this.aiFill;
    list.replaceChildren(...slots.map((slot, index) => {
      const ai = !slot?.occupied && aiRemaining > 0;
      if (ai) aiRemaining--;
      return this.renderSlot(index, slot, ai);
    }));

    const humans = this.slots.filter(slot => slot.occupied);
    const maxAI = 8 - humans.length;
    this.el.querySelector('#pvp-room-count')!.textContent = `${humans.length + this.aiFill}/8 席 · 真人 ${humans.length} · AI ${this.aiFill}`;
    const aiRow = this.el.querySelector<HTMLLabelElement>('#ai-fill-row')!;
    const aiSelect = this.el.querySelector<HTMLSelectElement>('#ai-fill-select')!;
    aiRow.hidden = !this.isHost;
    aiSelect.replaceChildren(...Array.from({ length: maxAI + 1 }, (_, count) => new Option(`${count} 位`, String(count))));
    aiSelect.value = String(this.aiFill);

    const allReady = humans.length + this.aiFill === 8 && humans.every(slot => slot.ready);
    if (!allReady || !socketManager.isConnected) this.cancelCountdown();
    else if (this.countdownTimer === null && !this.awaitingSelection && !this.errorMessage) this.startCountdown();
    this.renderProgress();
  }

  private renderSlot(index: number, slot?: PublicRoomSlot, ai = false): HTMLElement {
    const player = slot?.occupied ? slot : undefined;
    const tile = document.createElement('li');
    tile.className = 'pvp-room-slot';
    if (player?.index === this.mySlotIndex) tile.dataset.self = 'true';
    const status = player
      ? !player.connected ? { kind: 'offline', label: '已断线' }
        : player.ready ? { kind: 'ready', label: '已准备' } : { kind: 'present', label: '未准备' }
      : ai ? { kind: 'ai', label: '自动就绪' } : { kind: 'empty', label: '等待加入' };
    tile.dataset.state = status.kind;
    const slotName = player?.nickname || player?.accountName || (ai ? 'AI 玩家' : '空位');

    tile.innerHTML = `
      <div class="pvp-slot-heading">
        <span class="pvp-slot-index">${index + 1} 号位</span>
        <span class="pvp-slot-tags">
          ${player?.isHost ? '<span class="pvp-slot-host">房主</span>' : ''}
          ${tile.dataset.self ? '<span class="pvp-slot-self">你</span>' : ''}
        </span>
      </div>
      <div class="pvp-slot-person">
        <div class="pvp-slot-avatar">${ai ? uiIcon('settings') : uiIcon('user')}</div>
        <div class="pvp-slot-detail">
          <strong class="pvp-slot-name"></strong>
          <span class="pvp-slot-state">${status.label}</span>
        </div>
      </div>
    `;
    const name = tile.querySelector<HTMLElement>('.pvp-slot-name')!;
    name.textContent = slotName;
    name.title = slotName;
    if (player?.avatar) {
      const portrait = document.createElement('img');
      portrait.src = player.avatar;
      portrait.alt = '';
      portrait.addEventListener('error', () => portrait.remove(), { once: true });
      tile.querySelector('.pvp-slot-avatar')!.appendChild(portrait);
    }
    return tile;
  }

  private renderProgress(): void {
    const humans = this.slots.filter(slot => slot.occupied);
    const readyCount = humans.filter(slot => slot.ready).length;
    const me = this.getLocalSlot();
    const ready = me?.ready ?? false;
    const connected = socketManager.isConnected;
    const unfilled = 8 - humans.length - this.aiFill;
    const count = this.el.querySelector('#ready-count')!;
    const hint = this.el.querySelector('#pvp-ready-hint')!;
    const button = this.el.querySelector<HTMLButtonElement>('#btn-ready')!;
    const aiSelect = this.el.querySelector<HTMLSelectElement>('#ai-fill-select')!;

    button.textContent = ready ? '取消准备' : '准备';
    button.dataset.ready = String(ready);
    button.disabled = !connected || !me;
    aiSelect.disabled = !connected;
    count.textContent = `真人准备 ${readyCount}/${humans.length}`;
    hint.textContent = this.errorMessage || this.getProgressMessage(connected, unfilled, ready);
    hint.classList.toggle('pvp-room-error', !!this.errorMessage);
  }

  private getProgressMessage(connected: boolean, unfilled: number, ready: boolean): string {
    if (!connected) return '连接已断开，等待重连。';
    if (this.secondsToSelection !== null) return `${this.secondsToSelection} 秒后进入选将。`;
    if (this.awaitingSelection) return '正在进入选将…';
    if (unfilled > 0) {
      return this.isHost ? `还差 ${unfilled} 席，可等待玩家加入或设置 AI 补位。` : `还差 ${unfilled} 席，等待玩家加入或由房主设置 AI 补位。`;
    }
    return ready ? '等待其他玩家准备。' : '座位已满，所有玩家准备后自动选将。';
  }

  private startCountdown(): void {
    this.secondsToSelection = 3;
    this.countdownTimer = window.setInterval(() => {
      const remaining = (this.secondsToSelection ?? 0) - 1;
      if (remaining > 0) {
        this.secondsToSelection = remaining;
      } else {
        this.cancelCountdown();
        this.awaitingSelection = true;
        if (this.isHost) socketManager.emit('start_hero_select');
      }
      this.renderProgress();
    }, 1000);
  }

  private cancelCountdown(): void {
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.secondsToSelection = null;
    this.awaitingSelection = false;
  }

  private cleanup(): void {
    this.cancelCountdown();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  show(): void { this.el.classList.add('active'); }
  hide(): void { this.cleanup(); this.el.classList.remove('active'); }
}
