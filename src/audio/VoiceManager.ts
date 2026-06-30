// ============================================================
// VoiceManager.ts — 角色技能语音播放管理器 + 技能动画事件
// ============================================================

import { GameEvent } from '../core/types';
import type { EventBus } from '../core/EventBus';
import { cacheGet, cacheSave } from '../data/SettingsCache';

const VOICE_BASE = 'Resources/Voices';

/**
 * 语音文件映射表：角色ID → 技能中文名 → 语音文件列表
 * 只包含实际存在语音文件的技能
 */
const VOICE_MAP: Record<string, Record<string, string[]>> = {
  venti: {
    '自由': ['自由1.mp3', '自由2.mp3'],
    '高天': ['高天1.mp3', '高天2.mp3'],
    '吟游': ['吟游1.mp3', '吟游2.mp3'],
  },
  mavuika: {
    '圣火': ['圣火1.mp3', '圣火2.mp3', '圣火3.mp3'],
    '领袖': ['领袖1.mp3', '领袖2.mp3', '领袖3.mp3'],
  },
  kaeya: {
    '午后': ['午后1.mp3', '午后2.mp3', '午后3.mp3'],
    '骑队': ['骑队1.mp3', '骑队2.mp3', '骑队3.mp3'],
  },
  diluc: {
    '夜枭': ['夜枭1.mp3', '夜枭2.mp3', '夜枭3.mp3'],
    '晨曦': ['晨曦1.mp3', '晨曦2.mp3'],
  },
  jean: {
    '代理': ['代理1.mp3', '代理2.mp3'],
    '蒲骑': ['蒲骑1.mp3', '蒲骑2.mp3'],
  },
  klee: {
    '炸鱼': ['炸鱼1.mp3', '炸鱼2.mp3', '炸鱼3.mp3', '炸鱼4.mp3'],
    '禁闭': ['禁闭1.mp3', '禁闭2.mp3'],
  },
  varka: {
    '写信': ['写信1.mp3'],
    '北风': ['北风1.mp3', '北风2.mp3'],
    '远征': ['远征1.mp3', '远征2.mp3'],
  },
  albedo: {
    '炼金': ['炼金1.mp3', '炼金2.mp3', '炼金3.mp3'],
  },
  eula: {
    '浪花': ['浪花1.mp3', '浪花2.mp3', '浪花3.mp3'],
  },
  ganyu: {
    '霜华': ['霜华1.mp3', '霜华2.mp3', '霜华3.mp3'],
    '月海': ['月海1.mp3', '月海2.mp3'],
    '麟迹': ['麟迹1.mp3', '麟迹2.mp3'],
  },
  hutao: {
    '往生': ['往生1.mp3', '往生2.mp3'],
    '幽蝶': ['幽蝶1.mp3'],
  },
  keqing: {
    '七星': ['七星1.mp3', '七星2.mp3'],
    '玉衡': ['玉衡1.mp3', '玉衡2.mp3', '玉衡3.mp3'],
  },
  ningguang: {
    '七星': ['七星1.mp3'],
    '天权': ['天权1.mp3', '天权2.mp3'],
    '璇玑': ['璇玑1.mp3', '璇玑2.mp3', '璇玑3.mp3'],
  },
  shenhe: {
    '劈观': ['劈观1.mp3', '劈观2.mp3', '劈观3.mp3'],
    '鹤归': ['鹤归1.mp3', '鹤归2.mp3', '鹤归3.mp3'],
  },
  xiao: {
    '金鹏': ['金鹏1.mp3', '金鹏2.mp3'],
    '降魔': ['降魔1.mp3', '降魔2.mp3'],
  },
  yelan: {
    '络命': ['络命1.mp3', '络命2.mp3', '络命3.mp3'],
    '幽客': ['幽客1.mp3', '幽客2.mp3', '幽客3.mp3'],
  },
  zibai: {
    '三尸': ['三尸1.mp3', '三尸2.mp3', '三尸3.mp3'],
  },
  raiden: {
    '御决': ['御决1.mp3', '御决2.mp3', '御决3.mp3'],
    '无想': ['无想1.mp3', '无想2.mp3', '无想3.mp3'],
  },
  yae: {
    '狐魅': ['狐魅1.mp3', '狐魅2.mp3', '狐魅3.mp3'],
    '宫司': ['宫司1.mp3', '宫司2.mp3', '宫司3.mp3', '宫司4.mp3', '宫司5.mp3'],
  },
  kazuha: {
    '红枫': ['红枫1.mp3', '红枫2.mp3', '红枫3.mp3'],
    '落叶': ['落叶1.mp3', '落叶2.mp3', '落叶3.mp3'],
  },
  itto: {
    '赤鬼': ['赤鬼1.mp3', '赤鬼2.mp3', '赤鬼3.mp3', '赤鬼4.mp3', '赤鬼5.mp3', '赤鬼6.mp3'],
  },
  kokomi: {
    '军师': ['军师1.mp3', '军师2.mp3', '军师3.mp3'],
    '神巫': ['神巫1.mp3', '神巫2.mp3', '神巫3.mp3'],
  },
  ayaka: {
    '白鹭': ['白鹭1.mp3', '白鹭2.mp3', '白鹭3.mp3'],
    '霜灭': ['霜灭1.mp3', '霜灭2.mp3', '霜灭3.mp3'],
  },
  ayato: {
    '社奉': ['社奉1.mp3', '社奉2.mp3'],
    '家主': ['家主1.mp3', '家主2.mp3', '家主3.mp3'],
  },
  yoimiya: {
    '琉金': ['琉金1.mp3', '琉金2.mp3', '琉金3.mp3'],
    '夏祭': ['夏祭1.mp3', '夏祭2.mp3', '夏祭3.mp3'],
  },
  nahida: {
    '智慧': ['智慧1.mp3', '智慧2.mp3', '智慧3.mp3'],
    '囚笼': ['囚笼1.mp3', '囚笼2.mp3'],
    '比喻': ['比喻1.mp3', '比喻2.mp3', '比喻3.mp3'],
  },
  dehya: {
    '佣兵': ['佣兵1.mp3', '佣兵2.mp3', '佣兵3.mp3'],
    '鬃狮': ['鬃狮1.mp3', '鬃狮2.mp3', '鬃狮3.mp3'],
  },
  nilou: {
    '花舞': ['花舞1.mp3', '花舞2.mp3', '花舞3.mp3'],
    '莲步': ['莲步1.mp3'],
    '水环': ['水环1.mp3'],
    '水月': ['水月1.mp3'],
  },
  alhaitham: {
    '知论': ['知论1.mp3', '知论2.mp3', '知论3.mp3'],
    '代贤': ['代贤1.mp3', '代贤2.mp3'],
  },
  tighnari: {
    '巡林': ['巡林1.mp3', '巡林2.mp3'],
    '生论': ['生论1.mp3'],
  },
  cyno: {
    '素论': ['素论1.mp3', '素论2.mp3', '素论3.mp3'],
    '风纪': ['风纪1.mp3', '风纪2.mp3', '风纪3.mp3', '风纪4.mp3', '风纪5.mp3', '风纪6.mp3'],
  },
  furina: {
    '正义': ['正义1.mp3', '正义2.mp3', '正义3.mp3', '正义4.mp3', '正义5.mp3'],
    '歌颂': ['歌颂1.mp3', '歌颂2.mp3', '歌颂3.mp3'],
    '罪舞': ['罪舞1.mp3'],
  },
  neuvillette: {
    '审判': ['审判1.mp3', '审判2.mp3', '审判3.mp3'],
    '龙权': ['龙权1.mp3', '龙权2.mp3', '龙权3.mp3'],
  },
  wriothesley: {
    '狱长': ['狱长1.mp3', '狱长2.mp3', '狱长3.mp3'],
    '公爵': ['公爵1.mp3', '公爵2.mp3', '公爵3.mp3'],
  },
  xilonen: {
    '工匠': ['工匠1.mp3', '工匠2.mp3'],
    '祝福': ['祝福1.mp3', '祝福2.mp3', '祝福3.mp3'],
  },
  chasca: {
    '超越': ['超越1.mp3', '超越2.mp3', '超越3.mp3'],
    '调停': ['调停1.mp3', '调停2.mp3', '调停3.mp3'],
  },
  varesa: {
    '豪宴': ['豪宴1.mp3', '豪宴2.mp3', '豪宴3.mp3'],
    '牛劲': ['牛劲1.mp3', '牛劲2.mp3', '牛劲3.mp3'],
  },
  lyney: {
    '魔术': ['魔术1.mp3', '魔术2.mp3', '魔术3.mp3'],
    '奇迹': ['奇迹1.mp3', '奇迹2.mp3', '奇迹3.mp3'],
  },
  navia: {
    '说服': ['说服1.mp3', '说服2.mp3', '说服3.mp3'],
  },
  clorinde: {
    '决斗': ['决斗1.mp3', '决斗2.mp3', '决斗3.mp3'],
    '剧团': ['剧团1.mp3', '剧团2.mp3', '剧团3.mp3'],
  },
  sigewinne: {
    '护士': ['护士1.mp3', '护士2.mp3', '护士3.mp3'],
    '温度': ['温度1.mp3', '温度2.mp3', '温度3.mp3'],
  },
  olorun: {
    '庇笛': ['庇笛1.mp3', '庇笛2.mp3', '庇笛3.mp3'],
    '残魂': ['残魂1.mp3', '残魂2.mp3', '残魂3.mp3'],
  },
  citlali: {
    '萨满': ['萨满1.mp3', '萨满2.mp3', '萨满3.mp3'],
    '记忆': ['记忆1.mp3', '记忆2.mp3', '记忆3.mp3'],
    '黑曜': ['黑曜1.mp3', '黑曜2.mp3', '黑曜3.mp3'],
  },
  kinich: {
    '回火': ['回火1.mp3', '回火2.mp3', '回火3.mp3'],
    '阿乔': ['阿乔1.mp3', '阿乔2.mp3'],
    '价格': ['价格1.mp3', '价格2.mp3', '价格3.mp3'],
  },
  mualani: {
    '流泉': ['流泉1.mp3', '流泉2.mp3'],
    '团结': ['团结1.mp3', '团结2.mp3', '团结3.mp3'],
  },
  columbina: {
    '少女': ['少女1.mp3', '少女2.mp3', '少女3.mp3'],
    '月神': ['月神1.mp3', '月神2.mp3', '月神3.mp3'],
  },
  philins: {
    '长茔': ['长茔1.mp3', '长茔2.mp3', '长茔3.mp3'],
    '灯妖': ['灯妖1.mp3', '灯妖2.mp3', '灯妖3.mp3'],
  },
  inev: {
    '破镜': ['破镜1.mp3', '破镜2.mp3', '破镜3.mp3'],
    '机娘': ['机娘1.mp3', '机娘2.mp3', '机娘3.mp3'],
  },
  lyneya: {
    '启喻': ['启喻1.mp3', '启喻2.mp3', '启喻3.mp3'],
  },
  lauma: {
    '咏月': ['咏月1.mp3', '咏月2.mp3', '咏月3.mp3'],
    '灵使': ['灵使1.mp3', '灵使2.mp3', '灵使3.mp3', '灵使4.mp3', '灵使5.mp3', '灵使6.mp3'],
  },
  nefur: {
    '秘闻': ['秘闻1.mp3', '秘闻2.mp3', '秘闻3.mp3'],
    '蛇蝎': ['蛇蝎1.mp3', '蛇蝎2.mp3', '蛇蝎3.mp3'],
    '北网': ['北网1.mp3', '北网2.mp3', '北网3.mp3'],
  },
  zhongli: {
    '契约': ['契约1.mp3', '契约2.mp3', '契约3.mp3'],
    '玉璋': ['玉璋1.mp3', '玉璋2.mp3', '玉璋3.mp3', '玉璋4.mp3', '玉璋5.mp3'],
    '闲游': ['闲游1.mp3'],
  },
};

/**
 * 角色ID → 角色中文名（用于路径拼接）
 */
const HERO_NAME_MAP: Record<string, string> = {
  venti: '温迪',
  mavuika: '玛薇卡',
  kaeya: '凯亚',
  diluc: '迪卢克',
  jean: '琴',
  klee: '可莉',
  varka: '法尔伽',
  albedo: '阿贝多',
  eula: '优菈',
  ganyu: '甘雨',
  hutao: '胡桃',
  keqing: '刻晴',
  ningguang: '凝光',
  shenhe: '申鹤',
  xiao: '魈',
  yelan: '夜兰',
  zibai: '兹白',
  raiden: '雷电将军',
  yae: '八重神子',
  kazuha: '枫原万叶',
  itto: '荒泷一斗',
  kokomi: '珊瑚宫心海',
  ayaka: '神里绫华',
  ayato: '神里绫人',
  yoimiya: '宵宫',
  nahida: '纳西妲',
  dehya: '迪希雅',
  nilou: '妮露',
  alhaitham: '艾尔海森',
  tighnari: '提纳里',
  cyno: '赛诺',
  furina: '芙宁娜',
  neuvillette: '那维莱特',
  wriothesley: '莱欧斯利',
  xilonen: '希诺宁',
  chasca: '恰斯卡',
  varesa: '瓦雷莎',
  lyney: '林尼',
  navia: '娜维娅',
  clorinde: '克洛琳德',
  sigewinne: '希格雯',
  olorun: '欧洛伦',
  citlali: '茜特菈莉',
  kinich: '基尼奇',
  mualani: '玛拉妮',
  columbina: '哥伦比娅',
  philins: '菲林斯',
  inev: '伊涅芙',
  lyneya: '莉奈娅',
  lauma: '菈乌玛',
  nefur: '奈芙尔',
  zhongli: '钟离',
};

/**
 * 出牌语音映射：牌名 → 文件编号前缀
 * 文件命名格式: Resources/Voices/出牌语音/{编号}【{男/女}】{牌名}.mp3
 */
const CARD_VOICE_PREFIX: Record<string, string> = {
  '杀': '01',
  '火杀': '02',
  '雷杀': '03',
  '闪': '04',
  '决斗': '05',
  '酒': '06',
  '火攻': '07',
  '闪电': '08',
  '无懈可击': '09',
  '顺手牵羊': '10',
  '过河拆桥': '11',
  '乐不思蜀': '12',
  '兵粮寸断': '13',
  '南蛮入侵': '14',
  '万箭齐发': '15',
  '桃园结义': '16',
  '借刀杀人': '17',
  '铁索连环': '18',
  '无中生有': '19',
  '五谷丰登': '20',
};

const CARD_VOICE_BASE = 'Resources/Voices/出牌语音';

/** 技能动画事件名称，GamePage 监听此事件渲染浮空动画 */
export const VOICE_PLAY_EVENT = 'voice:play';

export interface VoicePlayEventDetail {
  heroId: string;
  skillName: string;
  /** 发动技能的玩家ID，用于定位DOM席位 */
  playerId: number;
}

export class VoiceManager {
  private static instance: VoiceManager;

  /** 服务端 EventBus 引用（PVP 模式下用于广播语音事件到客户端） */
  private static eventBus: EventBus | null = null;

  /** 是否为浏览器环境（服务端 Node.js 无 DOM / Audio API，直接降级为空操作） */
  private readonly isBrowser: boolean = typeof window !== 'undefined' && typeof document !== 'undefined';

  private enabled: boolean = true;
  private volume: number = 0.7;
  private currentAudio: HTMLAudioElement | null = null;

  constructor() {
    if (this.isBrowser) {
      this.loadSettings();
    }
  }

  static getInstance(): VoiceManager {
    if (!VoiceManager.instance) {
      VoiceManager.instance = new VoiceManager();
    }
    return VoiceManager.instance;
  }

  /** 设置服务端 EventBus（PVP 模式下由 GameHost 调用） */
  static setEventBus(bus: EventBus | null): void {
    VoiceManager.eventBus = bus;
  }

  // ==================== 设置管理 ====================

  private loadSettings(): void {
    try {
      const enabledStr = cacheGet('voiceEnabled', null);
      if (enabledStr !== null) this.enabled = enabledStr === true || enabledStr === 'true';
      const volumeStr = cacheGet('voiceVolume', null);
      if (volumeStr !== null) this.volume = parseFloat(String(volumeStr));
    } catch (e) { /* ignore */ }
  }

  private saveSettings(): void {
    cacheSave('voiceEnabled', this.enabled, undefined);
    cacheSave('voiceVolume', this.volume, undefined);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    this.saveSettings();
    if (!value && this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
  }

  getVolume(): number {
    return this.volume;
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    this.saveSettings();
    if (this.currentAudio) {
      this.currentAudio.volume = this.volume;
    }
  }

  // ==================== 语音播放 ====================

  /**
   * 播放角色技能语音 + 触发技能动画事件
   * @param heroId 角色ID（如 'venti', 'kaeya'）
   * @param skillName 技能中文名（如 '自由', '骑队'）
   * @param playerId 发动技能的玩家ID，用于动画定位（可选）
   */
  playSkillVoice(heroId: string, skillName: string, playerId?: number): void {
    // 服务端：通过 EventBus 广播语音事件到所有客户端
    if (!this.isBrowser) {
      if (VoiceManager.eventBus) {
        VoiceManager.eventBus.emit(GameEvent.SkillVoicePlay, { heroId, skillName, playerId });
      }
      return;
    }

    // 触发技能动画事件（即使语音未enable也触发动画）
    if (playerId !== undefined) {
      const eventDetail: VoicePlayEventDetail = { heroId, skillName, playerId };
      document.dispatchEvent(new CustomEvent(VOICE_PLAY_EVENT, { detail: eventDetail }));
    }

    if (!this.enabled) return;

    const heroMap = VOICE_MAP[heroId];
    if (!heroMap) return;

    const files = heroMap[skillName];
    if (!files || files.length === 0) return;

    const heroName = HERO_NAME_MAP[heroId];
    if (!heroName) return;

    // 使用时间+性能计数器生成随机索引
    // 组合 Date.now() 微秒部分和 performance.now() 纳秒精度，避免伪随机
    let file: string;
    if (files.length === 1) {
      file = files[0];
    } else {
      const seed = Date.now() * performance.now() * 1000;
      const index = Math.floor((seed % (files.length * 1000)) / 1000) % files.length;
      file = files[index];
    }

    const path = `${VOICE_BASE}/${heroName}/${file}`;

    // 停止当前正在播放的语音
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }

    try {
      const audio = new Audio(path);
      audio.volume = this.volume;
      this.currentAudio = audio;

      audio.addEventListener('ended', () => {
        if (this.currentAudio === audio) {
          this.currentAudio = null;
        }
      });

      audio.addEventListener('error', () => {
        if (this.currentAudio === audio) {
          this.currentAudio = null;
        }
        console.warn(`[VoiceManager] 无法加载语音: ${path}`);
      });

      audio.play().catch((err) => {
        console.warn(`[VoiceManager] 播放语音失败: ${path}`, err);
        this.currentAudio = null;
      });
    } catch (e) {
      console.warn(`[VoiceManager] 创建Audio失败: ${path}`, e);
    }
  }

  /**
   * 播放出牌语音（杀、闪、锦囊等）
   * @param gender 角色性别
   * @param cardName 牌名（如 '杀', '火攻', '决斗'）
   */
  playCardVoice(gender: string, cardName: string): void {
    // 服务端：通过 EventBus 广播出牌语音事件到所有客户端
    if (!this.isBrowser) {
      if (VoiceManager.eventBus) {
        VoiceManager.eventBus.emit(GameEvent.CardVoicePlay, { gender, cardName });
      }
      return;
    }

    if (!this.enabled) return;

    const prefix = CARD_VOICE_PREFIX[cardName];
    if (!prefix) return;

    const genderChar = gender === 'Female' ? '女' : '男';
    const path = `${CARD_VOICE_BASE}/${prefix}【${genderChar}】${cardName}.mp3`;

    // 不打断当前语音（出牌语音和技能语音可并存）
    try {
      const audio = new Audio(path);
      audio.volume = this.volume;
      audio.play().catch((err) => {
        console.warn(`[VoiceManager] 播放出牌语音失败: ${path}`, err);
      });
    } catch (e) {
      console.warn(`[VoiceManager] 创建Audio失败: ${path}`, e);
    }
  }

  /**
   * 停止当前语音播放
   */
  stop(): void {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
  }

  // ==================== 调试工具 ====================

  /**
   * 列出所有已有语音的角色和技能
   */
  static listAllVoices(): { heroId: string; heroName: string; skillName: string; count: number }[] {
    const result: { heroId: string; heroName: string; skillName: string; count: number }[] = [];
    for (const [heroId, skills] of Object.entries(VOICE_MAP)) {
      const heroName = HERO_NAME_MAP[heroId] || heroId;
      for (const [skillName, files] of Object.entries(skills)) {
        result.push({ heroId, heroName, skillName, count: files.length });
      }
    }
    return result;
  }
}
