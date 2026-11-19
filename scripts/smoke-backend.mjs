import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

// Use a disposable database: this creates an account and exercises both live services.
const base = (process.env.ACCOUNT_API_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const game = process.env.GAME_SERVER_URL || 'http://127.0.0.1:3457';
const sockets = [];
const timeout = 10000;
async function http(path, { token, key, method = 'GET', body } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'X-Game-Service-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
  return { status: response.status, data: await response.json() };
}
function wait(socket, name, accept = () => true) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); socket.off(name, ok); socket.off('disconnect', disconnected); };
    const ok = data => { if (!accept(data)) return; clean(); resolve(data); };
    const disconnected = () => { clean(); reject(new Error(`${name}: disconnected`)); };
    const timer = setTimeout(() => { clean(); reject(new Error(`${name}: timeout`)); }, timeout);
    socket.on(name, ok); socket.once('disconnect', disconnected);
  });
}
async function connect() {
  const socket = io(game, { transports: ['websocket'], autoConnect: false, reconnection: false, timeout });
  sockets.push(socket);
  const ready = wait(socket, 'connect'); socket.connect(); await ready; return socket;
}
function event(socket, name, data, response) {
  const ready = wait(socket, response); socket.emit(name, data); return ready;
}
function assertPublicRoom(room, expectedHumans) {
  assert.ok(room?.hasPassword);
  assert.equal(Object.hasOwn(room, 'password'), false);
  assert.equal(room.slots.filter(slot => slot.occupied).length, expectedHumans);
  assert.ok(room.slots.every(slot => typeof slot.occupied === 'boolean' && !Object.hasOwn(slot, 'token')));
}
try {
  assert.equal((await http('/api/health')).data.status, 'ok');
  assert.equal((await http('/api/account')).status, 401);
  const socket = await connect();
  const name = `s${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const password = `Smoke-${randomUUID()}`;
  const signupReady = wait(socket, 'signup_result'); const sessionReady = wait(socket, 'logged_in');
  socket.emit('signup', { name, password });
  const [signup, session] = await Promise.all([signupReady, sessionReady]);
  assert.equal(signup.success, true); assert.ok(session.token && session.account?.id);
  assert.equal(Object.hasOwn(session.account, 'passwordHash'), false);
  const token = session.token;
  const profile = await event(socket, 'update_profile', { nickname: 'SmokeTester', avatar: '' }, 'profile_updated');
  assert.equal(profile.account.nickname, 'SmokeTester');
  assert.equal((await socket.timeout(timeout).emitWithAck('save_settings', { bgmVolume: 40 })).success, true);
  assert.equal((await socket.timeout(timeout).emitWithAck('save_settings', { aiDelay: 200 })).success, true);
  assert.equal((await socket.timeout(timeout).emitWithAck('save_pve_stars', { stars: { 1: 3 } })).success, true);
  assert.equal((await socket.timeout(timeout).emitWithAck('save_pve_stars', { stars: { 1: 1, 2: 2 } })).success, true);
  assert.equal((await socket.timeout(timeout).emitWithAck('save_pve_stars', { stars: { 1: 4 } })).success, false);
  const reward = await socket.timeout(timeout).emitWithAck('add_exp', { totalExp: 20 });
  assert.equal(reward.success, true); assert.equal(reward.totalExp, 20);
  const stored = (await http('/api/account', { token })).data.account;
  assert.equal(stored.nickname, 'SmokeTester'); assert.equal(stored.settings.bgmVolume, 40);
  assert.equal(stored.settings.aiDelay, 200); assert.equal(stored.pveStars['1'], 3); assert.equal(stored.pveStars['2'], 2);
  console.log('PASS: signup, profile, merged settings, monotonic stars and PVE reward');
  const roomPassword = `SmokeRoom-${randomUUID()}`;
  const created = await event(socket, 'create_room', { roomName: 'SmokeRoom', password: roomPassword }, 'room_created');
  assert.ok(created.roomId && created.isHost);
  assertPublicRoom(created.room, 1);
  socket.disconnect();
  const resumedSocket = await connect();
  const resumedReady = wait(resumedSocket, 'logged_in'); const roomReady = wait(resumedSocket, 'reconnected');
  resumedSocket.emit('auth_token', { token });
  const [resumed, room] = await Promise.all([resumedReady, roomReady]);
  assert.equal(resumed.account.id, session.account.id); assert.equal(room.roomId, created.roomId);
  assertPublicRoom(room.room, 1);
  const retrieved = await event(resumedSocket, 'get_profile', undefined, 'profile_data');
  assert.equal(retrieved.account.exp, 20);
  console.log('PASS: room creation and token-based reconnect');
  const anonymous = await connect();
  assert.ok((await event(anonymous, 'create_room', { roomName: 'forbidden' }, 'error_msg')).reason);
  const path = `/internal/accounts/${encodeURIComponent(session.account.id)}/pvp-result`;
  const body = { amount: 50, role: 'Rebel', won: true, operationId: `smoke-${randomUUID()}` };
  assert.ok([401, 403].includes((await http(path, { method: 'POST', body })).status));
  if (process.env.GAME_SERVICE_KEY) {
    const options = { method: 'POST', key: process.env.GAME_SERVICE_KEY, body };
    const first = await http(path, options); const replay = await http(path, options);
    assert.equal(first.status, 200); assert.equal(first.data.totalExp, 70); assert.deepEqual(replay.data, first.data);
    const after = (await http('/api/account', { token })).data.account;
    assert.equal(after.exp, 70); assert.equal(after.stats.totalGames, 1); assert.equal(after.stats.totalWins, 1);
    assert.equal(after.stats.rebel.games, 1);
    console.log('PASS: protected PVP settlement, idempotency and statistics');
  } else console.log('SKIP: authorized PVP settlement (GAME_SERVICE_KEY is not set)');
  // Exercise the actual game startup path, including Java account reads for both slots.
  const peer = await connect();
  const peerLogin = wait(peer, 'logged_in');
  peer.emit('signup', { name: `p${randomUUID().replaceAll('-', '').slice(0, 10)}`, password });
  await peerLogin;
  const rejected = await event(peer, 'join_room', { roomId: created.roomId, password: 'wrong-password' }, 'error_msg');
  assert.equal(rejected.reason, '密码错误');
  const joined = await event(peer, 'join_room', { roomId: created.roomId, password: roomPassword }, 'room_joined');
  assertPublicRoom(joined.room, 2);
  assert.ok(joined.room.slots.find(slot => slot.index === joined.mySlotIndex)?.occupied);
  const updated = await event(resumedSocket, 'set_ai_fill', { count: 6 }, 'room_update');
  assertPublicRoom(updated.room, 2);
  const readyRoom = wait(resumedSocket, 'room_update', data => {
    const humans = data.room.slots.filter(slot => slot.occupied);
    return data.room.aiFill === 6 && humans.length === 2 && humans.every(slot => slot.ready);
  });
  resumedSocket.emit('toggle_ready', { ready: true });
  peer.emit('toggle_ready', { ready: true });
  await readyRoom;
  const players = [resumedSocket, peer];
  const chooseHero = players.map(client => {
    const handler = data => client.emit(data.isMonarch ? 'select_monarch_hero' : 'select_hero', { heroId: data.candidates[0] });
    client.on('hero_select_start', handler);
    return () => client.off('hero_select_start', handler);
  });
  const started = Promise.all(players.map(client => wait(client, 'game_start')));
  const assigned = Promise.all(players.map(client => wait(client, 'game_event', data => data.type === 'RolesAssigned')));
  resumedSocket.emit('start_hero_select');
  const [starts, assignments] = await Promise.all([started, assigned]);
  for (const [index, start] of starts.entries()) {
    assert.equal(start.players.length, 8);
    assert.equal(start.players.filter(player => player.role === 'Monarch').length, 1);
    const snapshot = assignments[index].data.players;
    assert.equal(snapshot.length, 8);
    const self = snapshot.find(player => player.id === start.yourPlayerId);
    assert.ok(['Monarch', 'Minister', 'Rebel', 'Traitor'].includes(self?.role));
    const monarch = start.players.find(player => player.role === 'Monarch');
    assert.equal(snapshot.find(player => player.id === monarch.id)?.role, 'Monarch');
    for (const player of [...start.players, ...snapshot]) {
      if (player.id !== start.yourPlayerId && player.id !== monarch.id) {
        assert.equal(player.role, 'Unknown', 'A living opponent’s role must be hidden from this client');
      }
    }
  }
  chooseHero.forEach(cleanup => cleanup());
  await event(peer, 'leave_room', undefined, 'room_left');
  await event(resumedSocket, 'leave_room', undefined, 'room_left');
  await event(peer, 'logout', undefined, 'logged_out');
  console.log('PASS: two-human/six-AI selection, per-client PVP role visibility and match cleanup');
  await event(resumedSocket, 'logout', undefined, 'logged_out');
  assert.equal((await http('/api/account', { token })).status, 401);
  await event(anonymous, 'auth_token', { token }, 'auth_failed');
  const rooms = await event(anonymous, 'get_room_list', undefined, 'room_list');
  assert.ok(!rooms.rooms.some(item => item.id === created.roomId));
  assert.equal((await event(anonymous, 'login', { name, password: 'wrong-password' }, 'login_result')).success, false);
  const loginReady = wait(anonymous, 'login_result'); const reloginReady = wait(anonymous, 'logged_in');
  anonymous.emit('login', { name, password });
  const [login, relogin] = await Promise.all([loginReady, reloginReady]);
  assert.equal(login.success, true); assert.equal(relogin.account.nickname, 'SmokeTester');
  await event(anonymous, 'logout', undefined, 'logged_out');
  console.log('PASS: anonymous rejection, logout revocation and password login');
  console.log('Backend smoke test passed.');
} catch (error) {
  // Avoid printing response bodies containing session credentials.
  console.error(`Backend smoke test failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally { sockets.forEach(socket => socket.disconnect()); }
