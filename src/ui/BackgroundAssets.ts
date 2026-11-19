// ============================================================
// BackgroundAssets.ts — PVE chapter and PVP mode background map
// ============================================================

export const PVE_BACKGROUND_BY_REGION: Readonly<Record<string, string>> = {
  '蒙德': 'Resources/Backgrounds/mengde.png',
  '璃月': 'Resources/Backgrounds/liyue.png',
  '稻妻': 'Resources/Backgrounds/daoqi.png',
  '须弥': 'Resources/Backgrounds/xumi.png',
  '枫丹': 'Resources/Backgrounds/fengdan.png',
  '纳塔': 'Resources/Backgrounds/nata.png',
  '挪德卡莱': 'Resources/Backgrounds/nuodekalai.png',
  '至冬': 'Resources/Backgrounds/zhidong.png',
};

/** PVE 对局仍使用旧版地区图池：每个已配置地区对应连续的 10 张编号图。 */
const PVE_BATTLE_BACKGROUND_BASE_BY_REGION: Readonly<Record<string, number>> = {
  '蒙德': 10,
  '璃月': 20,
  '稻妻': 30,
  '须弥': 40,
  '枫丹': 50,
  '纳塔': 60,
  '挪德卡莱': 70,
};

export const PVP_BACKGROUNDS: readonly string[] = Array.from(
  { length: 10 },
  (_, index) => `Resources/Backgrounds/pvp${index + 1}.png`,
);

export function getPVEBackground(chapterId: string, region: string): string {
  if (chapterId === 'spiralabyss') {
    return 'Resources/Backgrounds/shenjingluoxuan.png';
  }
  return PVE_BACKGROUND_BY_REGION[region] || PVE_BACKGROUND_BY_REGION['蒙德'];
}

export function getPVEBattleBackgrounds(region: string): string[] {
  const base = PVE_BATTLE_BACKGROUND_BASE_BY_REGION[region]
    ?? PVE_BATTLE_BACKGROUND_BASE_BY_REGION['蒙德'];
  return Array.from(
    { length: 10 },
    (_, index) => `Resources/Backgrounds/${base + index}.png`,
  );
}

export function getRandomPVPBackground(random: () => number = Math.random): string {
  const index = Math.min(
    PVP_BACKGROUNDS.length - 1,
    Math.max(0, Math.floor(random() * PVP_BACKGROUNDS.length)),
  );
  return PVP_BACKGROUNDS[index];
}

export function toCssImage(path: string): string {
  return `url("${path}")`;
}
