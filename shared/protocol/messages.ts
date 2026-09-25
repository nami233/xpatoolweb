/**
 * 前后端之间的 WS JSON 协议（单条 WS、全文本帧、每条消息带 `t`）。
 *
 * 上行一律 `{ t, 请求号, … }`，下行要么是 `{ t:'回执'|'回包'|… , 请求号 }`（请求-回执），
 * 要么是 `{ t:'推送'|'槽位状态'|… }`（服务端主动推）。`请求号` 由前端单调递增分配，
 * 一次请求恰好对应一条回执。
 *
 * 为什么不用 `type`：`passport` 那条上行的参数里已经有个业务字段叫 `type`（`smsType`），
 * 顶层再用 `type` 极易撞名，这里统一叫 `t`。
 */
import type {
  EventName,
  FrameDirection,
  LogEntry,
  LogLevel,
  SlotState,
  FrameRecord,
  HeartbeatState,
  LoginInfo,
  LoginState,
  LinkState,
  PassportCredential,
  DebugSendResult,
  ScriptRunState,
} from './states.ts'
import type { DecodedMessage } from './jsonSafe.ts'

/** 游戏账号摘要：槽位号就是持久化记录里的 id，账号是给用户看的那串名字 */
export interface SlotSummary {
  slot: number
  account: string
}

// ---------------------------------------------------------------- 上行（前端 → 后端）

/** **必须是连接后的第一条**。不变式：只有认证通过 + 用户绑定之后才落地槽位 */
export interface AuthUp {
  t: '认证'
  /** 省略时不校验（本机开发） */
  token?: string
}

/**
 * 用户级绑定。给 `令牌` 就是拿旧令牌补一次绑定（后端 WS 掉线重连时用），
 * 给 `用户名` + `密码` 就是常规登录。
 */
export interface UserLoginUp {
  t: '用户登录'
  reqId: number
  username?: string
  password?: string
  /** 上次登录/注册下发的会话令牌；服务端只存它的 sha256 */
  token?: string
}

export interface RegisterUp {
  t: '注册'
  reqId: number
  username: string
  password: string
}

export interface HeartbeatUp {
  t: '心跳'
  reqId: number
}

/** 服务端做**覆盖式 upsert**（同一个游戏账号再填一次就是改密码），用户不必先删后加 */
export interface AddGameAccountUp {
  t: '加游戏账号'
  reqId: number
  account: string
  password: string
}

export interface RemoveGameAccountUp {
  t: '删游戏账号'
  reqId: number
  /** 游戏账号 id，也就是槽位号 */
  slot: number
}

/**
 * 登录某个游戏账号。**不带账号/密码** —— 它们是持久化记录里的东西，
 * 让前端能改就会出现「凭据与记录不一致」；服务端登录时自然会把记录里的那份装进槽位。
 */
export interface LoginUp {
  t: '登录'
  reqId: number
  slot: number
}

/** 登出的是 **xpatoolweb 用户**（不是某个游戏账号），服务端回到「已认证未绑定」态 */
export interface LogoutUp {
  t: '登出'
  reqId: number
}

export interface SubscribeUp {
  t: '订阅'
  reqId: number
  slot: number
  events: EventName[]
}

export interface UnsubscribeUp {
  t: '退订'
  reqId: number
  slot: number
  events: EventName[]
}

export interface SendCommandUp {
  t: '发命令'
  reqId: number
  slot: number
  name: string
  params?: DecodedMessage
}

export interface DebugSendUp {
  t: '调试发包'
  reqId: number
  slot: number
  name: string
  paramsJson: string
}

/** `参数` 用的是游戏 SDK 自己的字段名（`smsType`/`userName`/`password`/`code`/`loginType`/`appId`/`telNum`） */
export interface PassportUp {
  t: '通行证'
  reqId: number
  slot: number
  action: '发码' | '登录'
  params: DecodedMessage
}

export interface FetchRemoteConfigUp {
  t: '拉取远端配置'
  reqId: number
  route: string
  version: string
}

/** 不传 `文本` 时落服务端环形缓冲里最近的帧 */
export interface SaveCaptureUp {
  t: '保存抓包'
  reqId: number
  slot?: number
  text?: string
}

export interface ClearLogsUp {
  t: '清日志'
  reqId: number
  slot: number
}

// ---------------------------------------------------------------- 脚本（均按游戏账号的槽位各存各的）

/** 取这个槽位已保存的脚本源码（没存过回 `源码: ''`） */
export interface ReadScriptUp {
  t: '读脚本'
  reqId: number
  slot: number
}

/** 保存源码：落 `scripts.json`，并让引擎换成这份源码（**不会自动运行**） */
export interface SaveScriptUp {
  t: '存脚本'
  reqId: number
  slot: number
  source: string
}

/** 用已保存的源码编译 + 启动。已经在跑就先停掉再重来 */
export interface RunScriptUp {
  t: '跑脚本'
  reqId: number
  slot: number
}

export interface StopScriptUp {
  t: '停脚本'
  reqId: number
  slot: number
}

export type UpMessage =
  | AuthUp
  | UserLoginUp
  | RegisterUp
  | HeartbeatUp
  | AddGameAccountUp
  | RemoveGameAccountUp
  | LoginUp
  | LogoutUp
  | SubscribeUp
  | UnsubscribeUp
  | SendCommandUp
  | DebugSendUp
  | PassportUp
  | FetchRemoteConfigUp
  | SaveCaptureUp
  | ClearLogsUp
  | ReadScriptUp
  | SaveScriptUp
  | RunScriptUp
  | StopScriptUp

// ---------------------------------------------------------------- 下行（后端 → 前端）

/**
 * `命令表` 让前端彻底摆脱 958 行的 `cmds.gen.ts`：
 * `CMD_OF` 由它过滤 `C2S` 结尾反推，`CMD_NAMES[号+1]` 的用法完全不变。
 * 不带 `租户`/`槽位列表`：认证只是**连接级门禁**，这两样都是**用户级**的，
 * 由 `用户结果` 给出。
 */
export interface AuthResultDown {
  t: '认证结果'
  ok: boolean
  commandTable: Record<string, string>
  message?: string
}

/**
 * 用户绑定的结果（注册 / 登录 / 登出都回它）。
 *
 * `会话令牌` **只在注册/登录时下发**，恢复会话时不重发 —— 服务端的 TTL 是绝对时间戳，
 * 重发只会引入「服务端续了期、浏览器那份却没更新」的不一致。
 *
 * `游戏账号` 复用 `槽位摘要`（槽位号 + 账号名）：登录后前端就靠它知道该给自己建哪几个槽。
 */
export interface UserResultDown {
  t: '用户结果'
  reqId: number
  ok: boolean
  username: string
  sessionToken?: string
  gameAccounts?: SlotSummary[]
  message?: string
}

/** 动作类请求的立即回执 */
export interface AckDown {
  t: '回执'
  reqId: number
  ok: boolean
  slot?: number
  /** 加 / 删游戏账号时直接带上完整列表，前端不必再问一次 */
  gameAccounts?: SlotSummary[]
  message?: string
}

export interface HeartbeatAckDown {
  t: '心跳回执'
  reqId: number
  serverTime: string
  pendingAcks: number
}

export interface SlotStateDown {
  t: '槽位状态'
  state: SlotState
}

export interface LogsDown {
  t: '日志'
  slot: number
  entries: LogEntry[]
}

export interface FrameBatchDown {
  t: '帧批'
  slot: number
  entries: FrameRecord[]
}

/** 通用版 `rpc.onPush`：`数据` 就是今天 `decode(结构, frame.body)` 之后 JSON 化的结果 */
export interface PushDown {
  t: '推送'
  slot: number
  name: string
  cmdId: number
  data: DecodedMessage
}

export interface ResponseDown {
  t: '回包'
  reqId: number
  slot: number
  ok: boolean
  name?: string
  cmdId?: number
  /** 回包解码 + JSON 化的结果；`Actions[].Data` 这类 bytes 已就地替换成对象 */
  data?: DecodedMessage
  error?: string
  errorCode?: number
}

export interface DebugResultDown {
  t: '调试结果'
  reqId: number
  slot: number
  ok: boolean
  result?: DebugSendResult
  error?: string
}

export interface PassportResultDown {
  t: '通行证结果'
  reqId: number
  slot: number
  ok: boolean
  ret: string
  msg: string
  credential: PassportCredential | null
  content: Record<string, unknown> | null
  url?: string
  message?: string
}

export interface RemoteConfigDown {
  t: '远端配置结果'
  reqId: number
  ok: boolean
  url: string
  text: string
  data: Record<string, unknown> | null
  message?: string
}

export interface CaptureSaveDown {
  t: '抓包落盘结果'
  reqId: number
  ok: boolean
  path?: string
  message?: string
}

/**
 * `读脚本` / `存脚本` / `跑脚本` / `停脚本` 的共通回执。
 *
 * 回执里带上 `运行态`/`说明`（与 `脚本状态` 下行同一份数据）是为了让「按了按钮」的那次
 * 请求当场拿到结果，不必等异步推来的 `脚本状态`。
 */
export interface ScriptResultDown {
  t: '脚本结果'
  reqId: number
  slot: number
  ok: boolean
  /** 只有 `读脚本` 回它（没存过时是空串）；其余动作不回 */
  source?: string
  runState: ScriptRunState
  detail: string
  /** 请求本身失败的原因（`ok: false` 时给），不是脚本里的报错 */
  message?: string
}

/** 运行态自己变了就推（例如脚本连续出错被自动停用），不必有人来问 */
export interface ScriptStateDown {
  t: '脚本状态'
  slot: number
  runState: ScriptRunState
  detail: string
}

/** 协议级错误（不是某个请求的失败），例如首条消息不是 `认证` */
export interface ErrorDown {
  t: '错误'
  message: string
}

/** 背压时通知帧流已停 */
export interface DegradedDown {
  t: '降级'
  message: string
  /** 已被服务端自动退掉的事件 */
  unsubscribe?: EventName[]
}

export type DownMessage =
  | AuthResultDown
  | UserResultDown
  | AckDown
  | HeartbeatAckDown
  | SlotStateDown
  | LogsDown
  | FrameBatchDown
  | PushDown
  | ResponseDown
  | DebugResultDown
  | PassportResultDown
  | RemoteConfigDown
  | CaptureSaveDown
  | ScriptResultDown
  | ScriptStateDown
  | ErrorDown
  | DegradedDown

/** 重新导出，方便使用方只 import 这一个文件 */
export type {
  EventName,
  FrameDirection,
  LogEntry,
  LogLevel,
  SlotState,
  FrameRecord,
  HeartbeatState,
  LoginInfo,
  LoginState,
  LinkState,
  PassportCredential,
  DebugSendResult,
  ScriptRunState,
}