# Java 后端使用指南

本项目的 Java 后端负责账号和持久化业务，原有 TypeScript 服务负责实时对局。两者已经通过接口连接，前端继续使用现有 Socket.IO 事件。

## 先运行起来

在项目目录打开 PowerShell，确认以下命令能够显示版本：

```powershell
java -version
mvn -version
node -v
```

使用 JDK 21、Maven 3.6.3 或以上，以及支持 `--import` 的 Node.js 18.19 或以上。已有 `node_modules` 时可以直接运行：

```powershell
npm start
```

如果依赖尚未安装，先执行 `npm install`。首次启动会下载 Maven 依赖，需要网络，耗时比后续启动长。启动脚本会先构建 Java 程序，再启动三个进程：

| 服务 | 默认地址 | 职责 |
|---|---|---|
| Vite 网页 | http://localhost:3000 | 页面和操作界面 |
| Node.js 游戏服务 | http://localhost:3457 | 房间、实时通信、回合和伤害结算 |
| Spring Boot 账号服务 | http://127.0.0.1:8080 | 注册、登录、资料、设置、星级和战绩存储 |

游戏服务会等待 Java 的 `/api/health` 就绪后再启动。所有服务共用启动终端，按 `Ctrl+C` 结束；其中一个服务退出时，启动器会停止其余服务。端口被占用时应先结束旧进程，再重新运行，避免混用两次启动的服务。

## 单独运行和检查

```powershell
npm run backend          # 构建并运行 Java 服务
npm run server           # 等待 Java 就绪后运行 Node.js 游戏服务
npm run dev              # 运行网页开发服务器
npm run backend:test     # 运行 Java 集成测试
npm run backend:package  # 测试并生成可执行 jar
npm run typecheck
npm test
npm run test:backend:smoke # 服务启动后执行跨服务验证；建议配合独立测试数据库使用
```

分别启动时，前三条命令需要三个终端。`npm start` 最方便，它会自动为两套后端设置相同的本地服务密钥。`npm run backend` 也会初始化该密钥，之后 `npm run server` 自动读取。

Java 脚本使用 `JAVA_HOME`、`MAVEN_HOME` 或 `PATH` 查找工具，无需修改为本机硬编码目录。项目中的 `scripts/java-backend.ps1` 还可以直接调用：

```powershell
./scripts/java-backend.ps1 -Task test
./scripts/java-backend.ps1 -Task package
./scripts/java-backend.ps1 -Task run
```

## 现在的代码怎么分工

```text
网页：登录、资料、对局界面
  │ Socket.IO
  ▼
Node.js：接收原有事件，管理房间和游戏实例
  │ HTTP / Bearer Token / 内部服务密钥
  ▼
Java Controller：接收请求，校验输入，返回 JSON
  ▼
Java Service：账号验证、等级计算、设置合并、战绩结算
  ▼
Java Repository：执行 SQL，读取和保存数据
  ▼
H2 文件数据库
```

`Controller` 表示请求入口，`Service` 表示业务处理，`Repository` 表示数据库访问。以修改昵称为例：入口层接收昵称，业务层验证昵称是否为空、长度是否符合要求，存储层更新对应账号。游戏的 `while` 循环、技能效果和伤害结算依然由现有 TypeScript 实现。

当前数据库使用 H2 文件模式，启动时自动建表，不需要另外安装数据库。它是实际的关系数据库，数据会写入磁盘；当前实现没有接入 MySQL。数据库文件默认在 `java-backend/data/`，Maven 下载缓存保存在项目 `.cache/maven/`，可执行程序位于 `java-backend/target/genshin-card-backend.jar`。

## 账号和旧数据

启动脚本会将旧账号文件 `server/accounts.json` 的绝对路径传给 Java 服务。迁移保留原文件，不会为了导入而删除或覆盖它；重复启动不会重复创建已有账号。导入后的数据由数据库维护，旧 JSON 不再作为新的业务写入位置。

旧账号原来使用 SHA-256 密码哈希。兼容登录时会验证旧哈希，并在成功登录后升级为 BCrypt；新注册账号直接使用 BCrypt。超过 BCrypt 72 字节限制的旧密码采用带标识的 SHA-256 预处理后再 BCrypt，兼容原有登录。新注册密码要求至少3个字符、UTF-8 编码不超过72字节。登录令牌随机生成，数据库保存令牌摘要及过期时间；退出登录会使该令牌失效。

迁移前可以自行备份旧 JSON。不要将账号文件、本地密钥、数据库或构建产物提交到 Git。项目忽略规则已经排除这些运行文件。对已经被 Git 跟踪的历史文件，忽略规则不会自动删除历史记录。

## HTTP 接口

所有正常业务响应包含 `success`，业务错误包含 `reason`。`/api/account` 路由要求请求头 `Authorization: Bearer <token>`。

| 方法 | 路径 | 请求内容或用途 |
|---|---|---|
| GET | `/api/health` | 检查 Java 服务是否就绪 |
| POST | `/api/auth/signup` | `{ "name": "玩家", "password": "你的密码" }` |
| POST | `/api/auth/login` | 账号密码登录 |
| POST | `/api/auth/logout` | 退出当前令牌 |
| GET | `/api/account` | 读取自己的资料、设置、星级和战绩 |
| PATCH | `/api/account/profile` | `{ "nickname": "新昵称", "avatar": "头像路径" }` |
| PUT | `/api/account/settings` | 设置对象，和已有设置合并 |
| PUT | `/api/account/pve-stars` | `{ "stars": { "1": 3, "2": 2 } }`，保留各关最高星级 |

内部接口仅供游戏服务调用，使用 `X-Game-Service-Key`，不向浏览器提供密钥：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/internal/accounts/{id}/exp` | 保存经验增量，`operationId` 防止同一次操作重复入账 |
| POST | `/internal/accounts/{id}/pvp-result` | 在一个事务中保存 PVP 经验和角色胜率统计，同一次结算只处理一次 |

PVP 经验由游戏服务器结算后提交。待提交的结算命令保存在 `.runtime/pvp-settlements.json`，Java 服务暂时不可用时可重试，Node.js 重启后也能继续提交；文件不保存玩家令牌。Java 将同一局的经验和统计放在事务中处理，并使用操作编号防止重复结算。

PVE 延续原有浏览器本地对局和结果上报方式，校验范围与 PVP 不同；若以后上线竞争性排行榜，需要把 PVE 结果校验移到受信任的服务端。

## 配置位置

Java 默认配置位于 `java-backend/src/main/resources/application.properties`。常用环境变量如下：

| 变量 | 含义 |
|---|---|
| `GAME_SERVICE_KEY` | Java 与 Node.js 共同使用的内部服务密钥；启动器未检测到配置时会生成 `.cache/game-service-key` |
| `ACCOUNT_API_URL` | Node.js 请求 Java 的地址，默认 `http://127.0.0.1:8080` |
| `LEGACY_ACCOUNTS_FILE` | 要迁移的旧账号 JSON 路径，启动器默认指向本项目旧文件 |
| `JAVA_BACKEND_PORT` | Java HTTP 端口，默认 `8080`；修改后还需设置对应的 `ACCOUNT_API_URL` |
| `JAVA_BACKEND_HOST` | Java 监听地址，默认 `127.0.0.1` |
| `ACCOUNT_DB_URL` | Java 数据库连接地址，覆盖默认的 H2 文件路径 |
| `ACCOUNT_SESSION_TTL` | 登录令牌有效期，默认 `PT168H`（7天） |
| `PORT` | Node.js 游戏服务端口，默认 `3457`；修改后需同步 Vite 的 Socket.IO 代理目标 |

本地学习时直接使用默认值即可。Java 服务默认只绑定本机；部署到其他机器时需要自行配置监听地址、HTTPS 入口和持久化目录。

## 建议从这条调用链读代码

先找到 Java 的登录入口，再顺着方法调用看到密码验证、令牌生成和数据库读写。读完后尝试自己增加一个资料字段，观察要改哪些层。这样能够具体回答：

- 用户和登录状态在数据库中怎样表示？
- 接口入口与业务逻辑为什么分开？
- 两个请求同时增加经验，如何避免覆盖？
- 同一局结算重试，为什么不会重复增加经验？
- Java 服务暂时不可用时，游戏服务怎样向前端返回错误？

面试时应准确表述为“Java 负责账号与持久化，Node.js 负责实时对局”，并根据已经实现的代码解释模块之间的调用关系。
