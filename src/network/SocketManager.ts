// ============================================================
// SocketManager.ts — Socket.IO 客户端单例
// ============================================================

import { io, Socket } from 'socket.io-client';

/** 客户端等级进度计算（与服务器 AccountManager 一致） */
function buildCumulative(): { level: number; totalExp: number }[] {
  const cumul: { level: number; totalExp: number }[] = [];
  let total = 0;
  cumul.push({ level: 1, totalExp: 0 });
  for (let lv = 1; lv < 60; lv++) {
    let need: number;
    if (lv <= 55) { need = lv * 100; }
    else if (lv === 56) { need = 56000; }
    else if (lv === 57) { need = 57000; }
    else if (lv === 58) { need = 58000; }
    else { need = 59000; }
    total += need;
    cumul.push({ level: lv + 1, totalExp: total });
  }
  return cumul;
}
const CUMULATIVE = buildCumulative();

function getLevelAndProgress(exp: number): { level: number; currentExp: number; nextExp: number } {
  for (let i = CUMULATIVE.length - 1; i >= 0; i--) {
    if (exp >= CUMULATIVE[i].totalExp) {
      const next = i + 1 < CUMULATIVE.length ? CUMULATIVE[i + 1] : null;
      return {
        level: CUMULATIVE[i].level,
        currentExp: exp - CUMULATIVE[i].totalExp,
        nextExp: next ? next.totalExp - CUMULATIVE[i].totalExp : 0,
      };
    }
  }
  return { level: 1, currentExp: 0, nextExp: 100 };
}

export type EventHandler = (data: any) => void;

class SocketManager {
  private socket: Socket | null = null;
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectCallbacks: Array<() => void> = [];
  private _isConnected = false;
  private _account: { id: string; name: string; nickname?: string; avatar?: string; level?: number; exp?: number; currentLevelExp?: number; nextLevelExp?: number } | null = null;
  private _token: string | null = null;

  /** 连接到服务器 */
  connect(url?: string): void {
    if (this.socket?.connected) return;

    // 开发环境通过 Vite proxy 连接（同端口3000），生产环境连同源或自定义地址
    const serverUrl = url || window.location.origin;
    console.log(`[SocketManager] 连接服务器: ${serverUrl}`);

    this.socket = io(serverUrl, {
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
      upgrade: true,
    });

    this.socket.on('connect', () => {
      this._isConnected = true;
      console.log('[SocketManager] 已连接:', this.socket?.id);
      this.emitLocal('__connected');

      // 如果有token，自动重新认证
      if (this._token) {
        this.socket?.emit('auth_token', { token: this._token });
      }
    });

    this.socket.on('disconnect', (reason) => {
      this._isConnected = false;
      console.log(`[SocketManager] 断线: ${reason}`);
      this.emitLocal('__disconnected');
    });

    this.socket.on('connect_error', (err) => {
      console.error(`[SocketManager] 连接失败:`, err.message);
    });

    this.socket.on('reconnect', () => {
      console.log('[SocketManager] 重连成功');
      this.emitLocal('__reconnected');
      for (const cb of this.reconnectCallbacks) cb();
    });

    // 服务器事件透传
    const serverEvents = [
      'login_result', 'signup_result', 'logged_in', 'logged_out', 'auth_failed',
      'profile_updated',
      'room_list', 'room_created', 'room_joined', 'room_left',
      'room_update', 'error_msg', 'reconnected',
      'hero_select_start', 'hero_select_result',
      'hero_select_waiting', 'hero_select_monarch_picked',
      'game_start', 'game_event', 'game_over',
      'prompt',  // RemotePlayerDriver的请求
    ];

    for (const event of serverEvents) {
      this.socket.on(event, (data: any) => {
        console.log(`[SocketManager] 收到服务端事件: "${event}"`, typeof data === 'object' ? JSON.stringify(data) : data);
        this.emitLocal(event, data);
      });
    }

    // 冗余：直接在socket上监听认证事件，绕过自定义事件系统
    this.socket.on('login_result', (data: any) => {
      if (data?.success && data?.account && data?.token) {
        console.log('[SocketManager] 冗余登录hook触发，设置token');
        this.setAccount(data.account);
        this.setToken(data.token);
      }
    });

    this.socket.on('signup_result', (data: any) => {
      if (data?.success && data?.account && data?.token) {
        console.log('[SocketManager] 冗余注册hook触发，设置token');
        this.setAccount(data.account);
        this.setToken(data.token);
      }
    });
  }

  /** 发送事件 */
  emit(event: string, data?: any): void {
    if (this.socket?.connected) {
      this.socket.emit(event, data);
    } else {
      console.warn(`[SocketManager] 未连接，无法发送 ${event}`);
    }
  }

  /** 发送事件并等待服务端ack回调 */
  emitWithAck(event: string, data?: any): Promise<any> {
    return new Promise((resolve) => {
      if (this.socket?.connected) {
        this.socket.emit(event, data, (ack: any) => resolve(ack));
      } else {
        console.warn(`[SocketManager] 未连接，无法发送 ${event}`);
        resolve(null);
      }
    });
  }

  /** 主动断开连接（PVP离开时调用） */
  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
      this._isConnected = false;
    }
    this.eventHandlers.clear();
  }

  /** 监听服务器事件 */
  on(event: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  /** 监听一次 */
  once(event: string, handler: EventHandler): void {
    const wrapper = (data: any) => {
      handler(data);
      this.off(event, wrapper);
    };
    this.on(event, wrapper);
  }

  /** 取消监听 */
  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /** 注册重连回调 */
  onReconnect(cb: () => void): () => void {
    this.reconnectCallbacks.push(cb);
    return () => {
      this.reconnectCallbacks = this.reconnectCallbacks.filter(c => c !== cb);
    };
  }

  /** 发送 prompt 响应 */
  respond(requestId: string, result: any): void {
    this.emit('prompt_response', { requestId, result });
  }

  /** 内部事件触发 */
  private emitLocal(event: string, data?: any): void {
    const handlers = this.eventHandlers.get(event);
    const count = handlers?.size || 0;
    console.log(`[SocketManager] emitLocal("${event}") → 已注册处理器: ${count}`);
    if (count === 0) {
      console.warn(`[SocketManager] ⚠ 没有处理器监听 "${event}" 事件！`);
    }
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (e) {
          console.error(`[SocketManager] ${event} 处理错误:`, e);
        }
      }
    }
  }

  // ---- 便捷方法 ----
  get account() { return this._account; }
  get token() { return this._token; }
  get isConnected() { return this._isConnected; }
  get socketId() { return this.socket?.id || null; }

  setAccount(account: { id: string; name: string; nickname?: string; avatar?: string; level?: number; exp?: number; currentLevelExp?: number; nextLevelExp?: number } | null) {
    if (account && typeof account.exp === 'number' && (account.currentLevelExp === undefined || account.nextLevelExp === undefined)) {
      // 自动从累计经验计算当前等级进度
      const progress = getLevelAndProgress(account.exp);
      account.currentLevelExp = progress.currentExp;
      account.nextLevelExp = progress.nextExp;
      if (account.level === undefined) account.level = progress.level;
    }
    this._account = account;
  }

  setToken(token: string | null) {
    this._token = token;
    if (token) {
      sessionStorage.setItem('genshin_card_token', token);
    } else {
      sessionStorage.removeItem('genshin_card_token');
    }
  }

  getSavedToken(): string | null {
    return sessionStorage.getItem('genshin_card_token');
  }
}

export const socketManager = new SocketManager();
