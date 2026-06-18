# 原神杀（Genshin Card）

> 一款以《三国杀》军争八人场为核心玩法、以《原神》角色为武将的网页卡牌游戏。
>
> 版本：v2.0.0 | 更新日期：2026-06-18

---

## 项目简介

**原神杀**将三国杀的策略卡牌玩法与原神的世界观融合，玩家使用原神中的角色作为武将进行对战。项目支持 **PVE 闯关** 和 **PVP 联机** 两种模式，采用 TypeScript + Vite + 原生 DOM 渲染，零框架依赖，包体极小。

### 核心特性

- **PVE 闯关模式**：蒙德7关 + 璃月12关，2-8人动态座位布局，星级评定系统
- **PVP 联机模式**：完整的服务端（Express + Socket.IO），8人军争身份局，支持真人+AI混合
- **29位武将技能**：七神7位 + 非神22位，含联动机制（那维莱特-审判/龙权、莱欧斯利-狱长/公爵等）
- **账号系统**：注册/登录/Token认证，经验与等级系统（Lv.1-60），文件持久化
- **160张标准牌堆**：全部卡牌效果实现（杀/闪/桃/锦囊/装备/延时）
- **7国BGM/背景**：根据主公/章节地区自动切换，壁纸轮播 + 平时/战斗BGM切换
- **断线重连**：Socket.IO自动重连，断线AI接替，重连恢复控制

---

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 构建工具 | Vite 5 | 快速HMR，原生ESM支持 |
| 语言 | TypeScript 5 | 全量类型安全 |
| UI渲染 | 原生 DOM API | 零框架依赖 |
| 样式 | CSS3 | CSS Variables + Grid + Flexbox |
| 路由 | 自研轻量 Router | 基于发布订阅模式 |
| 网络通信 | Socket.IO 4 | WebSocket长连接，自动重连 |
| 服务端 | Node.js + Express | PVP房间管理 + 游戏实例 |
| 账号存储 | 内存 + JSON文件 | SHA256密码哈希 |

---

## 快速开始

### 环境要求

- Node.js >= 18.0
- npm >= 9.0
- 现代浏览器（Chrome / Edge / Firefox 最新版）

### 安装与启动

```bash
# 安装依赖
cd genshin-card-web
npm install

# 同时启动前端(3000) + PVP服务端(3457)
npm start

# 浏览器打开
# http://localhost:3000
```

### 仅启动前端（PVE单机）

```bash
npm run dev
```

### 仅启动服务端

```bash
npm run server
```

### 构建生产版本

```bash
npm run build
# 产物在 dist/ 目录
```

---

## 项目结构

```
genshin-card-web/
├── index.html                  # 入口HTML
├── package.json                # 项目配置 (v2.0.0)
├── vite.config.ts              # Vite构建配置（含Socket.IO代理）
├── Resources/                  # 静态资源
│   ├── Cards/                  # 卡牌图片 (44张)
│   ├── Backgrounds/            # 背景图片 (71张, 7国×10)
│   ├── Characters/             # 角色立绘 (43张)
│   ├── Musics/                 # 背景音乐 (15首, 7国×2)
│   ├── Suits/                  # 花色图片 (4张)
│   └── Identities/             # 身份图片 (4张)
├── docs/                       # 文档
│   ├── 需求文档.md             # 功能需求
│   ├── 设计文档.md             # 技术架构设计
│   ├── 使用文档.md             # 使用指南
│   ├── 接口文档.md             # 子系统接口传递关系
│   ├── 待完成功能.md           # 版本迭代记录
│   ├── DESIGN_PVE.md           # PVE闯关设计
│   ├── BUG_FIX_EXPERIENCE.md   # Bug修复经验
│   └── BUG_RECORD_PVP_PARAMS.md # PVP参数对齐记录
├── server/                     # PVP服务端
│   ├── index.ts                # 服务器入口
│   ├── AccountManager.ts       # 账号+经验等级系统
│   ├── accounts.json           # 账号持久化数据
│   ├── RoomManager.ts          # 房间管理
│   ├── GameHost.ts             # 服务端游戏主持人
│   └── RemotePlayerDriver.ts   # 远程玩家驱动
└── src/
    ├── main.ts                 # 应用入口
    ├── core/                   # 核心游戏逻辑
    │   ├── types.ts            # 类型/枚举/接口定义
    │   ├── EventBus.ts         # 事件总线
    │   ├── Card.ts             # 卡牌模型
    │   ├── Player.ts           # 玩家工厂
    │   ├── DeckManager.ts      # 牌堆管理
    │   ├── DistanceCalc.ts     # 距离计算
    │   ├── DamageSystem.ts     # 伤害系统
    │   ├── EquipEffectManager.ts
    │   ├── CardEffectManager.ts
    │   ├── GameFlowController.ts
    │   └── skills/SkillManager.ts  # 29位武将技能
    ├── ai/
    │   ├── AIDriver.ts         # AI决策引擎
    │   └── DelayedAIDriver.ts  # 延迟包装器
    ├── data/
    │   ├── CardData.ts         # 160张卡牌数据
    │   ├── heroes.ts           # 43位武将数据
    │   └── PVELevels.ts        # PVE关卡+章节+星级
    ├── network/
    │   └── SocketManager.ts    # Socket.IO客户端单例
    └── ui/                     # UI层
        ├── router.ts           # 路由系统
        ├── HomePage.ts         # 主页面
        ├── ChaptersPage.ts     # 关卡选择
        ├── MatchPage.ts        # PVP匹配
        ├── WaitingPage.ts      # 房间等待
        ├── GamePage.ts         # 游戏主界面
        └── *.css               # 样式文件
```

---

## 游戏模式

### PVE 闯关模式

- **9大章节**：蒙德 → 璃月 → 稻妻 → 须弥 → 枫丹 → 纳塔 → 挪德卡莱 → 至冬 → 深境螺旋
- **已实现**：蒙德7关 + 璃月12关
- **阵营制**：友方 vs 敌方，无身份系统
- **动态座位**：2-8人场自动布局
- **星级评定**：★★★（全员存活）/ ★★（阵亡1人）/ ★（阵亡2人）
- **解锁条件**：等级 + 前一章节累计20星

### PVP 联机模式

- **8人军争**：主公×1 / 忠臣×2 / 反贼×4 / 内奸×1
- **真人+AI混合**：房主可设置AI填充数量
- **选将系统**：主公从3神+3非神中选1，非主公从3候选中选1
- **身份脱敏**：非主公、非自己的玩家身份隐藏
- **断线处理**：AI接替 + 逃跑标记（经验为0）
- **经验结算**：胜利/失败基础经验 + 击杀加成

---

## 武将系统

### 43位武将数据（7国）

| 国家 | 数量 | 代表角色 |
|------|------|----------|
| 蒙德 | 7 | 温迪、琴、迪卢克、可莉、优菈、凯亚、法尔伽 |
| 璃月 | 9 | 钟离、刻晴、甘雨、魈、胡桃、凝光、申鹤、夜兰、兹白 |
| 稻妻 | 7 | 雷电将军、八重神子、神里绫华、枫原万叶、珊瑚宫心海、荒泷一斗、宵宫 |
| 须弥 | 4 | 纳西妲、艾尔海森、妮露、迪希雅 |
| 枫丹 | 3 | 芙宁娜、那维莱特、莱欧斯利 |
| 纳塔 | 6 | 玛薇卡、基尼奇、希诺宁、茜特菈莉、欧洛伦、玛拉妮 |
| 挪德卡莱 | 4 | 哥伦比娅、莉奈娅、奈芙尔、菈乌玛 |

### 29位已实现技能

**七神(7)**：温迪、钟离、雷电将军、纳西妲、芙宁娜、玛薇卡、哥伦比娅

**非神(22)**：那维莱特、八重神子、希诺宁、兹白、优菈、莱欧斯利、胡桃、凝光、艾尔海森、魈、枫原万叶、夜兰、宵宫、妮露、迪希雅、莉奈娅、荒泷一斗、珊瑚宫心海、刻晴、神里绫华、甘雨、申鹤

### 特殊机制

- **冰寒标记**：神里绫华/甘雨/申鹤共享，受火伤+1并移除
- **冰翎标记**：申鹤独有，目标需2张闪抵消1张杀
- **囚笼（双发）**：纳西妲比喻技能打出锦囊双发
- **审判/龙权**：那维莱特修改判定牌 + 判定后摸牌
- **狱长/公爵**：莱欧斯利与乐不思蜀联动
- **启喻**：莉奈娅牌堆顶可见 + 打出牌时翻牌堆顶联动

---

## 经验与等级系统

### 等级表

| 等级范围 | 升级所需经验 |
|----------|-------------|
| Lv.1-55 | 当前等级 × 100 |
| Lv.56-59 | 56,000-59,000 |
| Lv.60 | 封顶 |

### 经验来源

| 场景 | 基础经验 | 击杀加成 |
|------|----------|----------|
| PVP 内奸胜利 | 100 | 每杀+3 |
| PVP 主公胜利 | 75 | 杀反+3/杀内+2/杀忠-5 |
| PVP 忠臣胜利 | 50 | 杀反+3/杀内+2/杀主-5 |
| PVP 反贼胜利 | 40 | 杀忠+3/杀内+3/杀主+5 |
| PVP 失败 | 20 | 按角色 |
| PVE 通关 | 按关卡 | 按击杀 |
| 逃跑 | 0 | 0 |

---

## 背景图与音乐

### 7国资源

每国包含：
- **10张壁纸**（`Resources/Backgrounds/{base}0-{base}9.png`），每分钟随机轮播
- **2首BGM**（平时 + 战斗），平时BGM播放5分钟后切换战斗BGM

### 切换规则

| 模式 | 切换依据 | 切换时机 |
|------|----------|----------|
| PVE | 关卡所属章节的 `region` | 选将完成时 |
| PVP | 主公武将的 `region` | 游戏开始时 |

### 壁纸编号

| 国家 | 编号范围 | 国家 | 编号范围 |
|------|----------|------|----------|
| 蒙德 | 10-19 | 枫丹 | 50-59 |
| 璃月 | 20-29 | 纳塔 | 60-69 |
| 稻妻 | 30-39 | 挪德卡莱 | 70-79 |
| 须弥 | 40-49 | | |

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [需求文档](docs/需求文档.md) | 功能需求与页面结构 |
| [设计文档](docs/设计文档.md) | 技术架构与数据流设计 |
| [使用文档](docs/使用文档.md) | 安装启动与使用指南 |
| [接口文档](docs/接口文档.md) | 六大子系统传递关系详解 |
| [待完成功能](docs/待完成功能.md) | 版本迭代记录与待办 |
| [DESIGN_PVE](docs/DESIGN_PVE.md) | PVE闯关系统设计 |
| [BUG_FIX_EXPERIENCE](docs/BUG_FIX_EXPERIENCE.md) | Bug修复经验总结 |
| [BUG_RECORD_PVP_PARAMS](docs/BUG_RECORD_PVP_PARAMS.md) | PVP参数对齐记录 |

---

## 开发指南

### 添加新武将

1. 在 `src/data/heroes.ts` 的 `HEROES` 数组中添加武将数据
2. 在 `src/core/skills/SkillManager.ts` 中实现技能（getSkills + executeActiveSkill + 钩子）
3. 在 `Resources/Characters/` 添加角色立绘 PNG

### 添加新PVE关卡

1. 在 `src/data/PVELevels.ts` 对应章节的数组中添加 `PVELevel` 数据
2. 设置 `enemyHeroes`、`turnOrder`、`bannedHeroes`
3. 添加 `Resources/Backgrounds/` 和 `Resources/Musics/` 资源（新章节）

### 添加新卡牌

1. 在 `src/data/CardData.ts` 的 `CARD_DATA` 数组中添加卡牌数据
2. 在 `src/core/CardEffectManager.ts` 中实现卡牌效果
3. 在 `Resources/Cards/` 添加卡牌图片 PNG

### 修改AI策略

1. 编辑 `src/ai/AIDriver.ts` 的 `scoreCard` 方法调整卡牌优先级
2. 编辑 `getEnemies`/`getAllies` 调整敌友判断逻辑

---

## 许可

本项目为个人学习项目，仅用于技术交流。
