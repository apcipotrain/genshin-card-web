import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PvpSettlementQueue, type PendingSettlement } from '../server/PvpSettlementQueue.js';

const entry: PendingSettlement = { accountId: 'alice', operationId: 'match-1', amount: 50, role: 'Rebel', won: true };
const reward = { success: true, oldLevel: 1, newLevel: 1, totalExp: 50, leveledUp: false };

test('failed settlements survive restart and are removed only after confirmation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pvp-settlement-'));
  try {
    const file = join(dir, 'queue.json');
    const first = new PvpSettlementQueue(file, async () => { throw new Error('offline'); });
    first.enqueue([entry]);
    assert.equal(await first.attempt(entry), null);
    assert.equal(first.size, 1);
    const sent: PendingSettlement[] = [];
    const restarted = new PvpSettlementQueue(file, async item => { sent.push(item); return reward; });
    await restarted.flush();
    assert.deepEqual(sent, [entry]);
    assert.equal(restarted.size, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('background retry and foreground settlement share one request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pvp-settlement-'));
  try {
    let resolve!: (value: typeof reward) => void;
    let requests = 0;
    const queue = new PvpSettlementQueue(join(dir, 'queue.json'), () => {
      requests++;
      return new Promise(done => { resolve = done; });
    });
    queue.enqueue([entry]);
    const first = queue.attempt(entry);
    const second = queue.attempt(entry);
    assert.equal(requests, 1);
    resolve(reward);
    assert.deepEqual(await Promise.all([first, second]), [reward, reward]);
    assert.equal(queue.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
