# Bug Fix 经验文档

> 记录大项目中因类型/接口/方法名不对齐导致的典型错误，以备后续参考。

---

## 一、类型定义与消费端不对齐

### 现象
`HomePage.ts` L132/L133/L453 报错：`acc.level`/`acc.exp` 属性不存在。

### 根因
`SocketManager.ts` 中 `_account` 字段的类型声明**缺少**实际使用的属性：

```typescript
// 修复前：仅包含基本字段
private _account: { id: string; name: string; nickname?: string; avatar?: string } | null = null;

// 修复后：补齐消费端需要的字段
private _account: { id: string; name: string; nickname?: string; avatar?: string; level?: number; exp?: number } | null = null;
```

### 教训
**定义类型前，先检查所有消费方需要哪些字段。** 在一个大型项目中，类型定义（如 `SocketManager.account`）可能被数十处代码引用。修改类型时，必须同步更新 setter 和所有相关类型注解。

---

## 二、接口可选方法与调用方式不对齐

### 现象
`SkillManager.ts` 多处（L3417, L3594, L3705, L3959, L4033）报错：`driver.promptSelectCard` 可能为 `undefined`。

### 根因
`IPlayerDriver` 接口中 `promptSelectCard` 标记为**可选方法**（`?`），但调用方使用了非可选调用语法 `driver.promptSelectCard(...)` 而非 `driver.promptSelectCard?.(...)`。

```typescript
// 接口定义（types.ts）
promptSelectCard?(
    state: PlayerState,
    title: string,
    filter: (card: Card) => boolean,
    context: GameContextSnapshot
): Promise<number>;

// 错误调用
const cardIdx = await driver.promptSelectCard(player, '...', () => true, ctx);

// 正确调用
const cardIdx = await driver.promptSelectCard?.(player, '...', () => true, ctx) ?? -1;
```

### 教训
1. **接口中的可选方法（`methodName?`）调用时必须用 `?.()` 语法**，否则 TS 报"不能调用可能是未定义的对象"。
2. 可选方法调用后返回值也是可选的，**必须提供默认值**（如 `?? -1`），避免返回 `Promise<number | undefined>`。
3. 在大型项目中，如果一个方法在绝大多数 driver 中都有实现，要考虑**是否应该去掉 `?` 变成必须实现的方法**，或者统一使用 `?.` 调用模式。

---

## 三、回调签名与接口定义不匹配

### 现象
`SkillManager.ts` L1238 报错：`(_, idx) => idx < data.mapleLeaves.length` 不符合 `(card: Card) => boolean`。

### 根因
`promptSelectCard` 的 filter 回调签名为 `(card: Card) => boolean`，只接受**一个参数**（手牌对象），而非 `(card, index)`。原始代码试图通过索引过滤，但接口不支持该用法。

```typescript
// 错误：2 个参数
(_, idx) => idx < data.mapleLeaves.length

// 正确：1 个参数
(_card) => true
```

### 教训
1. **写回调函数前先查接口定义，看清参数个数和类型。**
2. 如果业务需要索引参数而接口不支持，应该通过其他方式实现（如重构接口、使用 `as any` 绕过等）。
3. 不同代码区域对同一接口的使用模式应保持一致，如该项目中其他 `promptSelectCard` 调用均使用 `c => c.type === 'Basic'` 单参数模式。

---

## 四、类型安全的索引访问

### 现象
`SkillManager.ts` L1864/L1868 报错：`string` 不能索引 `Record<EquipmentType, Card | null>`。

### 根因
`equipZone` 的类型是 `Record<EquipmentType, Card | null>`（联合类型作为 key），但传入的 `slot` 是 `string` 类型。TypeScript 不允许 `string` 索引联合类型的 Record。

```typescript
// equipZone 类型
equipZone: Record<EquipmentType, Card | null>
// EquipmentType = 'None' | 'Weapon' | 'Armor' | 'OffensiveHorse' | 'DefensiveHorse'

// 错误：slot 是 string
equipTarget.equipZone[slot]

// 正确：类型断言
equipTarget.equipZone[slot as EquipmentType]
```

### 教训
1. **使用枚举/联合类型做 Record key 时，索引表达式必须是该联合类型或其子类型。**
2. 同一个模式（`equipZone[slot]`）在相邻两行中出现，必须**两处都修复**，不能遗漏。
3. 函数参数使用具体类型（如 `slot: EquipmentType`）比 `slot: string` 更好，从源头避免类型断言。

---

## 五、对象字面量缺少必填属性

### 现象
`SkillManager.ts` L3250/L3455 报错：虚拟牌对象缺少 `equipType`、`weaponRange` 属性。L3050 报错：`mtMagicTargetType` 等额外属性不在 `Card` 类型中。

### 根因
`Card` 接口要求 `equipType: EquipmentType` 和 `weaponRange: number` 是必填字段，但多处创建虚拟卡牌时遗漏了这两个字段。同时 L3050 向非魔法牌注入了 `mtMagicTargetType` 等魔法专用字段，导致超出接口定义。

```typescript
// 错误：缺少 equipType 和 weaponRange
const fireCard: Card = {
  id: ..., name: '火攻', type: CardType.Magic, suit: ...,
  number: ..., element: ElementType.Pyro, description: ...,
  cardSource: player, isVirtual: true,
};

// 正确：补齐所有必填字段
const fireCard: Card = {
  id: ..., name: '火攻', type: CardType.Magic, suit: ...,
  number: ..., element: ElementType.Pyro, description: ...,
  equipType: EquipmentType.None, weaponRange: 0, cardSource: player, isVirtual: true,
};
```

### 教训
1. **创建新对象赋值给接口类型时，务必对照接口定义检查所有必填字段。**
2. 非装备牌应使用 `EquipmentType.None` 和 `weaponRange: 0` 作为默认值。
3. 对于需要接口之外属性的对象（如魔法牌专用字段 `mtMagicTargetType`），应使用 `as any as Card` 双重断言或扩展接口。
4. 项目中存在**3 处以上相同模式的对象创建**（L3040, L3250, L3455），说明缺少一个统一的 `createVirtualCard()` 工具函数——这是重构的信号。

---

## 六、方法签名不匹配导致参数错传

### 现象
`SkillManager.ts` L4637 报错：`promptDiscard` 期望 2 个参数，但传了 4 个参数；且返回值被当作数组使用。

### 根因
代码意图是"弃置 1 张牌"，但误用了 `promptDiscard`（签名：`(state, ctx) => Promise<number>`），实际应使用 `promptDiscardMulti`（签名：`(state, count, ctx) => Promise<number[]>`）。

```typescript
// 错误：promptDiscard 只有 2 个参数，返回 number
const discardIdx = await driver.promptDiscard?.(player, 1, `标题`, ctx);
if (discardIdx.length > 0) { ... }  // number 没有 .length

// 正确：用 promptDiscardMulti，3 个参数，返回 number[]
const discardIdxs = await (driver as any).promptDiscardMulti?.(player, 1, ctx) ?? [];
if (discardIdxs.length > 0) { ... }
```

### 教训
1. **调用方法前确认其完整签名**——参数个数、类型、返回值类型都要匹配。
2. `promptDiscard` vs `promptDiscardMulti`：一个是弃单张（返回 number），一个是弃多张（返回 number[]）。名称相似但行为完全不同。
3. 4 个参数的调用可能是误将 `promptSelectCard`（4 参数：state, title, filter, ctx）的调用模式套用到 `promptDiscard` 上。
4. 当方法名暗示功能但签名不匹配时，优先怀疑**用错了方法**而非接口定义有问题。

---

## 七、async 函数返回类型标注

### 现象
`SkillManager.ts` L541 报错：异步函数的返回类型必须为全局 `Promise<T>` 类型。

### 根因
TypeScript 要求 `async` 函数的返回类型注解必须是 `Promise<T>`，不能直接用 `void`。

```typescript
// 错误
async onRoundStart(): void { ... }

// 正确
async onRoundStart(): Promise<void> { ... }
```

### 教训
这是 TypeScript 的严格模式约束，虽然不是逻辑错误，但在 strict 配置下会产生编译错误。所有 `async` 方法都应显式标注 `Promise<T>` 返回类型。

---

## 八、PVP 客户端 prompt 处理器缺失导致行为被静默跳过

### 现象
PVP 对战中，"火攻"自动展示第一张手牌、"五谷丰登"自动选牌等行为被"静默跳过"——服务器发出了 prompt 但客户端没有渲染 UI，直接返回默认值。

### 根因
`GamePage.ts` 的 `handlePVPPrompt` switch 语句**遗漏了大量 prompt 类型**。服务端的 `RemotePlayerDriver` 通过 socket 发送 `showCard`、`ironChainMode`、`ransackHand`、`genderWeapon`、`zhanba` 等类型的 prompt，但客户端 switch 中没有对应的 case，全部落入 `default: respond(-1)`，触发服务器的默认值逻辑。

```typescript
// RemotePlayerDriver 支持但客户端未处理的 prompt 类型：
// showCard       → 火攻目标展示手牌
// ironChainMode  → 铁索连环选择"重铸"还是"连环"
// ransackHand    → 顺手牵羊/过河拆桥从目标手牌选牌
// genderWeapon   → 雌雄双股剑抉择"弃牌"或"摸牌"
// zhanba         → 丈八蛇矛选择两张牌合成

// 修复前 switch（缺失 5 个 case）：
switch (type) {
  case 'playCard': ... break;
  case 'target': ... break;
  // ... 其他已有 case
  case 'amazingGrace': ... break;
  // ❌ showCard / ironChainMode / ransackHand / genderWeapon / zhanba 全部缺失
  default: respond(-1); break;  // ← 所有缺失类型都在这里被静默拒绝
}

// 修复后：
switch (type) {
  // ... 已有 case
  case 'showCard': this.pvpPromptShowCard(state, respond); break;
  case 'ironChainMode': this.pvpPromptIronChainMode(state, respond); break;
  case 'ransackHand': this.pvpPromptRansackHand(promptData, respond); break;
  case 'genderWeapon': this.pvpPromptGenderWeapon(promptData, respond); break;
  case 'zhanba': this.pvpPromptZhanBa(state, respond); break;
  // ...
}
```

### 教训
1. **新增 `RemotePlayerDriver` 方法时，必须同步在客户端 `handlePVPPrompt` 添加对应 case。** 这就是"大项目方法名/类型名一定要对齐"的典型体现——服务端和客户端通过字符串 type 名通信，缺少一端就会导致静默失败。
2. **`default: respond(-1)` 是危险的**：它会把所有未知 prompt 类型当作"用户取消"处理，而有些 prompt 的正确默认行为是积极的（如 `showCard` 应该选第 0 张而非取消）。
3. **对照 `RemotePlayerDriver` 的所有 public 方法，逐一检查客户端是否有对应处理**——方法数必须一一对应。

---

## 九、PVP 客户端 game_event 处理器缺失导致视觉动效丢失

### 现象
PVP 对战中，黄光连线（source→target 光束动画）不显示，出牌动画不播放。

### 根因
`GamePage.ts` 的 `processPVPSingleEvent` switch 只处理了 `Log`/`RolesAssigned`/`TurnStarted`/`PhaseChanged`/`GameOver` 等 5 种事件，遗漏了服务器转发的视觉动效事件：

```typescript
// 修复前 switch（仅处理 5 种事件）：
switch (eventType) {
  case 'Log': ... break;
  case 'RolesAssigned': ... break;
  case 'TurnStarted': ... break;
  case 'PhaseChanged': ... break;
  case 'GameOver': ... break;
  // ❌ CardTargeted / CardResponded / CardRevealed 全部缺失
}

// 修复后（添加 3 种动效事件）：
case 'CardTargeted': {
  // 黄光连线动画
  this.showTargetBeamBetween(srcId, tgtId);
  break;
}
case 'CardResponded': {
  // 出牌动画（杀/闪/桃等）
  this.animateCardPlayed(pId, cName, c?.suit, c?.number);
  break;
}
case 'CardRevealed': {
  // 火攻展示牌动画
  this.animateRevealCard(pId, cName, c?.suit, c?.number);
  break;
}
```

### 教训
1. **PVP 服务端通过 `EventBus.on('*')` 全量转发所有游戏事件到客户端，客户端 switch 需要覆盖所有需要视觉反馈的事件类型。**
2. **PVE 和 PVP 的事件处理逻辑应该保持对称**：PVE 中 `this.eventBus.on(GameEvent.CardTargeted, ...)` 监听了哪些事件，PVP 的 `processPVPSingleEvent` 就应该处理哪些事件。
3. 黄光连线（`showTargetBeamBetween`）是重要的视觉提示，缺少它会让玩家在 PVP 中**无法直观确认技能目标指向**，严重影响游戏体验。

---

## 总结：大项目的类型对齐原则

| 原则 | 说明 |
|------|------|
| **查接口再写代码** | 调用任何方法前，先看 `IDriver`/`IPlayerDriver` 等接口的完整签名 |
| **可选方法用 `?.`** | 接口中标记 `?` 的方法，调用时统一用 `?.()` + 默认值 |
| **对象创建核对必填字段** | 用接口类型标注的变量，创建对象时必须包含所有必填属性 |
| **索引用具体类型** | Record 的 key 是联合类型时，索引表达式也要是联合类型，避免用 `string` |
| **同名方法不同签名** | `promptDiscard` vs `promptDiscardMulti` 等，注意参数个数和返回类型差异 |
| **统一缺失值** | 同一模式的重复代码（如虚拟牌创建）暗示需要工具函数抽取 |
| **C/S prompt 类型一一对应** | ~~UI 逻辑已在 HumanWebUIDriver 统一，PVP 通过 pvpRespond 双通道委托复用，不再需要手动同步~~ |
| **PVE/PVP 事件对称** | PVE 的 `EventBus.on` 监听了哪些动效事件，PVP 的 `processPVPSingleEvent` 就应处理哪些 |
| **default 分支要谨慎** | `default: respond(-1)` 会把所有未知 prompt 当"取消"，应评估是否需要更安全的默认值 |
| **PVE/PVP 共用 UI 驱动** | HumanWebUIDriver 实现 IPlayerDriver，PVE 直接调用，PVP 通过 setPVPRespond 注入 socket 回调实现同一套 UI 方法复用 |

---

## 十、PVP 与 PVE 分裂维护：300 行重复代码的根因与解法

### 现象
PVP 和 PVE 是两套独立的 prompt 处理代码路径：PVE 通过 `HumanWebUIDriver` 驱动 UI，PVP 通过 `handlePVPPrompt` switch + 15 个 `pvpPromptXxx()` 方法手动构建 UI。每次新增 prompt 类型都必须修改两处，遗漏就会导致 PVP 静默吞掉交互（如五谷丰登选牌、火攻展示等）。

### 根因
两种模式下，prompt 的唯一区别是**响应通道**：
- PVE：用户点击 → `humanDriver.resolveXxx()` → 本地 Promise resolve
- PVP：用户点击 → `respond()` → `socketManager.respond(requestId, result)`

但 UI 渲染逻辑（`highlightShowCards`、`showIronChainPrompt`、`showZhanBaPrompt` 等）**完全相同**。冗余的来源是 `handlePVPPrompt` 绕过了 `HumanWebUIDriver`，自己用 cloneNode + addEventListener 重新实现了所有交互 UI。

### 解法
1. `HumanWebUIDriver` 增加 `pvpRespond` 字段和 `setPVPRespond()` 方法
2. 所有 `resolveXxx()` 方法在内部 Promise resolve 之前，先检查 `pvpRespond`，如果存在则同时触发 socket 响应
3. `initPVPGameMode` 创建 `this.humanDriver` 实例（与 PVE 完全一致）
4. `handlePVPPrompt` 删除所有 `pvpPromptXxx()` 方法，改为调用 `this.humanDriver.promptXxx()` 委托

```typescript
// 重构后：PVP 通过两种通道复用 HumanWebUIDriver
//   pvpRespond 通道（setResolve 类方法）：set pvpRespond, call driver method
//     → UI 点击 → resolveXxx → pvpRespond fires → respond → socket answers
//   await 通道（回调类方法）：await driver Promise, forward to respond
//     → showXxxPrompt(resolve) → resolve fires → Promise resolves → respond

private async dispatchPVPPrompt(type, requestId, state, promptData, ctx) {
    const d = this.humanDriver!;
    const respond = (result) => { /* socket respond + cleanup */ };
    try {
        switch (type) {
            // pvpRespond 通道
            case 'playCard': this.pvpRespond = respond; d.setPVPRespond(respond); d.promptPlayCard(state, ctx); break;
            case 'showCard': d.setPVPRespond(respond); d.promptShowCard(state, ctx); break;
            // await 通道
            case 'ironChainMode': respond(await d.promptIronChainMode(state, ctx)); break;
            case 'zhanba': respond(await d.promptZhanBa(state, ctx)); break;
            // ...
        }
    } catch { respond(-1); }
}
```

### 收益
- 删除 **238 行**冗余代码（15 个 `pvpPrompt*` 方法）
- 新增 prompt 类型只需在 `HumanWebUIDriver` 实现一次，PVP 自动兼容
- `handlePVPPrompt` 从 44 行 switch 缩减为委托调用

---

## 十一、PVP 渲染缺失导致手牌无法选中

### 现象
PVP 联机对战中，`prompt('playCard')` 到达客户端后，手牌区域空白，无法点击出牌。15 秒超时后服务端报 `[RemoteDriver] Player X timeout on playCard, defaulting to -1`。

### 根因
重构后 `handlePVPPrompt` 只调了 `syncLocalPlayerFromPrompt(state)`（数据层同步），没调 `renderHandCards()`（DOM 层渲染）。`highlightPlayableCards` 通过 `querySelectorAll('.game-card')` 查找手牌 DOM，查不到任何元素 → 无 click 事件绑定。

### 修复
`handlePVPPrompt` 中 `syncLocalPlayerFromPrompt` 后增加 `this.renderHandCards()`。

---

## 十二、PVP 回合头日志泄露身份

### 现象
PVP 对战中，非主公玩家的角色身份被打印到日志中：`优菈 (忠臣)` 对所有玩家可见。

### 根因
`GameFlowController` 回合头日志：`${player.name} (${getRoleChineseName(player.role)})`。服务端 `EventBus.on('*')` 全量转发 Log 事件到所有客户端，只脱敏了 `players` 数组，未脱敏 Log 文本内容。

### 修复
去除回合头日志中的 `(角色)` 部分，只显示 `玩家名 HP: xx/xx`。身份信息已通过座位卡正确脱敏（服务端 `sanitizePlayerForViewer` 对非主公非自己玩家隐藏 role）。

---

## 十三、AI 酒牌死循环：`nextSlashDamageBonus` 误判可出牌

### 现象
AI 玩家打出酒 → 杀消耗 bonus → AI 误判还能再出酒 → 选中酒 → 游戏引擎拒绝（`wineUsedThisTurn=true`）→ 牌返还手牌 → AI 再次选中（仍是最高优先级）→ 死循环。

```
优菈 使用了 ♣3 酒
优菈 对 希诺宁 使用了 ♦7 杀！
本回合已经使用过【酒】了。
♠9 酒 使用失败，已返还。
♠9 酒 已连续使用失败，本回合不再尝试打出。  ← 重复 9 次
```

### 根因
AI `scoreCard` 用 `me.nextSlashDamageBonus > 0` 判断酒是否已出。但杀打出后 bonus 被消耗归零，AI 以为还能出酒。游戏引擎另用 `wineUsedThisTurn` 做真正的"每回合一次"检查，两者不一致导致死循环。

### 修复（3 处对齐）

| 位置 | 修改 |
|------|------|
| `AIDriver.ts` `scoreCard` 酒分支 | `nextSlashDamageBonus > 0` → `me.wineUsedThisTurn` |
| `GamePage.ts` `canPlayCard` 酒分支 | 增加 `!state.wineUsedThisTurn` |
| `GamePage.ts` `syncLocalPlayerFromPrompt` | 增加同步 `local.wineUsedThisTurn = state.wineUsedThisTurn` |

**核心原则**：AI 决策判断与游戏引擎检查条件必须一致。杀用 `slashUsedCount`，酒用 `wineUsedThisTurn`，都是"每回合一次"的权威标志位。

---

## 十四、`executeMagicByName` 绕过技能钩子导致囚笼失效

### 现象
纳西妲使用【比喻】技能打出非延时锦囊时，囚笼（双发）效果不触发。

### 根因
`CardEffectManager.executeMagicByName` 直接调用 `executeMagicCard`，跳过了 `handleActivePlay` 中的 `onMagicUsed`（囚笼检查）钩子。

### 修复
`executeMagicByName` 改为调用 `this.handleActivePlay(virtual, source)`，经过完整的技能钩子链路。

---

## 十五、莉奈娅启喻 AI 死循环

### 现象
AI 莉奈娅使用启喻替换牌后，若替换牌无法打出，AI 会在本回合内反复尝试触发启喻形成死循环。

### 根因
`onBeforeCardUse` 中启喻触发无次数限制，AI 每次出牌都检查花色/点数匹配。一旦替换后的牌无法打出（如已出过杀再次触发启喻替换为杀），原牌返还手牌，AI 下次出牌再次触发。

### 修复（三重防护）
1. `revelationUsedThisTurn`：本回合已发动过即跳过
2. `revelationDisabledThisTurn`：牌堆顶牌经 `canPlayTopCard()` 判定不可打出，全回合禁用
3. `canPlayTopCard()`：检查装备/桃/杀/酒的基本可打性
4. 回合开始重置上述标志位

---

## 十六、PVE AI 队友集火自己：isEnemy 误判

### 现象
PVE 对战中，AI 队友（友方阵营）对玩家使用杀、锦囊等攻击性操作。

### 根因
PVE 所有玩家 `role = RoleType.None`，`isEnemy()` 首行：
```typescript
if (me.role === RoleType.None || other.role === RoleType.None) return true;
```
所有玩家互视为敌人。

### 修复
`isEnemy()` / `isHostile()` 新增 faction 优先判断：PVE 基于 `faction`（Ally/Enemy），PVP 基于 `role`（主/忠/反/内）。

### 教训
PVE/PVP 共用同一套 AI 逻辑时，敌友判定是第一条分岔路。必须在判定函数中显式处理两种模式的阵营数据源。

---

## 十七、宵宫琉金火免完全不生效：接口声明但从未调用

### 现象
宵宫在有琉金技能时，仍被火杀/火攻/炸弹正常造成伤害。

### 根因
`isImmuneToFire` 在 `SkillManager` 接口中声明、在 `addYoimiyaSkills` 中返回 true，但 `DamageSystem.ts` 从未调用它。

### 修复
`DamageSystem.ts` 火属性伤害计算前新增 `isImmuneToFire` 检查，命中则直接 return。

### 教训
**实现了方法 ≠ 接入了系统**。验证时应追踪完整调用链（声明 → 注册 → 调用），而非只看"有这个方法"。

---

## 十八、魈降魔封印无效：入口缺失

### 现象
魈使用降魔后，其他角色仍能打出被封印花色的牌。

### 根因
`isSuitSealed` 已实现，但在 `CardEffectManager.handleActivePlay` 中从未调用。

### 修复
`handleActivePlay` 首行新增封印花色检查。

### 教训
"封印"类型控制效果必须处处拦截，包括出牌入口和响应入口。

---

## 十九、凝光天权播报缺少层级隔离

### 现象
所有玩家看到同样的天权日志（含牌堆顶详情和猜测）。

### 根因
Log 事件没有 `visibleTo` 过滤机制。

### 修复
1. `GamePage.ts` Log 事件处理新增 `visibleTo` 过滤
2. 天权播报复构为三层：凝光视角/目标视角/他人视角

### 教训
三国杀类游戏中信息不对称设计需要 Log 系统支持定向可见性。

---

## 二十、弃牌动画从不播放：CardDiscarded 缺少 playerId

### 现象
全场弃牌没有任何动画。

### 根因
`DeckManager.sendToDiscard` 发出 `CardDiscarded` 事件时没有 `playerId` 字段。Handler 中 `if (playerId !== undefined)` 永远 false。

### 修复
清空 `card.cardSource` 前提取 `sourcePlayerId` 随事件发出。

---

## 二十一、经验值与星数刷新才更新

### 现象
PVE 结算后主页等级/经验条不变，需刷新页面。

### 根因
页面 `show()` 只切换 `display`，不重读数据。

### 修复
1. `ChaptersPage.show()` 新增 `refreshStars()` 重读 localStorage
2. `GamePage.GameOver` PVE 结算时调用 `socketManager.setAccount()`

### 教训
SPA 应用中 `show()` ≠ `render()`。跨页面数据变更需通过 EventBus 或 `show()` 中重读数据源。

---

## 总结更新：v2.1 新增教训

| 原则 | 说明 |
|------|------|
| **PVE faction / PVP role 双轨** | 敌友判定必须区分两种模式的阵营来源 |
| **声明 ≠ 接入** | 接口方法存在但无人调用是最隐蔽的 bug |
| **控制效果需处处拦截** | 封印/免疫类效果要在出牌、响应、伤害等所有入口检查 |
| **Log 系统支持定向可见** | 三国杀大量信息不对称技能要求日志分级显示 |
| **事件结构与消费端对齐** | `emit` 缺少字段会导致 handler 条件永远不成立 |
| **SPA show() 重新读数据** | 页面切换不等于重新渲染，关键数据源需在 show 中刷新 |

---

## 二十二、PVP 技能不亮：skillManager 缺失导致类型为空

### 现象
温迪自由技能在 PVP 自己的回合显示为灰色不可点击。

### 根因
PVP 模式客户端 `this.skillManager` 未初始化，`this.flowController?.skillManager` 也为 null。`renderSkills` 的 fallback 将所有技能 `type` 设为空字符串 `''`，`usable` 固定返回 `false`。

### 修复
在 fallback 中建立 `knownTypes` 映射表（技能名→类型），active 技能的 `usable` 基于 `currentPlayerId === player.id` 判断。覆盖全部 39 武将的 active/trigger/passive 技能类型。

### 教训
客户端 fallback 路径不能简单地所有技能都不可用，必须至少区分 active vs trigger/passive，否则所有主动技在 PVP 都无法点击。

---

## 二十三、AI 借刀杀人卡死：只检查武器存在，未检查射程目标

### 现象
AI 打出借刀杀人后卡死（循环重试），场上虽有武器但武器持有者射程内无目标。

### 根因
`scoreCard` 只检查 `weaponHolders.length > 0`，未检查武器持有者是否有射程内的攻击目标。选完 targetA 后 `legalVictims` 为空，`executeBorrowWeapon` 返回 false → 牌退回手牌 → AI 下一轮仍评分 > 0 → 重试循环。

### 修复
`scoreCard` 借刀杀人分支新增 `hasValidTarget`：遍历所有武器持有者，确认至少有一个能打到射程内角色。不满足则返回 0。

### 教训
"能用"的判断需要检查完整的操作链路，不能只检查第一环条件。

---

## 二十四、迪卢克酒牌死循环：双状态标志导致 scoreCard 遗漏

### 现象
AI 迪卢克打出第一张酒成功后，第二张酒循环失败 6 次导致卡死。

### 根因
酒有二阶段判定：`nextSlashDamageBonus > 0`（伤害加成未消耗）和 `wineUsedThisTurn`（已使用）。scoreCard 只检查了 `wineUsedThisTurn`。当第一张酒生效后 `nextSlashDamageBonus` 仍为 1（杀未打出），AI 再次选酒 → `executeAnalepticLogic` 返回 false → `wineUsedThisTurn` 仍为 true → 但 scoreCard 的 ctx 中玩家引用可能过期，导致 scoreCard 仍返回 > 0。

### 修复（双重防护）
1. `scoreCard` 酒分支新增 ` || me.nextSlashDamageBonus > 0` 检查
2. `playPhase` 失败分支新增：若牌名为酒，强制 `player.wineUsedThisTurn = true` 和 `player.nextSlashDamageBonus = 1`

### 教训
**多个独立的禁止条件必须在 scoreCard 中全部复制**。引擎层的防御逻辑（`executeXxx` 中的 early return）不等同于 AI 评分层的防御逻辑。状态标志跨 await 边界时可能不同步，失败后需显式强制执行。

---

## 二十五、哥伦比娅空月弹窗静默：driver 判空后仍执行消耗

### 现象
哥伦比娅空月免疫锦囊没有弹出确认框。

### 根因
`columbinaMaidenProtect` 中 driver 存在性检查后，promptYesNo 使用了 `?.` 可选链 + `??` 默认 false，当 driver 为 null 或没有 promptYesNo 时穿透到标记消耗逻辑，静默消耗标记。

### 修复
使用显式的 `typeof promptYesNo === 'function'` 检查，不满足则提前返回 `{ intercepted: false }` 不消耗标记。移除可选链，强制调用者面对决议。

### 教训
`?.` + `??` 的穿透风险：`const useIt = await obj?.method?.() ?? false` 在 method 不存在时 useIt = false，但代码继续执行到标记消耗。异步方法应显式检查存在性后直接调用，不要用可选链。

---

## 二十六、甘雨月海回收6张（应为3张）：装备牌误计入打出记录

### 现象
甘雨回合结束翻面回收了6张牌（实际只打了3张杀+2张装备）。

### 根因
`GameFlowController.playPhase` 中 `_cardsPlayedThisTurn` 记录了所有成功打出的牌，包括装备牌（藤甲/诸葛连弩）。月海读取时未过滤。

### 修复
`ganyuMoonseaTurnEnd` 读取时过滤：`.filter((c: Card) => c.type !== 'Equipment')`

### 教训
"打出"的语义在三国杀中需要区分：月海只回收"进入弃牌堆"的牌。装备牌虽然经过 `handleActivePlay` 但进入装备区，不应被回收。

---

## 二十七、纳西妲比喻永远无效：chosenCardName从未设置

### 现象
AI发动比喻后只弃牌无效果，日志显示"未选择目标锦囊"。

### 根因
`nahidaMetaphor` 从 `ctx.metaphorCardName` 读取目标牌名，该值从未被任何代码设置。

### 修复
直接在函数内根据AI策略决定目标牌名（1血敌人→决斗，否则→无中生有），不再依赖 ctx 传参。

### 教训
通过 `ctx` 传递决策参数的接口设计需要**明确由谁设置**。如果是AI设置，则需要在 `evaluateSkill` 或 `promptActiveSkill` 中写入；如果是函数内部决策，则不应依赖外部 ctx。

---

## 二十八、茜特菈莉萨满/记忆从未触发：函数已实现但无调用点

### 现象
游戏中多次判定机会，但萨满和记忆从未弹出。

### 根因
`citlaliShamanPredict`、`checkCitlaliShamanResult` 实现完整，但从未被嵌入判定流程。`onBeforeJudgeEffect` 和 `onAfterJudge` 中缺少调用。

### 修复
- `onBeforeJudgeEffect` 首步新增萨满预言调用
- `onAfterJudge` 新增 `checkCitlaliShamanResult(judgeCard.suit)`

### 教训
**函数存在 ≠ 系统集成**。技能函数和钩子函数是两个独立概念——实现了函数但未注册到钩子流程中，等于零。每实现一个trigger型技能都必须追踪其钩子注册。

---

## 二十九、PVP数据残留：cleanupGame不彻底 + SocketManager监听器泄漏

### 现象
PVP第一局正常，退出后再开一局有上局数据残留。

### 根因
1. `cleanupGame()` 仅调 `abort()` 但未置 null 核心对象引用
2. `SocketManager` 的 `on()` 注册的 `game_event`/`prompt` 等监听器在 `cleanupPVPListeners` 中已取消，但可能存在未纳入 `pvpUnsubs` 管理的残留handler

### 修复
- `GamePage.cleanupGame`：nullify flowController/skillManager/players/deck/eventBus/humanDriver
- `SocketManager.removeGameListeners`：清除8类游戏事件的所有本地handler
- 双重 `leave_room` 确保离开服务端房间

### 教训
SPA 中 `cleanup()` 必须显式 nullify 所有跨生命周期对象，不能让 GC 独自判断。Socket.IO 的 `on()` 注册需要通过 unsubscribe 闭包管理生命周期。

---

## 三十、恰斯卡调停只触发一次：标记过早清除

### 现象
调停标记的目标用杀/决斗只受一次伤害。

### 根因
`chascaMediateOnSlashOrDuel` 首次触发后清除 `chascaMediateTarget = undefined`。

### 修复
不即时清除标记，改为 `resetTurnFlags` 中当目标回合结束时清除。

### 教训
持续型标记的正确生命周期是：发动时设置 → 条件满足时触发 → **目标回合结束时**清除。不能每次触发都清除。

