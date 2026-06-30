// ============================================================
// heroes.ts — 武将数据定义（52个武将，含完整技能 + 定位标签）
// ============================================================

export interface HeroData {
  id: string;          // 唯一标识
  name: string;        // 武将名（中文）
  enName: string;      // 武将名（英文/罗马音）
  title: string;       // 称号
  region: string;      // 所属区域
  element: string;     // 元素属性：风/岩/雷/草/水/火/冰
  maxHp: number;       // 血量
  isGod: boolean;      // 是否七神之一
  gender: 'male' | 'female'; // 性别
  role: string;        // 定位：输出/防御/爆发/控制/辅助/娱乐
  skillName?: string;  // 技能名
  skillDesc?: string;  // 技能描述
  skills?: { name: string; desc: string }[]; // 详细技能列表
}

/**
 * 全部武将数据 - 48个武将
 * 七神(7): 温迪、钟离、雷电将军、纳西妲、芙宁娜、玛薇卡、哥伦比娅
 * 非神(41)
 */
export const ALL_HEROES: HeroData[] = [
  // ========== 七神 7人 ==========
  {
    id: 'venti', name: '温迪', enName: 'Venti', title: '高天的歌者', region: '蒙德', element: '风', maxHp: 5, isGod: true, gender: 'male', role: '防御',
    skillName: '自由·高天·吟游',
    skillDesc: '体力上限与手牌上限之和恒为8',
    skills: [
      { name: '自由', desc: '锁定技，你的体力上限与手牌上限之和恒为8。每回合限一次，你可以将你的体力上限调整为1至7之间的任意值。' },
      { name: '高天', desc: '当你受到伤害后，你可以将手牌补至手牌上限。' },
      { name: '吟游', desc: '回合外，你可将所有手牌当一张酒打出。' },
    ]
  },
  {
    id: 'zhongli', name: '钟离', enName: 'Zhongli', title: '尘世闲游', region: '璃月', element: '岩', maxHp: 6, isGod: true, gender: 'male', role: '防御',
    skillName: '契约·玉璋·闲游',
    skillDesc: '玉璋标记护体，建立契约，交换座位',
    skills: [
      { name: '契约', desc: '你的回合开始时，你可以将1枚"玉璋"标记交给一名其他角色，与其建立"契约"关系，直到你的下一回合开始，你与该角色可以互相使用对方手牌区中的牌。' },
      { name: '玉璋', desc: '锁定技，每轮开始时，你增加2枚"玉璋"标记（上限4）。"玉璋"标记：当拥有该标记的角色受到伤害时，须移去1枚标记，抵消1点伤害。' },
      { name: '闲游', desc: '出牌阶段限一次，你可以弃置1枚"玉璋"，与场上任意一名其他角色交换座位。' },
    ]
  },
  {
    id: 'raiden', name: '雷电将军', enName: 'Raiden Shogun', title: '一心净土', region: '稻妻', element: '雷', maxHp: 5, isGod: true, gender: 'female', role: '输出',
    skillName: '永恒·御决·无想',
    skillDesc: '无法成为杀的目标，御决决斗，无想蓄力',
    skills: [
      { name: '永恒', desc: '锁定技，你无法成为【杀】的目标。' },
      { name: '御决', desc: '出牌阶段限一次，你可以先后选择在场两名其他角色各摸1张牌，令前者对后者发起【决斗】。决斗结束后，你可以选择是否对败者打出一张【杀】。' },
      { name: '无想', desc: '当你对一名角色造成【杀】的伤害时，你可以防止此伤害，并获得1枚"无想"标记（上限3）。若你不防止此伤害，则此伤害改为X+1点（X=标记数×2），然后你移去所有"无想"标记。' },
    ]
  },
  {
    id: 'nahida', name: '纳西妲', enName: 'Nahida', title: '白草净华', region: '须弥', element: '草', maxHp: 4, isGod: true, gender: 'female', role: '爆发',
    skillName: '智慧·囚笼·比喻',
    skillDesc: '免疫延时锦囊，锦囊双发，锦囊转化',
    skills: [
      { name: '智慧', desc: '锁定技，延时类锦囊无法对你生效。' },
      { name: '囚笼', desc: '当你使用一张非延时类锦囊牌时，你可以弃置1张基本牌。若如此做，此牌生效两次。' },
      { name: '比喻', desc: '出牌阶段限一次，你可以将手上的所有锦囊牌当作一张非延时类锦囊牌使用。' },
    ]
  },
  {
    id: 'furina', name: '芙宁娜', enName: 'Furina', title: '不休独舞', region: '枫丹', element: '水', maxHp: 5, isGod: true, gender: 'female', role: '防御',
    skillName: '正义·歌颂·罪舞',
    skillDesc: '判定牌回收，体力变化判定回复，濒死限定技',
    skills: [
      { name: '正义', desc: '锁定技，你的判定牌判定生效后，你获得此牌。' },
      { name: '歌颂', desc: '当你的体力值发生变化后，你可以进行一次判定。若结果为黑色，你回复1点体力（此效果不会触发"歌颂"自身）。' },
      { name: '罪舞', desc: '限定技，当你首次处于濒死状态时，你立即进行一次判定。若结果为红色，回复3点体力；若结果为黑色，你指定一名角色造成3点伤害。' },
    ]
  },
  {
    id: 'mavuika', name: '玛薇卡', enName: 'Mavuika', title: '焚夜以炎', region: '纳塔', element: '火', maxHp: 5, isGod: true, gender: 'female', role: '输出',
    skillName: '战争·圣火·领袖',
    skillDesc: '火伤加成，杀转火杀回血，高血量减伤',
    skills: [
      { name: '战争', desc: '锁定技，你与所有纳塔阵营角色造成的火属性伤害+1。' },
      { name: '圣火', desc: '你可以将【杀】当【火杀】使用。若此【火杀】造成伤害，你回复1点体力。' },
      { name: '领袖', desc: '你的回合结束后，若你的体力值为全场最高（或之一），则直到你的下回合开始，你累计最多受到2点伤害。' },
    ]
  },
  {
    id: 'columbina', name: '哥伦比娅', enName: 'Columbina', title: '空月归乡', region: '挪德卡莱', element: '水', maxHp: 5, isGod: true, gender: 'female', role: '爆发',
    skillName: '少女/月神',
    skillDesc: '空月标记护体，转换形态',
    skills: [
      { name: '少女', desc: '出牌阶段开始时和结束时，你可分别减少1点体力上限，获得2枚"空月"标记。当你成为非延时类锦囊牌的目标时，可以移去1枚"空月"标记，令此锦囊对你无效。当你的体力上限为1时，将体力上限重置为5（若你是主公则为6），体力值不变，失去"少女"，然后获得"月神"。' },
      { name: '月神', desc: '每回合限一次，摸牌阶段，你可以移去1枚"空月"标记，令本回合摸牌数+X（X为当前"空月"标记数）。然后你可以选择至多X名其他角色，这些角色的下回合摸牌阶段摸牌数-1。' },
    ]
  },

  // ========== 非神武将 41人 ==========

  // 那维莱特 - 水
  {
    id: 'neuvillette', name: '那维莱特', enName: 'Neuvillette', title: '谕告的潮音', region: '枫丹', element: '水', maxHp: 5, isGod: false, gender: 'male', role: '控制',
    skillName: '审判·龙权',
    skillDesc: '修改判定牌花色点数，判定后摸牌',
    skills: [
      { name: '审判', desc: '当一名角色的判定牌即将生效时，你可以弃置1张红色牌，将此判定牌的花色改为你指定的任意花色；或弃置1张黑色牌，将此判定牌的点数改为你指定的任意点数。' },
      { name: '龙权', desc: '每回合限一次，当一名角色的判定牌判定生效后，你可以摸1张牌。' },
    ]
  },
  // 八重神子 - 雷
  {
    id: 'yae', name: '八重神子', enName: 'Yae Miko', title: '浮世笑百姿', region: '稻妻', element: '雷', maxHp: 5, isGod: false, gender: 'female', role: '辅助',
    skillName: '狐魅·宫司',
    skillDesc: '狐魅博弈，宫司看牌分配',
    skills: [
      { name: '狐魅', desc: '出牌阶段限一次，你可以选择两名其他角色选择一项：1.对另一名角色使用一张【杀】；2.交给你一张牌。' },
      { name: '宫司', desc: '当你受到伤害后，你可以观看牌堆顶的3张牌，放回1张牌，并将剩下2张牌交给任意角色，若你以此法将牌交给了其他角色，则该角色在其下个出牌阶段内使用【杀】的次数上限+1。' },
    ]
  },
  // 希诺宁 - 岩
  {
    id: 'xilonen', name: '希诺宁', enName: 'Xilonen', title: '焮火铸魂', region: '纳塔', element: '岩', maxHp: 5, isGod: false, gender: 'female', role: '辅助',
    skillName: '工匠·祝福',
    skillDesc: '复制装备，摸牌加成',
    skills: [
      { name: '工匠', desc: '出牌阶段限一次，你可以失去1点体力，然后选择一名装备区里有牌的角色。若其装备区牌数为X，你摸X张牌，并选择X张手牌作为这些装备牌的复制品，装备给任意角色。' },
      { name: '祝福', desc: '出牌阶段限一次，你可以选择一名角色，令其下回合摸牌数增加X（X为其装备区里的牌数除以2，向下取整）。' },
    ]
  },
  // 兹白 - 岩
  {
    id: 'zibai', name: '兹白', enName: 'Zibai', title: '华黍由仪', region: '璃月', element: '岩', maxHp: 6, isGod: false, gender: 'female', role: '爆发',
    skillName: '三尸',
    skillDesc: '质数摸牌，玉璋标记，五谷加成',
    skills: [
      { name: '三尸', desc: '1.你的回合内，每当你于出牌阶段内已使用的牌数为X（X为质数），且该牌的点数亦为X时，摸X张牌。2.你的回合内，每当你打出5的倍数张牌时，你获得1枚"玉璋"标记（上限2）。3.你存活时，所有角色使用的【五谷丰登】亮出的牌数+1，你从中获得两张牌。' },
    ]
  },
  // 优菈 - 冰
  {
    id: 'eula', name: '优菈', enName: 'Eula', title: '浪涌之瞬', region: '蒙德', element: '冰', maxHp: 6, isGod: false, gender: 'female', role: '输出',
    skillName: '浪花·不归·复仇',
    skillDesc: '杀伤害=距离，距离修正',
    skills: [
      { name: '浪花', desc: '锁定技，你的【杀】造成的伤害等于目标对你的距离。' },
      { name: '不归', desc: '锁定技，其他角色对你的距离+1。' },
      { name: '复仇', desc: '锁定技，你对其他角色的距离-1。' },
    ]
  },
  // 莱欧斯利 - 冰
  {
    id: 'wriothesley', name: '莱欧斯利', enName: 'Wriothesley', title: '劫中泛滥', region: '枫丹', element: '冰', maxHp: 5, isGod: false, gender: 'male', role: '控制',
    skillName: '狱长·公爵',
    skillDesc: '乐不思蜀联动，黑色牌当乐不思蜀',
    skills: [
      { name: '狱长', desc: '锁定技，当一名角色的【乐不思蜀】判定结果生效后，你对该角色造成1点伤害；判定结果失效后，你获得其1张牌。' },
      { name: '公爵', desc: '出牌阶段，若你于上个回合结束后曾通过"狱长"获得过牌，可将任意一张黑色牌当【乐不思蜀】使用。' },
    ]
  },
  // 胡桃 - 火
  {
    id: 'hutao', name: '胡桃', enName: 'Hu Tao', title: '赤团开时', region: '璃月', element: '火', maxHp: 5, isGod: false, gender: 'female', role: '爆发',
    skillName: '往生·幽蝶',
    skillDesc: '濒死拿牌，扣血增伤',
    skills: [
      { name: '往生', desc: '锁定技，当一名角色进入濒死状态时，你获得其所有手牌；当一名角色死亡后，你获得其装备区里的所有牌。' },
      { name: '幽蝶', desc: '出牌阶段限一次，若你的体力值大于1，你可以失去体力至1点。若如此做，直到回合结束，你造成的所有伤害值+1；若你于此回合内击杀一名角色，你回复2点体力。' },
    ]
  },
  // 凝光 - 岩
  {
    id: 'ningguang', name: '凝光', enName: 'Ningguang', title: '掩月天权', region: '璃月', element: '岩', maxHp: 4, isGod: false, gender: 'female', role: '控制',
    skillName: '七星·天权·璇玑',
    skillDesc: '限定技回血+玉璋，猜花色博弈，回合结束控牌堆顶',
    skills: [
      { name: '七星', desc: '限定技，出牌阶段，你可以令你与一名角色各恢复2点体力并获得2枚"玉璋"标记。' },
      { name: '天权', desc: '出牌阶段限一次，你可以观看牌堆顶的3张牌，并指定一名其他角色猜测这些牌的花色。若其猜错的数量为：3张：该角色跳过其下个摸牌阶段；2张：该角色流失1点体力；1张：该角色获得其中点数最大的牌；0张：该角色获得这3张牌，并回复1点体力。结算后弃置剩下的牌。' },
      { name: '璇玑', desc: '你的回合结束后，你可以将一张牌置于牌堆顶。' },
    ]
  },
  // 艾尔海森 - 草
  {
    id: 'alhaitham', name: '艾尔海森', enName: 'Alhaitham', title: '敕诫枢谋', region: '须弥', element: '草', maxHp: 5, isGod: false, gender: 'male', role: '控制',
    skillName: '书记·知论·代贤',
    skillDesc: '锦囊不可无懈，扣牌当无懈，回收双无懈锦囊',
    skills: [
      { name: '书记', desc: '锁定技，你使用的锦囊牌不能被【无懈可击】响应。' },
      { name: '知论', desc: '出牌阶段限两次，你可以将一张手牌置于你的武将牌上，以此法置于武将牌上的牌可当做【无懈可击】使用。' },
      { name: '代贤', desc: '每轮限一次，当一张锦囊牌被连续使用两张【无懈可击】后，你可以获得此锦囊牌。' },
    ]
  },
  // 魈 - 风
  {
    id: 'xiao', name: '魈', enName: 'Xiao', title: '护法夜叉', region: '璃月', element: '风', maxHp: 4, isGod: false, gender: 'male', role: '控制',
    skillName: '金鹏·降魔',
    skillDesc: '杀需双色，弃同花色牌封花色',
    skills: [
      { name: '金鹏', desc: '锁定技，当其他角色对你使用【杀】时，须额外使用一张花色不同的【杀】，否则此【杀】对你无效。' },
      { name: '降魔', desc: '出牌阶段开始时，你可以弃置一种花色的所有手牌。若如此做，直到你的下个回合开始，所有角色不能使用该花色的牌。每种花色每局限1次。' },
    ]
  },
  // 枫原万叶 - 风
  {
    id: 'kazuha', name: '枫原万叶', enName: 'Kaedehara Kazuha', title: '叶落风随', region: '稻妻', element: '风', maxHp: 5, isGod: false, gender: 'male', role: '防御',
    skillName: '红枫·落叶',
    skillDesc: '扣置基本牌为"枫"获效果，回合结束弃枫当顺手/过河',
    skills: [
      { name: '红枫', desc: '出牌阶段，你可以将任意张基本牌扣置于你的武将牌上，称为"枫"。你每有一张"枫"，根据其原牌名获得以下效果：【杀】攻击范围+1；【闪】摸一张牌；【桃】回复2点体力；【酒】下一张【杀】伤害+2。' },
      { name: '落叶', desc: '回合结束时，若你有"枫"，则需弃置一张"枫"，将其当【顺手牵羊】或【过河拆桥】使用。' },
    ]
  },
  // 夜兰 - 水
  {
    id: 'yelan', name: '夜兰', enName: 'Yelan', title: '兰生幽谷', region: '璃月', element: '水', maxHp: 6, isGod: false, gender: 'female', role: '控制',
    skillName: '络命·幽客',
    skillDesc: '造成伤害视为体力流失，查看身份+额外回合',
    skills: [
      { name: '络命', desc: '锁定技，你造成的伤害均视为体力流失。' },
      { name: '幽客', desc: '每回合限一次，你可以查看一名其他角色的身份牌。若被你查看过身份的角色死亡，当前回合结束后，你获得一个完整回合。' },
    ]
  },
  // 宵宫 - 火
  {
    id: 'yoimiya', name: '宵宫', enName: 'Yoimiya', title: '琉焰华舞', region: '稻妻', element: '火', maxHp: 5, isGod: false, gender: 'female', role: '控制',
    skillName: '琉金·夏祭',
    skillDesc: '免疫火伤，挂烟花标记引爆',
    skills: [
      { name: '琉金', desc: '锁定技，你不能受到火属性伤害。' },
      { name: '夏祭', desc: '若场上没有"烟花"标记，你可以弃置一张红桃牌，为一名角色挂上"烟花"标记。拥有"烟花"标记的角色使用【桃】时，【桃】的效果无效，然后该角色及其距离为1以内的所有角色各受到1点火属性伤害，最后移除"烟花"标记。' },
    ]
  },
  // 妮露 - 水
  {
    id: 'nilou', name: '妮露', enName: 'Nilou', title: '莲光落舞筵', region: '须弥', element: '水', maxHp: 5, isGod: false, gender: 'female', role: '防御',
    skillName: '花舞·莲步',
    skillDesc: '判定摸牌回血，切换状态转换牌色',
    skills: [
      { name: '花舞', desc: '回合开始时，你可以连续判定三次牌堆顶的牌：获得所有黑色判定牌；若其中至少有两张红色牌，你回复1点体力，然后弃置这些红色判定牌。' },
      { name: '莲步', desc: '游戏开始时，你处于"水环"状态。出牌阶段限一次，你可以切换【水环】为【水月】，或切换【水月】为【水环】。' },
      { name: '水环', desc: '你的黑色手牌可以当【闪】使用或打出。' },
      { name: '水月', desc: '你的红色手牌可以当【杀】使用或打出。' },
    ]
  },
  // 迪希雅 - 火
  {
    id: 'dehya', name: '迪希雅', enName: 'Dehya', title: '炽鬃之狮', region: '须弥', element: '火', maxHp: 5, isGod: false, gender: 'female', role: '防御',
    skillName: '佣兵·鬃狮',
    skillDesc: '拼点拿牌承伤，被杀反击回血',
    skills: [
      { name: '佣兵', desc: '出牌阶段限一次，你可以与一名其他角色拼点：若你赢，则你获得其所有手牌，这些牌不计入你的手牌上限。直到你下回合开始，该角色受到的所有伤害均由你承担。回合开始时，你返还该角色仍在你手中的手牌。' },
      { name: '鬃狮', desc: '你受到【杀】的伤害后，可以对目标来源使用1张【杀】，若此【杀】造成伤害，则你回复1点体力。' },
    ]
  },
  // 莉奈娅 - 岩
  {
    id: 'lyneya', name: '莉奈娅', enName: 'Lyneya', title: '博闻异旅', region: '挪德卡莱', element: '岩', maxHp: 5, isGod: false, gender: 'female', role: '爆发',
    skillName: '谶鸟·启喻',
    skillDesc: '牌堆顶可见，打出牌时翻牌堆顶联动',
    skills: [
      { name: '谶鸟', desc: '锁定技，牌堆顶的1张牌对你始终可见。' },
      { name: '启喻', desc: '当你主动使用一张手牌的时候，你可以翻开牌堆顶的一张牌：若这两张牌花色相同，你可以将翻开的这张牌当作你的牌使用，然后收回你原本使用的那张手牌；若这两张牌点数相同，你可以将你原本打出的这张牌当作翻开的牌使用，然后收回翻开的牌。' },
    ]
  },
  // 荒泷一斗 - 岩
  {
    id: 'itto', name: '荒泷一斗', enName: 'Arataki Itto', title: '花坂豪快', region: '稻妻', element: '岩', maxHp: 6, isGod: false, gender: 'male', role: '娱乐',
    skillName: '赤鬼·天牛',
    skillDesc: '自伤获乐不思蜀效果摸牌，手牌少时魔免',
    skills: [
      { name: '赤鬼', desc: '你的回合开始时，你可以失去1点体力，然后获得【乐不思蜀】效果（已有效果不叠加）。若生效，你摸牌等同于当前体力值数量的手牌，并跳过弃牌阶段。若失效，你弃置所有手牌，并恢复1点体力。' },
      { name: '天牛', desc: '锁定技，当你的手牌数小于你的体力值时，其他角色不能以你为目标使用单体锦囊牌。' },
    ]
  },
  // 珊瑚宫心海 - 水
  {
    id: 'kokomi', name: '珊瑚宫心海', enName: 'Sangonomiya Kokomi', title: '真珠之智', region: '稻妻', element: '水', maxHp: 5, isGod: false, gender: 'female', role: '辅助',
    skillName: '军师·神巫',
    skillDesc: '给牌后触发桃园，桃园治疗摸牌',
    skills: [
      { name: '军师', desc: '出牌阶段限一次，你可以将任意张手牌交给一名其他角色，然后可以视为你使用一张【桃园结义】。' },
      { name: '神巫', desc: '当你打出【桃园结义】时，若此时回复的体力值总和为X，则你摸X张牌。' },
    ]
  },
  // 基尼奇 - 草
  {
    id: 'kinich', name: '基尼奇', enName: 'Kinich', title: '回火之狩', region: '纳塔', element: '草', maxHp: 4, isGod: false, gender: 'male', role: '输出',
    skillName: '回火·阿乔·价格',
    skillDesc: '装备当火攻，火伤连环，被杀需双杀',
    skills: [
      { name: '回火', desc: '你可以将一张装备牌当【火攻】使用，若造成伤害，你可获得目标的任意一张手牌。' },
      { name: '阿乔', desc: '出牌阶段限一次，当你造成火属性伤害时，你可以令一名角色进入连环状态。' },
      { name: '价格', desc: '当你成为【杀】的目标时，来源需要再对你使用一张【杀】。若其无法使用，则此【杀】无效，若打出【杀】，则你不可闪避该伤害。' },
    ]
  },
  // 玛拉妮 - 水
  {
    id: 'mualani', name: '玛拉妮', enName: 'Mualani', title: '哗啦啦逐浪客', region: '纳塔', element: '水', maxHp: 5, isGod: false, gender: 'female', role: '控制',
    skillName: '流泉·团结',
    skillDesc: '扣牌为泉延期火伤，少摸牌连环',
    skills: [
      { name: '流泉', desc: '出牌阶段限一次，你可以将一张手牌扣置于你的武将牌上，称为"泉"，仅能被【过河拆桥】和【顺手牵羊】拆除。下回合开始时，若"泉"还在，你收回它，然后对距离1以内的一名角色造成1点火属性伤害。' },
      { name: '团结', desc: '摸牌阶段开始时，你可以选择少摸1张牌，然后选择至多2名角色进入连环状态。' },
    ]
  },
  // 凯亚 - 冰
  {
    id: 'kaeya', name: '凯亚', enName: 'Kaeya', title: '西风骑士团骑兵团长', region: '蒙德', element: '冰', maxHp: 5, isGod: false, gender: 'male', role: '输出',
    skillName: '午后·骑队',
    skillDesc: '扣牌当酒，最后杀多目标',
    skills: [
      { name: '午后', desc: '出牌阶段限一次，你可以将至多两张手牌扣置于你的武将牌上，这些牌可当【酒】使用。以此法存储的酒不超过2张。' },
      { name: '骑队', desc: '当你使用的【杀】是你最后一张手牌时，此【杀】可以额外指定至多距离内的3个目标，且此【杀】造成的伤害 = 4 - 目标数。' },
    ]
  },
  // 迪卢克 - 火
  {
    id: 'diluc', name: '迪卢克', enName: 'Diluc', title: '晨曦酒庄的贵公子', region: '蒙德', element: '火', maxHp: 5, isGod: false, gender: 'male', role: '输出',
    skillName: '晨曦·夜枭',
    skillDesc: '扣牌当酒，弃非杀无限火杀',
    skills: [
      { name: '晨曦', desc: '摸牌阶段开始前，你可以将至多两张手牌扣置于你的武将牌上，这些牌可当【酒】使用。以此法存储的酒不超过2张。' },
      { name: '夜枭', desc: '出牌阶段限一次，你可以弃置除【杀】以外的所有手牌。若如此做，本回合你使用【杀】无次数限制，且均视为【火杀】。' },
    ]
  },
  // 琴 - 风
  {
    id: 'jean', name: '琴', enName: 'Jean', title: '西风骑士团代理团长', region: '蒙德', element: '风', maxHp: 6, isGod: false, gender: 'female', role: '辅助',
    skillName: '代理·蒲骑',
    skillDesc: '交换手牌后回复，跳过AOE摸牌',
    skills: [
      { name: '代理', desc: '出牌阶段限一次，你可以与一名其他角色交换所有手牌。然后，交换后手牌数较少的一方回复1点体力。' },
      { name: '蒲骑', desc: '你可以跳过【南蛮入侵】和【万箭齐发】，并摸一张牌。' },
    ]
  },
  // 可莉 - 火
  {
    id: 'klee', name: '可莉', enName: 'Klee', title: '逃跑的太阳', region: '蒙德', element: '火', maxHp: 4, isGod: false, gender: 'female', role: '娱乐',
    skillName: '炸鱼·禁闭',
    skillDesc: '扣牌为炸弹判定炸伤，炸弹爆炸时追加伤害并翻面',
    skills: [
      { name: '炸鱼', desc: '出牌阶段限一次，你可以将一张手牌扣置于自己的判定区上，称为"炸弹"（每名角色最多1张）。该角色的摸牌阶段开始前，其进行一次判定：若判定牌与"炸弹"牌名相同，则其受到2点火伤，然后弃置此"炸弹"；若不同，则"炸弹"移至下一位存活玩家。' },
      { name: '禁闭', desc: '当"炸弹"爆炸时，你可以再弃置一张牌名与判定牌相同的手牌，令其再受到2点伤害，然后你将武将牌翻面。' },
    ]
  },
  // 刻晴 - 雷
  {
    id: 'keqing', name: '刻晴', enName: 'Keqing', title: '霆霓快雨', region: '璃月', element: '雷', maxHp: 5, isGod: false, gender: 'female', role: '输出',
    skillName: '七星·玉衡',
    skillDesc: '限定技回复+玉璋，雷杀无视防具不占次数',
    skills: [
      { name: '七星', desc: '限定技，你可以令你与一名角色各恢复2点体力并获得2枚"玉璋"。' },
      { name: '玉衡', desc: '锁定技，你使用的【雷杀】无视防具且不计入出杀次数。' },
    ]
  },
  // 神里绫华 - 冰
  {
    id: 'ayaka', name: '神里绫华', enName: 'Kamisato Ayaka', title: '白鹭霜华', region: '稻妻', element: '冰', maxHp: 4, isGod: false, gender: 'female', role: '爆发',
    skillName: '白鹭·霜灭',
    skillDesc: '打出手牌时手牌少则补至体力值，决斗造成伤害附加冰寒标记',
    skills: [
      { name: '白鹭', desc: '当你打出手牌时，若手牌数小于体力值，你将手牌数摸至体力值。' },
      { name: '霜灭', desc: '当你使用【决斗】对一名角色造成伤害时，该角色获得"冰寒"标记。"冰寒"标记：拥有该标记的角色受到火属性伤害时，此伤害+1，然后移除此标记。' },
    ]
  },
  // 甘雨 - 冰
  {
    id: 'ganyu', name: '甘雨', enName: 'Ganyu', title: '循循守月', region: '璃月', element: '冰', maxHp: 4, isGod: false, gender: 'female', role: '控制',
    skillName: '霜华·月海·麟迹',
    skillDesc: '万箭附加冰寒，翻面回收打出的牌，默认麒麟弓',
    skills: [
      { name: '霜华', desc: '当你使用【万箭齐发】时，受到伤害的角色获得"冰寒"标记。"冰寒"标记：拥有该标记的角色受到火属性伤害时，此伤害+1，然后移除此标记。' },
      { name: '月海', desc: '回合结束后，你可以将你的武将牌翻面，获得该回合内打出的所有手牌。' },
      { name: '麟迹', desc: '锁定技，装备区没有武器时，默认拥有麒麟弓效果。' },
    ]
  },
  // 申鹤 - 冰
  {
    id: 'shenhe', name: '申鹤', enName: 'Shenhe', title: '孤辰茕怀', region: '璃月', element: '冰', maxHp: 5, isGod: false, gender: 'female', role: '输出',
    skillName: '劈观·鹤归',
    skillDesc: '杀指定目标后给冰翎标记，杀造成伤害附加冰寒',
    skills: [
      { name: '劈观', desc: '出牌阶段限一次，当你使用【杀】指定一名角色为目标后，可令该角色获得一个"冰翎"标记，持续到你的下回合开始。拥有"冰翎"标记的角色，每次需使用两张【闪】才能抵消一张【杀】。' },
      { name: '鹤归', desc: '当你使用【杀】对一名角色造成伤害时，该角色获得"冰寒"标记。"冰寒"标记：拥有该标记的角色受到火属性伤害时，此伤害+1，然后移除此标记。' },
    ]
  },
  // 奈芙尔 - 草
  {
    id: 'nefur', name: '奈芙尔', enName: 'Nefur', title: '湮沙的秘闻', region: '挪德卡莱', element: '草', maxHp: 4, isGod: false, gender: 'female', role: '控制',
    skillName: '秘闻·蛇蝎·北网',
    skillDesc: '查看标记手牌，杀当借刀杀人，体力流失摸牌',
    skills: [
      { name: '秘闻', desc: '出牌阶段限一次，你可以查看一名其他角色的1张手牌并进行标记，持续到你的下回合开始。若该角色使用此牌，其流失1点体力；若该角色弃置此牌，其须再弃置一张牌。' },
      { name: '蛇蝎', desc: '你可以将一张【杀】当【借刀杀人】使用。若因此打出的【杀】造成伤害，此伤害视为体力流失。' },
      { name: '北网', desc: '当有其他角色流失体力时，你摸一张牌。' },
    ]
  },
  // 菈乌玛 - 草
  {
    id: 'lauma', name: '菈乌玛', enName: 'Lauma', title: '永月的祀歌', region: '挪德卡莱', element: '草', maxHp: 5, isGod: false, gender: 'female', role: '辅助',
    skillName: '咏月·灵使',
    skillDesc: '弃牌令他人摸牌自回血，霜月标记分担伤害',
    skills: [
      { name: '咏月', desc: '出牌阶段限一次，你可以弃置两张颜色不同的手牌，然后选择一名其他角色摸两张牌，你回复1点体力。' },
      { name: '灵使', desc: '出牌阶段限一次，你可以指定一名其他角色，获得"霜月"标记。若你的当前体力值大于该角色，则你代替其承受伤害；若你的当前体力值小于等于该角色，则其代替你承受伤害。此效果持续到你的下回合开始。' },
    ]
  },
  // 欧洛伦 - 雷
  {
    id: 'olorun', name: '欧洛伦', enName: 'Olorun', title: '深黯的谜烟', region: '纳塔', element: '雷', maxHp: 5, isGod: false, gender: 'male', role: '娱乐',
    skillName: '庇笛·残魂',
    skillDesc: '手牌当闪电，体力流失偷技能',
    skills: [
      { name: '庇笛', desc: '你可以将一张手牌当【闪电】打出。' },
      { name: '残魂', desc: '回合开始时，你可以失去1点体力，然后选择场上任意一名已死亡角色，获得其一项技能至下回合开始。' },
    ]
  },
  // 茜特菈莉 - 冰
  {
    id: 'citlali', name: '茜特菈莉', enName: 'Citlali', title: '白星黑曜', region: '纳塔', element: '冰', maxHp: 4, isGod: false, gender: 'female', role: '控制',
    skillName: '萨满·记忆·黑曜',
    skillDesc: '预言判定花色，替换判定牌，黑桃决斗双杀',
    skills: [
      { name: '萨满', desc: '每轮限一次，判定开始前，你可以预言本回合即将进行的判定的花色。若判定结果与你预言的花色相同，你回复1点体力；若不同，你摸一张牌。' },
      { name: '记忆', desc: '当一名角色进行判定时，若本局游戏上次判定牌仍在弃牌堆中，你可以将其替换本次判定牌。' },
      { name: '黑曜', desc: '若场上出现黑桃判定牌（判定结果），你可以选择与该判定角色进行决斗。此决斗中，对方每回合需打出两张【杀】。' },
    ]
  },

  // ========== 新增角色 9人 ==========

  // 法尔伽 - 风 - 蒙德
  {
    id: 'varka', name: '法尔伽', enName: 'Varka', title: '北风骑士', region: '蒙德', element: '风', maxHp: 5, isGod: false, gender: 'male', role: '输出',
    skillName: '远征·北风·写信',
    skillDesc: '远程杀摸牌，弃牌无限杀，扣牌标记无视距离',
    skills: [
      { name: '远征', desc: '当你使用【杀】指定距离大于1的角色为目标时，你摸一张牌。' },
      { name: '北风', desc: '当你使用【杀】时，你可以弃置一张手牌，令此【杀】不计入本回合出杀次数限制。' },
      { name: '写信', desc: '你可以将一张手牌扣置于一名其他角色的武将牌上，本回合对其出杀时无视距离。该角色的下回合开始时，其获得此牌。' },
    ]
  },
  // 阿贝多 - 岩 - 蒙德
  {
    id: 'albedo', name: '阿贝多', enName: 'Albedo', title: '白垩之子', region: '蒙德', element: '岩', maxHp: 6, isGod: false, gender: 'male', role: '辅助',
    skillName: '炼金',
    skillDesc: '用杀/闪合成虚拟装备给队友',
    skills: [
      { name: '炼金', desc: '你的回合各限一次，你可以：将两张【杀】转换为一柄虚拟武器，装备给一名角色；将两张【闪】转换为一副虚拟防具，装备给一名角色。以此法装备的虚拟牌，其基础属性以第一张被转换的牌为准（花色、点数、牌名）。当虚拟装备被移出装备区时，还原为第一张被转换的牌进入弃牌堆。' },
    ]
  },
  // 菲林斯 - 水 - 挪德卡莱
  {
    id: 'philins', name: '菲林斯', enName: 'Philins', title: '诡灯陌影', region: '挪德卡莱', element: '雷', maxHp: 5, isGod: false, gender: 'male', role: '爆发',
    skillName: '长茔·灯妖',
    skillDesc: '角色死亡额外摸牌，血量匹配时濒死即死',
    skills: [
      { name: '长茔', desc: '当一名角色死亡时，你额外摸2张牌。' },
      { name: '灯妖', desc: '回合开始时，若你的当前体力值等于场上存活角色数，则直到本回合结束，当你使一名角色进入濒死状态时，该角色立即阵亡。' },
    ]
  },
  // 伊涅芙 - 雷 - 挪德卡莱
  {
    id: 'inev', name: '伊涅芙', enName: 'Inev', title: '轰隆雷鸣波', region: '挪德卡莱', element: '雷', maxHp: 5, isGod: false, gender: 'female', role: '爆发',
    skillName: '破镜·机娘',
    skillDesc: '连续两张牌点数之和为11摸2弃1，牌点数对11取模',
    skills: [
      { name: '破镜', desc: '你的回合内，若你连续使用的两张手牌点数之和为11，你摸2张牌，然后弃1张牌。' },
      { name: '机娘', desc: '你的牌点数对11取模（J=11=0, Q=12=1, K=13=2）。' },
    ]
  },
  // 提纳里 - 草 - 须弥
  {
    id: 'tighnari', name: '提纳里', enName: 'Tighnari', title: '浅蔚轻行', region: '须弥', element: '草', maxHp: 4, isGod: false, gender: 'male', role: '辅助',
    skillName: '巡林·生论',
    skillDesc: '观看牌堆顶X张牌分配基本牌（X=存活人数），桃可多人回复',
    skills: [
      { name: '巡林', desc: '回合开始时，你可以观看牌堆顶的X张牌（X为场上存活角色数），然后将其中的基本牌分配给任意角色，其余牌以原顺序放回牌堆顶。' },
      { name: '生论', desc: '当你使用【桃】时，可以额外指定一名其他角色，该角色也回复1点体力。' },
    ]
  },
  // 赛诺 - 雷 - 须弥
  {
    id: 'cyno', name: '赛诺', enName: 'Cyno', title: '缄秘的裁遣', region: '须弥', element: '雷', maxHp: 5, isGod: false, gender: 'male', role: '控制',
    skillName: '素论·风纪',
    skillDesc: '长武器需双闪/不可闪避，杀造成伤害后弃装备',
    skills: [
      { name: '素论', desc: '当你使用【杀】指定目标时，若你的武器距离≥2，目标需使用两张【闪】来抵消；若你的武器距离≥4，此【杀】不可被【闪】响应。' },
      { name: '风纪', desc: '当你使用【杀】造成伤害后，你可以弃置目标装备区里的一张牌。' },
    ]
  },
  // 神里绫人 - 水 - 稻妻
  {
    id: 'ayato', name: '神里绫人', enName: 'Kamisato Ayato', title: '磐祭叶守', region: '稻妻', element: '水', maxHp: 5, isGod: false, gender: 'male', role: '控制',
    skillName: '社奉·家主',
    skillDesc: '拼点拿双方牌，差值小于4则下张牌可多目标',
    skills: [
      { name: '社奉', desc: '当你参与拼点时，你获得双方用于拼点的牌。' },
      { name: '家主', desc: '你的回合限一次，你可以与一名角色拼点。若双方拼点牌的差值绝对值小于4，则你使用的下一张手牌可以额外选择任意个合法目标。' },
    ]
  },
  // 瓦雷莎 - 雷 - 纳塔
  {
    id: 'varesa', name: '瓦雷莎', enName: 'Varesa', title: '悠暇豪劲', region: '纳塔', element: '雷', maxHp: 6, isGod: false, gender: 'female', role: '防御',
    skillName: '豪宴·牛劲',
    skillDesc: '手牌上限20，手牌多则下回合额外摸牌，前3张牌须额外弃牌',
    skills: [
      { name: '豪宴', desc: '你的手牌上限为20。回合结束时，若你的手牌数大于当前体力值，你下回合摸牌阶段额外摸X张牌（X=手牌数-体力值）。' },
      { name: '牛劲', desc: '你的回合，每主动使用或打出前3张牌时，你须额外弃置一张牌。' },
    ]
  },
  // 恰斯卡 - 风 - 纳塔
  {
    id: 'chasca', name: '恰斯卡', enName: 'Chasca', title: '巡宇翦定', region: '纳塔', element: '风', maxHp: 5, isGod: false, gender: 'female', role: '输出',
    skillName: '超越·调停',
    skillDesc: '未出杀则下回合+2出杀次数，弃杀标记角色反伤',
    skills: [
      { name: '超越', desc: '若你本回合内未主动使用过【杀】或【决斗】，则下回合你使用【杀】的次数上限+2。此效果不叠加。' },
      { name: '调停', desc: '你的回合限一次，你可以弃置一张【杀】，然后选择一名角色对其标记。该角色回合内，若该角色使用【杀】或【决斗】，其先受到1点伤害。该角色弃置的【杀】或【决斗】归你所有。' },
    ]
  },
  // 林尼 - 火 - 枫丹
  {
    id: 'lyney', name: '林尼', enName: 'Lyney', title: '货光幻戏', region: '枫丹', element: '火', maxHp: 5, isGod: false, gender: 'male', role: '爆发',
    skillName: '魔术·奇迹',
    skillDesc: '展示手牌令全场猜类型，猜错掉血猜对回血；手牌为零时摸至体力上限',
    skills: [
      { name: '魔术', desc: '出牌阶段限一次，你可以将一张手牌背面朝上置于桌面，然后令所有其他角色依次猜测此牌为"基本牌"或"非基本牌"：猜对的角色回复1点体力；猜错的角色流失1点体力。然后你摸X张牌（X为本次猜错的角色数），最后将此牌交给任意一名角色。' },
      { name: '奇迹', desc: '每局限一次，当你的手牌数首次为0时，你摸牌至体力上限。' },
    ]
  },
  // 娜维娅 - 岩 - 枫丹
  {
    id: 'navia', name: '娜维娅', enName: 'Navia', title: '明花蔓舵', region: '枫丹', element: '岩', maxHp: 5, isGod: false, gender: 'female', role: '控制',
    skillName: '刺玫·说服',
    skillDesc: '受到的伤害恒为1；交出/获得手牌令目标下回合受限制',
    skills: [
      { name: '刺玫', desc: '锁定技，你受到的伤害恒为1。' },
      { name: '说服', desc: '出牌阶段限一次，你可以交给其一张手牌，令其下回合不能使用【杀】；或获得其一张手牌，令其下回合不能成为【杀】的目标。' },
    ]
  },
  // 克洛琳德 - 雷 - 枫丹
  {
    id: 'clorinde', name: '克洛琳德', enName: 'Clorinde', title: '秉烛狝影', region: '枫丹', element: '雷', maxHp: 5, isGod: false, gender: 'female', role: '输出',
    skillName: '决斗·剧团',
    skillDesc: '摸牌后高点数可当决斗；禁用全场技能',
    skills: [
      { name: '决斗', desc: '出牌阶段限一次，你可以从牌堆中摸一张牌，本回合该牌及以上点数的手牌可当【决斗】打出。' },
      { name: '剧团', desc: '每局限一次，你禁用场上所有角色的技能（不改变已经存在的状态），直到你阵亡或你的下一回合开始。' },
    ]
  },
  // 希格雯 - 水 - 枫丹
  {
    id: 'sigewinne', name: '希格雯', enName: 'Sigewinne', title: '龙女妙变', region: '枫丹', element: '水', maxHp: 4, isGod: false, gender: 'female', role: '辅助',
    skillName: '护士·温度',
    skillDesc: '弃桃令队友回血；打出桃回复量+2',
    skills: [
      { name: '护士', desc: '出牌阶段限一次，你可以弃置一张【桃】，然后令一名其他角色回复1点体力。' },
      { name: '温度', desc: '锁定技，你打出【桃】时，回复量+2。' },
    ]
  },
];

/** 获取所有七神 */
export function getGods(): HeroData[] {
  return ALL_HEROES.filter(h => h.isGod);
}

/** 获取非七神武将 */
export function getNonGods(): HeroData[] {
  return ALL_HEROES.filter(h => !h.isGod);
}

/** 根据ID获取武将 */
export function getHeroById(id: string): HeroData | undefined {
  return ALL_HEROES.find(h => h.id === id);
}

/** 根据名称获取武将 */
export function getHeroByName(name: string): HeroData | undefined {
  return ALL_HEROES.find(h => h.name === name);
}
