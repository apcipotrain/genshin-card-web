// ============================================================
// Player.ts — 玩家类
// ============================================================

import {
  PlayerState, RoleType, GenderType, EquipmentType, Card
} from './types';

export function createPlayer(id: number, playerName: string, heroId: string, heroName: string, gender: GenderType, maxHp: number): PlayerState {
  return {
    id,
    playerName,
    heroId,
    name: heroName,
    gender,
    role: RoleType.None,
    maxHp,
    hp: maxHp,
    handCards: [],
    equipZone: {
      [EquipmentType.Weapon]: null,
      [EquipmentType.Armor]: null,
      [EquipmentType.OffensiveHorse]: null,
      [EquipmentType.DefensiveHorse]: null,
    },
    judgeZone: [],
    isFlipped: false,
    isChained: false,
    isDead: false,
    skipDrawPhase: false,
    skipPlayPhase: false,
    skipDiscardPhase: false,
    slashUsedCount: 0,
    nextSlashDamageBonus: 0,
    wineUsedThisTurn: false,
  };
}

/** 手牌上限（温迪特殊：8 - 体力上限） */
export function getHandLimit(player: PlayerState): number {
  if (player.heroId === 'venti') {
    return Math.max(1, 8 - player.maxHp);
  }
  return Math.max(0, player.hp);
}

/** 获取武器射程 */
export function getWeaponRange(player: PlayerState): number {
  const weapon = player.equipZone[EquipmentType.Weapon];
  return weapon?.weaponRange ?? 1;
}

/** 是否有手牌 */
export function hasHandCards(player: PlayerState): boolean {
  return player.handCards.length > 0;
}

/** 获取身份中文名 */
export function getRoleChineseName(role: RoleType): string {
  switch (role) {
    case RoleType.Monarch: return '主公';
    case RoleType.Minister: return '忠臣';
    case RoleType.Rebel: return '反贼';
    case RoleType.Traitor: return '内奸';
    default: return '未知';
  }
}

/** 深拷贝玩家状态 */
export function clonePlayerState(player: PlayerState): PlayerState {
  return {
    ...player,
    handCards: player.handCards.map(c => ({ ...c })),
    equipZone: { ...player.equipZone },
    judgeZone: player.judgeZone.map(c => ({ ...c })),
  };
}
