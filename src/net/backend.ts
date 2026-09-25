/**
 * 前端唯一依赖的后端接口。
 *
 * 只有一个实现：`backendClient.ts`（一条 WS + JSON，后端跑协议栈与会话状态机）。
 * 早期还有一个「旧桥接」实现用来秒级回退，随着旧桥接整体删除，它也一并去掉了。
 *
 * 接口按**槽位**划分（不是按连接）：`注册槽位` 拿到回调、`发命令` 带槽位号。
 * 这样一条共享 WS 就能同时服务多个槽位。
 */
import { computed, shallowRef } from 'vue'
import type { DecodedMessage } from '@shared/protocol/jsonSafe'
import type {
  EventName,
  LogEntry,
  SlotState,
  FrameRecord,
  AuthResultDown,
  PassportCredential,
  SlotSummary,
  DebugSendResult,
  ScriptRunState,
} from '@shared/protocol/messages'
import { createBackendClient } from './backendClient'

export type FrontLinkState = '未连接' | '连接中' | '已连接' | '已断开'

export interface BackendCallback {
  /** WS/桥接这一层自己的连接状态（与「游戏链路」是两回事） */
  onConnState?: (state: FrontLinkState, message: string) => void
  /** 认证结果：命令表、槽位列表 */
  onAuth?: (result: AuthResultDown) => void
  onSlotState?: (state: SlotState) => void
  onLogs?: (entries: LogEntry[]) => void
  onFrames?: (entries: FrameRecord[]) => void
  onPushEvent?: (name: string, cmdId: number, data: DecodedMessage) => void
  /** 后端因背压自动停掉了某些事件 */
  degraded?: (unsubscribe: EventName[], message: string) => void
  /** 脚本运行态变了（跑 / 停 / 出错自动停用）。回执里也带一份，这条是给别的页签同步用的 */
  onScriptState?: (slot: number, runState: ScriptRunState, detail: string) => void
}

export interface sendCommandResult {
  ok: boolean
  error?: string
  respName?: string
  cmdId?: number
  value?: DecodedMessage
}

export interface PassportResult {
  ok: boolean
  ret: string
  msg: string
  credential: PassportCredential | null
  content: Record<string, unknown> | null
  url?: string
  message?: string
}

export interface RemoteConfigResult {
  ok: boolean
  url: string
  text: string
  data: Record<string, unknown> | null
  message?: string
}

/** `用户登录` 的入参：给 `令牌` 是补一次绑定（后端 WS 掉线重连时用），给用户名密码是常规登录 */
export interface userLoginParams {
  username?: string
  password?: string
  token?: string
}

export interface UserBindResult {
  ok: boolean
  username: string
  /** 只在注册 / 常规登录时下发，恢复会话不重发 */
  sessionToken?: string
  gameAccounts: SlotSummary[]
  error?: string
}

export interface AddGameAccountResult {
  ok: boolean
  slot?: number
  gameAccounts: SlotSummary[]
  error?: string
}

export interface RemoveGameAccountResult {
  ok: boolean
  gameAccounts: SlotSummary[]
  error?: string
}

/** 脚本四条（读 / 存 / 跑 / 停）共用的回执：都带引擎的当前运行态 */
export interface ScriptResult {
  ok: boolean
  /** 只有 `读脚本` 回它 */
  source?: string
  runState: ScriptRunState
  /** 运行态的说明（如「脚本已保存，点运行开始跑」） */
  detail: string
  error?: string
}

export interface BackendApi {
  connect(): void
  disconnect(): void
  isReady(): boolean
  /** 注册某个槽位的回调，返回注销函数 */
  registerSlot(slot: number, callback: BackendCallback): () => void
  /** 账号/密码是服务端持久化记录里的东西，前端不参与 */
  login(slot: number): Promise<{ ok: boolean; error?: string }>
  userLogin(params: userLoginParams): Promise<UserBindResult>
  register(username: string, password: string): Promise<UserBindResult>
  userLogout(): Promise<{ ok: boolean; error?: string }>
  addGameAccount(account: string, password: string): Promise<AddGameAccountResult>
  removeGameAccount(slot: number): Promise<RemoveGameAccountResult>
  /** 登出 / 换用户时清掉按槽位号存的回调与订阅记录 */
  resetUserState(): void
  subscribe(slot: number, events: EventName[]): void
  unsubscribe(slot: number, events: EventName[]): void
  /** 前端↔后端这一层的保活 + 取回「等待应答数」与服务器时间 */
  heartbeat(slot: number): Promise<{ serverTime: string; pendingAcks: number }>
  sendCommand(slot: number, name: string, params?: DecodedMessage): Promise<sendCommandResult>
  debugSend(
    slot: number,
    name: string,
    paramsJson: string,
  ): Promise<{ ok: boolean; error?: string; result?: DebugSendResult }>
  passport(slot: number, action: '发码' | '登录', params: DecodedMessage): Promise<PassportResult>
  fetchRemoteConfig(route: string, version: string): Promise<RemoteConfigResult>
  saveCapture(text?: string): Promise<{ ok: boolean; path?: string; error?: string }>
  clearLogs(slot: number): void
  /** 取回这个槽位存的脚本源码（顺带把存档载进引擎，只编译不跑） */
  readScript(slot: number): Promise<ScriptResult>
  /** 存脚本：落盘 + 让引擎编译。语法错的也存下来，但回 ok:false */
  saveScript(slot: number, source: string): Promise<ScriptResult>
  /** 跑已存的脚本（跑顶层并补发当前状态） */
  runScript(slot: number): Promise<ScriptResult>
  stopScript(slot: number): Promise<ScriptResult>
}

// ------------------------------------------------------------------ 命令表

/**
 * 号 ↔ 名。由服务端的 `认证结果` 填 —— 前端不再自带那张 958 行的 `cmds.gen.ts`。
 */
const idToName = shallowRef<Record<string, string>>({})
const nameToId = shallowRef<Record<string, number>>({})

export function loadCommandTable(table: Record<string, string>): void {
  const forward: Record<string, string> = {}
  const byName: Record<string, number> = {}
  for (const [Id, name] of Object.entries(table)) {
    if (typeof name !== 'string' || name.length === 0) continue
    forward[Id] = name
    byName[name] = Number(Id)
  }
  idToName.value = forward
  nameToId.value = byName
}

export function commandName(Id: number): string {
  return idToName.value[Id] ?? `CMD=${Id}`
}

export function cmdId(name: string): number | undefined {
  return nameToId.value[name.trim()]
}

/** `DebugOps.vue` / `CaptureView.vue` 的下拉候选（只列上行命令） */
export const commandCandidates = computed(() =>
  Object.values(idToName.value)
    .filter((name) => name.endsWith('C2S'))
    .sort(),
)

// ------------------------------------------------------------------ 实例

export const backendLinkState = shallowRef<FrontLinkState>('未连接')
export const backendLinkMessage = shallowRef('')

/**
 * 这条 WS 现在是否绑定了用户。
 * 与 `当前用户` 是两回事：掉线时 `当前用户` 还是非空的，但服务端那侧已经解绑了，
 * 所以「重连后要不要补一次恢复会话」得看这个。
 */
export const userBound = shallowRef(false)

/**
 * 最近一次认证结果（由传输实现写入，`在认证` 回调也会逐个槽位通知）。
 * 主要给调试面板看：命令表多少条、认证是不是被令牌挡了。
 */
export const authResult = shallowRef<AuthResultDown | null>(null)

let instance: BackendApi | null = null

/** 取（必要时创建）后端实例 */
export function getBackend(): BackendApi {
  if (instance) return instance
  const newInstance = createBackendClient()
  instance = newInstance
  return newInstance
}

/** 丢掉当前实例，下次 `取后端()` 会重新建一个（改完地址 / 令牌后调它） */
export function resetBackend(): void {
  instance?.disconnect()
  instance = null
}