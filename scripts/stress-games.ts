import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GameHost } from '../server/GameHost';
import { AIDriver } from '../src/ai/AIDriver';
import { ALL_HEROES } from '../src/data/heroes';
import { GameEvent } from '../src/core/types';

const count = Math.max(1, Math.min(200, Number(process.argv[2]) || 30));
const seeds = process.argv[3] ? process.argv[3].split(',').map(Number) : Array.from({ length: count }, (_, index) => index + 1);
const budgetMs = Math.max(1000, Math.min(60000, Number(process.argv[4]) || 8000));
const output = resolve(process.argv[5] || (process.argv[3] ? '.cache/ui-review/stress-rerun.json' : '.cache/ui-review/stress-results.json'));
const log = console.log.bind(console);
const originalRandom = Math.random;
let recent: string[] = [];
console.log = (...args) => { recent.push(args.map(String).join(' ')); if (recent.length > 45) recent.shift(); };
const results: any[] = [];
mkdirSync(resolve('.cache/ui-review'), { recursive: true });
try {
  for (const seed of seeds) {
    const beganAt = performance.now();
    let randomState = seed;
    Math.random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
    const heroes = [...ALL_HEROES];
    for (let i = heroes.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [heroes[i], heroes[j]] = [heroes[j], heroes[i]]; }
    const heroIds = heroes.slice(0, 8).map(hero => hero.id);
    const io = { sockets: { sockets: new Map() }, to: () => ({ emit() {} }) };
    const host = new GameHost(`stress-${seed}`, io as any,
      heroIds.map((heroId, index) => ({ index, token: null, heroId })) as any, 8, new Map(), new Map());
    let turns = 0; let aborted: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    recent = [];
    try {
      await host.initGame([]);
      const internals = host as any;
      for (const player of internals.players) internals.drivers.set(player.id, new AIDriver(player.id));
      internals.flowController.turnDelayMs = 0;
      internals.flowController.aiActionDelayMs = 0;
      host.setMonarchPlayerId(seed % 8);
      internals.eventBus.on(GameEvent.Log, (event: any) => { recent.push(String(event.data.message)); if (recent.length > 45) recent.shift(); });
      internals.eventBus.on(GameEvent.TurnStarted, () => { if (++turns > 400) { aborted = 'turn_limit'; host.abort(); } });
      timeout = setTimeout(() => { aborted = 'time_limit'; host.abort(); }, budgetMs);
      await host.start();
      results.push({ seed, heroIds, turns, elapsedMs: Math.round(performance.now() - beganAt), status: aborted || 'finished', winner: host.winner,
        ...(aborted ? { recent: [...recent] } : {}) });
    } catch (error) {
      results.push({ seed, heroIds, turns, status: 'error', error: error instanceof Error ? error.stack : String(error), recent: [...recent] });
    } finally { if (timeout) clearTimeout(timeout); host.abort(); }
    writeFileSync(output, JSON.stringify({ games: results.length, results }, null, 2));
    if (results.length % 5 === 0 || results.length === seeds.length || process.argv[3]) log(`Checked ${results.length}/${seeds.length}: finished=${results.filter(r => r.status === 'finished').length}, errors=${results.filter(r => r.status === 'error').length}, limits=${results.filter(r => r.status.endsWith('limit')).length}`);
  }
} finally { console.log = log; Math.random = originalRandom; }
log(`Saved deterministic simulation results: ${output}`);
if (results.some(result => result.status === 'error')) process.exitCode = 1;
