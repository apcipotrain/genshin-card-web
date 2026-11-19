import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { ChatService, registerChat } from '../server/ChatService.js';

test('ordering, retry idempotency, validation, rate limit and cleanup', async () => {
  const rooms = new Set(['A', 'B']);
  const service = new ChatService(id => rooms.has(id));
  const member = { roomId: 'A', accountId: 'alice', name: '旅行者' };
  const send = (clientId: string, text: unknown = '你好', roomId = 'A') => service.send(member, { roomId, clientId, text }, 1000);
  assert.equal(send('cross', '秘密', 'B').success, false);
  assert.equal(send('empty', ' \n ').success, false);
  assert.equal(send('long', '字'.repeat(201)).success, false);
  assert.equal(send('object', {}).success, false);
  const result = send('first', '<script>alert(1)</script>');
  assert.ok(result.success);
  assert.deepEqual(send('first', '重试内容'), { ...result, duplicate: true });
  await Promise.all(Array.from({ length: 4 }, (_, i) => Promise.resolve().then(() => send(`parallel-${i}`))));
  assert.deepEqual(service.history('A').map(m => m.sequence), [1, 2, 3, 4, 5]);
  assert.equal(send('limited').success, false);
  assert.deepEqual(service.history('B'), []);
  assert.equal(service.send(member, { roomId: 'A', clientId: 'later', text: '稍后' }, 12000).success, true);
  for (let i = 0; i < 120; i++) service.send(member, { roomId: 'A', clientId: `history-${i}`, text: '记录' }, 30000 + i * 11000);
  assert.equal(service.history('A').length, 100);
  rooms.delete('A');
  assert.deepEqual(service.history('A'), []);
  assert.equal(send('closed').success, false);
});

test('real sockets: broadcast, isolation, retry and denied membership', { timeout: 10000 }, async () => {
  const http = createServer();
  const io = new Server(http);
  const service = new ChatService(() => true);
  io.on('connection', socket => {
    const roomId = socket.handshake.auth.room;
    socket.join(roomId);
    registerChat(socket, io, service, () => socket.handshake.auth.denied ? null : { roomId, accountId: socket.id, name: '旅伴' });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const clients = ['A', 'A', 'B', 'A'].map((room, i) => connect(`http://127.0.0.1:${port}`, { auth: { room, denied: i === 3 }, transports: ['websocket'] }));
  try {
    await Promise.all(clients.map(c => new Promise<void>(resolve => c.on('connect', resolve))));
    const received: any[][] = clients.map(() => []);
    clients.forEach((c, i) => c.on('chat_message', m => received[i].push(m)));
    const first = await clients[0].timeout(1000).emitWithAck('chat_send', { roomId: 'A', clientId: 'one', text: '一起旅行' });
    assert.ok(first.success);
    const history = await clients[1].timeout(1000).emitWithAck('chat_history', { roomId: 'A' });
    assert.equal(history.messages[0].text, '一起旅行');
    const retry = await clients[0].timeout(1000).emitWithAck('chat_send', { roomId: 'A', clientId: 'one', text: '一起旅行' });
    assert.equal(retry.message.id, first.message.id);
    assert.equal(retry.duplicate, true);
    assert.equal(received[0].length, 1);
    assert.equal(received[1].length, 1);
    assert.equal(received[2].length, 0);
    const denied = await clients[3].timeout(1000).emitWithAck('chat_send', { roomId: 'A', clientId: 'forged', text: '冒充' });
    assert.equal(denied.success, false);
    const cross = await clients[2].timeout(1000).emitWithAck('chat_history', { roomId: 'A' });
    assert.equal(cross.success, false);
  } finally {
    clients.forEach(c => c.disconnect());
    await new Promise<void>(resolve => io.close(() => resolve()));
  }
});
