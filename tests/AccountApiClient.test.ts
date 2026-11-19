import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AccountApiClient } from '../server/AccountApiClient.js';

const account = { id: 'account-1', name: 'alice', nickname: 'Alice', avatar: '', level: 1, exp: 0, createdAt: 1 };
async function fixture(handler: (request: IncomingMessage, response: ServerResponse, body: any) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    response.setHeader('Content-Type', 'application/json');
    handler(request, response, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    client: new AccountApiClient(`http://127.0.0.1:${port}/`, 'test-service-key'),
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    }),
  };
}

test('adapter requires an internal credential and an HTTP service URL', () => {
  assert.throws(() => new AccountApiClient('http://localhost:8080', '  '), /GAME_SERVICE_KEY/);
  assert.throws(() => new AccountApiClient('file:///accounts.json', 'key'), /HTTP/);
});

test('public account operations use bearer authentication without leaking the server credential', async () => {
  const calls: Array<{ path: string; method: string; token: string | undefined; body: any }> = [];
  const server = await fixture((request, response, body) => {
    assert.equal(request.headers['x-game-service-key'], undefined);
    calls.push({ path: request.url!, method: request.method!, token: request.headers.authorization, body });
    response.end(JSON.stringify(request.url === '/api/health' ? { status: 'ok' } : { success: true, account, token: 'user-session' }));
  });
  try {
    assert.equal(await server.client.health(), true);
    assert.equal((await server.client.signup('alice', 'password')).success, true);
    assert.equal((await server.client.login('alice', 'password')).token, 'user-session');
    assert.deepEqual(await server.client.validateToken('user-session'), account);
    assert.equal((await server.client.updateProfile('user-session', { nickname: 'Traveler' })).success, true);
    assert.equal(await server.client.saveSettings('user-session', { bgmVolume: 40 }), true);
    assert.equal(await server.client.savePVEStars('user-session', { 1: 3 }), true);
    await server.client.logout('user-session');
    assert.deepEqual(calls, [
      { path: '/api/health', method: 'GET', token: undefined, body: undefined },
      { path: '/api/auth/signup', method: 'POST', token: undefined, body: { name: 'alice', password: 'password' } },
      { path: '/api/auth/login', method: 'POST', token: undefined, body: { name: 'alice', password: 'password' } },
      { path: '/api/account', method: 'GET', token: 'Bearer user-session', body: undefined },
      { path: '/api/account/profile', method: 'PATCH', token: 'Bearer user-session', body: { nickname: 'Traveler' } },
      { path: '/api/account/settings', method: 'PUT', token: 'Bearer user-session', body: { bgmVolume: 40 } },
      { path: '/api/account/pve-stars', method: 'PUT', token: 'Bearer user-session', body: { stars: { 1: 3 } } },
      { path: '/api/auth/logout', method: 'POST', token: 'Bearer user-session', body: undefined },
    ]);
  } finally { await server.close(); }
});

test('expired sessions and business failures do not issue unauthorized rewards', async () => {
  let calls = 0;
  const server = await fixture((request, response) => {
    calls++; response.statusCode = request.url === '/api/account' ? 401 : 409;
    response.end(JSON.stringify({ success: false, reason: 'invalid account or session' }));
  });
  try {
    assert.equal(await server.client.validateToken(''), null); assert.equal(calls, 0);
    assert.equal(await server.client.validateToken('expired'), null);
    assert.equal((await server.client.signup('duplicate', 'password')).success, false);
    assert.equal(await server.client.saveSettings('expired', {}), false);
    assert.equal(await server.client.addExp('expired', 20, 'operation-1'), null);
    assert.equal(calls, 4, 'an expired bearer must not reach an internal reward endpoint');
  } finally { await server.close(); }
});

test('internal settlements use the server credential and preserve the operation identifier', async () => {
  const expected = { success: true, oldLevel: 1, newLevel: 2, totalExp: 100, leveledUp: true };
  const calls: Array<{ path: string; body: any }> = [];
  const server = await fixture((request, response, body) => {
    if (request.url === '/api/account') {
      assert.equal(request.headers.authorization, 'Bearer user-session');
      assert.equal(request.headers['x-game-service-key'], undefined);
      response.end(JSON.stringify({ success: true, account })); return;
    }
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['x-game-service-key'], 'test-service-key');
    calls.push({ path: request.url!, body }); response.end(JSON.stringify(expected));
  });
  try {
    assert.deepEqual(await server.client.addExp('user-session', 100, 'pve-1'), expected);
    assert.deepEqual(await server.client.settlePVP('account/encoded', 100, 'Rebel', true, 'match-1'), expected);
    assert.deepEqual(calls, [
      { path: '/internal/accounts/account-1/exp', body: { amount: 100, operationId: 'pve-1' } },
      { path: '/internal/accounts/account%2Fencoded/pvp-result', body: { amount: 100, role: 'Rebel', won: true, operationId: 'match-1' } },
    ]);
  } finally { await server.close(); }
});

test('service outages, deadlines and rejected settlements are visible to the caller', async () => {
  const server = await fixture((_request, response) => {
    response.statusCode = 503; response.end(JSON.stringify({ success: false, reason: 'unavailable' }));
  });
  try {
    await assert.rejects(server.client.health(), /503/);
    await assert.rejects(server.client.validateToken('session'), /503/);
  } finally { await server.close(); }
  const rejecting = new AccountApiClient('http://unused.test', 'key', async (_input, options) => {
    assert.ok(options?.signal, 'requests must carry a cancellation deadline');
    return new Response(JSON.stringify({ success: false, reason: 'invalid settlement' }), { status: 400 });
  });
  await assert.rejects(rejecting.settlePVP('id', 1, 'Rebel', true, 'match'));
  const offline = new AccountApiClient('http://unused.test', 'key', async () => { throw new Error('offline'); });
  await assert.rejects(offline.login('alice', 'password'), /offline/);
});
