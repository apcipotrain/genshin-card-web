# 原神杀（Genshin Card）

> 一款以《三国杀》军争八人场为核心玩法、以《原神》角色为武将的网页卡牌游戏。
>
> 玩法文档版本：v2.3 | 最近开发更新：2026-11-05 | Java 账号后端与牌桌交互修复
>
> 最新记录：[2026-11-05 牌桌交互与问题修复](docs/更新日志_2026-11-05.md)。[Java 后端接入记录](docs/更新日志_2026-11-04.md) 保留。本次记录未调整 npm 包版本。

[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-purple)](https://vitejs.dev/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4-black)](https://socket.io/)
[![Java](https://img.shields.io/badge/Java-21-orange)](https://openjdk.org/projects/jdk/21/)
[![Spring Boot](https://img.shields.io/badge/Spring_Boot-4.1.2-green)](https://spring.io/projects/spring-boot)

---

## 项目简介

**原神杀**将三国杀的策略卡牌玩法与原神世界观融合，玩家使用原神角色作为武将进行对战。项目支持 **PVE 闯关** 和 **PVP 联机** 两种模式。网页使用 TypeScript + Vite + 原生 DOM；Node.js 服务运行实时对局；Java + Spring Boot 服务管理账号和持久化数据。

### 核心特性

- 🎮 **PVE 闯关模式**：蒙德7关 + 璃月12关 + **稻妻15关**，2-8人动态座位布局，星级评定系统
- 🌐 **PVP 联机模式**：完整服务端（Express + Socket.IO），8人军争身份局，支持真人+AI混合
- ⚔️ **52位武将技能全部实现**：七神7位 + 非神45位，含联动、增减伤、转化、标记等多样机制
- 🎤 **角色语音系统**：全部52位武将技能均有专属语音播报
- 👤 **账号系统**：Spring Boot 注册/登录/Token认证，经验与等级系统（Lv.1-60），H2 数据库持久化
- 🃏 **160张标准牌堆**：全部卡牌效果实现（杀/闪/桃/锦囊/装备/延时）
- 🖱️ **牌桌内操作**：出牌确认与取消并排；效果确认、区域选牌和五谷丰登在原牌桌内完成，保留八个座位布局；窄窗口可横向滚动牌桌
- 🎵 **背景与音乐**：PVE 对局使用地区壁纸池，PVP 使用独立壁纸池；音乐按关卡或主公地区选择
- 🔌 **断线处理**：Socket.IO 自动重连、Token 重新认证、房间状态恢复；对局中断线由 AI 接替
- 💬 **对局聊天**：房间消息广播、历史查询、重复消息处理和发送限频
- 💾 **可靠结算**：PVP 经验和战绩在同一数据库事务中更新，重复提交只处理一次；失败结算持久化重试
- 📖 **神将图鉴**：52位武将详细资料弹窗，按国家/元素分组，定位标签

---

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 构建工具 | Vite 5 | 快速HMR，原生ESM支持 |
| 语言 | TypeScript 5 + Java 21 | 网页和实时游戏使用 TypeScript，账号服务使用 Java |
| UI渲染 | 原生 DOM API | 零框架依赖 |
| 样式 | CSS3 | CSS Variables + Grid + Flexbox |
| 路由 | 自研轻量 Router | 基于发布订阅模式 |
| 网络通信 | Socket.IO 4 | WebSocket长连接，自动重连 |
| 游戏服务端 | Node.js + Express + Socket.IO | PVP房间管理 + 游戏实例 |
| 账号服务端 | Java 21 + Spring Boot 4.1.2 | Controller / Service / Repository 分层 |
| 账号存储 | H2 文件数据库 | BCrypt密码哈希、过期令牌和事务结算 |

### 三部分如何配合

```text
网页 src/ ── Socket.IO ──> 游戏服务 server/ ── HTTP ──> Java 账号服务
  页面和操作               房间、玩家交互、对局结算       账号业务和 H2 数据库
```

`src/core/` 是共用游戏逻辑：PVE 在浏览器运行，PVP 由 Node.js 服务运行。Java 负责注册登录、资料、设置、星级、经验和角色胜率统计；回合推进、技能和伤害结算仍使用现有 TypeScript 实现。

默认存储为 H2 文件数据库，无需另行安装数据库。当前没有接入 MySQL；PVE 仍由浏览器运行并上报结果，尚未实现服务端权威结果校验。

---

## 快速开始

### 环境要求

- Node.js >= 18.19
- npm >= 9.0
- JDK 21 + Maven >= 3.6.3（`java -version`、`mvn -version` 可运行）
- Windows PowerShell（当前一键启动脚本使用 PowerShell）
- 现代浏览器（Chrome / Edge / Firefox 最新版）

### 安装与启动

```powershell
# 安装依赖
cd genshin-card-web
npm install

# 同时启动前端(3000) + PVP服务端(3457) + Java账号服务(8080)
npm start

# 浏览器打开 http://localhost:3000
```

| 服务 | 默认地址 | 作用 |
|---|---|---|
| 网页 | `http://localhost:3000` | 登录、大厅、PVE 和 PVP 界面 |
| Node.js 游戏服务 | `http://localhost:3457` | Socket.IO、房间和实时对局 |
| Java 账号服务 | `http://127.0.0.1:8080` | 账号 HTTP 接口和数据存储 |

### 单独启动

```bash
npm run backend          # Java账号服务
npm run server           # 游戏服务（需先启动Java服务）
npm run dev              # 仅前端
npm run backend:test     # Java集成测试
npm run backend:package  # 测试并构建可执行jar
npm run typecheck        # 检查网页和游戏服务 TypeScript 类型
npm test                 # TypeScript 自动化测试
npm run test:backend:smoke # 已启动服务的跨服务联调；使用独立测试数据库
npm run test:game:stress -- 30 # 30个固定种子的八AI核心对局（不经过浏览器界面）
npm run build            # 构建前端 → dist/
```

Windows 下 `npm start` 会先构建 Java 服务，并等待账号接口就绪后启动游戏服务。首次运行需要下载 Maven 依赖。按 `Ctrl+C` 停止全部开发服务。旧 `server/accounts.json` 会自动导入数据库，原文件保留。完整接口、配置和阅读代码的路线见 [Java后端使用指南](docs/Java后端使用指南.md)。

如果启动提示端口已占用，已启动的游戏可以直接在浏览器使用。需要重启时，先在启动旧服务的终端按 `Ctrl+C`，再运行 `npm start`。

### 本地数据与配置

| 位置 | 内容 |
|---|---|
| `java-backend/data/` | 默认 H2 数据库，保存账号、会话和结算记录 |
| `.cache/game-service-key` | 启动器生成的内部服务密钥，由 Java 和 Node.js 共用 |
| `.cache/maven/` | Maven 下载的依赖 |
| `.runtime/pvp-settlements.json` | Java 暂不可用时待重试的 PVP 结算 |
| `java-backend/target/` | 编译结果和可运行 jar |

新账号使用 BCrypt 密码哈希；旧账号成功登录后升级密码存储。Token 默认有效期为 7 天，数据库保存摘要，登出时撤销。旧 JSON 不再接收正常业务写入；当前 `server/AccountManager.ts` 保留旧实现及共用类型、等级计算，入口实际使用 `AccountApiClient.ts` 调用 Java。

---

## 项目结构

```
genshin-card-web/
├── index.html                     # 入口HTML
├── package.json                   # Node.js依赖与npm命令
├── vite.config.ts                 # Vite构建配置（含Socket.IO代理）
├── java-backend/                   # Spring Boot账号服务（Java21 + JDBC + H2）
│   ├── pom.xml                    # Maven依赖、Java版本、测试与打包配置
│   ├── src/main/java/com/genshincard/account/
│   │   ├── AccountApplication.java # Java服务入口
│   │   ├── AccountController.java  # HTTP请求入口
│   │   ├── AccountService.java     # 账号业务规则与事务
│   │   ├── AccountRepository.java  # JDBC查询和保存数据
│   │   ├── AccountData.java        # 账号数据结构
│   │   ├── LevelProgress.java      # 等级与升级进度计算
│   │   ├── LegacyAccountImporter.java # 旧JSON账号迁移
│   │   ├── ApiException.java       # 业务错误
│   │   └── ApiErrorHandler.java    # 统一错误响应
│   ├── src/main/resources/
│   │   ├── application.properties # 端口、数据库和令牌配置
│   │   └── schema.sql             # 账号、会话和结算记录建表语句
│   ├── src/test/java/com/genshincard/account/
│   │   ├── AccountApiTest.java     # HTTP接口与业务测试
│   │   └── DatabasePersistenceTest.java # H2文件持久化测试
│   ├── data/                      # 默认数据库目录（运行产生）
│   └── target/                    # jar和编译结果（构建产生）
├── scripts/                       # 构建、启动与验证
│   ├── backend-common.ps1         # Java/Maven查找与配置初始化
│   ├── java-backend.ps1           # Java运行、测试与打包
│   ├── dev.ps1                    # npm start入口
│   ├── dev.mjs                    # 管理三个服务进程
│   ├── game-server.mjs            # 等待Java后启动Node.js游戏服务
│   ├── smoke-backend.mjs          # 跨服务联调脚本
│   └── stress-games.ts            # 固定种子的八AI整局核心验证
├── Resources/                     # 静态资源
│   ├── Cards/                     # 卡牌图片 (44张)
│   ├── Backgrounds/               # 地区、章节、PVP和大厅背景
│   ├── Characters/                # 角色立绘
│   ├── Musics/                    # 背景音乐 (7国×平时+战斗)
│   ├── Voices/                    # 武将技能语音
│   ├── Suits/                     # 花色图片 (4张)
│   └── Identities/               # 身份图片 (4张)
├── docs/                          # 完整文档
│   ├── 需求文档.md                # 功能需求与页面结构
│   ├── 设计文档.md                # 技术架构与数据流设计
│   ├── 使用文档.md                # 安装启动与使用指南
│   ├── 接口文档.md                # 六大子系统传递关系
│   ├── PVE设计文档.md             # PVE闯关系统设计
│   ├── 待完成功能.md              # 版本迭代记录与待办
│   ├── 接口对齐分析_v2.3.md       # PVP/PVE/存储接口对齐分析
│   ├── 更新日志_v2.1.md ~ v2.3.md # 完整更新日志
│   ├── 更新日志_2026-11-04.md     # Java后端接入与验证记录
│   ├── 更新日志_2026-11-05.md     # 牌桌交互、计时、窄窗口与弃牌修复
│   ├── Java后端使用指南.md        # 启动、接口、配置与代码阅读路线
│   ├── Bug修复经验.md             # Bug修复经验总结
│   └── PVP参数Bug记录.md          # PVP参数对齐记录
├── server/                        # PVP服务端
│   ├── index.ts                   # 服务器入口 (Express + Socket.IO)
│   ├── AccountApiClient.ts        # Java账号服务的HTTP适配器
│   ├── AccountManager.ts          # 旧账号格式类型与等级计算（旧存储实现不再启用）
│   ├── PvpSettlementQueue.ts      # 战绩结算的持久化重试队列
│   ├── RoomManager.ts             # 房间管理
│   ├── GameHost.ts                # 服务端游戏主持人
│   ├── RemotePlayerDriver.ts      # 远程玩家驱动
│   └── ChatService.ts             # 房间聊天、历史、去重与限频
├── tests/                         # 游戏会话、聊天、背景、账号适配与结算重试测试
│   ├── BattleInteractions.test.ts # 交互取消、计时、旧响应与动作事件测试
│   ├── EquipEffectManager.test.ts # 贯石斧选牌和弃牌结算测试
│   └── ui/battle.html + battle.ts # 使用生产组件的八人牌桌浏览器回归场景
└── src/
    ├── main.ts                    # 应用总入口（路由 + 页面组装）
    ├── core/                      # 核心游戏逻辑（PVE/PVP共用）
    │   ├── types.ts               # 类型/枚举/接口定义
    │   ├── EventBus.ts            # 事件总线
    │   ├── Card.ts                # 卡牌模型工具
    │   ├── Player.ts              # 玩家工厂
    │   ├── DeckManager.ts         # 牌堆管理
    │   ├── DistanceCalc.ts        # 距离计算
    │   ├── DamageSystem.ts        # 伤害/濒死/奖惩系统
    │   ├── EquipEffectManager.ts  # 装备效果处理器
    │   ├── CardEffectManager.ts   # 卡牌效果处理器
    │   ├── GameFlowController.ts  # 游戏流程控制（回合/阶段/判定）
    │   ├── GameSession.ts         # 对局取消、计时与资源清理
    │   └── skills/
    │       └── SkillManager.ts    # 52位武将技能管理器
    ├── ai/
    │   ├── AIDriver.ts            # AI决策引擎（规则与优先级决策）
    │   └── DelayedAIDriver.ts     # 延迟包装器（可配置延迟）
    ├── data/
    │   ├── CardData.ts            # 160张卡牌数据
    │   ├── heroes.ts              # 52位武将数据
    │   ├── PVELevels.ts           # PVE关卡 + 章节 + 星级系统（含localStorage兜底）
    │   └── SettingsCache.ts       # 用户设置内存缓存
    ├── audio/
    │   └── VoiceManager.ts        # 语音管理器（52位武将技能 + 卡牌语音）
    ├── network/
    │   ├── SocketManager.ts       # Socket.IO客户端单例
    │   └── ChatProtocol.ts        # 聊天协议与文本校验
    └── ui/                        # UI层
        ├── router.ts              # 路由系统
        ├── LoginPage.ts           # 登录与注册
        ├── HomePage.ts            # 主页面（账号/图鉴/设置）
        ├── ChaptersPage.ts        # 关卡选择页面
        ├── MatchPage.ts           # PVP匹配页面
        ├── WaitingPage.ts         # 房间等待页面
        ├── GamePage.ts            # 游戏主界面（PVE+PVP共用）
        ├── BattlePresentation.ts  # 出牌、响应、弃牌与技能展示
        ├── GameClock.ts           # 按实际经过时间计算对局时长与倒计时
        ├── WebUIDriver.ts         # 网页玩家操作驱动
        ├── ChatPanel.ts           # 聊天面板
        ├── BackgroundAssets.ts    # 背景资源映射
        ├── icons.ts               # 页面图标
        ├── battle-feedback.css    # 动作展示和牌桌内效果操作区
        ├── battle-responsive.css  # 手牌滚动与窄窗口整桌横向滚动
        └── *.css                  # 样式文件
```

### 从登录功能读懂 Java

`src/main/java` 是 Maven 的源码约定，`com/genshincard/account` 是 Java 包名；这段目录可以先理解为“账号服务源码”。`src/test` 放测试，`target` 是构建产物。

```text
LoginPage → SocketManager → server/index.ts → AccountApiClient
    → AccountController.login → AccountService.login → AccountRepository.findByName → H2
```

Controller 接收请求，Service 验证账号密码并创建登录会话，Repository 执行 SQL，AccountData 表示账号数据。先沿着登录入口、业务处理和数据库查询这三个步骤阅读，再看注册、资料修改和结算逻辑。

---

## 游戏模式

### PVE 闯关模式

- **9大章节**：蒙德 → 璃月 → 稻妻 → 须弥 → 枫丹 → 纳塔 → 挪德卡莱 → 至冬 → 深境螺旋
- **已实现**：蒙德7关 + 璃月12关 + 稻妻15关（共34关）
- **阵营制**：友方 vs 敌方，无身份系统
- **动态座位**：2-8人场自动布局
- **星级评定**：★★★（全员存活）/ ★★（阵亡1人）/ ★（阵亡2人）
- **解锁条件**：等级 + 前一章节累计20星
- **本地兜底**：PVE星数 localStorage 备份，防止服务器断连丢失进度

### PVP 联机模式

- **8人军争**：主公×1 / 忠臣×2 / 反贼×4 / 内奸×1
- **真人+AI混合**：房主可设置AI填充数量
- **选将系统**：主公从3神+3非神中选1，非主公从3候选中选1（30秒倒计时）
- **身份脱敏**：非主公、非自己的玩家身份隐藏，游戏结束后公开
- **断线处理**：AI接替 + 逃跑标记（经验为0）
- **经验结算**：胜利/失败基础经验 + 击杀加成，升级动画

---

## 武将系统

### 52位武将（7国全覆盖）

| 国家 | 数量 | 武将列表 |
|------|------|----------|
| 蒙德 | 7 | 温迪、琴、迪卢克、可莉、优菈、凯亚、法尔伽 |
| 璃月 | 9 | 钟离、刻晴、甘雨、魈、胡桃、凝光、申鹤、夜兰、兹白 |
| 稻妻 | 8 | 雷电将军、八重神子、神里绫华、枫原万叶、珊瑚宫心海、荒泷一斗、宵宫、神里绫人 |
| 须弥 | 6 | 纳西妲、艾尔海森、妮露、迪希雅、提纳里、赛诺 |
| 枫丹 | 7 | 芙宁娜、那维莱特、莱欧斯利、林尼、娜维娅、克洛琳德、希格雯 |
| 纳塔 | 8 | 玛薇卡、基尼奇、希诺宁、茜特菈莉、欧洛伦、玛拉妮、瓦雷莎、恰斯卡 |
| 挪德卡莱 | 6 | 哥伦比娅、莉奈娅、奈芙尔、菈乌玛、菲林斯、伊涅芙 |

### 技能机制亮点

| 机制 | 代表性技能 |
|------|-----------|
| 伤害转化 | 娜维娅-刺玫（受伤恒为1）、迪希雅-佣兵（转移承伤） |
| 全场禁技 | 克洛琳德-剧团（禁用全场技能） |
| 卡牌转化 | 克洛琳德-决斗（高点数当决斗）、妮露-水月/水环（红牌当杀/黑牌当闪） |
| 全场互动 | 林尼-魔术（全场猜牌分牌） |
| 标记系统 | 冰寒标记（绫华/甘雨/申鹤）、冰翎（申鹤）、玉璋（钟离）、空月（哥伦比娅） |
| 判定联动 | 那维莱特-龙权（修改判定）、莱欧斯利-狱长/公爵（乐不思蜀联动） |
| 二段机制 | 纳西妲-囚笼（双发锦囊）、甘雨-月海（翻面回收） |
| 回复强化 | 希格雯-温度（桃+2）、芙宁娜-歌颂（HP变化时判定） |

### 状态标记（全部14种）

游戏支持完整的状态标记系统，在角色卡上以图标形式展示。PVP模式通过 `_xxx` 字段序列化传递，`mapServerPlayerToLocal` 保留所有标记。

| # | 标记 | 图标 | 所属英雄 | 效果 |
|---|------|------|----------|------|
| 1 | 🛡玉璋 | `🛡N` | 钟离 | 抵消伤害，每层-1伤害 |
| 2 | ⚡无想 | `⚡N` | 雷电将军 | 蓄力标记，N≥2时造成伤害 |
| 3 | 🌙空月 | `🌙N` | 哥伦比娅-少女 | 可主动移去令锦囊无效 |
| 4 | ❄霜月 | `❄N` | 哥伦比娅-月神 | 变身月神后的标记 |
| 5 | 🎆烟花 | `🎆` | 宵宫 | 伤害+1标记 |
| 6 | 🤝契约 | `🤝名字` | 钟离 | 分担伤害的契约伙伴 |
| 7 | 👑领袖 | `👑N/2` | 玛薇卡 | 已承受N/2伤害上限 |
| 8 | 🦋幽蝶 | `🦋` | 胡桃 | 伤害+1激活 |
| 9 | 💧/🌊 | `💧水环`/`🌊水月` | 妮露 | 黑牌当闪/红牌当杀 |
| 10 | 🍁枫 | `🍁N` | 枫原万叶 | 落叶层数 |
| 11 | 🚫封印 | `🚫花色` | 魈 | 被封印花色不可打出 |
| 12 | 📚知论 | `📚N` | 艾尔海森 | 知论牌数量 |
| 13 | 🛡️佣兵 | `🛡️` | 迪希雅 | 伤害转移保护 |
| 14 | 🪶冰翎 | `🪶N` | 申鹤 | 需2张闪抵消1张杀 |

> **PVP 注意事项**：以上标记的 `_xxx` 字段由服务端 `injectSkillMarks` 注入事件数据，客户端 `mapServerPlayerToLocal` 必须保留。新增标记需**同时更新三个位置**：`GameHost.ts` 的 `injectSkillMarks`、`GamePage.ts` 的 `extraMarks` 数组、`getStatusMarks` 的 fallback 读取。

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
- **10张壁纸**（每分钟池式随机轮播，每10分钟轮完一组）
- **2首BGM**（平时 + 战斗），平时BGM播放5分钟后切换战斗BGM

### 切换规则

| 场景 | 背景选择 | 音乐选择 |
|------|----------|----------|
| PVE 章节卡片 | 对应国家的具名图片，深境螺旋使用专用图片 | 按页面逻辑播放 |
| PVE 对局 | 关卡所属地区的 10 张编号壁纸池 | 关卡所属章节的 `region` |
| PVP 对局 | `pvp1.png` 至 `pvp10.png` 壁纸池 | 主公武将的 `region` |

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
| [PVE设计文档](docs/PVE设计文档.md) | PVE闯关系统设计 |
| [接口对齐分析 v2.3](docs/接口对齐分析_v2.3.md) | PVP/PVE/存储接口对齐分析 |
| [最新开发更新](docs/更新日志_2026-11-05.md) | 2026-11-05 牌桌交互、计时、窄窗口和弃牌修复 |
| [Java后端接入记录](docs/更新日志_2026-11-04.md) | 2026-11-04 Java账号后端、迁移、启动与验证记录 |
| [Java后端使用指南](docs/Java后端使用指南.md) | Java文件分工、HTTP接口、数据库、环境变量与阅读路线 |
| [更新日志 v2.3](docs/更新日志_v2.3.md) | v2.3 版本完整更新日志 |
| [更新日志 v2.2](docs/更新日志_v2.2.md) | v2.2 版本更新日志 |
| [更新日志 v2.1](docs/更新日志_v2.1.md) | v2.1 版本更新日志 |
| [Bug修复经验](docs/Bug修复经验.md) | Bug修复经验总结 |
| [PVP参数Bug记录](docs/PVP参数Bug记录.md) | PVP参数对齐记录 |

v2.1 至 v2.3 日志保留当时的实现和待办；当前账号架构以本 README、最新开发更新和 Java 后端使用指南为准。

---

## 账号后端验证（2026-11-04）

- Java：10 项测试通过，覆盖账号接口、令牌撤销和过期、旧账号兼容、并发与重复结算，以及 H2 文件持久化。
- TypeScript：22 项测试通过，覆盖现有游戏会话、聊天、背景资源，以及新增的账号接口适配和结算重试。
- 网页和游戏服务类型检查通过；前端构建通过。
- 独立测试数据库下完成三服务联调：注册登录、资料、设置、星级、经验、房间重连、战绩结算、退出撤销，以及 2 名真人 + 6 名 AI 的选将、对局启动和退出清理。

这些结果覆盖上述流程；完整角色技能组合和长时间多人对局仍需持续验证。

牌桌交互修复的代码分工、验收步骤与验证范围见 [2026-11-05 更新记录](docs/更新日志_2026-11-05.md)。核心八AI模拟与浏览器交互测试分别记录，不能相互替代。

2026-11-05 本轮验证：48 项 TypeScript 测试、类型检查和前端构建通过；浏览器核对窄窗口滚动、贯石斧实际弃牌、拆桥归属和五谷期间无懈响应；另有 8 个新种子的八AI完整核心对局正常结束。窄窗口保留完整桌面牌桌并横向滚动，不将八个座位压缩进同一屏。

---

## 开发指南

### 添加新武将

1. 在 `src/data/heroes.ts` 的 `ALL_HEROES` 数组中添加武将数据
2. 在 `src/core/skills/SkillManager.ts` 中实现技能（`getSkills` + `executeActiveSkill` + 钩子）
3. 在 `src/audio/VoiceManager.ts` 中注册语音（`VOICES` + `HERO_NAME_MAP`）
4. 在 `src/ai/AIDriver.ts` 中添加角色AI策略
5. 在 `Resources/Characters/` 添加角色立绘 PNG

### 添加新PVE关卡

1. 在 `src/data/PVELevels.ts` 对应章节的数组中添加 `PVELevel` 数据
2. 设置 `enemyHeroes`、`turnOrder`、`bannedHeroes`

### 添加新卡牌

1. 在 `src/data/CardData.ts` 的 `CARD_DATA` 数组中添加卡牌数据
2. 在 `src/core/CardEffectManager.ts` 中实现卡牌效果

---

## 许可

本项目为个人学习项目，仅用于技术交流。
