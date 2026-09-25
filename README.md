# xpatoolweb

吉星派对 **Web 控制台 / 自动化工具**。

核心思路是**把游戏连接搬到后端**：浏览器不直连游戏服，而是连本项目的后端 WebSocket 服务；后端用一条 TCP 连到游戏服（自定义 35 字节包头 + protobuf 包体），把登录、房间、对局、推送都代理出来，再以统一的 JSON 协议转发给前端。

这样做换来两件事：

- **多账号并行**：一个后端进程可以同时挂着多个游戏账号（下称「槽位」），互不干扰。
- **可远程、可脱机**：槽位是服务端单例，和浏览器连接解耦 —— 页面刷新、关标签、断网，游戏连接与用户脚本照常跑；前端随时连回来恢复视图。

---

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 用户系统 | 自助注册 / 登录 / 登出，密码 `scrypt` 加盐哈希，会话令牌只在浏览器明文保存（服务端只存 sha256） |
| 游戏账号（槽位） | 每个用户最多 4 个，覆盖式 upsert（同账号再填一次 = 改密码），槽位号 = 持久化记录的 id |
| 通行证登录 | 服务端完成 feimo passport 发码 / 登录（签名是 MD5，且 `m-sdk` 无 CORS，必须放后端） |
| 账号主页 | 批量登录、创建 / 进入房间、账号状态与运行日志 |
| 操作抽屉 | 走位、骰子、卡牌、弃牌、商店、怪物、事件、战斗等按「当前待办」动态启用 |
| 地图 / 战斗视图 | 地块、Buff、怪物、英雄位置与战斗态势可视化 |
| 抓包 | 收发帧环形缓冲（默认 2000 条）、hex 预览、命令级过滤、可选落盘 |
| 脚本引擎 | 每槽位一份 JS 脚本，跑在后端 `node:vm` 沙箱里，页面关着也继续跑 |
| 调试发包 | 任意 `C2S` 命令 + JSON 参数直接下发，回包解码后展示 |

---

## 环境要求

- Node.js `^22.18.0 || >=24.12.0`

后端直接 `node server/index.ts` 运行，依赖 Node 原生的 **TypeScript 类型剥离**（strip-only），因此：

- 后端代码里不能用「构造函数参数属性」（`constructor(private x)`）等需要转换的语法；
- 后端 import 必须写相对路径 + 显式 `.ts` 后缀，不能用 Vite 的 `@/` 别名。

包管理器 npm / pnpm 均可（仓库两种 lock 文件都在）。

---

## 快速开始

```bash
npm install

# 同时起前端（Vite，5173）和后端（WS，8787）
npm run dev:all

# 也可以分开起
npm run dev        # 只起前端
npm run server     # 只起后端
```

打开前端后：

1. 首次使用点「注册」建一个 xpatoolweb 用户；
2. 在账号页添加游戏账号（账号 + 密码），后端会为它建一个槽位；
3. 点登录，后端走通行证 → 连游戏服 → `ConnectC2S`；
4. 进主页后用操作抽屉 / 抓包页 / 脚本页干活。

> 前端**不自动恢复会话**：刷新或重开页面需要重新登录。登录页的「记住密码」只帮你把用户名密码填好，仍需手动点登录。

### 常用脚本

```bash
npm run build            # type-check + vite build
npm run build-only       # 只打包
npm run preview          # 预览构建产物
npm run type-check       # vue-tsc（前端）
npm run type-check:server # tsc -p tsconfig.server.json（后端）
npm run format           # prettier 格式化 src/
```

## 配置项

后端全部配置集中在 [config.ts](file:///e:/dev/JXPD/xpatoolweb/server/config.ts)，通过 `XPA_*` 环境变量读取。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `XPA_WS_HOST` | `127.0.0.1` | 后端监听地址（旧名 `XPA_BRIDGE_HOST` 作回落） |
| `XPA_WS_PORT` | `8787` | 后端监听端口（旧名 `XPA_BRIDGE_PORT` 作回落） |
| `XPA_TOKEN` | 空 | 部署级门禁令牌。**为空仅允许监听回环地址**，非本机监听又没设令牌会直接拒绝启动 |
| `XPA_DATA_DIR` | `~/.xpatoolweb` | 落盘目录（`users.json` / `scripts.json`） |
| `XPA_ALLOW_REGISTER` | `1` | `=0` 关闭自助注册（先发号再放人的部署用） |
| `XPA_PUSH_MIN_MS` | `40` | 推送最小间隔（背压用） |
| `XPA_LOG_RING` | `500` | 每槽位日志环上限 |
| `XPA_FRAME_RING` | `2000` | 每槽位收发帧环上限 |
| `XPA_SLOT_IDLE_MS` | `0` | 槽位闲置回收阈值，`0` = 不按闲置回收 |
| `XPA_SLOT_RETAIN_MS` | `3600000` | 无任何前端连接时，账号桶保留多久才回收（1 小时） |
| `XPA_CONFIG_BASE` | feimo web 配置接口 | 远端配置拉取地址 |
| `XPA_PASSPORT_BASE` | `https://m-sdk.feimogames.com` | 通行证接口地址 |
| `XPA_CAPTURE_DIR` | `~/jxpd` | 抓包落盘目录 |
| `XPA_GAME_HOST` | `se-jump-cn-01.feimogames.com` | 游戏服地址 |
| `XPA_GAME_PORT` | `8800` | 游戏服端口 |

前端侧：

- 后端地址 / 令牌可在运行时改，存在 `localStorage` 的 `xpatoolweb.后端` 键里（操作抽屉的「调试」页签有地址 / 令牌输入框与「重连后端」按钮）；
- 默认地址来自 `VITE_XPA_WS`，回落到 `ws://127.0.0.1:8787`；
- 游戏服地址、客户端版本、账号上限等常量在 [src/config.ts](file:///e:/dev/JXPD/xpatoolweb/src/config.ts) 与后端各写一份（`import.meta.env` 在 Node 里用不了），改动时两边一起改。

---

## 架构

```
┌────────────┐   WS（全文本 JSON，每条带 t）   ┌──────────────────────────┐
│  浏览器     │ ─────────────────────────────▶ │  后端 server/            │
│  Vue 3 SPA │ ◀───────────────────────────── │  单进程多槽位             │
└────────────┘        连接级认证 + 用户绑定     │  ┌────────────────────┐  │
                                              │  │ slotSession × N    │  │
                                              │  │  脚本引擎 / 回放缓存 │  │
                                              │  └─────────┬──────────┘  │
                                              └────────────┼─────────────┘
                                                           │ TCP：35 字节包头 + protobuf 包体
                                                           ▼
                                                  ┌──────────────────┐
                                                  │ 游戏服 (feimogames)│
                                                  └──────────────────┘
```

### 鉴权两段

1. **连接级门禁**：连接后首条消息必须是 `认证`，只校验 `XPA_TOKEN`（为空则放行），回 `认证结果`（带命令表 `cmdId → 名称`，前端据此反推 `CMD_OF`，不必再打包 958 行的命令表）。
2. **用户级绑定**：`用户登录` / `注册` 校验口令后绑定租户 `u-<用户名>`，回 `用户结果`。

不变式：**认证 + 已绑定用户之前，不落地任何槽位**。

### 槽位生命周期

槽位是服务端单例，与 WS 连接无关：

- 槽位号在用户内单调分配（从 1 开始、只增、不复用）；「指定号」用于按持久化记录建槽，所以后端重启 / 刷新 / 登出再登回，前端手里的号依然对得上。
- 连接引用计数归零**不销毁**，只起保留定时器（用户记录里手写的 `retainMs` 优先，否则 `XPA_SLOT_RETAIN_MS`），期间有人连回来即撤销回收。
- 创建槽位是幂等的：按「账号 + 密码」指纹判断复用现有会话，指纹变了才同号重建。

### 目录结构

```
xpatoolweb/
├─ index.html                 # Vite 入口
├─ vite.config.ts             # 别名 @ / @shared；XPA_DEVTOOLS 门控
├─ src/                       # 前端（Vue 3 + Pinia + Vue Router + Vite）
│  ├─ views/                  # LoginView / HomeView（账号）/ CaptureView（抓包）
│  ├─ stores/                 # accounts / session / room / battle / user / packetLog / autoMove
│  ├─ net/                    # 与后端的 WS JSON 客户端（自动重连 + 请求号 + 订阅）
│  ├─ components/             # 操作抽屉、菜单块、房间对话框、地图 / 战斗视图
│  └─ data/                   # 名称表、战斗动作表、错误码文案
├─ server/                    # 后端（Node 直接跑 .ts）
│  ├─ index.ts                # 入口：WebSocketServer + 首条消息协议判定
│  ├─ config.ts               # 全部 XPA_* 环境变量 + 安全默认值校验
│  ├─ ws/                     # JSON 握手、上行类型守卫、连接分派
│  ├─ tenant/                 # 用户桶（槽位表）、槽位会话、全量帧回放缓存
│  ├─ slot/                   # 日志环 / 帧环 / 扇出 / 抓包落盘
│  ├─ net/                    # 游戏服帧拆分、protobuf 编解码、RPC 客户端
│  │  └─ proto/generated/     # 命令表与结构定义（生成物，已提交）
│  ├─ script/                 # 脚本引擎 + node:vm 沙箱
│  ├─ user/                   # 用户 / 会话 / 密码 / 脚本落盘
│  ├─ game/                   # 对局现场视图（脚本读的 state 来源）
│  ├─ passport.ts             # 通行证发码 / 登录
│  └─ remoteConfig.ts         # 代理拉取远端配置（绕 CORS）
└─ shared/                    # 前后端共用
   ├─ protocol/               # WS JSON 消息定义、状态类型、可读 JSON 化
   └─ game/                   # 走位折叠等共用逻辑
```

---

## 前后端 WS JSON 协议

单一 WebSocket、全文本帧、**每条消息顶层带 `t`**（不用 `type`，因为通行证上行参数里已经有业务字段 `type`）。

- 上行：`{ t, reqId, … }`，`reqId` 由前端单调递增分配，一次请求恰好对应一条回执。
- 下行分两类：请求-回执（`回执` / `回包` / `调试结果` / `通行证结果` / `脚本结果` …）与服务端主动推送（`推送` / `槽位状态` / `日志` / `帧批` / `脚本状态` / `降级`）。

消息定义见 [messages.ts](file:///e:/dev/JXPD/xpatoolweb/shared/protocol/messages.ts)，上行类型守卫（把前端输入当不可信数据）见 [protocol.ts](file:///e:/dev/JXPD/xpatoolweb/server/ws/protocol.ts)。

可订阅的事件种类：`状态` / `日志` / `帧` / `推送` / `脚本`（「暂停记录」= 退订 `帧`）。订阅按（连接, 槽位）记账，后端背压时会回 `降级` 并自动退掉部分事件。

### 与游戏服的协议

- 35 字节大端包头（`length / sessionId / cmdId / ver1-3 / upsn / downsn / err`）+ protobuf 包体，见 [frame.ts](file:///e:/dev/JXPD/xpatoolweb/server/net/frame.ts)；
- `upsn` 从 100 起，单次调用超时 15 s，见 [rpc.ts](file:///e:/dev/JXPD/xpatoolweb/server/net/rpc.ts)；
- 推送解码走一条通用通路：`cmdId → 命令名 → getSchema → decode → JSON 化`，只有 `ConnectS2C`(5002) / `HeartbeatS2C`(5004) 内部拦截、不向外发推送。

---

## 用户脚本

每个槽位一份脚本，存在 `~/.xpatoolweb/scripts.json`，**跑在后端进程里**，页面关掉照跑。运行态：

```
未载入 ──存脚本/读脚本──▶ 已停止 ──跑脚本──▶ 运行中 ──停脚本/登出──▶ 已停止
                            ▲                 └──连续出错 3 次──▶ 出错停用
                            └──────────── 重新保存 ────────────┘
```

保存脚本只编译、不执行；点「运行」才跑顶层并补报一次当前状态。若后端有存档而引擎还处于「未载入」，`读脚本` 会顺手把它编译进去（只编译、不跑），避免「存过但从没跑过」显示成「未载入」。

### 注入的 `game` 对象

标识符统一用英文（界面文案、游戏命令名等仍保留原文）。

```js
game.slot                     // 槽位号
game.account                  // 游戏账号名
game.myId                     // 登录后的玩家 id（未登录为空串）
game.state                    // 当前全貌快照 { slot, account, myId, match }（JSON 克隆，改它改不到引擎内存）
game.todo([commandName])      // 当前待办动作；不传 = 全部
game.sendAction(name, field)  // 发一条待办动作（命令必须在当前待办里）
game.when(events, callback)   // 注册事件钩子，返回序号
game.setTimer(callback, ms)   // 登记宿主定时器，返回序号
game.cancelTimer(seq)         // 取消定时器
game.logs(text, level)        // 写日志，level: info | success | warn | error
```

`sendAction` 只报成败；回包内容请钩对应的 `S2C` 事件。`Info.Sn` 由引擎自动填当前待办的动作序号，脚本传什么都会被覆盖。

`game.state.match` 的主要字段：`myId`、`room`（`state` / `roomId` / `mapId` / `difficulty` / `round` / `progress` / `progressLimit`）、`my`（自己的 `position` / `fromNode` / `walkCandidates` / `forceDirection` / `handCards` / `buffs` / `skillCooldown` / `chip` / 属性…）、`players`、`monsters`、`actor`、`myTurn`、`rollDice`、`todo`、`battle`。未进对局时 `my` 与 `battle` 为 `null`。

### 可钩的事件

- **服务端命令名**：如 `MoveS2C`、`ThrowDiceS2C`；
- **别名**：`move`（`MoveS2C` / `PursuitS2C` / `MonsterPursuitS2C`）、`MonsterRefresh`、`progress`、`attrChange`（只报自己的属性变化）；
- **语义事件**（前后两帧比出来的变化）：`进入对局` / `离开房间` / `轮次` / `待办` / `战斗开始` / `战斗结束`。

一条推送可能同时派发「原名 + 别名 + 语义事件」，派发按队列串行，脚本里 `await` 不会和下一帧交错。

### 示例

```js
game.when('待办', (todo) => {
  game.logs(`现在可以：${todo.commandName}`)
})

game.when('move', () => {
  game.logs(`我到了 ${game.state.match.my.position}`)
})

game.when('战斗开始', () => {
  game.setTimer(() => game.logs('战斗里定时器还在跑'), 1000)
})
```


## 数据落盘

| 文件 / 目录 | 内容 |
| --- | --- |
| `~/.xpatoolweb/users.json` | 用户记录（`passwordHash` / `gameAccounts` / 可选 `retainMs`）+ 会话表（sha256(令牌) → expiresAt）。**读不动会直接退出进程**，避免下一次落盘洗掉数据 |
| `~/.xpatoolweb/scripts.json` | 按「用户名 → 槽位号 → 源码」组织的脚本；读不动只警告当空库 |
| `~/jxpd/capture-<时间戳>.txt` | 抓包导出文件 |

两个存储都遵守：**原子写**（先写 `.tmp` 再 `rename`）、**串行化**（所有落盘排一条 Promise 队列）。

`users.json` 里可以手写 `retainMs`（毫秒）覆盖该用户的账号桶保留时长，不加协议、不加 UI。

---