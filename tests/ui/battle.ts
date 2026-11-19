// Deterministic browser fixture using production components. No production route or debug hook.
import '../../src/ui/main.css';
import '../../src/ui/game.css';
import '../../src/ui/travel.css';
import '../../src/ui/battle-polish.css';
import '../../src/ui/battle-feedback.css';
import '../../src/ui/battle-responsive.css';
import '../../src/ui/battle-seats.css';
import '../../src/ui/battle-identity.css';
import '../../src/ui/battle-hud.css';
import '../../src/ui/pvp-battle.css';
import { GamePage, HumanWebUIDriver } from '../../src/ui/GamePage';
import { BattlePresentation } from '../../src/ui/BattlePresentation';
import { GameSession, GameSessionCancelled } from '../../src/core/GameSession';
import { createPlayer } from '../../src/core/Player';
import { DeckManager } from '../../src/core/DeckManager';
import { EventBus } from '../../src/core/EventBus';
import { EquipEffectManager } from '../../src/core/EquipEffectManager';
import { CARD_DATA } from '../../src/data/CardData';
import { getHeroById } from '../../src/data/heroes';
import { Faction, GamePhase, GenderType, RoleType } from '../../src/core/types';
import { getLevelById } from '../../src/data/PVELevels';

let page: any;
const toolbar = document.createElement('section');
const toolbarToggle = document.createElement('button');
toolbarToggle.textContent = '收起测试工具';
toolbarToggle.style.cssText = 'position:fixed;right:12px;top:76px;z-index:4001;padding:5px 8px;font-size:11px;border:1px solid #9ab7a8;border-radius:4px;background:#eff5ee;color:#234f42';
toolbarToggle.onclick = () => {
  const collapsed = toolbar.style.display === 'none';
  toolbar.style.display = collapsed ? 'flex' : 'none';
  toolbarToggle.textContent = collapsed ? '收起测试工具' : '展开测试工具';
};
toolbar.setAttribute('aria-label', '回归测试控制台');
toolbar.style.cssText = 'position:fixed;right:10px;bottom:12px;z-index:4000;width:268px;padding:10px;background:#eff5ee;border:1px solid #9dbaad;border-radius:8px;display:flex;gap:6px;flex-wrap:wrap;';
const result = document.createElement('output');
result.id = 'fixture-result';
result.style.cssText = 'width:100%;font:12px/1.6 sans-serif;color:#214c40';
const status = (message: string) => { result.textContent = message; };
const reportFailure = (error: unknown) => {
  if (error instanceof GameSessionCancelled) return;
  status(`FAIL：${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
};

function reset() {
  page?.hide();
  const app = document.querySelector('#app')!;
  app.replaceChildren();
  page = new GamePage();
  app.append(page.render());
  page.session = new GameSession();
  page.mode = 'pvp'; page.pvpMyPlayerId = 0; page.humanPlayerIdx = 0;
  page.gameStarted = true; page.isGameOver = false;
  const ids = ['shenhe', 'jean', 'hutao', 'venti', 'raiden', 'ayato', 'ningguang', 'ganyu'];
  page.players = ids.map((id, index) => {
    const hero = getHeroById(id)!;
    const player = createPlayer(index, index ? `AI-${index}` : '测试玩家', id, hero.name,
      hero.gender === 'male' ? GenderType.Male : GenderType.Female, hero.maxHp, hero.region);
    player.role = index === 0 ? RoleType.Minister : index === 1 ? RoleType.Monarch : RoleType.None;
    return player;
  });
  page.currentTurnPlayerId = 0;
  page.eventBus = new EventBus();
  page.deck = new DeckManager(page.eventBus); page.deck.init(CARD_DATA);
  const pool = [...page.deck.drawPile];
  const used = new Set<number>();
  const take = (name: string) => {
    const card = pool.find(card => card.name === name && !used.has(card.id))!;
    used.add(card.id); return card;
  };
  page.players[0].handCards = ['五谷丰登', '无懈可击', '杀', '闪', '桃', '无中生有'].map(take);
  page.players.slice(1).forEach((player: any) => { player.handCards = pool.filter(card => !used.has(card.id)).slice(0, 4); });
  page.humanDriver = new HumanWebUIDriver(0, page);
  page.show(); page.renderBattlefield(); page.renderHandCards();
  page.battlePresentation = new BattlePresentation(page.gameMainEl, page.battlefieldEl, page.session,
    (id: number) => { const p = page.players.find((p: any) => p.id === id); return p ? { name: p.name, imageSrc: `../../Resources/Characters/${p.name}.png`, element: getHeroById(p.heroId)?.element } : undefined; },
    (id: number) => page.getSeatElement(id));
  // Production image URLs are relative to the app root.
  page.applyBattlefieldBackground('Resources/Backgrounds/pvp1.png');
  page.startTimer();
  page.phaseEl.textContent = '出牌阶段';
  page.addLog('固定八人场景：验证动作展示、五谷丰登和倒计时。');
  status('场景已就绪');
}
function button(label: string, action: () => void) {
  const button = document.createElement('button'); button.textContent = label;
  button.style.cssText = 'border:1px solid #9ab7a8;background:white;color:#234f42;border-radius:4px;padding:5px 8px;font-size:12px;cursor:pointer';
  button.onclick = () => {
    action();
    if (innerWidth < 1100) { toolbar.style.display = 'none'; toolbarToggle.textContent = '展开测试工具'; }
  };
  toolbar.append(button);
}
button('出牌与响应', () => {
  const hand = page.players[0].handCards;
  page.presentBattleCard('play', { playerId: 0, card: hand.find((c: any) => c.name === '杀') });
  page.handlePVPGameEvent({ type: 'CardTargeted', data: { sourceId: 0, targetId: 5 } });
  page.presentBattleCard('response', { playerId: 2, card: hand.find((c: any) => c.name === '闪') });
  page.presentBattleCard('discard', { playerId: 4, card: hand.find((c: any) => c.name === '桃') });
  status('显示出牌、响应和弃牌三种动作');
});
button('技能发动', () => { page.showSkillFloatAnimation(0, '劈观'); page.showSkillFloatAnimation(4, '御决'); status('显示角色、技能与元素色'); });
button('出牌按钮', () => {
  page.closeTableInteraction(); page.clearGraceCards();
  page.humanDriver.cancelInteraction();
  void page.humanDriver.promptPlayCard(page.players[0], { players: page.players }).then((index: number) => status(`出牌阶段已提交：${index}`)).catch(reportFailure);
  status('选中一张牌后，确认与取消应在同一水平线上；取消选择不会结束回合');
});
button('寒冰剑效果', () => {
  page.closeTableInteraction(); page.humanDriver.cancelInteraction();
  void page.humanDriver.promptYesNo('是否发动寒冰剑，改为弃置目标的两张牌？').then((value: boolean) => status(`PASS：寒冰剑选择 ${value ? '发动' : '不发动'}，仍在原牌桌`)).catch(reportFailure);
});
button('顺手／拆桥选牌', () => {
  page.closeTableInteraction(); page.humanDriver.cancelInteraction();
  void page.humanDriver.promptRansackHand(page.players[0], 1, { players: page.players }).then((index: number) => status(`PASS：目标手牌选择 ${index}，未打开全屏弹窗`)).catch(reportFailure);
});
button('丈八选牌', () => {
  page.closeTableInteraction(); page.humanDriver.cancelInteraction();
  void page.humanDriver.promptZhanBa(page.players[0], {}).then((value: unknown) => status(`PASS：丈八结果 ${JSON.stringify(value)}，没有延迟自动提交`)).catch(reportFailure);
});
button('贯石斧弃牌', () => {
  page.closeTableInteraction(); page.humanDriver.cancelInteraction();
  const player = page.players[0];
  const before = [...player.handCards];
  const axe = page.deck.drawPile.find((card: any) => card.name === '贯石斧');
  player.equipZone.Weapon = axe;
  player.equipZone.Armor = page.deck.drawPile.find((card: any) => card.name === '八卦阵');
  page.renderBattlefield();
  const manager: any = new EquipEffectManager(page.deck, page.eventBus, null as any, new Map([[0, page.humanDriver]]), page.players);
  void manager.discardTwoForWeapon(player, axe).then(() => {
    const discarded = before.filter((card: any) => !player.handCards.includes(card));
    page.renderBattlefield(); page.renderHandCards();
    status(`实际弃置：${discarded.map((card: any) => card.name).join('、')}；贯石斧保留：${player.equipZone.Weapon === axe}`);
  }).catch(reportFailure);
  status('请选择相邻的五谷丰登、无懈可击；确认后检查实际弃牌。斧本体不应出现在候选中');
});
button('满装备与状态', () => {
  const player = page.players[5] ?? page.players[1];
  const findCard = (name: string) => page.deck.drawPile.find((card: any) => card.name === name);
  player.equipZone.Weapon = findCard('青龙偃月刀');
  player.equipZone.Armor = findCard('八卦阵');
  player.equipZone.OffensiveHorse = findCard('紫骍');
  player.equipZone.DefensiveHorse = findCard('的卢');
  page.players[0].equipZone.Armor = findCard('仁王盾');
  player.judgeZone = [findCard('闪电'), findCard('乐不思蜀')];
  player.isChained = true;
  player.attachedCardCount = 2;
  player._sealedSuits = { Spade: true, Heart: true };
  if (page.players[3]) page.players[3].hp = 0;
  page.renderBattlefield();
  page.renderHandCards();
  page.handlePVPGameEvent({ type: 'TurnStarted', data: { playerId: player.id, playerName: player.name } });
  page.handlePVPGameEvent({ type: 'PhaseChanged', data: { playerId: player.id, phase: GamePhase.Play } });
  status('比较有装备、判定牌、状态和濒死标签的座位；点击装备或状态查看全部内容');
});
button('回合弃牌', () => {
  page.closePVPInteraction(page.pvpRequestId);
  page.humanDriver.cancelInteraction();
  const player = page.players[0];
  page.handlePVPGameEvent({ type: 'TurnStarted', data: { playerId: player.id, playerName: player.name } });
  page.handlePVPGameEvent({ type: 'PhaseChanged', data: { playerId: player.id, phase: GamePhase.Discard } });
  void page.humanDriver.promptDiscard(player, { discardHandLimit: player.maxHp }).then((value: unknown) => {
    status(`弃牌提交：${JSON.stringify(value)}`);
  }).catch(reportFailure);
});
button('公开温迪身份', () => {
  const player = page.players.find((p: any) => p.id === 3);
  if (!player || page.mode !== 'pvp') return;
  const players = page.players.map((p: any) => p === player
    ? { ...p, role: RoleType.Rebel, isDead: true, hp: 0 }
    : p);
  page.handlePVPGameEvent({ type: 'PlayerDied', data: { playerId: player.id, playerName: player.name, players } });
});
button('拆桥来源', () => {
  const card = page.players[1].handCards[0];
  page.handlePVPGameEvent({ type: 'CardDiscarded', data: { card } });
  page.handlePVPGameEvent({ type: 'CardDismantled', data: { card, playerId: 1 } });
  status('中心应只出现一次“琴·弃牌”，没有旧式浮动飞牌');
});
button('装备／判定选牌', () => {
  page.closeTableInteraction(); page.humanDriver.cancelInteraction();
  const target = page.players[1];
  target.equipZone.Weapon = page.deck.drawPile.find((c: any) => c.name === '寒冰剑');
  target.equipZone.Armor = page.deck.drawPile.find((c: any) => c.name === '八卦阵');
  page.renderBattlefield();
  void page.humanDriver.promptZone(page.players[0], 1, { players: page.players }).then((value: unknown) => status(`PASS：区域选择 ${JSON.stringify(value)}`)).catch(reportFailure);
  status('点击琴的装备区，再选择一张装备；明牌展示在原牌桌内');
});
button('五谷＋无懈', () => {
  page.closePVPInteraction(page.pvpRequestId);
  page.initGraceWindow(page.deck.drawPile.slice(10, 18), []);
  page.pvpRequestId = 'fixture-nullify'; page.startPVPCountdown(10);
  page.humanDriver.setPVPRespond((value: boolean) => { status(value ? 'PASS：五谷存在时，无懈可击成功响应' : '无懈可击已跳过'); page.pvpRequestId = null; });
  void page.humanDriver.promptNullification(page.players[0], { players: page.players, nullifyCardName: '五谷丰登', nullifySourceId: 1 }).catch(reportFailure);
  status('请点击手牌中的无懈可击；公共牌区保持显示');
});
button('五谷选牌', () => {
  page.closePVPInteraction(page.pvpRequestId);
  page.initGraceWindow(page.deck.drawPile.slice(10, 18), []);
  page.showGraceCards(page.deck.drawPile.slice(10, 18), (index: number) => {
    page.onGraceCardPicked(page.allGraceCards[index].id, '申鹤'); status('PASS：公共牌已选择，索引 ' + index);
  });
  status('点击一张公共牌');
});
button('关闭公共牌', () => { page.closePVPInteraction(page.pvpRequestId); page.clearGraceCards(); status('公共牌区已关闭'); });
button('10秒计时', () => { page.closePVPInteraction(page.pvpRequestId); page.pvpRequestId = 'fixture-timer'; page.startPVPCountdown(10); status('倒计时10秒，归零不为负数'); });
button('出牌读条', () => {
  page.closePVPInteraction(page.pvpRequestId);
  page.humanDriver.cancelInteraction();
  void page.handlePVPPrompt({ requestId: 'fixture-play-timer', type: 'playCard', timeoutSec: 10,
    data: { state: page.players[0], ctx: { players: page.players } } }).catch(reportFailure);
  status('手牌区上沿显示出牌读条；取消选牌继续计时，结束出牌关闭读条');
});
button('效果超时', () => {
  page.closePVPInteraction(page.pvpRequestId); page.closeTableInteraction();
  page.pvpRequestId = 'fixture-expiry'; page.startPVPCountdown(10);
  void page.humanDriver.promptYesNo('寒冰剑：等待操作，10秒后按服务器关闭事件清理').then(() => status('PASS：超时已清理效果面板，并结束等待')).catch(reportFailure);
  page.session.setTimeout(() => page.closePVPInteraction('fixture-expiry'), 10000);
  status('等待10秒；面板关闭后应能继续下一次交互');
});
const roster = document.createElement('select');
roster.setAttribute('aria-label', '测试阵容');
roster.append(new Option('PVP 八人', ''));
for (const id of [9, 14, 1, 10, 12, 4, 8]) {
  const level = getLevelById(id)!;
  roster.append(new Option(`PVE ${level.allyCount} 对 ${level.enemyCount}`, String(id)));
}
button('退出并重开', () => {
  roster.value = '';
  reset();
});
roster.addEventListener('change', () => {
  reset();
  if (!roster.value) return;
  const level = getLevelById(Number(roster.value))!;
  page.mode = 'pve';
  page.pveLevel = level;
  page.players = page.players.slice(0, level.allyCount + level.enemyCount);
  const heroIds = ['inev', 'kazuha', 'ayato', 'shenhe'].slice(0, level.allyCount).concat(level.enemyHeroes);
  page.players = heroIds.map((heroId, index) => {
    const hero = getHeroById(heroId)!;
    const player = createPlayer(index, index === 0 ? '测试玩家' : hero.name, hero.id, hero.name,
      hero.gender === 'male' ? GenderType.Male : GenderType.Female, hero.maxHp, hero.region);
    player.handCards = page.players[index].handCards;
    player.faction = index < level.allyCount ? Faction.Ally : Faction.Enemy;
    return player;
  });
  page.renderBattlefield();
  status(`PVE ${level.allyCount} 对 ${level.enemyCount}`);
});
toolbar.append(roster, result); document.body.append(toolbar, toolbarToggle); reset();
