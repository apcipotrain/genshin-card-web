// ============================================================
// DistanceCalc.ts — 距离计算工具
// ============================================================

import { PlayerState, EquipmentType } from './types';

/**
 * 计算两个存活玩家之间的实际物理距离
 * 实际距离 = 基础环形距离 + 目标防御马 - 自己进攻马 + 优菈被动修正
 */
export function getDistance(
  source: PlayerState,
  target: PlayerState,
  allPlayers: PlayerState[]
): number {
  const alivePlayers = allPlayers.filter(p => !p.isDead);
  // 使用 id 比较而非引用比较（PVP 模式下序列化对象引用不同）
  const sourceIdx = alivePlayers.findIndex(p => p.id === source.id);
  const targetIdx = alivePlayers.findIndex(p => p.id === target.id);

  if (sourceIdx === -1 || targetIdx === -1) return 99;

  const totalAlive = alivePlayers.length;
  const diff = Math.abs(sourceIdx - targetIdx);
  const baseDistance = Math.min(diff, totalAlive - diff);

  let finalDistance = baseDistance;

  // 目标防御马 +1
  if (target.equipZone[EquipmentType.DefensiveHorse]) {
    finalDistance += 1;
  }

  // 自己进攻马 -1
  if (source.equipZone[EquipmentType.OffensiveHorse]) {
    finalDistance -= 1;
  }

  // 优菈-不归（锁定技）：其他角色对优菈的距离+1（等效优菈自带防御马）
  if (target.heroId === 'eula' && source.heroId !== 'eula') {
    finalDistance += 1;
  }

  // 优菈-复仇（锁定技）：优菈对其他角色的距离-1（等效优菈自带进攻马）
  if (source.heroId === 'eula' && target.heroId !== 'eula') {
    finalDistance -= 1;
  }

  return Math.max(0, finalDistance);
}

/**
 * 检查 source 是否在 target 的距离范围内
 */
export function isInRange(
  source: PlayerState,
  target: PlayerState,
  range: number,
  allPlayers: PlayerState[]
): boolean {
  return getDistance(source, target, allPlayers) <= range;
}

/**
 * 获取存活玩家列表（按座位顺序）
 */
export function getAlivePlayers(players: PlayerState[]): PlayerState[] {
  return players.filter(p => !p.isDead);
}

/**
 * 寻找下一个存活玩家
 */
export function findNextAlivePlayer(
  currentIndex: number,
  players: PlayerState[]
): number {
  let next = (currentIndex + 1) % players.length;
  while (players[next].isDead) {
    next = (next + 1) % players.length;
  }
  return next;
}
