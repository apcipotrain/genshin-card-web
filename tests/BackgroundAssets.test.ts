import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getPVEBackground,
  getPVEBattleBackgrounds,
  getRandomPVPBackground,
  PVP_BACKGROUNDS,
  toCssImage,
} from '../src/ui/BackgroundAssets';

test('PVE chapters resolve to their named regional backgrounds', () => {
  assert.equal(getPVEBackground('mondstadt', '蒙德'), 'Resources/Backgrounds/mengde.png');
  assert.equal(getPVEBackground('liyue', '璃月'), 'Resources/Backgrounds/liyue.png');
  assert.equal(getPVEBackground('inazuma', '稻妻'), 'Resources/Backgrounds/daoqi.png');
  assert.equal(getPVEBackground('sumeru', '须弥'), 'Resources/Backgrounds/xumi.png');
  assert.equal(getPVEBackground('spiralabyss', '至冬'), 'Resources/Backgrounds/shenjingluoxuan.png');
});

test('PVE battles retain the legacy ten-image regional rotation pools', () => {
  assert.deepEqual(getPVEBattleBackgrounds('璃月'), [
    'Resources/Backgrounds/20.png',
    'Resources/Backgrounds/21.png',
    'Resources/Backgrounds/22.png',
    'Resources/Backgrounds/23.png',
    'Resources/Backgrounds/24.png',
    'Resources/Backgrounds/25.png',
    'Resources/Backgrounds/26.png',
    'Resources/Backgrounds/27.png',
    'Resources/Backgrounds/28.png',
    'Resources/Backgrounds/29.png',
  ]);
  assert.equal(getPVEBattleBackgrounds('至冬')[0], 'Resources/Backgrounds/10.png');
});

test('PVP backgrounds are selected only from pvp1 through pvp10', () => {
  assert.equal(PVP_BACKGROUNDS.length, 10);
  assert.equal(getRandomPVPBackground(() => 0), 'Resources/Backgrounds/pvp1.png');
  assert.equal(getRandomPVPBackground(() => 0.9999), 'Resources/Backgrounds/pvp10.png');
});

test('background paths are safely wrapped as CSS image values', () => {
  assert.equal(toCssImage('Resources/Backgrounds/pvp4.png'), 'url("Resources/Backgrounds/pvp4.png")');
});
