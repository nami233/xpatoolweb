/**
 * 槽位状态：一个消息顶掉今天散落在 `session.ts` 里的十几个 ref。
 *
 * 字段名刻意与前端 store 现有名字对齐（`游戏链路`/`链路消息`/`登录信息`/`心跳`/`等待应答数`…），
 * 这样 `DebugOps.vue`、`HomeView.vue` 的模板几乎不用改。
 */

/** 游戏服链路状态。`bridge-open` = 后端已连、游戏服还没连上，前端 `LINK_STATE_LABEL` 跟着它翻中文 */
export type LinkState = 'idle' | 'connecting' | 'bridge-open' | 'connected' | 'closed' | 'error'
export type LoginState = 'idle' | 'pending' | 'logined' | 'failed'
export type LogLevel = 'info' | 'success' | 'warn' | 'error'
export type FrameDirection = 'send' | 'recv'

/** 可订阅的事件种类。「暂停记录」= 退订 `帧` */
export type EventName = '状态' | '日志' | '帧' | '推送' | '脚本'

/** 用户脚本引擎的运行态（前端「脚本」页签显示的就是它） */
export type ScriptRunState = '未载入' | '运行中' | '已停止' | '出错停用'

export interface FrameRecord {
  direction: FrameDirection
  time: number
  cmdId: number
  name: string
  bodyLen: number
  /** 原来是 bigint，走 JSON 只能是字符串（`packetLog` 的表格模板不用改） */
  upsn: string
  downsn: string
  err: number
  /** 完整包体十六进制（不含 35 字节包头），前端的 hex 预览 / 导出都从这里切 */
  bodyHex: string
}

export interface LogEntry {
  id: number
  time: number
  level: LogLevel
  slot: number
  account: string
  text: string
}

export interface HeartbeatState {
  sent: number
  received: number
  intervalMs: number
  lastSent: number
  lastReceived: number
}

export interface LoginInfo {
  accountId: string
  accountNick: string
  playerId: string
  playerNick: string
  playerLevel: number
  serverId: string
  plat: string
}

export interface PassportCredential {
  sid: string
  userId: string
  userName: string
  extra: string
  gameId: string
  channelId: string
  appId: string
  deviceId: string
}

export interface PassportSnapshot {
  credential: PassportCredential | null
  state: string
  busy: boolean
  deviceId: string
}

export interface SlotState {
  slot: number
  account: string
  gameLink: LinkState
  linkMessage: string
  LoginState: LoginState
  LoginInfo: LoginInfo | null
  sessionNo: string
  queueTime: number
  banTime: string
  serverTime: string
  heartbeat: HeartbeatState
  pendingAcks: number
  passport: PassportSnapshot
}

/** `发送调试命令` 的结果（`DebugOps.vue` / `CaptureView.vue` 直接读这些字段） */
export interface DebugSendResult {
  cmdId: number
  bodyLen: number
  sendHex: string
  respName: string
  respLen: number
  respJson: string
}