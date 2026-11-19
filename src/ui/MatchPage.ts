// ============================================================
// MatchPage.ts — PVP 匹配界面（真实WebSocket服务端 + 创建房间）
// ============================================================

import { router } from './router';
import { socketManager } from '../network/SocketManager';
import type { PublicRoom } from '../network/RoomProtocol';
import { getRandomPVPBackground, toCssImage } from './BackgroundAssets';

interface RoomListItem {
  id: string;
  name: string;
  hasPassword: boolean;
  playerCount: number;
  maxSlots: number;
  aiFill?: number;
}

export class MatchPage {
  private el!: HTMLElement;
  private rooms: RoomListItem[] = [];
  private unsubs: Array<() => void> = [];

  render(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'page match-page pvp-lobby';
    container.innerHTML = `
      <header class="pvp-lobby-nav">
        <button class="btn btn-ghost btn-sm" id="match-back">← 返回主页</button>
        <div class="pvp-lobby-account">
          <span id="match-account"></span>
          <span class="pvp-lobby-connection" id="match-connection" role="status"></span>
        </div>
      </header>
      <main class="pvp-lobby-content">
        <section class="pvp-lobby-banner" aria-labelledby="pvp-lobby-title">
          <h1 id="pvp-lobby-title">PVP 联机对战</h1>
          <p>八人身份局 · 可用 AI 填补空位</p>
        </section>
        <div class="pvp-lobby-layout">
          <section class="pvp-lobby-panel pvp-room-directory" aria-labelledby="pvp-room-title">
            <header class="pvp-room-directory-header">
              <div>
                <h2 id="pvp-room-title">房间列表</h2>
                <p id="room-list-summary" role="status">正在载入房间</p>
              </div>
              <button class="btn btn-ghost btn-sm" id="refresh-rooms" type="button">刷新</button>
            </header>
            <ul class="pvp-room-list" id="room-list"></ul>
            <p class="pvp-room-placeholder" id="room-list-placeholder">正在载入房间…</p>
          </section>
          <aside class="pvp-lobby-tools">
            <form class="pvp-lobby-panel pvp-lobby-form" id="join-room-form">
              <h2>按房号加入</h2>
              <label for="join-room-code">房间号</label>
              <input id="join-room-code" placeholder="输入房间号" autocomplete="off" spellcheck="false" required>
              <details id="join-password-details">
                <summary>输入房间密码</summary>
                <input id="join-room-password" type="password" aria-label="加入房间的密码" autocomplete="off" placeholder="房间密码">
              </details>
              <button class="btn btn-gold" id="quick-match" type="submit">加入房间</button>
            </form>
            <form class="pvp-lobby-panel pvp-lobby-form" id="create-room-form">
              <h2>创建房间</h2>
              <label for="room-name">房间名称</label>
              <input id="room-name" value="原神杀房间">
              <label class="pvp-lobby-checkbox">
                <input type="checkbox" id="private-toggle" aria-controls="password-group">
                设置加入密码
              </label>
              <div id="password-group" hidden>
                <label for="room-password">房间密码</label>
                <input id="room-password" type="password" autocomplete="off">
              </div>
              <button class="btn btn-ghost" id="create-room" type="submit">创建房间</button>
            </form>
            <p class="pvp-lobby-error" id="match-error" role="alert" hidden></p>
          </aside>
        </div>
      </main>
    `;

    container.querySelector('#match-back')!.addEventListener('click', () => router.navigate('home'));
    container.querySelector('#refresh-rooms')!.addEventListener('click', () => this.requestRooms());
    const toggle = container.querySelector<HTMLInputElement>('#private-toggle')!;
    const passwordGroup = container.querySelector<HTMLElement>('#password-group')!;
    const createPassword = container.querySelector<HTMLInputElement>('#room-password')!;
    toggle.addEventListener('change', () => {
      passwordGroup.hidden = !toggle.checked;
      createPassword.required = toggle.checked;
      if (toggle.checked) createPassword.focus();
      else createPassword.value = '';
    });
    container.querySelector('#create-room-form')!.addEventListener('submit', event => {
      event.preventDefault();
      if (!this.canSend()) return;
      const nameInput = container.querySelector<HTMLInputElement>('#room-name')!;
      socketManager.emit('create_room', {
        roomName: nameInput.value.trim() || '原神杀房间',
        password: toggle.checked ? createPassword.value : null,
      });
    });
    container.querySelector('#join-room-form')!.addEventListener('submit', event => {
      event.preventDefault();
      const code = container.querySelector<HTMLInputElement>('#join-room-code')!.value.trim().toUpperCase();
      const details = container.querySelector<HTMLDetailsElement>('#join-password-details')!;
      const password = container.querySelector<HTMLInputElement>('#join-room-password')!.value;
      if (!code) { this.showError('请输入房间号'); return; }
      this.tryJoinRoom(code, details.open ? password : '');
    });

    this.el = container;
    return container;
  }

  show(): void {
    this.el.style.setProperty('--pvp-background-image', toCssImage(getRandomPVPBackground()));
    this.el.classList.add('active');

    const accountEl = this.el.querySelector('#match-account')!;
    accountEl.textContent = socketManager.account?.nickname || socketManager.account?.name || '';
    this.showError('');
    this.updateConnection(socketManager.isConnected);

    // 监听房间列表
    this.unsubs.push(socketManager.on('room_list', (data: { rooms: RoomListItem[] }) => {
      this.rooms = data.rooms || [];
      this.renderRoomList();
    }));

    this.unsubs.push(socketManager.on('room_created', (data: { roomId: string; room: PublicRoom; mySlotIndex: number }) => {
      router.navigate('waiting', { roomId: data.roomId, room: data.room, isHost: true, mySlotIndex: data.mySlotIndex });
    }));

    this.unsubs.push(socketManager.on('room_joined', (data: { roomId: string; room: PublicRoom; mySlotIndex: number }) => {
      router.navigate('waiting', { roomId: data.roomId, room: data.room, isHost: false, mySlotIndex: data.mySlotIndex });
    }));

    this.unsubs.push(socketManager.on('error_msg', (data: { reason?: string }) => {
      this.showError(data.reason || '操作失败');
      if (data.reason?.includes('密码')) {
        const details = this.el.querySelector<HTMLDetailsElement>('#join-password-details')!;
        if (this.el.querySelector<HTMLButtonElement>('#quick-match') === document.activeElement ||
            this.el.querySelector('#join-room-form')?.contains(document.activeElement)) {
          details.open = true;
          details.querySelector('input')?.focus();
        }
      }
    }));
    this.unsubs.push(socketManager.on('__connected', () => {
      this.updateConnection(true);
      this.requestRooms();
    }));
    this.unsubs.push(socketManager.on('__disconnected', () => this.updateConnection(false)));
    this.unsubs.push(socketManager.on('__connection_error', () => this.updateConnection(false)));
    if (socketManager.isConnected) this.requestRooms();
  }

  hide(): void {
    this.el.classList.remove('active');
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  private renderRoomList(): void {
    const listEl = this.el.querySelector('#room-list')!;
    const placeholder = this.el.querySelector<HTMLElement>('#room-list-placeholder')!;
    placeholder.hidden = this.rooms.length > 0;
    placeholder.textContent = '暂无房间，可以创建一间或输入房间号加入。';
    this.el.querySelector('#room-list-summary')!.textContent = `${this.rooms.length} 间房间`;
    listEl.replaceChildren(...this.rooms.map(room => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const full = room.playerCount >= room.maxSlots;
      button.type = 'button';
      button.className = 'pvp-room-row';
      button.disabled = full;
      button.innerHTML = '<span class="pvp-room-identity"><strong></strong><small></small></span><span class="pvp-room-meta"></span><span class="pvp-room-access"></span><span class="pvp-room-join"></span>';
      button.querySelector('strong')!.textContent = room.name;
      button.querySelector('small')!.textContent = `#${room.id}`;
      button.querySelector('.pvp-room-meta')!.textContent = `真人 ${room.playerCount}/${room.maxSlots}${room.aiFill ? ` · AI ${room.aiFill}` : ''}`;
      button.querySelector('.pvp-room-access')!.textContent = room.hasPassword ? '需密码' : '公开';
      button.querySelector('.pvp-room-join')!.textContent = full ? '已满' : '加入 →';
      button.addEventListener('click', () => {
        if (!room.hasPassword) { this.tryJoinRoom(room.id); return; }
        if (!this.canSend()) return;
        this.el.querySelector<HTMLInputElement>('#join-room-code')!.value = room.id;
        const details = this.el.querySelector<HTMLDetailsElement>('#join-password-details')!;
        details.open = true;
        const input = details.querySelector('input')!;
        input.value = '';
        input.focus();
      });
      item.append(button);
      return item;
    }));
  }

  private showError(message: string): void {
    const error = this.el.querySelector<HTMLElement>('#match-error')!;
    error.hidden = !message;
    error.textContent = message;
  }

  private updateConnection(online: boolean): void {
    const indicator = this.el.querySelector<HTMLElement>('#match-connection')!;
    indicator.dataset.online = String(online);
    indicator.textContent = online ? '已连接' : '连接中断';
    if (!online && this.rooms.length === 0) {
      this.el.querySelector('#room-list-summary')!.textContent = '等待服务器连接';
      this.el.querySelector('#room-list-placeholder')!.textContent = '连上服务器后将显示房间。';
    }
  }

  private canSend(): boolean {
    this.showError(socketManager.isConnected ? '' : '连接中断，请稍后重试。');
    return socketManager.isConnected;
  }

  private requestRooms(): void {
    if (this.canSend()) socketManager.emit('get_room_list');
  }

  private tryJoinRoom(roomId: string, password = ''): void {
    if (this.canSend()) socketManager.emit('join_room', password ? { roomId, password } : { roomId });
  }
}
