import test from 'node:test';
import assert from 'node:assert/strict';
import { EquipEffectManager } from '../src/core/EquipEffectManager';
import { CardEffectManager } from '../src/core/CardEffectManager';
import { DamageSystem } from '../src/core/DamageSystem';
import { DeckManager } from '../src/core/DeckManager';
import { EventBus } from '../src/core/EventBus';
import { GameFlowController } from '../src/core/GameFlowController';
import { createPlayer } from '../src/core/Player';
import { createCard } from '../src/core/Card';
import { CARD_DATA } from '../src/data/CardData';
import { EquipmentType, Faction, GenderType, GameEvent, RoleType, type IPlayerDriver, type PlayerState } from '../src/core/types';

function setup(reply: unknown, handCount = 3, armorName = '八卦阵') {
  let nextId = 1000;
  const card = (name: string) => ({ ...createCard(CARD_DATA.find(data => data.Name === name)!), id: nextId++ });
  const source = createPlayer(0, '测试玩家', 'shenhe', '申鹤', GenderType.Female, 5);
  const target = createPlayer(1, '目标', 'kaeya', '凯亚', GenderType.Male, 5);
  const hand = ['杀', '闪', '桃'].slice(0, handCount).map(card);
  source.handCards = [...hand];
  const axe = card('贯石斧');
  const armor = card(armorName);
  source.equipZone[EquipmentType.Weapon] = axe;
  source.equipZone[EquipmentType.Armor] = armor;
  const bus = new EventBus();
  const deck = new DeckManager(bus);
  const owners: unknown[] = [];
  bus.on(GameEvent.CardDiscarded, event => owners.push(event.data.playerId));
  let prompts = 0;
  const driver = {
    promptWeaponEffect: async () => true,
    promptDiscardMulti: async (_state: unknown, count: number, ctx: any) => {
      prompts++;
      assert.equal(count, 2);
      assert.deepEqual(ctx.discardPrompt, { title: '贯石斧', excludedCardIds: [axe.id] });
      return reply;
    },
  };
  const manager = new EquipEffectManager(deck, bus, {} as any, new Map([[0, driver as any]]), [source, target]);
  const run = () => manager.handleWeaponOnDodgeSuccess(source, target, card('杀'));
  return { source, target, hand, axe, armor, deck, owners, run, prompts: () => prompts };
}

for (const indices of [[0, 1], [1, 0]]) {
  test(`axe consumes the original adjacent hand cards for selection ${indices}`, async () => {
    const game = setup(indices);
    assert.equal(await game.run(), true);
    assert.deepEqual(game.source.handCards, [game.hand[2]]);
    assert.deepEqual(new Set(game.deck.discardPile), new Set([game.hand[0], game.hand[1]]));
    assert.equal(game.source.equipZone[EquipmentType.Weapon], game.axe);
    assert.deepEqual(game.owners, [0, 0]);
  });
}

test('axe equipment indices include the weapon slot while selecting hand plus armor', async () => {
  const game = setup([1, 4]); // hand 0..2, weapon 3, armor 4
  assert.equal(await game.run(), true);
  assert.deepEqual(game.source.handCards, [game.hand[0], game.hand[2]]);
  assert.equal(game.source.equipZone[EquipmentType.Armor], null);
  assert.equal(game.source.equipZone[EquipmentType.Weapon], game.axe);
  assert.deepEqual(game.deck.discardPile, [game.hand[1], game.armor]);
});

test('malformed, duplicate, weapon and excess selections cannot discard extra cards', async () => {
  const game = setup([3, 0, 0, -1, 0.5, '1', NaN, 999, 1, 2, 4]);
  assert.equal(await game.run(), true);
  assert.deepEqual(game.deck.discardPile, [game.hand[0], game.hand[1]]);
  assert.deepEqual(game.source.handCards, [game.hand[2]]);
  assert.equal(game.source.equipZone[EquipmentType.Weapon], game.axe);
  assert.equal(game.source.equipZone[EquipmentType.Armor], game.armor);
});

for (const reply of [[], null, { invalid: true }]) {
  test(`axe automatically fills an empty or invalid reply ${JSON.stringify(reply)}`, async () => {
    const game = setup(reply, 1);
    assert.equal(await game.run(), true);
    assert.deepEqual(game.deck.discardPile, [game.hand[0], game.armor]);
    assert.equal(game.source.handCards.length, 0);
    assert.equal(game.source.equipZone[EquipmentType.Weapon], game.axe);
  });
}

test('axe cannot activate with fewer than two eligible cards', async () => {
  const game = setup([], 0);
  assert.equal(await game.run(), false);
  assert.equal(game.prompts(), 0);
  assert.equal(game.deck.discardPile.length, 0);
  assert.equal(game.source.equipZone[EquipmentType.Weapon], game.axe);
  assert.equal(game.source.equipZone[EquipmentType.Armor], game.armor);
});

test('discarding Silver Lion as axe cost applies its armor loss effect once', async () => {
  const game = setup([0, 4, 4], 3, '白银狮子');
  game.source.hp = 2;
  assert.equal(await game.run(), true);
  assert.equal(game.source.hp, 3);
  assert.equal(game.source.equipZone[EquipmentType.Armor], null);
  assert.deepEqual(game.deck.discardPile, [game.hand[0], game.armor]);
});

test('playing weapons retains the equipped card and sends only the replaced weapon to discard', async () => {
  const source = createPlayer(0, '测试玩家', 'shenhe', '申鹤', GenderType.Female, 5);
  const firstWeapon = createCard(CARD_DATA.find(data => data.Name === '寒冰剑')!);
  const secondWeapon = createCard(CARD_DATA.find(data => data.Name === '贯石斧')!);
  source.handCards = [firstWeapon, secondWeapon];

  const players = [source];
  const bus = new EventBus();
  const deck = new DeckManager(bus);
  const driver = {
    async promptPlayCard(player: PlayerState) {
      return player.handCards.length ? 0 : -1;
    },
  } as IPlayerDriver;
  const drivers = new Map([[source.id, driver]]);
  const damage = new DamageSystem(deck, bus, drivers, players);
  const equip = new EquipEffectManager(deck, bus, damage, drivers, players);
  const effects = new CardEffectManager(deck, bus, damage, equip, drivers, players);
  const flow = new GameFlowController(players, deck, bus, effects, damage, equip, drivers);
  const discarded: unknown[] = [];
  bus.on(GameEvent.CardDiscarded, event => discarded.push(event.data));

  await flow['playPhase'](source);

  assert.deepEqual(source.handCards, []);
  assert.equal(source.equipZone[EquipmentType.Weapon], secondWeapon);
  assert.deepEqual(deck.discardPile, [firstWeapon]);
  assert.deepEqual(discarded, [{
    card: firstWeapon,
    playerId: source.id,
    discardPileCount: 1,
    cause: 'equipment-replaced',
  }]);
});

for (const pve of [false, true]) {
  test(`${pve ? 'PVE' : 'PVP'} stops a multi-target card when the first death decides the match`, async () => {
    const victim = createPlayer(0, '目标', 'jean', '琴', GenderType.Female, 4);
    const later = createPlayer(1, '后继目标', 'kaeya', '凯亚', GenderType.Male, 4);
    const source = createPlayer(2, '出牌者', 'shenhe', '申鹤', GenderType.Female, 5);
    const players = [victim, later, source];
    if (pve) {
      victim.faction = Faction.Enemy;
      later.faction = source.faction = Faction.Ally;
    } else {
      victim.role = RoleType.Monarch;
      later.role = RoleType.Minister;
      source.role = RoleType.Rebel;
      victim.isFlipped = later.isFlipped = true;
    }
    const playedCard = createCard(CARD_DATA.find(data => data.Name === '万箭齐发')!);
    source.handCards = [playedCard];

    const bus = new EventBus();
    const deck = new DeckManager(bus);
    const dodgePrompts: number[] = [];
    const driver = {
      async promptPlayCard(player: PlayerState) {
        assert.equal(player, source);
        assert.equal(player.handCards.length, 1);
        return 0;
      },
      async promptResponse(player: PlayerState, cardName: string) {
        if (cardName === '闪') dodgePrompts.push(player.id);
        return null;
      },
    } as IPlayerDriver;
    const drivers = new Map(players.map(player => [player.id, driver]));
    const damage = new DamageSystem(deck, bus, drivers, players);
    const equip = new EquipEffectManager(deck, bus, damage, drivers, players);
    const effects = new CardEffectManager(deck, bus, damage, equip, drivers, players);
    const flow = new GameFlowController(players, deck, bus, effects, damage, equip, drivers);
    flow.turnDelayMs = 0;
    bus.on(GameEvent.RolesAssigned, () => { victim.hp = 1; });
    const results: unknown[] = [];
    bus.on(GameEvent.GameOver, event => results.push(event.data.winner));

    await flow.startGame(undefined, pve ? [source.id, victim.id, later.id] : undefined);

    const winner = pve ? '友方阵营' : '反贼阵营';
    assert.deepEqual(results, [winner]);
    assert.equal(flow.gameOverWinner, winner);
    assert.equal(victim.isDead, true);
    assert.equal(later.hp, later.maxHp);
    assert.deepEqual(dodgePrompts, [victim.id]);
    assert.equal(flow.killStats.get(source.id)?.[pve ? 'rebel' : 'monarch'], 1);
    assert.equal(deck.discardPile.filter(card => card === playedCard).length, 1);
  });
}

test('a monarch death during chained damage stops the rest of the chain', async () => {
  const names = ['琴', '凯亚', '申鹤', '凝光'];
  const heroes = ['jean', 'kaeya', 'shenhe', 'ningguang'];
  const [monarch, later, source, first] = names.map((name, id) =>
    createPlayer(id, name, heroes[id], name, GenderType.None, 4));
  const players = [monarch, later, source, first];
  monarch.role = RoleType.Monarch;
  later.role = RoleType.Minister;
  source.role = first.role = RoleType.Rebel;
  monarch.isFlipped = later.isFlipped = true;
  monarch.isChained = later.isChained = first.isChained = true;
  source.handCards = [createCard(CARD_DATA.find(data => data.Name === '火杀')!)];

  const bus = new EventBus();
  const deck = new DeckManager(bus);
  const driver = {
    async promptPlayCard(player: PlayerState) {
      assert.equal(player, source);
      return player.handCards.length ? 0 : -1;
    },
    async promptTarget() { return first.id; },
    async promptResponse() { return null; },
  } as IPlayerDriver;
  const drivers = new Map(players.map(player => [player.id, driver]));
  const damage = new DamageSystem(deck, bus, drivers, players);
  const equip = new EquipEffectManager(deck, bus, damage, drivers, players);
  const effects = new CardEffectManager(deck, bus, damage, equip, drivers, players);
  damage.onTransmitChain = (target, amount, card, attacker) =>
    effects.transmitChainedDamage(target, amount, card, attacker, false);
  const flow = new GameFlowController(players, deck, bus, effects, damage, equip, drivers);
  flow.turnDelayMs = 0;
  bus.on(GameEvent.RolesAssigned, () => { monarch.hp = 1; });

  await flow.startGame();

  assert.equal(flow.gameOverWinner, '反贼阵营');
  assert.equal(first.hp, first.maxHp - 1);
  assert.equal(monarch.isDead, true);
  assert.equal(later.hp, later.maxHp);
  assert.equal(later.isChained, true);
});

test('a winning ZhanBa Slash discards its two physical cards exactly once', async () => {
  const monarch = createPlayer(0, '主公', 'jean', '琴', GenderType.Female, 4);
  const source = createPlayer(1, '出牌者', 'shenhe', '申鹤', GenderType.Female, 5);
  const players = [monarch, source];
  monarch.role = RoleType.Monarch;
  source.role = RoleType.Rebel;
  monarch.isFlipped = true;
  source.equipZone[EquipmentType.Weapon] = createCard(CARD_DATA.find(data => data.Name === '丈八蛇矛')!);
  const physicalCards = ['闪', '桃'].map(name => createCard(CARD_DATA.find(data => data.Name === name)!));
  source.handCards = [...physicalCards];

  const bus = new EventBus();
  const deck = new DeckManager(bus);
  const prompts: string[] = [];
  const driver = {
    async promptPlayCard(player: PlayerState) {
      assert.equal(player, source);
      prompts.push('play');
      return -2;
    },
    async promptZhanBa() { return [0, 1]; },
    async promptTarget() { return monarch.id; },
    async promptResponse() { return null; },
  } as IPlayerDriver;
  const drivers = new Map(players.map(player => [player.id, driver]));
  const damage = new DamageSystem(deck, bus, drivers, players);
  const equip = new EquipEffectManager(deck, bus, damage, drivers, players);
  const effects = new CardEffectManager(deck, bus, damage, equip, drivers, players);
  const flow = new GameFlowController(players, deck, bus, effects, damage, equip, drivers);
  flow.turnDelayMs = 0;
  bus.on(GameEvent.RolesAssigned, () => { monarch.hp = 1; });

  await flow.startGame();

  assert.equal(flow.gameOverWinner, '反贼阵营');
  assert.deepEqual(prompts, ['play']);
  assert.deepEqual(source.handCards, []);
  assert.deepEqual(deck.discardPile, physicalCards);
  assert.equal(deck.discardPile.some(card => card.isVirtual), false);
  assert.equal(source.equipZone[EquipmentType.Weapon]?.name, '丈八蛇矛');
});
