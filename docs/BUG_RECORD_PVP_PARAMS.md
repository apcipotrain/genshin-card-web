# PVP 参数传递对齐问题 — Bug 记录

> 审查时间: 2026-06-17
> 审查范围: PVP 全链路（选将 → game_start → game_event → prompt → game_over）

---

## 一、已修复的严重问题

### BUG-1: AI英雄选择无随机化（已修复）
- **文件**: `server/index.ts` 行676-677
- **问题**: `getNonGods().filter(...).slice(0, n)` 每次取固定顺序前N个，AI对手永远是胡桃、莱欧斯利等
- **修复**: 添加 `.sort(() => Math.random() - 0.5)` 打乱

### BUG-2: 背景总是须弥（已修复）
- **文件**: `src/ui/GamePage.ts` 行1069（原1021）
- **问题**: `handlePVPGameStart` 用 `myHero.region` 加载壁纸（自己英雄地区），而非主公地区
- **修复**: 改为 `switchBGMForMonarch()`，与PVE一致

### BUG-3: 选将展示主公与实际主公不一致（已修复）
- **根因（三层叠加）**:
  1. `initGame(heroesForAI)` 无条件覆盖所有AI英雄，包括AI主公已选好的英雄
     - **文件**: `server/GameHost.ts` 行134-156
     - **修复**: 跳过已有 `heroId` 的AI（`p.heroId !== 'unknown'`）
  2. `aiHeroIds` 数量 = `room.aiFill`（含AI主公），但AI主公已有英雄，导致多取+错位
     - **文件**: `server/index.ts` 行670-683
     - **修复**: `neededAiCount = room.aiFill - aiAlreadyHasHero`
  3. `monarchHero` 字段名不一致：AI主公场景用 `{heroId, heroName...}`，人类主公场景用 `{id, name...}`
     - **文件**: `server/index.ts` 行548-556
     - **修复**: 统一为 `{heroId, heroName, heroRegion, heroElement, heroMaxHp, heroGender, heroIsGod}`

### BUG-4: 选将没有倒计时（已修复）
- **文件**: `src/ui/GamePage.ts` `renderPVPCandidateUI`
- **问题**: `timeoutSec` 参数未使用，无倒计时UI
- **修复**: 添加倒计时显示+超时自动选择+`cleanupGame`中清理定时器

---

## 二、本次审查发现的新问题

### BUG-5: `hero_select_monarch_picked` 处理时 heroCandidates 始终为空
- **文件**: `src/ui/GamePage.ts` 行920-924
- **参数链路**:
  ```
  服务端 hero_select_waiting → WaitingPage navigate → GamePage showPVPHeroSelect
  ```
  `hero_select_waiting` 只传 `{monarchPlayerName, timeoutSec}`，**没有 heroCandidates**。
  GamePage 收到 `hero_select_monarch_picked` 时:
  ```typescript
  const candidates = heroCandidates || [];  // heroCandidates 始终 undefined → []
  this.renderPVPCandidateUI(candidates, monarch, false, timeoutSec); // 0个候选！
  ```
- **影响**: 非主公玩家先闪一下空候选UI，然后 `hero_select_start` 到达才重新渲染正确候选
- **修复方案**: `hero_select_monarch_picked` 仅更新主公展示，不渲染候选列表（候选由 `hero_select_start` 提供）

### BUG-6: `RemotePlayerDriver.promptTarget` 缺少 state 参数
- **文件**: `server/RemotePlayerDriver.ts` 行77-83
- **参数对比**:

  | Prompt 类型 | 服务端发送字段 | 客户端期望字段 |
  |---|---|---|
  | `playCard` | `{ state, ctx }` | `data.state, data.ctx` ✅ |
  | `target` | `{ validTargets, reason, ctx }` | `data.state, data.validTargets, data.reason, data.ctx` ❌ |
  | `response` | `{ state, cardName, ctx }` | `data.state, data.cardName, data.ctx` ✅ |

  `promptTarget` 不传 `state`，客户端 `data.state` 为 `undefined`，回退到 `this.players[this.pvpMyPlayerId]`（可能过时）
- **影响**: 目标选择时玩家状态可能不同步
- **修复方案**: 在 `promptTarget` 的 request data 中加入 `state`

### BUG-7: `promptTarget` 客户端 fallback 字段名多余
- **文件**: `src/ui/GamePage.ts` 行1327
- **问题**: `data.validTargets || data.validTargetIds || []` — 服务端发送 `validTargets`，不存在 `validTargetIds`
- **影响**: 无害但造成误解，应统一字段名

### BUG-8: AI主公名字显示为 `AI-角色名` 而非 `AI-数字`
- **文件**: `server/GameHost.ts` 行153
- **问题**: `initGame` 中为AI分配英雄时执行 `p.playerName = \`AI-${hero.name}\``，覆盖了构造函数中设置的 `AI-${playerId + 1}`
- **影响**: AI主公（如AI-钟离）与其他AI（AI-3）命名不一致
- **修复**: 删除 `p.playerName = \`AI-${hero.name}\``，保持构造函数设置的 `AI-数字` 格式

### BUG-9: PVP模式下铁索连环/过河拆桥/五谷丰登等交互卡死（严重）
- **文件**: `src/ui/GamePage.ts` HumanWebUIDriver 多个 prompt 方法
- **根因**: `promptIronChainMode`、`promptAmazingGrace`、`promptRansackHand`、`promptDiscardMulti`、`promptGenderWeapon`、`promptYesNo`、`promptVentiFree`、`promptZhanBa` 等方法使用独立 Promise（直接 `showXxxPrompt(resolve)`），resolve 时**不经过 `pvpRespond`**，服务端永远收不到回应
- **影响**: PVP模式下以下交互全部失败：
  - 铁索连环：选"连环"或"重铸"后无响应（服务端超时→默认重铸）
  - 过河拆桥：选"手牌"后 `promptZone` 能工作（经 `resolveZone`），但后续 `promptRansackHand` 的选牌无响应
  - 五谷丰登：选牌后无响应
  - 雌雄双股剑：选择后无响应
  - 所有 `promptYesNo` 场景
- **修复方案**: 所有独立 Promise 的 resolve 包装为 `(v) => { this.pvpRespond?.(v); resolve(v); }`，确保 PVP 模式下结果也通过 socket 发回服务端

### BUG-10: PVP模式计时器永远是00:00
- **文件**: `src/ui/GamePage.ts` 行1059 `handlePVPGameStart`
- **问题**: PVE 模式下 `startGame()` 调用 `startTimer()`，但 PVP 模式的 `handlePVPGameStart` 未调用
- **修复**: 在 `handlePVPGameStart` 中添加 `this.startTimer()`

### BUG-11: PVP模式牌堆数量永远是160
- **文件**: `server/GameHost.ts` 行240-246, `server/index.ts` 行723, `src/ui/GamePage.ts` 行1148
- **问题**: 
  1. 服务端 `registerEventForwarding` 注入事件数据时没有包含 `drawPileCount`
  2. `game_start` 事件没有包含 `drawPileCount`
  3. 客户端没有本地 `DeckManager`，无法自行计算
- **修复**:
  1. `GameHost` 暴露 `deckPileCount` getter
  2. 事件转发注入 `drawPileCount`
  3. `game_start` 添加 `drawPileCount` 字段
  4. 客户端在 `handlePVPGameEvent` 中更新 `deckCountEl`

---

## 三、参数传递完整对照表

### 选将阶段

| 事件 | 服务端发送字段 | 客户端接收字段 | 对齐状态 |
|---|---|---|---|
| `hero_select_start` (AI主公→非主公) | `{candidates, timeoutSec, isMonarch:false, monarchHero:{heroId,heroName...}}` | `{heroCandidates, timeoutSec, isMonarch, monarchHero}` | ✅ |
| `hero_select_start` (人类主公→主公) | `{candidates, timeoutSec, isMonarch:true}` | `{heroCandidates, timeoutSec, isMonarch:true, monarchHero:null}` | ✅ |
| `hero_select_start` (人类主公→非主公) | `{candidates, timeoutSec, isMonarch:false, monarchHero:{heroId,heroName...}}` | `{heroCandidates, timeoutSec, isMonarch:false, monarchHero}` | ✅ |
| `hero_select_waiting` (人类主公→非主公) | `{monarchPlayerName, timeoutSec}` | `{isWaitingForMonarch, monarchPlayerName, timeoutSec}` | ⚠️ 无heroCandidates |
| `hero_select_monarch_picked` (广播) | `{heroId,heroName,heroRegion,heroElement,heroMaxHp,heroGender,heroIsGod}` | `data` 直接当 monarchData | ✅ |

### 游戏阶段

| 事件 | 服务端发送字段 | 客户端接收字段 | 对齐状态 |
|---|---|---|---|
| `game_start` | `{roomId, players, yourPlayerId}` | `data.yourPlayerId, data.players` | ✅ |
| `game_event` | `{type, data:{... , players}}` | `data.type, data.data.players` | ✅ |
| `game_over` | `{roomId, winner, killStats, expByPlayerId, escapedPlayerIds}` | `data.winner, data.killStats, data.expByPlayerId, data.escapedPlayerIds` | ✅ |

### Prompt 类型

| Prompt 类型 | 服务端 data 字段 | 客户端读取 | 对齐状态 |
|---|---|---|---|
| `playCard` | `{state, ctx}` | `data.state, data.ctx` | ✅ |
| `target` | `{validTargets, reason, ctx}` | `data.state ⚠️, data.validTargets, data.reason, data.ctx` | ❌ 缺state |
| `response` | `{state, cardName, ctx}` | `data.state, data.cardName, data.ctx` | ✅ |
| `zone` | `{state, targetId, ctx}` | `data.state, data.targetId, data.ctx` | ✅ |
| `zhanba` | `{state, ctx}` | `data.state, data.ctx` | ✅ |
| `discard` | `{state, ctx}` | `data.state, data.ctx` | ✅ |
| `nullify` | `{state, ctx}` | `data.state, data.ctx` | ✅ |
| `armorTrigger` | `{state, armorName, ctx}` | `data.state, data.armorName, data.ctx` | ✅ |
| `weaponEffect` | `{state, weaponName, ctx}` | `data.state, data.weaponName, data.ctx` | ✅ |
| `ironChainMode` | `{state, ctx}` | `data.state, data.ctx` | ✅ |
| `amazingGrace` | `{tableCards, ctx}` | `data.tableCards, data.ctx` | ✅ |
| `showCard` | `{state, ctx}` | `data.state, data.ctx` | ✅ |
| `genderWeapon` | `{state, attackerName, ctx}` | `data.state, data.attackerName, data.ctx` | ✅ |
| `yesNo` | `{question}` | `data.question` | ✅ |
| `ransackHand` | `{state, targetId, ctx}` | `data.state, data.targetId, data.ctx` | ✅ |
| `discardMulti` | `{state, count, ctx}` | `data.state, data.count, data.ctx` | ✅ |
| `selectCard` | `{state, title, ctx}` | `data.state, data.title, data.ctx` | ✅ |

---

## 四、根因分析

PVP参数不对齐的根本原因：

1. **两套发送逻辑字段名不统一** — AI主公和人类主公两套代码独立编写，`monarchHero` 对象用了不同字段名
2. **服务端改了字段名但客户端没同步更新** — `monarchHero` 从 `{id, name...}` 改为 `{heroId, heroName...}` 时只改了一处
3. **缺少类型定义共享** — 服务端和客户端没有共享的 TypeScript interface，字段名全靠手写对齐
4. **initGame 假设所有AI都需要分配英雄** — 没考虑到AI主公已在选将阶段确定了英雄

---

## 五、建议的预防措施

1. **定义共享的 Socket 事件类型文件** — 服务端和客户端共用一个 `pvp-events.ts` 定义所有事件的 payload 类型
2. **选将阶段事件由服务端统一管理** — `hero_select_monarch_picked` 只广播主公身份，`hero_select_start` 才发候选
3. **所有 prompt 类型必须传 `state`** — 确保客户端总能获取最新的玩家状态
