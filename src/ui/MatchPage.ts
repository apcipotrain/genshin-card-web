// ============================================================
// MatchPage.ts — PVP 匹配界面（真实WebSocket服务端 + 创建房间）
// ============================================================

import { router } from './router';
import { socketManager } from '../network/SocketManager';

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
    container.className = 'page match-page';
    container.innerHTML = `
      <div style="display:flex;align-items:center;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <button class="btn btn-ghost btn-sm" id="match-back">← 返回主页</button>
        <div style="flex:1;text-align:center;font-size:20px;font-weight:bold;color:var(--gold);letter-spacing:4px;">PVP 联机对战</div>
        <div style="width:80px;text-align:right;color:rgba(255,255,255,0.5);font-size:12px;" id="match-account"></div>
      </div>
      <div class="match-container">
        <div class="room-list-panel">
          <div class="room-list-header">
            <h2>房间列表</h2>
            <button class="btn btn-ghost btn-sm" id="refresh-rooms">刷新</button>
          </div>
          <div class="room-list" id="room-list">
            <div style="text-align:center;color:var(--text-dim);padding:40px;">加载中...</div>
          </div>
        </div>
        <div class="create-panel">
          <div class="create-card">
            <h3>创建房间</h3>
            <div class="form-group">
              <label>房间名称</label>
              <input class="form-input" id="room-name" placeholder="输入房间名称..." value="原神杀房间" />
            </div>
            <div class="toggle-row">
              <div class="toggle-switch" id="private-toggle"></div>
              <span class="toggle-label">私密模式</span>
            </div>
            <div class="form-group" id="password-group" style="display:none;">
              <label>房间密码</label>
              <input class="form-input" id="room-password" type="password" placeholder="输入密码..." />
            </div>
            <button class="btn btn-gold create-btn" id="create-room">创建房间</button>
          </div>
          <button class="btn quick-match-btn" id="quick-match">⚡ 加入房间（输入房号）</button>
        </div>
      </div>
    `;

    // 返回
    container.querySelector('#match-back')!.addEventListener('click', () => router.navigate('home'));

    // 刷新
    container.querySelector('#refresh-rooms')!.addEventListener('click', () => {
      socketManager.emit('get_room_list');
    });

    // 私密切换
    const toggle = container.querySelector('#private-toggle')!;
    const passwordGroup = container.querySelector('#password-group')! as HTMLElement;
    let isPrivate = false;
    toggle.addEventListener('click', () => {
      isPrivate = !isPrivate;
      toggle.classList.toggle('on', isPrivate);
      passwordGroup.style.display = isPrivate ? 'block' : 'none';
    });

    // 创建房间
    container.querySelector('#create-room')!.addEventListener('click', () => {
      if (!socketManager.isConnected) {
        alert('未连接到服务器，请刷新页面');
        return;
      }

      const nameInput = container.querySelector('#room-name') as HTMLInputElement;
      const pwInput = container.querySelector('#room-password') as HTMLInputElement;
      const aiSelect = container.querySelector('#ai-fill') as HTMLSelectElement;

      socketManager.emit('create_room', {
        roomName: nameInput.value || '原神杀房间',
        password: isPrivate ? (pwInput.value || null) : null,
      });
    });

    // 加入房间（输入房号）
    container.querySelector('#quick-match')!.addEventListener('click', () => {
      const code = prompt('请输入房间号:');
      if (code && code.trim()) {
        this.tryJoinRoom(code.trim().toUpperCase());
      }
    });

    this.el = container;
    return container;
  }

  show(): void {
    this.el.classList.add('active');

    // 显示账号名
    const accountEl = this.el.querySelector('#match-account')!;
    accountEl.textContent = socketManager.account?.name || '';

    // 监听房间列表
    this.unsubs.push(socketManager.on('room_list', (data: { rooms: RoomListItem[] }) => {
      this.rooms = data.rooms;
      this.renderRoomList();
    }));

    this.unsubs.push(socketManager.on('room_created', (data: any) => {
      router.navigate('waiting', { roomId: data.roomId, isHost: true, mySlotIndex: data.mySlotIndex });
    }));

    this.unsubs.push(socketManager.on('room_joined', (data: any) => {
      router.navigate('waiting', { roomId: data.roomId, isHost: false, mySlotIndex: data.mySlotIndex });
    }));

    this.unsubs.push(socketManager.on('error_msg', (data: any) => {
      alert(data.reason || '操作失败');
    }));

    // 请求房间列表
    socketManager.emit('get_room_list');
  }

  hide(): void {
    this.el.classList.remove('active');
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  private renderRoomList(): void {
    const listEl = this.el.querySelector('#room-list')!;
    if (this.rooms.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px;">暂无房间</div>';
      return;
    }
    listEl.innerHTML = this.rooms.map(r => {
      const aiText = (r.aiFill && r.aiFill > 0) ? ` +${r.aiFill}AI` : '';
      return `
      <div class="room-item" data-room="${r.id}" data-password="${r.hasPassword}">
        <div class="room-id">${r.name} <span style="font-size:11px;color:rgba(255,255,255,0.3);">#${r.id}</span></div>
        <div class="room-info">
          <span class="room-players">${r.playerCount}人${aiText}/${r.maxSlots}</span>
          <span class="room-lock-icon">${r.hasPassword ? '🔒' : '🔓'}</span>
        </div>
      </div>
    `;}).join('');

    listEl.querySelectorAll('.room-item').forEach(item => {
      item.addEventListener('click', () => {
        const el = item as HTMLElement;
        const roomId = el.dataset.room!;
        const hasPassword = el.dataset.password === 'true';

        if (hasPassword) {
          const pw = prompt('请输入房间密码:');
          if (pw === null) return;
          socketManager.emit('join_room', { roomId, password: pw });
        } else {
          socketManager.emit('join_room', { roomId });
        }
      });
    });
  }

  private tryJoinRoom(roomId: string): void {
    socketManager.emit('join_room', { roomId });
  }
}
