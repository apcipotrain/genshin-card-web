import type { Server, Socket } from 'socket.io';
import { CHAT_HISTORY_LIMIT, normalizeChatText, type ChatMessage, type ChatResult } from '../src/network/ChatProtocol.js';

export interface ChatMember { roomId: string; accountId: string; name: string }

/** One instance per server. No await between validation, sequence assignment and append. */
export class ChatService {
  private rooms = new Map<string, { sequence: number; messages: ChatMessage[]; rates: Map<string, number[]> }>();

  constructor(private roomExists: (roomId: string) => boolean) {}

  sweep(): void {
    for (const roomId of this.rooms.keys()) if (!this.roomExists(roomId)) this.rooms.delete(roomId);
  }

  history(roomId: string): ChatMessage[] {
    this.sweep();
    return [...(this.rooms.get(roomId)?.messages || [])];
  }

  send(member: ChatMember, input: unknown, now = Date.now()): ChatResult {
    this.sweep();
    if (!this.roomExists(member.roomId)) return { success: false, reason: '对局已结束，请返回大厅' };
    if (!input || typeof input !== 'object') return { success: false, reason: '消息格式错误' };
    const { roomId, clientId, text: rawText } = input as Record<string, unknown>;
    if (roomId !== member.roomId) return { success: false, reason: '不能向其他房间发送消息' };
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(clientId)) return { success: false, reason: '消息标识无效' };
    const text = normalizeChatText(rawText);
    if (!text) return { success: false, reason: '请输入1～200字的消息' };
    let room = this.rooms.get(member.roomId);
    if (!room) {
      room = { sequence: 0, messages: [], rates: new Map() };
      this.rooms.set(member.roomId, room);
    }
    const previous = room.messages.find(m => m.senderId === member.accountId && m.clientId === clientId);
    if (previous) return { success: true, message: previous, duplicate: true };
    const times = (room.rates.get(member.accountId) || []).filter(time => now - time < 10000);
    if (times.length >= 5) return { success: false, reason: '发送过于频繁，请稍后再试（10秒最多5条）' };
    room.rates.set(member.accountId, [...times, now]);
    const sequence = ++room.sequence;
    const message: ChatMessage = { id: `${member.roomId}:${sequence}`, roomId: member.roomId, clientId,
      sequence, senderId: member.accountId, senderName: member.name.slice(0, 40), text, sentAt: now };
    room.messages.push(message);
    if (room.messages.length > CHAT_HISTORY_LIMIT) room.messages.shift();
    return { success: true, message };
  }
}

export function registerChat(socket: Socket, io: Server, service: ChatService,
  getMember: () => ChatMember | null | Promise<ChatMember | null>): void {
  socket.on('chat_history', async (input: unknown, ack: unknown) => {
    if (typeof ack !== 'function') return;
    let member: ChatMember | null;
    try { member = await getMember(); }
    catch { ack({ success: false, reason: '账号服务暂时不可用，请稍后重试' }); return; }
    if (!member || (input as any)?.roomId !== member.roomId) {
      ack({ success: false, reason: '当前不在有效对局中' }); return;
    }
    ack({ success: true, roomId: member.roomId, messages: service.history(member.roomId) });
  });
  socket.on('chat_send', async (input: unknown, ack: unknown) => {
    let member: ChatMember | null;
    try { member = await getMember(); }
    catch {
      if (typeof ack === 'function') ack({ success: false, reason: '账号服务暂时不可用，请稍后重试' });
      return;
    }
    const result = member ? service.send(member, input) : { success: false as const, reason: '请登录并加入有效对局' };
    if (result.success && !result.duplicate) io.to(member!.roomId).emit('chat_message', result.message);
    if (typeof ack === 'function') ack(result);
  });
}
