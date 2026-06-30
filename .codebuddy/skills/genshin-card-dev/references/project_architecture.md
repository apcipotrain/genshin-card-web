# 原神杀项目架构速查

## 核心文件职责

| 文件 | 职责 | 行数（约） |
|------|------|-----------|
| `src/core/types.ts` | Card/PlayerState/GameEvent/CardType 等核心类型定义 | 371 |
| `src/core/EventBus.ts` | 发布/订阅事件总线 | ~50 |
| `src/core/DeckManager.ts` | 牌堆管理（摸牌、弃牌、洗牌） | ~120 |
| `src/core/DamageSystem.ts` | 伤害计算、濒死求桃、阵亡奖惩 | ~500 |
| `src/core/EquipEffectManager.ts` | 26 件装备特效 | ~524 |
| `src/core/CardEffectManager.ts` | 全部卡牌效果（杀/闪/桃/锦囊/装备） | ~1200 |
| `src/core/GameFlowController.ts` | 8 人回合流转、出牌阶段循环 | ~1150 |
| `src/core/skills/SkillManager.ts` | 48 武将技能管理器 | ~5900 |
| `src/audio/VoiceManager.ts` | 角色技能+出牌语音管理器（单例）+动画事件+PVP广播 | ~300 |
| `src/ai/AIDriver.ts` | AI 决策引擎（出牌优先级、目标选择、技能评估） | ~1400 |
| `src/ai/DelayedAIDriver.ts` | AI 延迟代理包装器 | ~120 |
| `src/ui/GamePage.ts` | 游戏主界面、HumanWebUIDriver、动画渲染、BGM/语音设置、技能浮空动画 | ~5100 |
| `src/ui/HomePage.ts` | 主页面（导航、设置面板含BGM/语音选项、图鉴、账号管理） | ~580 |
| `src/data/heroes.ts` | 48 位武将数据（含 enName 英文字段） | ~540 |
| `src/data/CardData.ts` | 160 张卡牌数据 | ~400 |
| `src/data/PVELevels.ts` | 8 章节 48 关 PVE 关卡 | ~200 |

## 关键接口速查

### Card
```typescript
interface Card {
  id: number; name: string; type: CardType; suit: SuitType;
  number: number; description: string; element: ElementType;
  equipType: EquipmentType; weaponRange: number;
  cardSource: PlayerState | null; isVirtual: boolean;
}
```

### IPlayerDriver（必实现方法）
- `promptPlayCard`, `promptTarget`, `promptResponse`, `promptZone`
- `promptDiscard`, `promptNullification`, `promptIronChainMode`
- `promptAmazingGrace`, `promptShowCard`, `promptYesNo`
- `promptSelectCard`, `getNextBestCardIndex`

### DelayedAIDriver 代理清单
所有 AIDriver 的 public 方法都需在 DelayedAIDriver 中代理，常用 method list：
`promptPlayCard`, `promptTarget`, `promptResponse`, `promptZone`, `promptDiscard`, `promptNullification`, `promptIronChainMode`, `promptAmazingGrace`, `promptShowCard`, `promptYesNo`, `promptSelectCard`, `promptActiveSkill`, `getNextBestCardIndex`, `isEnemy`

## SkillManager 方法模式

### executeActiveSkill 路由
```typescript
case 'skill_id': return await this.skillFunction(player, ctx);
```
每个主动技能必须在此 switch 中注册。

### 技能数据访问
```typescript
const data = this.getData(player.id);
// data.xxxUsedThisTurn, data.emptyMoonCount, etc.
```

### 技能注册模式
```typescript
skills.push({
  id: 'hero_skillname',
  name: '技能名',
  description: '...',
  type: 'active' | 'passive' | 'trigger' | 'limited',
  usable: (p, c) => { ... },
});
```

## 语音系统 (VoiceManager)

### 技能语音资源路径
`Resources/Voices/{角色中文名}/{技能中文名}{数字}.mp3`

### 完整语音覆盖统计（48角色，~101技能，330+ MP3文件）

所有角色按区域分布：

| 区域 | 角色数 | 状态 |
|------|--------|------|
| 蒙德 | 8 | ✅ 全部完成 |
| 璃月 | 9 | ✅ 全部完成 |
| 稻妻 | 8 | ✅ 全部完成 |
| 须弥 | 6 | ✅ 全部完成 |
| 枫丹 | 3 | ✅ 全部完成 |
| 纳塔 | 8 | ✅ 全部完成 |
| 挪德卡莱 | 6 | ✅ 全部完成 |

无语音的技能：
- 雷电将军-永恒、荒泷一斗-天牛、艾尔海森-书记（锁定技，暂无资源）
- 优菈-不归/复仇（锁定技，暂无资源）
- 莉奈娅-谶鸟、伊涅芙-机娘（被动技，暂无资源）
- 玛薇卡-战争（被动，暂无资源）

### 出牌语音（新增 2026-06-26）

**路径**: `Resources/Voices/出牌语音/{编号}【{男/女}】{牌名}.mp3`

**覆盖 20 种牌型**，男女声双轨（40 个文件）：

| 编号 | 牌名 | 编号 | 牌名 |
|------|------|------|------|
| 01 | 杀 | 11 | 过河拆桥 |
| 02 | 火杀 | 12 | 乐不思蜀 |
| 03 | 雷杀 | 13 | 兵粮寸断 |
| 04 | 闪 | 14 | 南蛮入侵 |
| 05 | 决斗 | 15 | 万箭齐发 |
| 06 | 酒 | 16 | 桃园结义 |
| 07 | 火攻 | 17 | 借刀杀人 |
| 08 | 闪电 | 18 | 铁索连环 |
| 09 | 无懈可击 | 19 | 无中生有 |
| 10 | 顺手牵羊 | 20 | 五谷丰登 |

**触发点**: `CardEffectManager.handleActivePlay()` 入口处，根据 `source.gender` 选男/女声。

### VoiceManager API
```typescript
// 单例获取
VoiceManager.getInstance()

// 播放技能语音 + 触发技能名浮空动画
playSkillVoice(heroId: string, skillName: string, playerId?: number): void

// 播放出牌语音（根据角色性别自动选男/女声）
playCardVoice(gender: string, cardName: string): void

// 设置管理（持久化到localStorage）
setEnabled(value: boolean): void    // 语音开关
setVolume(value: number): void      // 音量 0-1

// 调试
VoiceManager.listAllVoices(): { heroId, heroName, skillName, count }[]

// 服务端广播（PVP模式）
VoiceManager.setEventBus(bus: EventBus | null): void
```

### ⚠️ PVP 广播机制 —— 核心规则（违反必出 Bug）

**核心事实：PVP 模式下游戏逻辑跑在服务端 Node.js 中，客户端只做 UI 渲染。**

任何需要在客户端产生效果的操作（语音、DOM事件、动画触发等），如果写在核心逻辑中且被服务端调用，**必须**同时实现事件广播机制，否则在 PVP 下完全失效。

**广播三步走（每次新增此类功能必须完整执行）：**

```
┌─────────────┐    EventBus.emit     ┌─────────────┐    socket.emit     ┌─────────────┐
│  服务端代码  │ ──GameEvent.XxxPlay──→│  GameHost   │ ──game_event──→  │  客户端代码  │
│ (SkillManager│                      │registerEvent│                   │ GamePage    │
│  CardEffect  │                      │ Forwarding  │                   │ handlePVP   │
│  DamageSys)  │                      │ (自动转发)   │                   │ GameEvent   │
└─────────────┘                      └─────────────┘                   └─────────────┘
```

**具体步骤（每次必做）：**

1. **`types.ts`** — 在 `GameEvent` 枚举中新增事件类型（如 `CardVoicePlay`、`SkillVoicePlay`）
2. **VoiceManager / 核心代码** — 在 `!isBrowser` 分支通过 `VoiceManager.eventBus.emit(GameEvent.XxxPlay, {...})` 广播
3. **`GamePage.ts`** — 在 `handlePVPGameEvent` 的 `switch` 中添加对应 `case`，接收事件数据并调用本地方法
4. **`GameHost.ts`** — 通常无需修改，`registerEventForwarding` 遍历 `Object.values(GameEvent)` 自动转发所有事件

**已有事件类型（勿重复创建）：**

| EventBus 事件 | 触发场景 | 客户端处理 |
|---------------|----------|-----------|
| `GameEvent.SkillVoicePlay` | 角色技能语音 | `playSkillVoice(heroId, skillName, playerId)` |
| `GameEvent.CardVoicePlay` | 出牌语音 | `playCardVoice(gender, cardName)` |

**反面教材（曾导致崩溃）：**
- ❌ `document.dispatchEvent()` 在服务端调用 → `ReferenceError: document is not defined` → **游戏崩溃**
- ❌ `new Audio()` 在服务端调用 → 崩溃（已通过 `isBrowser` 守卫阻止）
- ❌ 只在浏览器端播放音频但未广播 → PVP 下**无声**

### 技能动画系统
语音播报时同步在角色席位上方显示技能名浮空动画（1.6秒，金色发光大字，向上淡出）。
通过 `CustomEvent('voice:play', { detail: { heroId, skillName, playerId } })` 驱动。

### 语音播报触发点分布
语音钩子分散在四个文件中：
- **SkillManager.ts**: 主要技能的 `GameEvent.Log` emit 之后
- **CardEffectManager.ts**: 骑队、浪花、霜华、麟迹、玉衡、鹤归、素论、水月等
- **DamageSystem.ts**: 络命、琉金、灯妖、水环、玉璋等
- **GameFlowController.ts**: 黑曜、豪宴(摸牌)、启喻等

### PVE/PVP/AI 兼容性
语音钩子位于核心游戏逻辑层，不依赖 UI 层。
所有玩家（人类/AI）、所有模式（PVE/PVP）均会触发语音。

### 添加新语音的步骤
1. 将 MP3 文件放入 `Resources/Voices/{角色中文名}/{技能中文名}{数字}.mp3`
2. 在 `VoiceManager.ts` 的 `VOICE_MAP` 和 `HERO_NAME_MAP` 中添加映射
3. 在技能触发点添加 `VoiceManager.getInstance().playSkillVoice(heroId, skillName, player.id)`

## Bug 记录

### 2026-06-27 全面移除 localStorage，改用 accounts.json 服务端持久化
- **涉及**: `PVELevels.ts`, `ChaptersPage.ts`, `GamePage.ts`, `HomePage.ts`, `VoiceManager.ts`, `SocketManager.ts`, `AccountManager.ts`, `server/index.ts`
- **新增文件**: `src/data/SettingsCache.ts` — 内存设置缓存
- **新增API**: `save_pve_stars`, `save_settings`
- **AccountManager**: 新增 `savePVEStars(token, stars)`, `saveSettings(token, settings)` 方法
- **数据流**: `get_profile` 响应携带 `account.pveStars` 和 `account.settings` → HomePage 同步到内存 → 各组件读内存缓存 → 写入时异步 `socketManager.emit('save_xxx')` 到服务端 → AccountManager 写入 accounts.json

### 2026-06-27 PVE 章节解锁失败（等级未同步到 localStorage）
- **现象**: 玩家等级≥4、蒙德24星，但璃月仍锁定
- **根因**: `SocketManager.setAccount()` 只将等级存入内存 `_account`，未写入 localStorage `genshin_card_local_exp`。`ChaptersPage.getPlayerLevel()` 读不到正确等级，fallback 返回 1 → `isChapterUnlocked` 等级检查失败
- **修复**: `SocketManager.setAccount()` 新增同步写入 `genshin_card_local_exp` localStorage

## 备份文档

- `zhongli_backup.md` — 钟离三技能（契约/玉璋/闲游）改动前完整代码备份（2026-06-25）

