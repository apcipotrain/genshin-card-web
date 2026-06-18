// ============================================================
// RoomManager.ts — 房间管理
// ============================================================

import * as crypto from 'crypto';

export interface RoomSlot {
  index: number;        // 0-7
  accountId: string | null;
  accountName: string | null;
  avatar: string | null;
  nickname: string | null;
  token: string | null;
  ready: boolean;
  isHost: boolean;
  connected: boolean;   // WebSocket 是否连接
  heroId?: string;
}

export interface RoomInfo {
  id: string;
  name: string;
  hasPassword: boolean;
  playerCount: number;
  maxSlots: number;
  aiFill: number;       // 房主设置的AI填充数
}

// 发给客户端的精简房间列表
export interface RoomListItem {
  id: string;
  name: string;
  hasPassword: boolean;
  playerCount: number;
  maxSlots: number;
  aiFill?: number;
}

export interface JoinResult {
  success: boolean;
  room?: RoomInfo;
  slotIndex?: number;
  reason?: string;
}

export class RoomManager {
  private rooms: Map<string, {
    id: string;
    name: string;
    password: string | null;
    aiFill: number;
    slots: RoomSlot[];
  }> = new Map();

  /** 通过 token 查找所在房间和槽位 */
  findPlayer(token: string): { roomId: string; slotIndex: number } | null {
    for (const [roomId, room] of this.rooms) {
      const idx = room.slots.findIndex(s => s.token === token);
      if (idx !== -1) return { roomId, slotIndex: idx };
    }
    return null;
  }

  /** 创建房间 */
  createRoom(hostToken: string, hostName: string, hostAccountId: string, hostAvatar: string, hostNickname: string, roomName: string, password: string | null, aiFill: number): string {
    const id = crypto.randomBytes(3).toString('hex').toUpperCase(); // 如 "A3F7B2"
    const slots: RoomSlot[] = [];
    for (let i = 0; i < 8; i++) {
      slots.push({
        index: i,
        accountId: null,
        accountName: null,
        avatar: null,
        nickname: null,
        token: null,
        ready: false,
        isHost: i === 0,
        connected: false,
      });
    }
    // 房主占第0位
    slots[0] = {
      index: 0,
      accountId: hostAccountId,
      accountName: hostName,
      avatar: hostAvatar,
      nickname: hostNickname,
      token: hostToken,
      ready: false,
      isHost: true,
      connected: true,
    };

    this.rooms.set(id, {
      id,
      name: roomName || '原神杀房间',
      password: password || null,
      aiFill: Math.max(0, Math.min(7, aiFill)),
      slots,
    });

    return id;
  }

  /** 加入房间 */
  joinRoom(roomId: string, token: string, accountName: string, accountId: string, avatar: string, nickname: string, password?: string): JoinResult {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, reason: '房间不存在' };
    }

    // 检查密码
    if (room.password && room.password !== password) {
      return { success: false, reason: '密码错误' };
    }

    // 检查是否已在房间中（重连）
    const existingSlot = room.slots.find(s => s.token === token);
    if (existingSlot) {
      existingSlot.connected = true;
      return {
        success: true,
        room: this.makeRoomInfo(room),
        slotIndex: existingSlot.index,
      };
    }

    // 检查是否已满
    const emptySlot = room.slots.find(s => s.token === null);
    if (!emptySlot) {
      return { success: false, reason: '房间已满' };
    }

    emptySlot.accountId = accountId;
    emptySlot.accountName = accountName;
    emptySlot.avatar = avatar;
    emptySlot.nickname = nickname;
    emptySlot.token = token;
    emptySlot.ready = false;
    emptySlot.connected = true;

    return {
      success: true,
      room: this.makeRoomInfo(room),
      slotIndex: emptySlot.index,
    };
  }

  /** 离开房间 */
  leaveRoom(token: string): string | null {
    const found = this.findPlayer(token);
    if (!found) return null;

    const room = this.rooms.get(found.roomId);
    if (!room) return null;

    const slot = room.slots[found.slotIndex];
    slot.accountId = null;
    slot.accountName = null;
    slot.token = null;
    slot.ready = false;
    slot.connected = false;

    // 如果房主离开，转移房主给下一个真人
    if (slot.isHost) {
      slot.isHost = false;
      const nextPlayer = room.slots.find(s => s.token !== null);
      if (nextPlayer) {
        nextPlayer.isHost = true;
      } else {
        // 没有真人了，删除房间
        this.rooms.delete(found.roomId);
        return null;
      }
    }

    // 如果所有真人都走了，删除房间
    const hasRealPlayers = room.slots.some(s => s.token !== null);
    if (!hasRealPlayers) {
      this.rooms.delete(found.roomId);
      return null;
    }

    return found.roomId;
  }

  /** 断线（保持槽位，标记断开） */
  disconnect(token: string): string | null {
    const found = this.findPlayer(token);
    if (!found) return null;

    const room = this.rooms.get(found.roomId);
    if (!room) return null;

    room.slots[found.slotIndex].connected = false;
    return found.roomId;
  }

  /** 重连 */
  reconnect(token: string): string | null {
    const found = this.findPlayer(token);
    if (!found) return null;

    const room = this.rooms.get(found.roomId);
    if (!room) return null;

    room.slots[found.slotIndex].connected = true;
    return found.roomId;
  }

  /** 切换准备状态 */
  setReady(token: string, ready: boolean): void {
    const found = this.findPlayer(token);
    if (!found) return;

    const room = this.rooms.get(found.roomId);
    if (!room) return;

    room.slots[found.slotIndex].ready = ready;
  }

  /** 设置AI填充数（仅房主）。上限 = 8 - 已加入的真人玩家数 */
  setAIFill(token: string, count: number): boolean {
    const found = this.findPlayer(token);
    if (!found) return false;

    const room = this.rooms.get(found.roomId);
    if (!room) return false;

    if (!room.slots[found.slotIndex].isHost) return false;
    const humanCount = room.slots.filter(s => s.token !== null).length;
    const maxAI = Math.max(0, 8 - humanCount);
    room.aiFill = Math.max(0, Math.min(maxAI, count));
    return true;
  }

  /** 设置英雄 */
  setHero(token: string, heroId: string): void {
    const found = this.findPlayer(token);
    if (!found) return;

    const room = this.rooms.get(found.roomId);
    if (!room) return;

    room.slots[found.slotIndex].heroId = heroId;
  }

  /** 所有真人准备好且人数>=4 */
  isAllReady(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const realSlots = room.slots.filter(s => s.token !== null);
    if (realSlots.length + room.aiFill < 8) return false; // 真人+AI至少8人
    return realSlots.every(s => s.ready);
  }

  /** 获取房间的槽位信息 */
  getSlots(roomId: string): RoomSlot[] | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.slots;
  }

  /** 获取房间信息列表 */
  getRoomList(): RoomListItem[] {
    const list: RoomListItem[] = [];
    for (const room of this.rooms.values()) {
      list.push({
        id: room.id,
        name: room.name,
        hasPassword: !!room.password,
        playerCount: room.slots.filter(s => s.token !== null).length,
        maxSlots: 8,
        aiFill: room.aiFill,
      });
    }
    return list;
  }

  getRoom(roomId: string): { id: string; name: string; password: string | null; aiFill: number; slots: RoomSlot[] } | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return { ...room };
  }

  /** 删除房间 */
  deleteRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  private makeRoomInfo(room: { id: string; name: string; password: string | null; aiFill: number; slots: RoomSlot[] }): RoomInfo {
    return {
      id: room.id,
      name: room.name,
      hasPassword: !!room.password,
      playerCount: room.slots.filter(s => s.token !== null).length,
      maxSlots: 8,
      aiFill: room.aiFill,
    };
  }
}
