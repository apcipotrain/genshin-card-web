import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { GameSession, GameSessionCancelled } from '../src/core/GameSession';
import { RemotePlayerDriver } from '../server/RemotePlayerDriver';
import { GameHost } from '../server/GameHost';
import { ALL_HEROES } from '../src/data/heroes';
import { createPlayer } from '../src/core/Player';
import { AIDriver } from '../src/ai/AIDriver';
import { DelayedAIDriver } from '../src/ai/DelayedAIDriver';
import { createCard } from '../src/core/Card';
import { CardEffectManager } from '../src/core/CardEffectManager';
import { DamageSystem } from '../src/core/DamageSystem';
import { DeckManager } from '../src/core/DeckManager';
import { EquipEffectManager } from '../src/core/EquipEffectManager';
import { EventBus } from '../src/core/EventBus';
import { SkillManager } from '../src/core/skills/SkillManager';
import { EquipmentType, Faction, GameEvent, GenderType, RoleType } from '../src/core/types';
import { CARD_DATA } from '../src/data/CardData';

test('disposing a match cancels pending input and AI delay', async () => {
  const session = new GameSession();
  const input = session.wait(() => {});
  const delay = session.delay(60_000);
  session.dispose();
  await assert.rejects(input, GameSessionCancelled);
  await assert.rejects(delay, GameSessionCancelled);
  assert.throws(() => session.assertActive(), GameSessionCancelled);
});

test('cleanup is idempotent, including synchronous Promise settlement', async () => {
  const session = new GameSession();
  let cleaned = 0;
  assert.equal(await session.wait<number>(resolve => {
    resolve(42);
    return () => { cleaned++; };
  }), 42);
  session.dispose();
  session.dispose();
  assert.equal(cleaned, 1);
  await assert.rejects(session.delay(1), GameSessionCancelled);
});

test('old match timers cannot alter a new match', async () => {
  const oldMatch = new GameSession();
  const page = { round: 1 };
  oldMatch.setTimeout(() => { page.round = 99; }, 10);
  oldMatch.setInterval(() => { page.round++; }, 10);
  oldMatch.dispose();
  const nextMatch = new GameSession();
  await nextMatch.delay(35);
  assert.equal(page.round, 1);
  nextMatch.dispose();
});

test('a settled input unregisters its cancellation cleanup', async () => {
  const session = new GameSession();
  let cleaned = 0;
  let answer!: (value: number) => void;
  const input = session.wait<number>(resolve => {
    answer = resolve;
    return () => { cleaned++; };
  });
  answer(3);
  assert.equal(await input, 3);
  session.dispose();
  assert.equal(cleaned, 1);
});

class FakeSocket extends EventEmitter {
  id = 'test-socket';
  prompts: any[] = [];
  override emit(event: string, ...args: any[]): boolean {
    if (event === 'prompt') this.prompts.push(args[0]);
    return super.emit(event, ...args);
  }
}

test('PVP prompts hide opponents’ roles until their death is confirmed', async () => {
  const socket = new FakeSocket();
  const driver = new RemotePlayerDriver(0, socket as any);
  const roles = [RoleType.Rebel, RoleType.Monarch, RoleType.Traitor, RoleType.Minister];
  const players = roles.map((role, id) => {
    const player = createPlayer(id, `玩家${id}`, 'venti', '温迪', GenderType.Male, 4, '蒙德');
    player.role = role;
    return player;
  });
  players[2].hp = 0; // 濒死时仍有机会获救。
  players[3].isDead = true;
  const choice = driver.promptPlayCard(players[0], {
    players,
    roundCount: 1,
    currentTurn: 1,
    currentPlayerId: 0,
    gameOverWinner: null,
    drawPileCount: 120,
    discardPileCount: 0,
  });
  try {
    const prompt = socket.prompts[0];
    assert.equal(prompt.data.state.role, RoleType.Rebel);
    assert.deepEqual(prompt.data.ctx.players.map((player: { role: string }) => player.role),
      [RoleType.Rebel, RoleType.Monarch, 'Unknown', RoleType.Minister]);
    assert.equal(players[2].role, RoleType.Traitor);
    socket.emit('prompt_response', { requestId: prompt.requestId, result: -1 });
    assert.equal(await choice, -1);
  } finally {
    driver.dispose();
  }
});

test('leaving a remote match releases its listener and pending prompt', async () => {
  const socket = new FakeSocket();
  const session = new GameSession();
  const driver = new RemotePlayerDriver(0, socket as any, session);
  const input = driver.promptYesNo('继续？');
  assert.equal(socket.listenerCount('prompt_response'), 1);
  driver.dispose();
  assert.equal(await input, false);
  assert.equal(socket.listenerCount('prompt_response'), 0);
  assert.equal(await driver.promptYesNo('已离开'), false);
  assert.equal(socket.prompts.length, 1);
  session.dispose();
});

test('a delayed response from an old match cannot answer the next match', async () => {
  const socket = new FakeSocket();
  const first = new RemotePlayerDriver(0, socket as any);
  const oldInput = first.promptYesNo('旧局');
  const oldId = socket.prompts.at(-1).requestId;
  first.dispose();
  await oldInput;
  const second = new RemotePlayerDriver(0, socket as any);
  let settled = false;
  const input = second.promptYesNo('新局').then(value => { settled = true; return value; });
  const newId = socket.prompts.at(-1).requestId;
  assert.notEqual(newId, oldId);
  socket.emit('prompt_response', { requestId: oldId, result: true });
  await sleep(0);
  assert.equal(settled, false);
  socket.emit('prompt_response', { requestId: newId, result: true });
  assert.equal(await input, true);
  second.dispose();
});

test('socket replacement does not accumulate response listeners', () => {
  const oldSocket = new FakeSocket();
  const newSocket = new FakeSocket();
  const session = new GameSession();
  const driver = new RemotePlayerDriver(0, oldSocket as any, session);
  driver.updateSocket(newSocket as any);
  driver.updateSocket(newSocket as any);
  assert.equal(oldSocket.listenerCount('prompt_response'), 0);
  assert.equal(newSocket.listenerCount('prompt_response'), 1);
  session.dispose();
  assert.equal(newSocket.listenerCount('prompt_response'), 0);
});

test('GameHost sees no online human after the last player leaves', async () => {
  const socket = new FakeSocket();
  const io = { sockets: { sockets: new Map([[socket.id, socket]]) }, to: () => ({ emit() {} }) };
  const host = new GameHost('test-room', io as any, [{ index: 0, token: 'test-token', heroId: ALL_HEROES[0].id }] as any, 0, new Map(), new Map([['test-token', socket.id]]));
  await host.initGame([]);
  assert.equal(host.hasAnyHumanPlayer(), true);
  assert.equal(socket.listenerCount('prompt_response'), 1);
  host.handleDisconnect(socket.id);
  assert.equal(host.hasAnyHumanPlayer(), false);
  assert.equal(socket.listenerCount('prompt_response'), 0);
  host.abort();
  host.abort();
  assert.equal(host.winner, 'aborted');
});

test('in PVE, Kazuha skips Slash outside enemy range and Fang Tian hits enemies only', async () => {
  const roster = [
    ['inev', '伊涅芙', Faction.Ally], ['kazuha', '枫原万叶', Faction.Ally],
    ['ayato', '神里绫人', Faction.Ally], ['ningguang', '凝光', Faction.Enemy],
    ['jean', '琴', Faction.Enemy],
  ] as const;
  const players = roster.map(([hero, name, faction], id) => ({
    ...createPlayer(id, name, hero, name, GenderType.None, 5),
    faction,
  }));
  const source = players[1];
  const session = new GameSession();
  const drivers = new Map(players.map(player => [
    player.id,
    player === source ? new DelayedAIDriver(player.id, () => 0, session) : new AIDriver(player.id),
  ]));
  const bus = new EventBus();
  const deck = new DeckManager(bus);
  const damage = new DamageSystem(deck, bus, drivers, players);
  const equipment = new EquipEffectManager(deck, bus, damage, drivers, players);
  const effects = new CardEffectManager(deck, bus, damage, equipment, drivers, players);
  const targetIds: unknown[] = [];
  bus.on(GameEvent.CardTargeted, event => targetIds.push(event.data.targetId));
  const slash = createCard(CARD_DATA.find(card => card.Name === '杀')!);
  try {
    assert.equal(await effects.handleActivePlay(slash, source), false);
    assert.deepEqual(targetIds, []);
    assert.equal(source.slashUsedCount, 0);
    assert.deepEqual(players.map(player => player.hp), [5, 5, 5, 5, 5]);

    source.equipZone[EquipmentType.Weapon] = createCard(CARD_DATA.find(card => card.Name === '方天画戟')!);
    assert.equal(await effects.handleActivePlay(slash, source), true);
    assert.deepEqual(targetIds, [3, 4]);
    assert.equal(source.slashUsedCount, 1);
    assert.deepEqual(players.map(player => player.hp), [5, 5, 5, 4, 4]);
  } finally {
    session.dispose();
  }
});

test('AI peach rescues follow PVE factions and PVP teams', async (t) => {
  const cases = [
    { name: 'PVE allies', factions: [Faction.Ally, Faction.Ally], rescued: true },
    { name: 'PVE enemies on the same team', factions: [Faction.Enemy, Faction.Enemy], rescued: true },
    { name: 'PVE opposing teams', factions: [Faction.Enemy, Faction.Ally], rescued: false },
    { name: 'PVP minister rescues monarch', roles: [RoleType.Monarch, RoleType.Minister], rescued: true },
    { name: 'PVP rebels rescue each other', roles: [RoleType.Rebel, RoleType.Rebel], rescued: true },
    { name: 'PVP rebel keeps their peach when monarch is dying', roles: [RoleType.Monarch, RoleType.Rebel], rescued: false },
    { name: 'PVP rebel keeps their peach when traitor is dying', roles: [RoleType.Traitor, RoleType.Rebel], rescued: false },
    { name: 'PVP traitor keeps their peach when monarch is dying', roles: [RoleType.Monarch, RoleType.Traitor], rescued: false },
  ];
  for (const { name, factions, roles, rescued } of cases) {
    await t.test(name, async () => {
      const players = [0, 1].map(id => createPlayer(id, `玩家${id}`, 'jean', `角色${id}`, GenderType.Female, 4));
      const [victim, rescuer] = players;
      players.forEach((player, index) => {
        player.faction = factions?.[index];
        player.role = roles?.[index] ?? RoleType.None;
      });
      victim.hp = 1;
      const peach = createCard(CARD_DATA.find(card => card.Name === '桃')!);
      rescuer.handCards.push(peach);
      const session = new GameSession();
      const drivers = new Map(players.map(player => [player.id, new DelayedAIDriver(player.id, () => 0, session)]));
      const bus = new EventBus();
      const deck = new DeckManager(bus);
      const damage = new DamageSystem(deck, bus, drivers, players);
      try {
        await damage.applyHpChange(victim, -1);
        assert.equal(victim.isDead, !rescued);
        assert.equal(victim.hp, rescued ? 1 : 0);
        assert.equal(rescuer.handCards.includes(peach), !rescued);
        assert.equal(deck.discardPile.includes(peach), rescued);
      } finally {
        session.dispose();
      }
    });
  }
});

test('peach self-rescue and manual cross-team rescue remain available', async () => {
  const victim = createPlayer(0, '玩家0', 'jean', '琴', GenderType.Female, 4);
  victim.role = RoleType.Traitor;
  const human = createPlayer(1, '玩家1', 'kazuha', '枫原万叶', GenderType.Male, 4);
  human.role = RoleType.Rebel;
  const socket = new FakeSocket();
  const humanDriver = new RemotePlayerDriver(human.id, socket as any);
  const players = [victim, human];
  const drivers = new Map<number, AIDriver | RemotePlayerDriver>([
    [victim.id, new AIDriver(victim.id)],
    [human.id, humanDriver],
  ]);
  const bus = new EventBus();
  const deck = new DeckManager(bus);
  const damage = new DamageSystem(deck, bus, drivers, players);
  const peachInfo = CARD_DATA.find(card => card.Name === '桃')!;
  victim.hp = 1;
  victim.handCards.push(createCard(peachInfo));
  human.handCards.push(createCard(peachInfo));
  try {
    await damage.applyHpChange(victim, -1);
    assert.equal(victim.hp, 1);
    assert.equal(victim.handCards.length, 0);
    assert.equal(socket.prompts.length, 0);

    socket.once('prompt', prompt => {
      assert.equal(prompt.data.cardName, '桃');
      assert.equal(prompt.data.ctx.dyingPlayerId, victim.id);
      assert.equal(prompt.data.ctx.players[0].role, 'Unknown');
      socket.emit('prompt_response', { requestId: prompt.requestId, result: prompt.data.state.handCards[0] });
    });
    await damage.applyHpChange(victim, -1);
    assert.equal(victim.hp, 1);
    assert.equal(human.handCards.length, 0);
    assert.equal(socket.prompts.length, 1);
  } finally {
    humanDriver.dispose();
  }
});

test('AI peach healing skills pick wounded teammates or skip when there are none', async () => {
  const sigewinne = createPlayer(0, '玩家0', 'sigewinne', '希格雯', GenderType.Female, 4);
  const tighnari = createPlayer(1, '玩家1', 'tighnari', '提纳里', GenderType.Male, 4);
  const enemy = createPlayer(2, '玩家2', 'jean', '琴', GenderType.Female, 4);
  sigewinne.faction = Faction.Ally;
  tighnari.faction = Faction.Ally;
  enemy.faction = Faction.Enemy;
  enemy.hp = 1;
  const players = [sigewinne, tighnari, enemy];
  const drivers = new Map(players.map(player => [player.id, new AIDriver(player.id)]));
  const bus = new EventBus();
  const deck = new DeckManager(bus);
  const damage = new DamageSystem(deck, bus, drivers, players);
  const skills = new SkillManager(deck, bus, damage, drivers, players);
  const ctx = {
    players,
    roundCount: 1,
    currentTurn: 1,
    currentPlayerId: sigewinne.id,
    gameOverWinner: null,
    drawPileCount: 0,
    discardPileCount: 0,
  };
  const peach = createCard(CARD_DATA.find(card => card.Name === '桃')!);
  sigewinne.handCards.push(peach);

  assert.equal(await skills.executeActiveSkill(sigewinne, 'sigewinne_nurse', ctx), false);
  assert.deepEqual(sigewinne.handCards, [peach]);
  assert.deepEqual(deck.discardPile, []);
  assert.equal(await skills.tighnariBiologyPrompt(tighnari, ctx), false);
  assert.equal(enemy.hp, 1);

  tighnari.hp = 2;
  assert.equal(await skills.executeActiveSkill(sigewinne, 'sigewinne_nurse', ctx), true);
  assert.equal(tighnari.hp, 3);
  assert.deepEqual(sigewinne.handCards, []);
  assert.deepEqual(deck.discardPile, [peach]);

  for (const player of players) player.faction = undefined;
  tighnari.role = RoleType.Monarch;
  sigewinne.role = RoleType.Minister;
  enemy.role = RoleType.Rebel;
  sigewinne.hp = 2;
  assert.equal(await skills.tighnariBiologyPrompt(tighnari, ctx), true);
  assert.equal(sigewinne.hp, 3);
  assert.equal(enemy.hp, 1);
});

test('GameHost exposes the selected monarch region for PVP music', () => {
  const io = { sockets: { sockets: new Map() }, to: () => ({ emit() {} }) };
  const host = new GameHost(
    'music-room',
    io as any,
    [
      { index: 3, token: null, heroId: 'venti' },
      { index: 6, token: null, heroId: 'zhongli' },
    ] as any,
    2,
    new Map(),
    new Map(),
  );
  host.setMonarchPlayerId(6);
  assert.equal(host.getMonarchRegion(), '璃月');
});
