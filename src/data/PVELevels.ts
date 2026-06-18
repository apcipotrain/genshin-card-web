// ============================================================
// PVELevels.ts — PVE闯关模式关卡 & 章节数据
// ============================================================

import { getGods, getNonGods, getHeroById } from './heroes';

// ======================== 类型定义 ========================

export interface PVELevel {
  id: number;
  name: string;
  enemyCount: number;
  allyCount: number;
  enemyHeroes: string[];     // 敌方阵容 heroId[]
  turnOrder: string[];       // 'main','ally1','ally2',... 或 敌将heroId
  bannedHeroes: string[];    // 禁选武将
  description?: string;
}

export interface PVEChapter {
  id: string;
  name: string;
  nameEn: string;
  region: string;
  cssClass: string;
  desc: string;
  requiredLevel: number;
  levels: PVELevel[];
  /** 是否为占位章节（未制作） */
  placeholder?: boolean;
}

// ======================== 星级存储 ========================

const STARS_KEY = 'genshin_card_pve_stars';

/** 获取所有关卡星级记录 { levelId: stars } */
export function getPVEStarRecords(): Record<number, number> {
  try {
    const raw = localStorage.getItem(STARS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/** 保存关卡星级（仅当新星级高于旧星级时更新） */
export function savePVEStar(levelId: number, stars: number): void {
  const records = getPVEStarRecords();
  if (stars > (records[levelId] || 0)) {
    records[levelId] = stars;
    localStorage.setItem(STARS_KEY, JSON.stringify(records));
  }
}

/** 获取某章节累计星级 */
export function getChapterStars(chapterId: string): number {
  const chapter = CHAPTERS.find(c => c.id === chapterId);
  if (!chapter) return 0;
  const records = getPVEStarRecords();
  return chapter.levels.reduce((sum, l) => sum + (records[l.id] || 0), 0);
}

/** 检查章节是否解锁 */
export function isChapterUnlocked(chapter: PVEChapter, playerLevel: number): boolean {
  if (chapter.placeholder) return false;
  // 等级要求
  if (playerLevel < chapter.requiredLevel) return false;
  // 第一章无需前置星级
  if (chapter.id === 'mondstadt') return true;
  // 前一章节需累计20星
  const chapters = CHAPTERS;
  const idx = chapters.findIndex(c => c.id === chapter.id);
  if (idx <= 0) return true;
  const prevChapter = chapters[idx - 1];
  const prevStars = getChapterStars(prevChapter.id);
  return prevStars >= 20;
}

// ======================== 关卡数据 ========================

// --- 蒙德 (1-7关) ---
const MONDSTADT_LEVELS: PVELevel[] = [
  {
    id: 1,
    name: '孔雀羽之章·第一幕 凯亚',
    enemyCount: 1,
    allyCount: 3,
    enemyHeroes: ['kaeya'],
    turnOrder: ['main', 'ally1', 'ally2', 'kaeya'],
    bannedHeroes: ['kaeya'],
  },
  {
    id: 2,
    name: '夜枭之章·第一幕 迪卢克',
    enemyCount: 2,
    allyCount: 3,
    enemyHeroes: ['kaeya', 'diluc'],
    turnOrder: ['main', 'ally1', 'ally2', 'kaeya', 'diluc'],
    bannedHeroes: ['kaeya', 'diluc'],
  },
  {
    id: 3,
    name: '浪沫之章·第一幕 优菈',
    enemyCount: 2,
    allyCount: 3,
    enemyHeroes: ['diluc', 'eula'],
    turnOrder: ['main', 'ally1', 'ally2', 'eula', 'diluc'],
    bannedHeroes: ['diluc', 'eula'],
  },
  {
    id: 4,
    name: '幼狮之章·第一幕 琴',
    enemyCount: 3,
    allyCount: 4,
    enemyHeroes: ['jean', 'kaeya', 'diluc'],
    turnOrder: ['main', 'ally1', 'ally2', 'ally3', 'jean', 'kaeya', 'diluc'],
    bannedHeroes: ['jean', 'kaeya', 'diluc'],
  },
  {
    id: 5,
    name: '四叶草之章·第一幕 可莉',
    enemyCount: 2,
    allyCount: 3,
    enemyHeroes: ['klee', 'jean'],
    turnOrder: ['main', 'ally1', 'ally2', 'jean', 'klee'],
    bannedHeroes: ['klee', 'jean'],
  },
  {
    id: 6,
    name: '歌仙之章·第一幕 温迪一',
    enemyCount: 3,
    allyCount: 4,
    enemyHeroes: ['venti', 'jean', 'klee'],
    turnOrder: ['main', 'ally1', 'ally2', 'ally3', 'venti', 'jean', 'klee'],
    bannedHeroes: ['venti', 'jean', 'klee'],
  },
  {
    id: 7,
    name: '歌仙之章·第二幕 温迪二',
    enemyCount: 4,
    allyCount: 4,
    enemyHeroes: ['venti', 'diluc', 'kaeya', 'eula'],
    turnOrder: ['venti', 'main', 'ally1', 'ally2', 'ally3', 'diluc', 'kaeya', 'eula'],
    bannedHeroes: ['venti', 'diluc', 'kaeya', 'eula'],
  },
];

// --- 璃月 (8-19关) ---
const LIYUE_LEVELS: PVELevel[] = [
  { id: 8,  name: '金翅鹏王之章·第一幕 魈',    enemyCount: 1, allyCount: 1, enemyHeroes: ['xiao'],                           turnOrder: ['main', 'xiao'],                                    bannedHeroes: ['xiao'] },
  { id: 9,  name: '玑衡仪之章·第一幕 凝光',    enemyCount: 2, allyCount: 3, enemyHeroes: ['ningguang', 'jean'],                turnOrder: ['main', 'ally1', 'ally2', 'ningguang', 'jean'],      bannedHeroes: ['ningguang', 'jean'] },
  { id: 10, name: '金紫定垂之章·第一幕 刻晴',  enemyCount: 2, allyCount: 3, enemyHeroes: ['keqing', 'ningguang'],             turnOrder: ['main', 'ally1', 'ally2', 'keqing', 'ningguang'],    bannedHeroes: ['keqing', 'ningguang'] },
  { id: 11, name: '引蝶之章·第一幕 胡桃',       enemyCount: 3, allyCount: 3, enemyHeroes: ['hutao', 'kaeya', 'diluc'],        turnOrder: ['main', 'ally1', 'ally2', 'hutao', 'kaeya', 'diluc'], bannedHeroes: ['hutao', 'kaeya', 'diluc'] },
  { id: 12, name: '幽客之章·第一幕 夜兰',       enemyCount: 3, allyCount: 3, enemyHeroes: ['yelan', 'ningguang', 'keqing'],   turnOrder: ['yelan', 'main', 'ally1', 'ally2', 'ningguang', 'keqing'], bannedHeroes: ['yelan', 'ningguang', 'keqing'] },
  { id: 13, name: '仙麟之章·第一幕 甘雨',       enemyCount: 2, allyCount: 2, enemyHeroes: ['ganyu', 'xiao'],                  turnOrder: ['xiao', 'main', 'ally1', 'ganyu'],                    bannedHeroes: ['ganyu', 'xiao'] },
  { id: 14, name: '愁疏之章·第一幕 申鹤',       enemyCount: 2, allyCount: 2, enemyHeroes: ['ganyu', 'shenhe'],               turnOrder: ['shenhe', 'main', 'ally1', 'ganyu'],                  bannedHeroes: ['ganyu', 'shenhe'] },
  { id: 15, name: '白驹之章·第一幕 兹白一',     enemyCount: 3, allyCount: 3, enemyHeroes: ['zibai', 'ganyu', 'keqing'],      turnOrder: ['zibai', 'main', 'ally1', 'ally2', 'ganyu', 'keqing'], bannedHeroes: ['ganyu', 'shenhe'] },
  { id: 16, name: '白驹之章·第二幕 兹白二',     enemyCount: 3, allyCount: 3, enemyHeroes: ['zibai', 'hutao', 'shenhe'],      turnOrder: ['zibai', 'main', 'ally1', 'ally2', 'hutao', 'shenhe'], bannedHeroes: ['zibai', 'hutao', 'shenhe'] },
  { id: 17, name: '古闻之章·第一幕 钟离一',     enemyCount: 4, allyCount: 4, enemyHeroes: ['zhongli', 'yelan', 'keqing', 'ningguang'], turnOrder: ['main', 'ally1', 'ally2', 'ally3', 'zhongli', 'yelan', 'keqing', 'ningguang'], bannedHeroes: ['zhongli', 'yelan', 'keqing', 'ningguang'] },
  { id: 18, name: '古闻之章·第二幕 钟离二',     enemyCount: 4, allyCount: 4, enemyHeroes: ['zhongli', 'hutao', 'ganyu', 'shenhe'],  turnOrder: ['zhongli', 'main', 'ally1', 'ally2', 'ally3', 'hutao', 'ganyu', 'shenhe'], bannedHeroes: ['zhongli', 'hutao', 'ganyu', 'shenhe'] },
  { id: 19, name: '古闻之章·第三幕 钟离三',     enemyCount: 4, allyCount: 4, enemyHeroes: ['zhongli', 'xiao', 'zibai', 'venti'],    turnOrder: ['zibai', 'xiao', 'main', 'ally1', 'ally2', 'ally3', 'venti', 'zhongli'], bannedHeroes: ['zhongli', 'xiao', 'zibai', 'venti'] },
];

// ======================== 章节定义 ========================

export const CHAPTERS: PVEChapter[] = [
  {
    id: 'mondstadt',
    name: '蒙德',
    nameEn: 'Mondstadt',
    region: '蒙德',
    cssClass: 'mondstadt',
    desc: '自由之都，风与牧歌之城',
    requiredLevel: 1,
    levels: MONDSTADT_LEVELS,
  },
  {
    id: 'liyue',
    name: '璃月',
    nameEn: 'Liyue',
    region: '璃月',
    cssClass: 'liyue',
    desc: '契约之港，岩与财富之国',
    requiredLevel: 4,
    levels: LIYUE_LEVELS,
  },
  {
    id: 'inazuma',
    name: '稻妻',
    nameEn: 'Inazuma',
    region: '稻妻',
    cssClass: 'inazuma',
    desc: '永恒之国，雷与樱之岛',
    requiredLevel: 7,
    levels: [],
    placeholder: true,
  },
  {
    id: 'sumeru',
    name: '须弥',
    nameEn: 'Sumeru',
    region: '须弥',
    cssClass: 'sumeru',
    desc: '智慧之都，草与沙之域',
    requiredLevel: 10,
    levels: [],
    placeholder: true,
  },
  {
    id: 'fontaine',
    name: '枫丹',
    nameEn: 'Fontaine',
    region: '枫丹',
    cssClass: 'fontaine',
    desc: '正义之廷，水与律之邦',
    requiredLevel: 13,
    levels: [],
    placeholder: true,
  },
  {
    id: 'natlan',
    name: '纳塔',
    nameEn: 'Natlan',
    region: '纳塔',
    cssClass: 'natlan',
    desc: '战争之国，火与龙之地',
    requiredLevel: 16,
    levels: [],
    placeholder: true,
  },
  {
    id: 'nodkrai',
    name: '挪德卡莱',
    nameEn: 'Nod-Krai',
    region: '挪德卡莱',
    cssClass: 'nodkrai',
    desc: '冰封之地，霜与暗之国',
    requiredLevel: 21,
    levels: [],
    placeholder: true,
  },
  {
    id: 'snezhnaya',
    name: '至冬',
    nameEn: 'Snezhnaya',
    region: '至冬',
    cssClass: 'snezhnaya',
    desc: '冰皇之座，雪与铁之域',
    requiredLevel: 26,
    levels: [],
    placeholder: true,
  },
  {
    id: 'spiralabyss',
    name: '深境螺旋',
    nameEn: 'Spiral Abyss',
    region: '至冬',
    cssClass: 'spiralabyss',
    desc: '螺旋之塔，无尽试炼',
    requiredLevel: 31,
    levels: [],
    placeholder: true,
  },
];

// ======================== 辅助函数 ========================

/** 根据章节ID获取章节 */
export function getChapterById(id: string): PVEChapter | undefined {
  return CHAPTERS.find(c => c.id === id);
}

/** 根据关卡ID获取关卡 */
export function getLevelById(id: number): PVELevel | undefined {
  for (const ch of CHAPTERS) {
    for (const lv of ch.levels) {
      if (lv.id === id) return lv;
    }
  }
  return undefined;
}

/** 获取关卡所在章节 */
export function getChapterForLevel(levelId: number): PVEChapter | undefined {
  return CHAPTERS.find(ch => ch.levels.some(l => l.id === levelId));
}

/** 计算总人数 */
export function getTotalPlayers(level: PVELevel): number {
  return level.allyCount + level.enemyCount;
}

/** 构建候选武将池（排除禁选和已选） */
export function getCandidateHeroes(level: PVELevel, alreadyPicked: string[]): string[] {
  const banned = new Set([...level.bannedHeroes, ...alreadyPicked]);
  // 候选池包含所有未禁未选的武将
  return [...getGods(), ...getNonGods()]
    .filter(h => !banned.has(h.id))
    .map(h => h.id);
}

/** 获取AI副将自动选择的武将 */
export function pickAIAllyHeroes(level: PVELevel, picked: string[]): string[] {
  const result: string[] = [];
  const candidates = getCandidateHeroes(level, picked);
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const needed = level.allyCount - 1; // 减去主将
  for (let i = 0; i < needed && i < shuffled.length; i++) {
    result.push(shuffled[i]);
  }
  return result;
}

/** 获取候选列表（供UI显示），每次显示 allyCount*3 个 */
export function getCandidatePool(level: PVELevel, alreadyPicked: string[]): string[] {
  const candidates = getCandidateHeroes(level, alreadyPicked);
  const poolSize = Math.min(3, candidates.length);
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, poolSize);
}
