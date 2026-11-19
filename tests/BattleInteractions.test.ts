import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GameClock } from '../src/ui/GameClock';
import { GamePage, HumanWebUIDriver } from '../src/ui/GamePage';
import { GameSession } from '../src/core/GameSession';
import { EventBus } from '../src/core/EventBus';
import { GameEvent } from '../src/core/types';
import { SkillManager } from '../src/core/skills/SkillManager';
import { GameHost } from '../server/GameHost';
import { RemotePlayerDriver } from '../server/RemotePlayerDriver';
import { SuitType } from '../src/core/types';

test('the five-player Liyue board follows the range order counterclockwise from the human', () => {
  const names = ['伊涅芙', '枫原万叶', '神里绫人', '凝光', '琴'];
  const players = names.map((name, id) => ({ name, id }));
  const page = { players, pveLevel: true, humanPlayerIdx: 0 };
  const self = GamePage.prototype['getHumanPlayer'].call(page as unknown as GamePage)!;
  const layout = GamePage.prototype['getBattlefieldLayout'].call(page as unknown as GamePage, self);
  assert.deepEqual(layout.right.map(player => player.name), ['枫原万叶']);
  assert.deepEqual(layout.top.map(player => player.name), ['凝光', '神里绫人']);
  assert.deepEqual(layout.left.map(player => player.name), ['琴']);
  assert.deepEqual([self, ...layout.right.reverse(), ...layout.top.reverse(), ...layout.left].map(player => player.name), names);
});

test('clock follows elapsed time after throttling, clamps expiry, freezes and restarts', () => {
  let now = 100;
  const clock = new GameClock(() => now);
  clock.start(10000);
  now += 7100; // A background tab may miss many interval callbacks.
  assert.equal(clock.elapsedSeconds, 7);
  assert.equal(clock.remainingSeconds, 3);
  assert.equal(Math.round(clock.percent), 29);
  now += 6000;
  assert.equal(clock.remainingSeconds, 0);
  assert.equal(clock.percent, 0);
  clock.stop();
  now += 9000;
  assert.equal(clock.elapsedSeconds, 13);
  clock.start(5000);
  assert.equal(clock.remainingSeconds, 5);
  assert.equal(clock.elapsedSeconds, 0);
});

function fakePage(timeoutMs = 5000) {
  const session = new GameSession();
  const ui = {
    session, highlighted: 0,
    getInteractionTimeoutMs: () => timeoutMs,
    highlightNullifyCards() { this.highlighted++; },
    clearHighlights() {}, hidePrompt() {}, hideNullifyPassButton() {}, closeHeroInfoPopup() {},
    showPrompt() {}, startPVPCountdown() {}, stopPVPCountdown() {},
  };
  return { session, ui, driver: new HumanWebUIDriver(0, ui as any, session) };
}
const state = { id: 0, role: 'Monarch', handCards: [{ id: 5, name: '无懈可击' }] } as any;

test('a human can nullify Amazing Grace and allied tricks instead of being auto-skipped', async () => {
  const { session, ui, driver } = fakePage();
  try {
    const replies: unknown[] = [];
    driver.setPVPRespond(value => replies.push(value));
    const pending = driver.promptNullification(state, { nullifyCardName: '五谷丰登', nullifySourceId: 1,
      players: [{ id: 0, role: 'Monarch' }, { id: 1, role: 'Minister' }] } as any);
    assert.equal(ui.highlighted, 1);
    assert.equal(driver.getResolveKey('nullify'), true);
    driver.resolveNullify(true);
    assert.equal(await pending, true);
    assert.deepEqual(replies, [true]);
  } finally { session.dispose(); }
});

test('an old nullification timeout cannot resolve a new nullification request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, driver } = fakePage();
  try {
    const first = driver.promptNullification(state, {} as any);
    t.mock.timers.tick(2000);
    driver.resolveNullify(false);
    assert.equal(await first, false);
    const second = driver.promptNullification(state, {} as any);
    t.mock.timers.tick(3001); // The first request's original deadline has now passed.
    assert.equal(driver.getResolveKey('nullify'), true);
    driver.resolveNullify(true);
    assert.equal(await second, true);
  } finally { session.dispose(); }
});

test('replacing an interaction settles the previous wait and cancels its timeout', async () => {
  const { session, driver } = fakePage();
  try {
    const first = driver.promptNullification(state, {} as any);
    driver.cancelInteraction();
    assert.equal(await first, false);
    assert.equal(driver.getResolveKey('nullify'), false);
    const second = driver.promptNullification(state, {} as any);
    driver.resolveNullify(true);
    assert.equal(await second, true);
  } finally { session.dispose(); }
});

test('a local driver cannot reset a remote 10-second deadline to 15 or 30 seconds', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const page = new GamePage() as any;
  page.mode = 'pvp'; page.pvpRequestId = 'request-one';
  page.countdownClock = new GameClock(() => now);
  page.pvpCountdownBarEl = { style: {} };
  page.pvpCountdownFillEl = { style: {}, classList: { toggle() {} } };
  page.pvpCountdownTextEl = { textContent: '' };
  page.playCountdownBarEl = { style: {} };
  try {
    page.startPVPCountdown(10);
    page.startPVPCountdown(30);
    assert.equal(page.pvpCountdownTextEl.textContent, '操作剩余 10 秒');
    now = 7000;
    t.mock.timers.tick(100);
    assert.equal(page.pvpCountdownTextEl.textContent, '操作剩余 3 秒');
    page.startPVPCountdown(15);
    assert.equal(page.getInteractionTimeoutMs(30000), 3000);
    now = 12000; t.mock.timers.tick(100);
    assert.equal(page.pvpCountdownTextEl.textContent, '操作剩余 0 秒');
    assert.equal(page.pvpCountdownFillEl.style.width, '0%');
  } finally { page.stopPVPCountdown(); page.session.dispose(); }
});

test('own-play progress follows the server deadline and clears before a response or session exit', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const page = new GamePage() as any;
  page.mode = 'pvp'; page.pvpRequestId = 'play-request';
  page.countdownClock = new GameClock(() => now);
  page.pvpCountdownBarEl = { style: {} };
  page.pvpCountdownFillEl = { style: {}, classList: { toggle() {} } };
  page.pvpCountdownTextEl = { textContent: '' };
  const progressAttributes = new Map<string, string>();
  const colors = new Set<string>();
  page.playCountdownBarEl = {
    style: {},
    setAttribute(name: string, value: string) { progressAttributes.set(name, value); },
  };
  page.playCountdownFillEl = {
    style: {},
    classList: {
      toggle(name: string, enabled: boolean) {
        if (enabled) colors.add(name);
        else colors.delete(name);
      },
    },
  };
  page.playCountdownTextEl = { textContent: '' };
  try {
    page.startPVPCountdown(10, 'playCard');
    assert.equal(page.playCountdownBarEl.style.display, 'block');
    assert.equal(page.pvpCountdownBarEl.style.display, 'none');
    assert.equal(page.playCountdownTextEl.textContent, '出牌剩余 10 秒');
    assert.equal(page.playCountdownFillEl.style.width, '100%');
    assert.equal(progressAttributes.get('aria-valuenow'), '100');
    assert.equal(colors.has('safe'), true);

    now = 7000;
    t.mock.timers.tick(100);
    page.startPVPCountdown(30);
    assert.equal(page.playCountdownTextEl.textContent, '出牌剩余 3 秒');
    assert.equal(page.playCountdownFillEl.style.width, '30%');
    assert.equal(progressAttributes.get('aria-valuenow'), '30');
    assert.equal(progressAttributes.get('aria-valuetext'), '出牌剩余 3 秒');
    assert.equal(page.getInteractionTimeoutMs(30000), 3000);
    assert.equal(colors.has('warning'), true);
    assert.equal(colors.has('safe'), false);

    now = 12000;
    t.mock.timers.tick(100);
    assert.equal(page.playCountdownTextEl.textContent, '出牌剩余 0 秒');
    assert.equal(page.playCountdownFillEl.style.width, '0%');
    assert.equal(progressAttributes.get('aria-valuenow'), '0');
    assert.equal(colors.size, 0);

    page.stopPVPCountdown();
    assert.equal(page.playCountdownBarEl.style.display, 'none');
    assert.equal(page.pvpCountdownBarEl.style.display, 'none');
    page.pvpRequestId = 'response-request';
    page.startPVPCountdown(10, 'response');
    assert.equal(page.playCountdownBarEl.style.display, 'none');
    assert.equal(page.pvpCountdownBarEl.style.display, 'block');
    assert.equal(page.pvpCountdownTextEl.textContent, '操作剩余 10 秒');
    page.session.dispose();
    now += 5000;
    t.mock.timers.tick(100);
    assert.equal(page.pvpCountdownTextEl.textContent, '操作剩余 10 秒');
  } finally { page.stopPVPCountdown(); page.session.dispose(); }
});

test('server expiry closes the matching prompt and stale replies do not reopen it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new EventEmitter();
  let prompt: any; const closed: string[] = [];
  socket.on('prompt', value => { prompt = value; });
  socket.on('prompt_closed', value => closed.push(value.requestId));
  const session = new GameSession();
  const driver = new RemotePlayerDriver(0, socket as any, session);
  try {
    const pending = driver.promptYesNo('test');
    assert.equal(prompt.timeoutSec, 10);
    t.mock.timers.tick(10000);
    assert.equal(await pending, false);
    assert.deepEqual(closed, [prompt.requestId]);
    socket.emit('prompt_response', { requestId: prompt.requestId, result: true });
    assert.equal(closed.length, 1);
  } finally { session.dispose(); }
});

test('responses are displayed once even when physical discard arrives first', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = new GamePage() as any;
  const shown: any[] = [];
  page.battlePresentation = { card: (action: any) => shown.push(action) };
  const event = { playerId: 1, card: { id: 7, name: '闪', suit: 'Heart', number: 5 } };
  try {
    page.presentBattleCard('discard', event);
    page.presentBattleCard('response', event);
    t.mock.timers.tick(200);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].kind, 'response');
    // Recycled cards must still display on a later genuine discard.
    page.presentBattleCard('discard', event);
    t.mock.timers.tick(200);
    assert.equal(shown.length, 2);
    assert.equal(shown[1].kind, 'discard');
  } finally { page.session.dispose(); }
});

test('a dismantle enriches the anonymous discard with its owner and appears only once', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = new GamePage() as any;
  const shown: any[] = [];
  page.battlePresentation = { card: (action: any) => shown.push(action) };
  page.renderBattlefield = () => {};
  page.renderHandCards = () => {};
  const card = { id: 17, name: '酒', suit: 'Club', number: 3 };
  try {
    page.handlePVPGameEvent({ type: 'CardDiscarded', data: { card } });
    page.handlePVPGameEvent({ type: 'CardDismantled', data: { card, playerId: 3 } });
    t.mock.timers.tick(150);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].playerId, 3);
    assert.equal(shown[0].kind, 'discard');
    assert.equal(shown[0].cardName, '酒');
  } finally { page.session.dispose(); }
});

test('PVE owner-bearing discard events replace the earlier deck event', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = new GamePage() as any;
  const shown: any[] = [];
  page.eventBus = new EventBus();
  page.battlePresentation = { card: (action: any) => shown.push(action) };
  page.renderBattlefield = () => {};
  page.renderHandCards = () => {};
  page.registerUIEventListeners();
  const card = { id: 18, name: '酒', suit: 'Club', number: 3 };
  try {
    page.eventBus.emit(GameEvent.CardDiscarded, { card });
    page.eventBus.emit(GameEvent.CardDismantled, { card, playerId: 3 });
    t.mock.timers.tick(150);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].playerId, 3);
  } finally { page.session.dispose(); page.eventBus.clear(); }
});

test('retained equipment and delayed tricks still show their later genuine discard', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = new GamePage() as any;
  const shown: any[] = [];
  page.battlePresentation = { card: (action: any) => shown.push(action) };
  page.renderBattlefield = () => {};
  page.renderHandCards = () => {};
  try {
    for (const [index, type] of ['CardEquipped', 'CardMovedToJudge'].entries()) {
      const card = { id: 30 + index, name: index ? '乐不思蜀' : '寒冰剑' };
      page.handlePVPGameEvent({ type: 'CardPlayed', data: { card, playerId: 1 } });
      page.handlePVPGameEvent({ type, data: { card, playerId: 1 } });
      if (type === 'CardEquipped') {
        const oldWeapon = { id: 40, name: '贯石斧' };
        page.handlePVPGameEvent({ type: 'CardDiscarded', data: { card: oldWeapon, playerId: 1, cause: 'equipment-replaced' } });
        t.mock.timers.tick(150);
      }
      page.handlePVPGameEvent({ type: 'CardDiscarded', data: { card, playerId: 1 } });
      t.mock.timers.tick(150);
    }
    assert.deepEqual(shown.map(action => [action.kind, action.cardName]), [
      ['play', '寒冰剑'], ['discard', '寒冰剑'], ['play', '乐不思蜀'], ['discard', '乐不思蜀'],
    ]);
  } finally { page.session.dispose(); }
});

test('mandatory Secret discard requests hand cards and consumes exactly one valid or automatic choice', async () => {
  for (const reply of [[], [1, 0], [99], ['1']]) {
    const bus = new EventBus();
    const hand = [{ id: 80, name: '杀', suit: 'Club', number: 7 }, { id: 81, name: '闪', suit: 'Heart', number: 2 }];
    const player = { id: 0, name: '目标', handCards: [...hand] } as any;
    const secretOwner = { id: 1 };
    const data = new Map([[0, { _nefurSecretMark: { cardName: '桃', suit: 'Heart', number: 6, markedById: 1 } }], [1, {}]]);
    const discarded: any[] = [];
    const manager = Object.create(SkillManager.prototype) as any;
    manager.getData = (id: number) => data.get(id);
    manager.allPlayers = [player, secretOwner];
    manager.eventBus = bus;
    manager.deck = { sendToDiscard: (card: any) => discarded.push(card) };
    manager.buildContext = () => ({ players: [player, secretOwner] });
    manager.drivers = new Map([[0, { promptDiscardMulti: (_state: any, count: number, context: any) => {
      assert.equal(count, 1);
      assert.deepEqual(context.discardPrompt, { title: '秘闻', handOnly: true });
      return Promise.resolve(reply);
    } }]]);
    await manager.checkNefurSecretOnDiscard(player, { name: '桃', suit: 'Heart', number: 6 });
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0], reply[0] === 1 ? hand[1] : hand[0]);
    assert.equal(player.handCards.length, 1);
  }
});

function callbackPage() {
  const { session, ui, driver } = fakePage();
  const callbacks = new Map<string, Array<(value: any) => void>>();
  const capture = (key: string, callback: (value: any) => void) => {
    const values = callbacks.get(key) || [];
    values.push(callback); callbacks.set(key, values);
  };
  Object.assign(ui, {
    showYesNoPrompt: (_title: string, callback: (value: any) => void) => capture('yesNo', callback),
    showZhanBaPrompt: (_state: unknown, callback: (value: any) => void) => capture('zhanba', callback),
    showRansackHandPrompt: (_target: unknown, callback: (value: any) => void) => capture('ransackHand', callback),
    showDiscardMultiPrompt: (_state: unknown, _count: number, callback: (value: any) => void) => capture('discardMulti', callback),
    showIronChainPrompt: (callback: (value: any) => void) => capture('ironChainMode', callback),
    showGraceCards: (_cards: unknown, callback: (value: any) => void) => capture('amazingGrace', callback),
    showGenderWeaponPrompt: (_name: string, callback: (value: any) => void) => capture('genderWeapon', callback),
    showVentiFreePrompt: (_state: unknown, callback: (value: any) => void) => capture('ventiFree', callback),
    highlightPlayableCards() {},
  });
  return { session, ui, driver, callbacks };
}

test('all callback prompts settle on server cancellation without submitting default choices', async () => {
  const scenarios: Array<{ key: string; defaultValue: unknown; start: (driver: HumanWebUIDriver) => Promise<unknown> }> = [
    { key: 'yesNo', defaultValue: false, start: d => d.promptYesNo('寒冰剑') },
    { key: 'zhanba', defaultValue: null, start: d => d.promptZhanBa(state, {} as any) },
    { key: 'ransackHand', defaultValue: -1, start: d => d.promptRansackHand(state, 1, { players: [{ id: 1, handCards: [{}] }] } as any) },
    { key: 'discardMulti', defaultValue: [], start: d => d.promptDiscardMulti(state, 2, {} as any) },
    { key: 'ironChainMode', defaultValue: 'recast', start: d => d.promptIronChainMode(state, {} as any) },
    { key: 'amazingGrace', defaultValue: 0, start: d => d.promptAmazingGrace(state, [], {} as any) },
    { key: 'genderWeapon', defaultValue: 'discard', start: d => d.promptGenderWeapon(state, '敌方', {} as any) },
    { key: 'ventiFree', defaultValue: 4, start: d => d.promptVentiFree({ ...state, maxHp: 4 }) },
  ];
  for (const scenario of scenarios) {
    const { session, driver } = callbackPage();
    const sent: unknown[] = [];
    try {
      driver.setPVPRespond(value => sent.push(value));
      const pending = scenario.start(driver);
      assert.equal(driver.getResolveKey(scenario.key), true, scenario.key);
      driver.cancelInteraction();
      assert.deepEqual(await pending, scenario.defaultValue, scenario.key);
      assert.equal(driver.getResolveKey(scenario.key), false, scenario.key);
      assert.deepEqual(sent, [], scenario.key);
    } finally { session.dispose(); }
  }
});

test('retained callbacks cannot answer a replacement request and duplicate clicks submit once', async () => {
  const { session, driver, callbacks } = callbackPage();
  const firstReplies: unknown[] = [];
  const nextReplies: unknown[] = [];
  try {
    driver.setPVPRespond(value => firstReplies.push(value));
    const first = driver.promptYesNo('旧的寒冰剑');
    const oldClick = callbacks.get('yesNo')![0];
    driver.cancelInteraction();
    assert.equal(await first, false);
    driver.setPVPRespond(value => nextReplies.push(value));
    let nextSettled = false;
    const second = driver.promptYesNo('新的八卦阵').then(value => { nextSettled = true; return value; });
    oldClick(true);
    await Promise.resolve();
    assert.equal(nextSettled, false);
    assert.equal(driver.getResolveKey('yesNo'), true);
    assert.deepEqual(firstReplies, []);
    assert.deepEqual(nextReplies, []);
    const currentClick = callbacks.get('yesNo')![1];
    currentClick(true); currentClick(false);
    assert.equal(await second, true);
    assert.deepEqual(nextReplies, [true]);
  } finally { session.dispose(); }
});

test('replacing the same custom prompt settles its previous wait without ending a PVE play-card wait', async () => {
  const { session, driver, callbacks } = callbackPage();
  try {
    let playSettled = false;
    const play = driver.promptPlayCard({ ...state, heroId: 'venti' }, {} as any)
      .then(value => { playSettled = true; return value; });
    const first = driver.promptYesNo('技能第一步');
    const oldClick = callbacks.get('yesNo')![0];
    const second = driver.promptYesNo('技能第二步');
    assert.equal(await first, false);
    oldClick(true);
    await Promise.resolve();
    assert.equal(driver.getResolveKey('yesNo'), true);
    assert.equal(playSettled, false);
    callbacks.get('yesNo')![1](true);
    assert.equal(await second, true);
    assert.equal(playSettled, false);
    driver.resolvePlayCard(2);
    assert.equal(await play, 2);
  } finally { session.dispose(); }
});

test('empty selectable cards reply immediately and a cancelled selector submits -1 only once', async () => {
  const { session, driver, ui } = callbackPage();
  const sent: unknown[] = [];
  let button: any;
  const oldDocument = globalThis.document;
  (globalThis as any).document = { createElement: () => (button = {
    style: {}, removed: false, remove() { this.removed = true; }, onclick: null,
  }) };
  Object.assign(ui, { highlightSelectableCards() {}, promptBarEl: { appendChild() {} } });
  try {
    driver.setPVPRespond(value => sent.push(value));
    assert.equal(await driver.promptSelectCard({ ...state, handCards: [] }, '空候选'), -1);
    assert.deepEqual(sent, [-1]);
    assert.equal(await driver.promptSelectCard(state, []), -1);
    assert.deepEqual(sent, [-1, -1]);
    const pending = driver.promptSelectCard(state, '选择牌');
    const cancel = button.onclick;
    cancel({ stopPropagation() {} }); cancel({ stopPropagation() {} });
    assert.equal(await pending, -1);
    assert.deepEqual(sent, [-1, -1, -1]);
    assert.equal(button.removed, true);
  } finally {
    session.dispose();
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});

test('a stale response timeout does not close a newer response and immediate pass does not reopen its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, driver, ui } = callbackPage();
  const countdowns: string[] = [];
  Object.assign(ui, {
    highlightResponseCards() {}, hideResponseButtons() {},
    startPVPCountdown() { countdowns.push('start'); },
    stopPVPCountdown() { countdowns.push('stop'); },
  });
  try {
    const first = driver.promptResponse(state, '闪', {} as any);
    t.mock.timers.tick(2000);
    driver.cancelInteraction();
    assert.equal(await first, null);
    const second = driver.promptResponse(state, '闪', {} as any);
    t.mock.timers.tick(3001);
    assert.equal(driver.getResolveKey('response'), true);
    driver.resolveResponse(null);
    assert.equal(await second, null);
    Object.assign(ui, { highlightResponseCards() { driver.resolveResponse(null); } });
    const immediate = driver.promptResponse(state, '闪', {} as any);
    assert.equal(await immediate, null);
    assert.deepEqual(countdowns.slice(-2), ['start', 'stop']);
  } finally { session.dispose(); }
});

test('disposing a session rejects custom waits and retained callbacks cannot send afterwards', async () => {
  const { session, driver, callbacks } = callbackPage();
  const sent: unknown[] = [];
  driver.setPVPRespond(value => sent.push(value));
  const pending = driver.promptYesNo('仍在等待');
  const rejected = assert.rejects(pending, { name: 'GameSessionCancelled' });
  session.dispose();
  await rejected;
  callbacks.get('yesNo')![0](true);
  assert.deepEqual(sent, []);
  assert.equal(driver.getResolveKey('yesNo'), false);
});

test('Heavenly Authority asks for three suits in four-button prompts and scores the chosen suits', async () => {
  const { session, driver, ui } = fakePage();
  const page = new GamePage();
  const suits = [SuitType.Spade, SuitType.Heart, SuitType.Club];
  const top = suits.map((suit, index) => ({ id: index, suit, number: index + 1, name: '杀' }));
  const source = { id: 1, name: '凝光' };
  const target = { id: 0, name: '目标', handCards: [], hp: 3, maxHp: 4 };
  const drawPile = [...top];
  const manager = Object.assign(Object.create(SkillManager.prototype), {
    getData: () => ({}),
    eventBus: new EventBus(),
    deck: { dealOneCard: () => drawPile.shift() },
    allPlayers: [source, target],
    drivers: new Map([[source.id, { promptTarget: async () => target.id }], [target.id, driver]]),
  });
  class TestElement {
    children: TestElement[] = [];
    dataset: Record<string, string> = {};
    textContent = '';
    click = () => {};
    append(...children: TestElement[]) { this.children.push(...children); }
    addEventListener(_type: string, listener: () => void) { this.click = listener; }
  }
  const oldDocument = globalThis.document;
  (globalThis as any).document = { createElement: () => new TestElement() };
  const opened: TestElement[] = [];
  const closed: TestElement[] = [];
  Object.assign(page, {
    mountTableInteraction(layer: TestElement) { opened.push(layer); },
    closeTableInteraction(layer: TestElement) { closed.push(layer); },
  });
  Object.assign(ui, { showSuitPrompt: page.showSuitPrompt.bind(page) });
  try {
    const pending = manager.ningguangHeaven(source, {});
    for (const [index, suit] of suits.entries()) {
      // Advance the selection loop to this card's pending prompt.
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(opened.length, index + 1);
      const [title, row] = opened[index].children[0].children;
      assert.match(title.textContent, new RegExp(`第 ${index + 1} 张`));
      assert.deepEqual(row.children.map(button => button.textContent), ['♠ 黑桃', '♥ 红桃', '♣ 梅花', '♦ 方块']);
      row.children.find(button => button.dataset.suit === suit)!.click();
    }
    assert.equal(await pending, true);
    assert.deepEqual(closed, opened);
    assert.deepEqual(target.handCards, top);
    assert.equal(target.hp, 4);
  } finally {
    session.dispose();
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});

test('remote suit prompts expose only position and reject invalid or stale replies', async () => {
  const socket = new EventEmitter();
  let prompt: any;
  socket.on('prompt', value => { prompt = value; });
  const session = new GameSession();
  const driver = new RemotePlayerDriver(0, socket as any, session);
  try {
    const first = driver.promptSuit(1, 3);
    assert.equal(prompt.type, 'chooseSuit');
    assert.deepEqual(prompt.data, { cardNumber: 1, totalCards: 3 });
    const firstId = prompt.requestId;
    socket.emit('prompt_response', { requestId: firstId, result: SuitType.None });
    assert.equal(await first, null);
    const second = driver.promptSuit(2, 3);
    socket.emit('prompt_response', { requestId: firstId, result: SuitType.Spade });
    socket.emit('prompt_response', { requestId: prompt.requestId, result: SuitType.Diamond });
    assert.equal(await second, SuitType.Diamond);
  } finally { session.dispose(); }
});

test('PVP snapshots expose only the number of cards attached to each hero', async () => {
  const events: any[] = [];
  const io = {
    to: () => ({ emit: (type: string, event: unknown) => {
      if (type === 'game_event') events.push(event);
    } }),
    sockets: { sockets: new Map() },
  };
  const slots = ['varka', 'alhaitham', 'kazuha', 'mualani', 'kaeya', 'diluc'].map((heroId, index) => ({
    index, heroId, token: index === 0 ? 'test-token' : null,
  }));
  const host = new GameHost('attached-card-test', io as any, slots as any, 0, new Map(), new Map([['test-token', 'viewer']]));
  try {
    await host.initGame([]);
    const { players, skillManager, drivers, deck } = host as any;
    const [varka, alhaitham, kazuha, mualani, kaeya, diluc] = players;
    const cards = deck.drawPile.splice(0, 8);
    const letters = cards.slice(0, 2);
    varka.handCards = [...letters];
    alhaitham.handCards = [cards[2]];
    let targetId: number | null = null;
    drivers.set(varka.id, { promptSelectCard: async () => 0, promptTarget: async () => targetId });
    drivers.set(alhaitham.id, { promptSelectCard: async () => 0 });
    skillManager.getData(kazuha.id).mapleLeaves = [cards[3]];
    skillManager.getData(mualani.id).springCard = cards[4];
    skillManager.getData(kaeya.id).kayeaMarkers = [cards[5]];
    skillManager.getData(diluc.id).dilucMarkers = [cards[6]];
    diluc.judgeZone.push(cards[7]);

    const ctx = { players, currentPlayerId: varka.id };
    const recipientCtx = { ...ctx, currentPlayerId: alhaitham.id };
    await skillManager.onTurnStart(alhaitham, recipientCtx);
    assert.equal(await skillManager.executeActiveSkill(alhaitham, 'alhaitham_knowledge', recipientCtx), true);
    await skillManager.onTurnStart(varka, ctx);
    assert.equal(await skillManager.executeActiveSkill(varka, 'varka_write', ctx), false);
    assert.deepEqual(varka.handCards, letters);
    targetId = alhaitham.id;
    assert.equal(await skillManager.executeActiveSkill(varka, 'varka_write', ctx), true);
    assert.equal(await skillManager.executeActiveSkill(varka, 'varka_write', ctx), true);
    assert.equal(skillManager.getVarkaLetterTarget(varka.id), alhaitham.id);
    assert.deepEqual(players.map((p: any) => skillManager.getAttachedCardCount(p)), [0, 3, 1, 1, 1, 1]);
    assert.deepEqual(host.getSanitizedPlayers(varka.id).map(p => p.attachedCardCount), [0, 3, 1, 1, 1, 1]);

    const snapshots = events.filter(event => event.type === 'Log');
    const stored = snapshots.at(-1).data;
    assert.equal(stored.players[alhaitham.id].attachedCardCount, 3);
    assert.equal(stored.players[alhaitham.id].handCards.length, 0);
    const privateIds = new Set(cards.slice(0, 7).map((card: any) => card.id));
    JSON.stringify(stored, (_key, value) => {
      assert.ok(!value || typeof value !== 'object' || !('suit' in value) || !privateIds.has(value.id));
      return value;
    });

    await skillManager.onTurnEnd(varka, ctx);
    assert.equal(skillManager.getVarkaLetterTarget(varka.id), null);
    await skillManager.onTurnStart(alhaitham, recipientCtx);
    assert.deepEqual(alhaitham.handCards, letters);
    assert.equal(skillManager.getAttachedCardCount(alhaitham), 1);
    assert.equal(skillManager.useAlhaithamKnowledge(alhaitham), true);
    assert.equal(host.getSanitizedPlayers(varka.id)[alhaitham.id].attachedCardCount, 0);

    await skillManager.onTurnStart(varka, ctx);
    assert.equal(skillManager.getVarkaLetterTarget(varka.id), null);
    targetId = kazuha.id;
    const finalLetter = alhaitham.handCards.pop();
    varka.handCards.push(finalLetter);
    assert.equal(await skillManager.executeActiveSkill(varka, 'varka_write', ctx), true);
    skillManager.onPlayerDeath(kazuha);
    assert.ok(deck.discardPile.includes(finalLetter));
    assert.equal(skillManager.getAttachedCardCount(kazuha), 1);
  } finally {
    host.abort();
  }
});
