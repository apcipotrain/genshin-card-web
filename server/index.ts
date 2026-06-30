// ============================================================
// server/index.ts — 原神杀 PVP 服务器入口
// 启动: npx tsx server/index.ts
// ============================================================

/* eslint-disable @typescript-eslint/no-require-imports */
// @ts-expect-error - @types/express 未安装，tsx 运行时无影响
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { AccountManager, getLevelAndProgress } from './AccountManager.js';
import { RoomManager } from './RoomManager.js';
import { GameHost } from './GameHost.js';
import { getNonGods, getGods, getHeroById } from '../src/data/heroes.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3457;

// ==================== 全局未处理异常捕获（防止服务器崩溃） ====================
process.on('uncaughtException', (err: Error) => {
  console.error('[系统] 未捕获异常:', err.message);
  console.error(err.stack);
  // 不退出进程，继续运行
});
process.on('unhandledRejection', (reason: any, _promise: Promise<any>) => {
  console.error('[系统] 未处理的 Promise 拒绝:', reason?.message || reason);
  if (reason?.stack) console.error(reason.stack);
  // 不退出进程，继续运行
});

// ==================== 创建服务 ====================
const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8,
});

// Express 错误处理中间件（捕获未处理异常，避免 500 崩溃）
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('[Express] 未处理错误:', err.message || err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ==================== 核心管理器 ====================
const accountManager = new AccountManager();
const roomManager = new RoomManager();
const gameHosts: Map<string, GameHost> = new Map(); // roomId → GameHost

// ==================== 辅助映射 ====================
const tokenToSocket: Map<string, string> = new Map(); // token → socketId
const socketToToken: Map<string, string> = new Map(); // socketId → token
const socketToRoom: Map<string, string> = new Map(); // socketId → roomId

// ==================== Socket.IO 错误处理 ====================
io.engine.on('connection_error', (err: any) => {
  console.error('[Socket.IO] 引擎连接错误:', err.message || err);
});



// ==================== 选将全局状态 ====================
// 存储选将中间状态：{ roomId → { monarchIndex, monarchHeroId? } }
// 模块作用域，供 socket 处理器和 checkAllSelectedAndStart 共用
const heroSelectState = new Map<string, {
  monarchSlotIndex: number;
  monarchHeroId?: string;
}>();

// ==================== Socket.IO 事件处理 ====================

io.on('connection', (socket) => {
  console.log(`[Server] 新连接: ${socket.id}`);

  // ---------- 账号 ----------

  socket.on('signup', (data: { name: string; password: string }) => {
    console.log(`[Server] signup: ${data.name}  (socket: ${socket.id})`);
    const result = accountManager.signup(data.name, data.password);
    console.log(`[Server] signup_result:`, result.success ? '成功' : result.reason);
    socket.emit('signup_result', result);
    if (result.success && result.token) {
      tokenToSocket.set(result.token, socket.id);
      socketToToken.set(socket.id, result.token);
      socket.emit('logged_in', { account: result.account, token: result.token });
    }
  });

  socket.on('login', (data: { name: string; password: string }) => {
    console.log(`[Server] login: ${data.name}  (socket: ${socket.id})`);
    const result = accountManager.login(data.name, data.password);
    console.log(`[Server] login_result:`, result.success ? '成功' : result.reason);
    socket.emit('login_result', result);
    if (result.success && result.token) {
      tokenToSocket.set(result.token, socket.id);
      socketToToken.set(socket.id, result.token);
      socket.emit('logged_in', { account: result.account, token: result.token });
    }
  });

  socket.on('auth_token', (data: { token: string }) => {
    const account = accountManager.validateToken(data.token);
    if (account) {
      tokenToSocket.set(data.token, socket.id);
      socketToToken.set(socket.id, data.token);

      // 检查是否在原位的房间中（重连）
      const found = roomManager.findPlayer(data.token);
      if (found) {
        const hasActiveGame = gameHosts.has(found.roomId);

        // 仅恢复房间等待状态（不自动恢复游戏中的 RemotePlayerDriver）
        // 避免用户刷新页面后被自动拉回旧对局导致新对局异常
        roomManager.reconnect(data.token);
        socketToRoom.set(socket.id, found.roomId);
        socket.join(found.roomId);

        // 如果游戏已开始，暂不恢复 RemotePlayerDriver（防止旧对局事件泄露）
        // 改为通知客户端存在可恢复的游戏，由客户端决定是否恢复

        socket.emit('reconnected', {
          roomId: found.roomId,
          room: roomManager.getRoom(found.roomId),
          hasActiveGame,
        });

        // 广播房间更新
        io.to(found.roomId).emit('room_update', {
          room: roomManager.getRoom(found.roomId),
        });
      }

      socket.emit('logged_in', { account, token: data.token });
    } else {
      socket.emit('auth_failed', { reason: 'token无效' });
    }
  });

  socket.on('logout', () => {
    const token = socketToToken.get(socket.id);
    if (token) {
      accountManager.logout(token);
      tokenToSocket.delete(token);
    }
    socketToToken.delete(socket.id);
    socket.emit('logged_out');
  });

  socket.on('update_profile', (data: { nickname?: string; avatar?: string }) => {
    const token = socketToToken.get(socket.id);
    if (!token) {
      socket.emit('error_msg', { reason: '请先登录' });
      return;
    }
    const result = accountManager.updateProfile(token, data);
    if (result.success) {
      socket.emit('profile_updated', { account: result.account });
    } else {
      socket.emit('error_msg', { reason: result.reason });
    }
  });

  socket.on('get_profile', () => {
    const token = socketToToken.get(socket.id);
    if (!token) {
      socket.emit('error_msg', { reason: '请先登录' });
      return;
    }
    const account = accountManager.validateToken(token);
    if (account) {
      const progress = getLevelAndProgress(account.exp ?? 0);
      socket.emit('profile_data', { account, level: account.level, exp: account.exp, progress });
    }
  });

  // ---------- 房间 ----------

  socket.on('get_room_list', () => {
    socket.emit('room_list', { rooms: roomManager.getRoomList() });
  });

  socket.on('create_room', (data: { roomName: string; password: string | null }) => {
    const token = socketToToken.get(socket.id);
    if (!token) {
      socket.emit('error_msg', { reason: '请先登录' });
      return;
    }
    const account = accountManager.validateToken(token);
    if (!account) {
      socket.emit('error_msg', { reason: 'token无效' });
      return;
    }

    // 检查是否已在其他房间，若有则完全退出（Socket.IO房间 + GameHost + RoomManager）
    const existing = roomManager.findPlayer(token);
    if (existing) {
      socket.leave(existing.roomId);
      socketToRoom.delete(socket.id);
      roomManager.leaveRoom(token);
      // 如果旧房间有正在运行的游戏且已无真人玩家，中止游戏
      const oldHost = gameHosts.get(existing.roomId);
      if (oldHost && !oldHost.hasAnyHumanPlayer()) {
        console.log(`[Server] 创建新房时，旧房间 ${existing.roomId} 无真人玩家，中止游戏`);
        oldHost.abort();
        gameHosts.delete(existing.roomId);
        roomManager.deleteRoom(existing.roomId);
        io.to(existing.roomId).emit('game_over', { roomId: existing.roomId, winner: 'aborted' });
      }
    }

    const roomId = roomManager.createRoom(
      token, account.name, account.id,
      account.avatar || '', account.nickname || account.name,
      data.roomName, data.password || null, 0
    );

    socketToRoom.set(socket.id, roomId);
    socket.join(roomId);

    socket.emit('room_created', {
      roomId,
      room: roomManager.getRoom(roomId),
      isHost: true,
      mySlotIndex: 0,
    });

    // 同步广播房间状态，让等待页获得初始槽位数据
    io.to(roomId).emit('room_update', {
      room: roomManager.getRoom(roomId),
    });
  });

  socket.on('join_room', (data: { roomId: string; password?: string }) => {
    const token = socketToToken.get(socket.id);
    if (!token) {
      socket.emit('error_msg', { reason: '请先登录' });
      return;
    }
    const account = accountManager.validateToken(token);
    if (!account) {
      socket.emit('error_msg', { reason: 'token无效' });
      return;
    }

    // 检查是否已在其他房间
    const existing = roomManager.findPlayer(token);
    if (existing) {
      roomManager.leaveRoom(token);
      socket.leave(existing.roomId);
    }

    const result = roomManager.joinRoom(data.roomId, token, account.name, account.id, account.avatar || '', account.nickname || account.name, data.password);
    if (result.success) {
      socketToRoom.set(socket.id, data.roomId);
      socket.join(data.roomId);

      socket.emit('room_joined', {
        roomId: data.roomId,
        room: roomManager.getRoom(data.roomId),
        mySlotIndex: result.slotIndex,
      });

      // 广播房间更新
      io.to(data.roomId).emit('room_update', {
        room: roomManager.getRoom(data.roomId),
      });
    } else {
      socket.emit('error_msg', { reason: result.reason });
    }
  });

  socket.on('leave_room', () => {
    const token = socketToToken.get(socket.id);
    if (!token) return;

    // 先查找所在房间（leaveRoom 会删除 room，需先获取 roomId）
    const found = roomManager.findPlayer(token);
    const oldRoomId = found?.roomId ?? null;

    const roomId = roomManager.leaveRoom(token);
    // 无论房间是否被删除，都要清理 socket 映射和退出 Socket.IO 房间
    if (oldRoomId) {
      socket.leave(oldRoomId);
    }
    socketToRoom.delete(socket.id);
    socket.emit('room_left');

    if (roomId) {
      // 房间仍存在（还有其他真人），广播更新
      if (roomManager.getRoom(roomId)) {
        io.to(roomId).emit('room_update', {
          room: roomManager.getRoom(roomId),
        });
      }
    } else if (oldRoomId) {
      // 房间已删除（无真人玩家）→ 中止旧 GameHost
      const host = gameHosts.get(oldRoomId);
      if (host && !host.hasAnyHumanPlayer()) {
        console.log(`[Server] 离开房间后，房间 ${oldRoomId} 无真人玩家，中止游戏`);
        host.abort();
        gameHosts.delete(oldRoomId);
        io.to(oldRoomId).emit('game_over', { roomId: oldRoomId, winner: 'aborted' });
      }
    }
  });

  socket.on('toggle_ready', (data: { ready: boolean }) => {
    const token = socketToToken.get(socket.id);
    if (!token) return;

    const found = roomManager.findPlayer(token);
    if (!found) return;

    roomManager.setReady(token, data.ready);

    io.to(found.roomId).emit('room_update', {
      room: roomManager.getRoom(found.roomId),
    });
  });

  socket.on('set_ai_fill', (data: { count: number }) => {
    const token = socketToToken.get(socket.id);
    if (!token) return;

    const ok = roomManager.setAIFill(token, data.count);
    if (!ok) {
      socket.emit('error_msg', { reason: '仅房主可设置AI填充' });
      return;
    }

    const found = roomManager.findPlayer(token);
    if (found) {
      io.to(found.roomId).emit('room_update', {
        room: roomManager.getRoom(found.roomId),
      });
    }
  });

  // ---------- 选将 ----------

  socket.on('start_hero_select', () => {
    const token = socketToToken.get(socket.id);
    if (!token) return;

    const found = roomManager.findPlayer(token);
    if (!found) return;

    const room = roomManager.getRoom(found.roomId);
    if (!room) return;

    // 防止竞态：如果已有活动游戏或选将已进行，拒绝重入
    if (gameHosts.has(found.roomId)) return;
    if (heroSelectState.has(found.roomId)) {
      socket.emit('error_msg', { reason: '选将已在进行中' });
      return;
    }

    // 检查是否是房主
    const hostSlot = room.slots.find(s => s.isHost);
    if (!hostSlot || hostSlot.token !== token) {
      socket.emit('error_msg', { reason: '仅房主可开始选将' });
      return;
    }

    // 检查准备状态
    if (!roomManager.isAllReady(found.roomId)) {
      socket.emit('error_msg', { reason: '所有玩家需准备就绪且凑满8人（含AI）' });
      return;
    }

    // 获取所有真人玩家
    const realSlots = room.slots.filter(s => s.token !== null);
    // 随机确定主公（从所有8个槽位中选择，包含AI；真人+AI合计必为8人）
    const all8Slots = room.slots.slice(0, 8);
    const monarchIdx = Math.floor(Math.random() * all8Slots.length);
    const monarchSlot = all8Slots[monarchIdx];
    console.log(`[Server] 房间 ${found.roomId} 主公: 槽位${monarchSlot.index} ${monarchSlot.token ? '(真人)' : '(AI)'}`);

    // 如果选中的是AI主公，服务器自动为其选将，直接进入非主公选将
    if (!monarchSlot.token) {
      const godsPool = [...getGods()].sort(() => Math.random() - 0.5);
      const nonGodsPool = [...getNonGods()].sort(() => Math.random() - 0.5);
      const aiPick = [...godsPool.slice(0, 3), ...nonGodsPool.slice(0, 3)].sort(() => Math.random() - 0.5)[0];
      const monarchHero = getHeroById(aiPick.id);
      // AI君主直接将heroId写入slot
      monarchSlot.heroId = aiPick.id;
      heroSelectState.set(found.roomId, {
        monarchSlotIndex: monarchSlot.index,
        monarchHeroId: aiPick.id,
      });

      // 广播主公结果
      const broadcastPayload = {
        heroId: aiPick.id,
        heroName: monarchHero?.name || '???',
        heroRegion: monarchHero?.region || '',
        heroElement: monarchHero?.element || '',
        heroMaxHp: monarchHero?.maxHp || 0,
        heroGender: monarchHero?.gender || 'male',
        heroIsGod: monarchHero?.isGod || false,
      };
      for (const slot of realSlots) {
        if (slot.token) {
          const sid = tokenToSocket.get(slot.token);
          if (sid) io.to(sid).emit('hero_select_monarch_picked', broadcastPayload);
        }
      }

      // 为每个非主公真人玩家生成3候选
      const usedIds = new Set<string>([aiPick.id]);
      const allHeroes = [...getNonGods(), ...getGods()].filter(h => !usedIds.has(h.id));
      const shuffled = [...allHeroes].sort(() => Math.random() - 0.5);
      const nonMonarchRealSlots = realSlots.filter(s => s.index !== monarchSlot.index);
      let cursor = 0;
      for (const slot of nonMonarchRealSlots) {
        if (!slot.token) continue;
        const sid = tokenToSocket.get(slot.token);
        if (!sid) continue;
        const pool = shuffled.slice(cursor, cursor + 3);
        cursor += 3;
        if (pool.length === 0) {
          const fallback = [...getNonGods(), ...getGods()].filter(h => !usedIds.has(h.id));
          const fb = fallback.slice(0, 3);
          io.to(sid).emit('hero_select_start', {
            candidates: fb.map(h => h.id),
            timeoutSec: 30,
            isMonarch: false,
            monarchHero: broadcastPayload,
          });
        } else {
          io.to(sid).emit('hero_select_start', {
            candidates: pool.map(h => h.id),
            timeoutSec: 30,
            isMonarch: false,
            monarchHero: broadcastPayload,
          });
        }
      }
      return;
    }

    // 人类主公：发送主公候选
    heroSelectState.set(found.roomId, {
      monarchSlotIndex: monarchSlot.index,
    });

    const gods = [...getGods()].sort(() => Math.random() - 0.5);
    const nonGods = [...getNonGods()].sort(() => Math.random() - 0.5);
    const monarchCandidates = [
      ...gods.slice(0, 3).map(h => h.id),
      ...nonGods.slice(0, 3).map(h => h.id),
    ];

    const monarchSocketId = tokenToSocket.get(monarchSlot.token!);
    if (monarchSocketId) {
      io.to(monarchSocketId).emit('hero_select_start', {
        candidates: monarchCandidates,
        timeoutSec: 30,
        isMonarch: true,
      });
    }

    // 通知其他玩家等待
    for (const slot of realSlots) {
      if (slot !== monarchSlot && slot.token) {
        const sid = tokenToSocket.get(slot.token);
        if (sid) {
          io.to(sid).emit('hero_select_waiting', {
            monarchPlayerName: monarchSlot.accountName || '主公',
            timeoutSec: 30,
          });
        }
      }
    }
  });

  // 主公选将
  socket.on('select_monarch_hero', (data: { heroId: string }) => {
    const token = socketToToken.get(socket.id);
    if (!token) return;

    const found = roomManager.findPlayer(token);
    if (!found) return;

    // 防止竞态：如果游戏已启动，拒绝重入
    if (gameHosts.has(found.roomId)) return;

    const state = heroSelectState.get(found.roomId);
    if (!state) return;

    const room = roomManager.getRoom(found.roomId);
    if (!room) return;

    // 确认是主公
    const monarchSlot = room.slots.find(s => s.index === state.monarchSlotIndex);
    if (!monarchSlot || monarchSlot.token !== token) {
      socket.emit('error_msg', { reason: '只有主公可以选择武将' });
      return;
    }

    // 存储主公选择
    state.monarchHeroId = data.heroId;
    roomManager.setHero(token, data.heroId);

    const monarchHero = getHeroById(data.heroId);
    const realSlots = room.slots.filter(s => s.token !== null);

    // 广播主公选择结果
    for (const slot of realSlots) {
      if (slot.token) {
        const sid = tokenToSocket.get(slot.token);
        if (sid) {
          io.to(sid).emit('hero_select_monarch_picked', {
            heroId: data.heroId,
            heroName: monarchHero?.name || '???',
            heroRegion: monarchHero?.region || '',
            heroElement: monarchHero?.element || '',
            heroMaxHp: monarchHero?.maxHp || 0,
            heroGender: monarchHero?.gender || 'male',
            heroIsGod: monarchHero?.isGod || false,
          });
        }
      }
    }

    // 为每个非主公真人玩家生成3个候选
    const usedIds = new Set<string>([data.heroId]);
    const allNonGods = getNonGods();
    const allGods = getGods();
    const remaining = [...allNonGods, ...allGods].filter(h => !usedIds.has(h.id));

    const nonMonarchRealSlots = realSlots.filter(s => s !== monarchSlot);
    const shuffled = [...remaining].sort(() => Math.random() - 0.5);

    let cursor = 0;
    for (const slot of nonMonarchRealSlots) {
      if (!slot.token) continue;
      const sid = tokenToSocket.get(slot.token);
      if (!sid) continue;

      // 每人3个候选
      const candidates = shuffled.slice(cursor, cursor + 3).map(h => h.id);
      cursor += 3;

      io.to(sid).emit('hero_select_start', {
        candidates,
        timeoutSec: 30,
        isMonarch: false,
        monarchHero: {
          heroId: data.heroId,
          heroName: monarchHero?.name || '???',
          heroRegion: monarchHero?.region || '',
          heroElement: monarchHero?.element || '',
          heroMaxHp: monarchHero?.maxHp || 0,
          heroGender: monarchHero?.gender || 'male',
          heroIsGod: monarchHero?.isGod || false,
        },
      });
    }
    // 主公选完后检查是否所有真人已选好，若是则直接启动（无其他真人时）
    checkAllSelectedAndStart(found.roomId, token);
  });

  socket.on('select_hero', (data: { heroId: string }) => {
    const token = socketToToken.get(socket.id);
    if (!token) return;

    const found = roomManager.findPlayer(token);
    if (!found) return;

    // 防止竞态：如果游戏已对该房间启动，拒绝重复操作
    if (gameHosts.has(found.roomId)) return;

    roomManager.setHero(token, data.heroId);

    // 检查是否所有人都选好了
    checkAllSelectedAndStart(found.roomId, token);
  });

  // ---------- 游戏交互 ----------

  socket.on('prompt_response', (data: { requestId: string; result: any }) => {
    // 由 RemotePlayerDriver 直接监听处理（在 GameHost 中创建）
    // 这里不需要额外处理
  });

  // ---------- PVE 经验值上报 ----------

  socket.on('add_exp', (data: { totalExp: number }, ack?: (result: any) => void) => {
    const token = socketToToken.get(socket.id);
    if (!token) {
      ack?.({ success: false, reason: '未登录' });
      return;
    }
    if (!data || typeof data.totalExp !== 'number' || data.totalExp < 0) {
      ack?.({ success: false, reason: '经验值无效' });
      return;
    }
    const result = accountManager.addExp(token, data.totalExp);
    if (result) {
      ack?.({ success: true, oldLevel: result.oldLevel, newLevel: result.newLevel, totalExp: result.totalExp, leveledUp: result.leveledUp });
    } else {
      ack?.({ success: false, reason: '账号不存在' });
    }
  });

  // ---------- PVE 星级同步 ----------
  socket.on('save_pve_stars', (data: { stars: Record<number, number> }, ack?: (result: any) => void) => {
    const token = socketToToken.get(socket.id);
    if (!token) { ack?.({ success: false, reason: '未登录' }); return; }
    const ok = accountManager.savePVEStars(token, data.stars);
    ack?.({ success: ok });
  });

  // ---------- 设置同步（BGM/语音/AI速度） ----------
  socket.on('save_settings', (data: Record<string, any>, ack?: (result: any) => void) => {
    const token = socketToToken.get(socket.id);
    if (!token) { ack?.({ success: false, reason: '未登录' }); return; }
    const ok = accountManager.saveSettings(token, data);
    ack?.({ success: ok });
  });

  // ---------- 断线 ----------

  socket.on('disconnect', () => {
    console.log(`[Server] 断线: ${socket.id}`);

    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const host = gameHosts.get(roomId);
      if (host) {
        host.handleDisconnect(socket.id);
        // 如果所有人类玩家都已离开，结束游戏并清理房间
        if (!host.hasAnyHumanPlayer()) {
          console.log(`[Server] 房间 ${roomId} 所有人类玩家已离开，结束游戏`);
          host.abort();
          gameHosts.delete(roomId);
          roomManager.deleteRoom(roomId);
          io.to(roomId).emit('game_over', { roomId, winner: 'aborted' });
          return;
        }
      }

      // 标记断开（不掉出房间）
      const token = socketToToken.get(socket.id);
      if (token) {
        roomManager.disconnect(token);
      }

      io.to(roomId).emit('room_update', {
        room: roomManager.getRoom(roomId),
      });
    }
  });
});



// ==================== 选将完成检查 ====================

/** 检查是否所有真人已选好武将，若是则统一启动游戏 */
function checkAllSelectedAndStart(roomId: string, _token: string): void {
  const room = roomManager.getRoom(roomId);
  if (!room) { console.log('[DEBUG:select] room not found:', roomId); return; }

  const realSlots = room.slots.filter(s => s.token !== null);
  const selectedSlots = realSlots.filter(s => s.heroId);
  const heroSummary = realSlots.map(s => `${s.accountName || '?'}:${s.heroId || 'none'}`).join(',');
  console.log(`[DEBUG:select] room=${roomId} slots=${realSlots.length} selected=${selectedSlots.length} heroes=[${heroSummary}]`);
  const allSelected = realSlots.every(s => s.heroId);
  if (!allSelected) { console.log('[DEBUG:select] NOT all selected, waiting...'); return; }

  const selectState = heroSelectState.get(roomId);
  if (!selectState) {
    // 选将状态已被并发请求清空，忽略此次重复触发
    console.warn(`[Server] select_hero 重复触发被忽略: room=${roomId}`);
    return;
  }

  const monarchSlotIndex = selectState.monarchSlotIndex;
  heroSelectState.delete(roomId);

  // 广播选将结果
  io.to(roomId).emit('hero_select_result', {
    picks: realSlots.map(s => ({ slotIndex: s.index, heroId: s.heroId, name: s.accountName })),
  });

  // 启动游戏（带错误处理）
  startGameForRoom(roomId, monarchSlotIndex).catch(err => {
    console.error(`[Server] 启动游戏失败(${roomId}):`, err?.message || err);
    io.to(roomId).emit('game_over', { roomId, error: String(err?.message || err) });
  });
}

// ==================== 启动游戏 ====================

async function startGameForRoom(roomId: string, monarchSlotIndex?: number): Promise<void> {
  // 防御性检查：禁止对已有 GameHost 的房间重复启动游戏（防止竞态条件）
  if (gameHosts.has(roomId)) {
    console.warn(`[startGameForRoom] 房间 ${roomId} 已有活动游戏，忽略重复启动`);
    return;
  }
  if (monarchSlotIndex === undefined) {
    console.error(`[startGameForRoom] 房间 ${roomId} monarchSlotIndex 为 undefined，回退到随机分配身份`);
  }
  try {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    // 收集未分配的非神英雄给AI（排除已有heroId的AI，如AI主公）
    const usedHeroIds = new Set<string>();
    let aiAlreadyHasHero = 0;
    for (const slot of room.slots) {
      if (slot.heroId) {
        usedHeroIds.add(slot.heroId);
        // 统计已有heroId的AI数量（选将阶段确定的AI主公等）
        if (!slot.token) aiAlreadyHasHero++;
      }
    }

    const availableForAI = [...getNonGods()].filter(h => !usedHeroIds.has(h.id)).sort(() => Math.random() - 0.5);
    const neededAiCount = room.aiFill - aiAlreadyHasHero;
    const aiHeroIds = availableForAI.slice(0, neededAiCount).map(h => h.id);

    // 构建真人玩家的 accountMap（token → account），使 GameHost 能正确显示玩家名
    const accountMap = new Map<string, Omit<import('./AccountManager.js').Account, 'passwordHash'>>();
    for (const slot of room.slots) {
      if (slot.token) {
        const acct = accountManager.validateToken(slot.token);
        if (acct) accountMap.set(slot.token, acct);
      }
    }

    // 创建 GameHost
    const host = new GameHost(
      roomId,
      io,
      room.slots,
      room.aiFill,
      accountMap,
      tokenToSocket,
    );

    gameHosts.set(roomId, host);
    await host.initGame(aiHeroIds);

    // 根据君主槽位索引设置游戏中的主公角色
    // monarchSlotIndex 是 room.slots 中的槽位索引 (0-7)
    // GameHost 内部会通过 playerSlotMap 映射到正确的 playerId
    if (monarchSlotIndex !== undefined) {
      host.setMonarchPlayerId(monarchSlotIndex);
      console.log(`[GameHost] 主公: 槽位=${monarchSlotIndex}`);
    }

    // 通知每个真人玩家游戏开始（按视角脱敏发送玩家列表）
    console.log(`[DEBUG:game_start] 准备发送game_start，room=${roomId}, slots=${room.slots.length}, gameHost已创建`);
    for (const slot of room.slots) {
      if (slot.token) {
        const socketId = tokenToSocket.get(slot.token);
        if (socketId) {
          const playerId = host.getPlayerIdForSocketId(socketId);
          if (playerId !== undefined) {
            const sanitizedPlayers = host.getSanitizedPlayers(playerId);
            io.to(socketId).emit('game_start', {
              roomId,
              players: sanitizedPlayers,
              yourPlayerId: playerId,
              drawPileCount: host.deckPileCount,
            });
          }
        }
      }
    }

    // 启动游戏循环（异步，不阻塞）
    host.start().then(() => {
      console.log(`[GameHost] 房间 ${roomId} 游戏结束，胜利方: ${host.winner || '未知'}`);

      // 中途退出/非正常结束不计算经验
      if (host.winner === 'aborted' || !host.winner) {
        console.log(`[GameHost] 房间 ${roomId} 非正常结束，跳过经验计算`);
        return;
      }

      // 计算经验值并更新账号（逃跑玩家跳过写库）
      const expList = host.computeExpForAllPlayers();
      const resultData = host.getGameResultData();
      // 调试日志
      if (resultData) console.log(`[GameHost] 经验计算: ${resultData.players.map(p => `${p.name}(tk=${p.token?.substring(0,6)||'null'},ai=${p.isAI})`).join(', ')}`);
      const escapedSet = new Set(resultData?.escapedPlayerIds ?? []);
      let expByPlayerId: Record<number, { baseExp: number; bonusExp: number; totalExp: number; oldLevel: number; newLevel: number; leveledUp: boolean; escaped: boolean }> = {};
      if (expList && resultData) {
        for (const exp of expList) {
          const player = resultData.players.find(p => p.playerId === exp.playerId);
          if (player && player.token && !player.isAI) {
            if (exp.escaped) {
              // 逃跑者：下发 0 经验但不写入数据库
              expByPlayerId[exp.playerId] = {
                baseExp: 0,
                bonusExp: 0,
                totalExp: 0,
                oldLevel: 0,
                newLevel: 0,
                leveledUp: false,
                escaped: true,
              };
            } else {
              // 优先用 accountId 直接加经验（避免 token 在 tokens map 中过期找不到）
              const result = (player.accountId
                ? accountManager.addExpByAccountId(player.accountId, exp.totalExp)
                : accountManager.addExp(player.token, exp.totalExp));
              if (result) {
                expByPlayerId[exp.playerId] = {
                  baseExp: exp.baseExp,
                  bonusExp: exp.bonusExp,
                  totalExp: result.totalExp,  // 账号累积总量（非本局增量）
                  oldLevel: result.oldLevel,
                  newLevel: result.newLevel,
                  leveledUp: result.leveledUp,
                  escaped: false,
                };
              }
            }
          }
        }
      }

      // 收集所有玩家的真实身份（游戏结束，身份全部公开）
      const playerRoles: Record<number, string> = {};
      if (resultData) {
        for (const p of resultData.players) {
          playerRoles[p.playerId] = p.role;
        }
      }

      io.to(roomId).emit('game_over', {
        roomId,
        winner: host.winner,
        killStats: resultData?.killStats ?? {},
        expByPlayerId,
        escapedPlayerIds: resultData?.escapedPlayerIds ?? [],
        playerRoles,
      });
      gameHosts.delete(roomId);
      roomManager.deleteRoom(roomId);
    }).catch(err => {
      console.error(`[GameHost] 房间 ${roomId} 游戏异常:`, err);
      io.to(roomId).emit('game_over', { roomId, error: String(err) });
      gameHosts.delete(roomId);
      roomManager.deleteRoom(roomId);
    });
  } catch (err: any) {
    console.error(`[startGameForRoom] 房间 ${roomId} 初始化失败:`, err?.message || err);
    console.error(err?.stack);
    io.to(roomId).emit('game_over', { roomId, error: String(err?.message || err) });
    gameHosts.delete(roomId);
    roomManager.deleteRoom(roomId);
  }
}

// ==================== HTTP API ====================

app.get('/api/health', (_req: any, res: any) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ==================== 启动 ====================

httpServer.listen(PORT, () => {
  console.log('========================================');
  console.log(`  原神杀 PVP 服务器已启动`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log('========================================');
});
