---
name: genshin-card-dev
description: >
  原神杀（Genshin Card）项目开发专用技能。本技能应在修改代码、添加新功能、修复Bug时使用。
  当遇到接口签名不匹配、TypeScript类型错误、大文件替换出错、skill-manager
  方法缺失等常见问题时，请查阅参考文档中的过往修复经验，避免重复踩坑。
  每次修改系统代码后，必须同步更新 docs/ 目录下的对应文档。
---

# 原神杀项目开发规范

## 核心原则

1. **先查文档再改代码**：遇到接口/参数/类型问题，优先查阅 `docs/Bug修复经验.md` 和项目参考文档，再动手修改。
2. **每次修改必更新文档**：代码变更后必须同步更新 docs/ 中的相关文档（设计文档、待完成功能、更新日志等）。
3. **大文件局部编辑**：对 GamePage.ts、SkillManager.ts、CardEffectManager.ts、GameFlowController.ts 等大文件，始终使用 `replace_in_file` 进行精准局部修改，禁止整文件重写。

## 代码结构速查

| 目录 | 用途 |
|------|------|
| `src/core/` | 游戏核心逻辑（事件总线、牌堆、伤害、卡牌效果、流程控制、武将技能） |
| `src/ai/` | AI 决策引擎（AIDriver + DelayedAIDriver 包装器） |
| `src/ui/` | UI 层（GamePage、HomePage、ChaptersPage 等 + CSS） |
| `src/data/` | 静态数据（160 张卡牌、39 位武将、PVE 关卡） |
| `src/network/` | Socket.IO 客户端 |

## 关键接口对齐原则

- `DelayedAIDriver` 是 `AIDriver` 的包装器，新增 AI 方法时必须在二者中**同时实现**。
- `IPlayerDriver` 接口中的可选方法（`?`）调用时必须用 `?.()` 语法并加默认值 `?? -1`。
- `Card` 接口创建虚拟牌时不能遗漏 `equipType: EquipmentType.None` 和 `weaponRange: 0`。
- 装备索引需用 `slot as EquipmentType` 断言，不能用 `string`。
- PVE/PVP 双轨敌友判定：PVE 基于 `faction`，PVP 基于 `role`。

## 常见陷阱

### 技能"已使用"标记未提前设置
技能的 `xxxUsedThisTurn = true` 必须设在函数顶部，在所有可能 `return false` 之前。否则技能失败后标记未设置，AI 循环会反复重试同一技能浪费迭代次数。

### `DelayedAIDriver` 方法缺失
新增 AIDriver 方法（如 `promptActiveSkill`、`getNextBestCardIndex`、`isEnemy`）时，必须在 DelayedAIDriver 中添加对应的代理方法，否则 PVE AI 无法使用。

### `GameEvent` 事件缺少 handler
新增 GameEvent 类型后，必须在 GamePage.ts 中注册对应的 EventBus 监听器，否则事件无人处理。

### 大文件替换失败
对 CardEffectManager.ts、SkillManager.ts 等大文件使用 `replace_in_file` 时：
- `old_str` 必须精确定位，包含足够的上下文使其唯一
- 修改前先用 `read_file` 确认当前内容
- 连续修改同一文件时，每次修改后需要重新 `read_file` 确认位置

### ⚠️ PVP 广播机制 —— 最高优先级规则

**核心事实：PVP 模式下游戏逻辑运行在服务端 Node.js，客户端只做 UI 渲染。**

任何在客户端需要产生效果的操作（语音播放、DOM 事件、动画触发等），如果写在核心逻辑中且会被服务端调用，必须实现事件广播。违反此规则会导致：无语音、游戏崩溃（`document is not defined`）。

**每次新增此类功能的三步强制流程：**

1. **`types.ts`** → `GameEvent` 枚举新增事件类型
2. **核心代码** → `!isBrowser` 分支通过 `VoiceManager.eventBus.emit(GameEvent.Xxx, {...})` 广播
3. **`GamePage.ts`** → `handlePVPGameEvent` 的 `switch` 添加对应 `case`，接收并调用本地方法

注：`GameHost.ts` 的 `registerEventForwarding` 自动转发所有 `GameEvent` 值，无需手动修改。

**已有广播事件（勿重复创建）：**
- `GameEvent.SkillVoicePlay` — 技能语音
- `GameEvent.CardVoicePlay` — 出牌语音

**曾因违反此规则导致的崩溃（反面教材）：**
- `document.dispatchEvent()` 在服务端 → `ReferenceError: document is not defined` → 游戏崩溃
- `new Audio()` 在服务端 → 崩溃（已通过 `isBrowser` 守卫阻止）
- 只在浏览器端播放未广播 → PVP 下无声

## 文档更新清单

每次修改代码后，根据变更类型更新：

| 变更类型 | 需更新的文档 |
|---------|------------|
| 新增武将 / 技能修复 | `docs/待完成功能.md`、`docs/更新日志_v2.1.md` |
| Bug 修复（含经验教训） | `docs/Bug修复经验.md`、`docs/更新日志_v2.1.md` |
| AI 决策变更 | `docs/更新日志_v2.1.md` |
| 系统架构变更 | `docs/设计文档.md`、`docs/更新日志_v2.1.md` |

## 参考文档清单

- `docs/Bug修复经验.md` — 25 条历史 Bug 修复记录与教训
- `docs/设计文档.md` — 技术架构、路由、UI 布局、数据流
- `docs/待完成功能.md` — 各版本已完成/待完成功能清单
- `docs/更新日志_v2.1.md` — v2.1 完整变更日志
- `docs/PVE设计文档.md` — PVE 关卡与章节设计
