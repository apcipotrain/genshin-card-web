// ============================================================
// Card.ts — 卡牌数据模型与工具函数
// ============================================================

import {
  Card, CardData, CardType, SuitType, ColorType,
  ElementType, MagicTimeType, MagicTargetType, EquipmentType
} from './types';

export { ColorType, MagicTimeType };

/** 从原始数据创建 Card 对象 */
export function createCard(data: CardData): Card {
  return {
    id: data.Id,
    name: data.Name,
    type: data.Type,
    suit: data.Suit,
    number: data.Number,
    description: data.Description,
    element: data.Element ?? ElementType.None,
    equipType: data.EquipType ?? EquipmentType.None,
    weaponRange: data.WeaponRange ?? 0,
    cardSource: null,
    isVirtual: false,
  };
}

/** 获取卡牌颜色 */
export function getCardColor(card: Card): ColorType {
  if (card.suit === SuitType.Heart || card.suit === SuitType.Diamond) return ColorType.Red;
  if (card.suit === SuitType.Spade || card.suit === SuitType.Club) return ColorType.Black;
  return ColorType.None;
}

/** 获取锦囊子类型（延时/非延时） */
export function getMagicSubType(card: Card): MagicTimeType {
  if (card.type !== CardType.Magic) return MagicTimeType.None;
  if (card.name === '乐不思蜀' || card.name === '闪电' || card.name === '兵粮寸断') {
    return MagicTimeType.Delay;
  }
  return MagicTimeType.Instant;
}

/** 获取锦囊目标类型（单体/群体） */
export function getMagicTarget(card: Card): MagicTargetType {
  if (card.type !== CardType.Magic) return MagicTargetType.None;
  const multiNames = ['铁索连环', '南蛮入侵', '万箭齐发', '桃园结义', '五谷丰登'];
  if (multiNames.includes(card.name)) return MagicTargetType.Multi;
  return MagicTargetType.Single;
}

/** 获取进攻马距离加成 */
export function getAttackHorseRange(card: Card): number {
  return card.equipType === EquipmentType.OffensiveHorse ? 1 : 0;
}

/** 获取防御马距离加成 */
export function getDefendHorseRange(card: Card): number {
  return card.equipType === EquipmentType.DefensiveHorse ? 1 : 0;
}

/** 判断是否为广义的"杀" */
export function isSlash(card: Card | null): boolean {
  if (!card) return false;
  return card.name === '杀' || card.name === '火杀' || card.name === '雷杀';
}

/** 获取卡牌详细描述字符串 */
export function getCardDetail(card: Card): string {
  const suitMap: Record<string, string> = {
    Heart: '♥', Diamond: '♦', Spade: '♠', Club: '♣', None: ''
  };
  const numMap: Record<number, string> = {
    1: 'A', 11: 'J', 12: 'Q', 13: 'K'
  };
  const suitStr = suitMap[card.suit] ?? '';
  const numStr = numMap[card.number] ?? card.number.toString();
  return `${suitStr}${numStr} ${card.name}`;
}

/** 克隆一张卡牌（不复制运行时状态） */
export function cloneCard(card: Card): Card {
  return { ...card, cardSource: null, isVirtual: false };
}

/** 创建虚拟卡牌 */
export function createVirtualCard(name: string, type: CardType, suit: SuitType = SuitType.None, element: ElementType = ElementType.None): Card {
  return {
    id: -1,
    name,
    type,
    suit,
    number: 0,
    description: `虚拟【${name}】`,
    element,
    equipType: EquipmentType.None,
    weaponRange: 0,
    cardSource: null,
    isVirtual: true,
  };
}
