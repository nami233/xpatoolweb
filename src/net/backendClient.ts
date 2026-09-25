/**
 * JSON 后端客户端：一条共享 WebSocket 服务所有槽位。
 *
 * 为什么共享一条连接：槽位是**服务端**的概念，与连接解耦。多个账号走同一条连接，
 * 前端只需要维护一份重连/请求号逻辑，也让「关掉浏览器照常跑」这件事成立。
 *
 * 语义分界（与旧 `Bridge.发控制请求` 一致，调用方靠它区分「网络问题」与「业务拒绝」）：
 *   - 连不上 / 超时 / 连接断开 → `reject`；
 *   - 服务端受理了但业务失败 → `resolve` 出 `ok:false`。
 */
import { backendSettings } from '@/config'
import { loadCommandTable, backendLinkState, backendLinkMessage, authResult, userBound } from './backend'
import type {
  BackendCallback,
  BackendApi,
  sendCommandResult,
  PassportResult,
  RemoteConfigResult,
  FrontLinkState,
  UserBindResult,
  userLoginParams,
  AddGameAccountResult,
  RemoveGameAccountResult,
  ScriptResult,
} from './backend'
import type { EventName, DownMessage, SlotSummary, UserResultDown, DebugSendResult } from '@shared/protocol/messages'
import type { DecodedMessage } from '@shared/protocol/jsonSafe'

/** 请求默认超时：对齐旧 `RpcClient` 的 15s，免得后端稍慢一点前端就报错 */
const requestTimeoutMs = 15_000

interface PendingItem {
  settle: (message: DownMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ReadyWaiter {
  settle: () => void
  reject: (error: Error) => void
}

let socket: WebSocket | null = null
let authenticated = false
let bound = false
let nextRequestId = 0

/** 用户主动点了「断开」：不该再自动重连 */
let manualClose = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffIndex = 0
/** 掉线自动重连的退避阶梯；到底了就按最后一档一直试 */
const reconnectBackoffMs = [1000, 2000, 4000, 8000, 15000]

const pendingAcks = new Map<number, PendingItem>()
/**
 * 门禁过了就能发的请求（用户级三条：登录 / 注册 / 登出 —— 它们本身就是「绑定」这一步，
 * 排在「已绑定」后面会自己把自己卡死）。
 */
const pendingAuth = new Set<ReadyWaiter>()
/**
 * 认证 + 绑定完成后才发的请求（槽位类）。store 建会话时就会调 `注册槽位` + `连()`，
 * 紧接着直接发请求，中间没有任何「等就绪」的动作，所以排队必须由本实现自己兜住。
 */
const pendingReady = new Set<ReadyWaiter>()
/** 槽位 → 回调集合。注销函数按「还剩几个注册者」决定要不要发 `退订` */
const callbacksBySlot = new Map<number, Set<BackendCallback>>()
/**
 * 槽位 → 已订阅事件。**必须按槽位分开记**：服务端按（连接, 槽位）记订阅，
 * 若共用一份，第二个槽位订同一事件时会被本地当成「已订」而不上行，那个槽位就永远收不到推送。
 */
const slotSubscriptions = new Map<number, Set<EventName>>()

function broadcastLinkState(state: FrontLinkState, message: string): void {
  backendLinkState.value = state
  backendLinkMessage.value = message
  for (const set of callbacksBySlot.values()) {
    for (const callback of set) callback.onConnState?.(state, message)
  }
}

function sendAsIs(message: Record<string, unknown>): boolean {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

/** 不等回执的上行：仍然占一个请求号，免得和服务端回执里的号对不上 */
function sendDirect(message: Record<string, unknown>): void {
  afterReady(() => sendAsIs({ ...message, reqId: ++nextRequestId }))
}

function ensureConnected(): void {
  if (socket !== null) return
  connect()
}

/** 门禁过了（还没绑定用户） */
function authDone(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN && authenticated
}

/** 就绪 = 门禁过了 + 用户绑上了。槽位类请求必须等这个 */
function isReadyDone(): boolean {
  return authDone() && bound
}

/** 只等门禁：用户级请求走这条（它们自己就是绑定的那一步） */
function afterAuth(action: () => void): void {
  ensureConnected()
  if (authDone()) {
    action()
    return
  }
  pendingAuth.add({ settle: action, reject: () => {} })
}

/** 就绪了就立刻做，否则排队（连上并认证绑定完再按顺序做） */
function afterReady(action: () => void): void {
  ensureConnected()
  if (isReadyDone()) {
    action()
    return
  }
  pendingReady.add({ settle: action, reject: () => {} })
}

function releaseQueue(queue: Set<ReadyWaiter>): void {
  const snapshot = [...queue]
  queue.clear()
  for (const item of snapshot) item.settle()
}

function rejectQueue(queue: Set<ReadyWaiter>, reason: string): void {
  const snapshot = [...queue]
  queue.clear()
  for (const item of snapshot) item.reject(new Error(reason))
}

function connect(): void {
  if (socket !== null) return
  manualClose = false
  broadcastLinkState('连接中', `连接后端 ${backendSettings.url}`)

  let next: WebSocket
  try {
    next = new WebSocket(backendSettings.url)
  } catch (error) {
    broadcastLinkState('已断开', `后端地址非法：${String(error)}`)
    scheduleReconnect()
    return
  }
  socket = next

  next.onopen = () => {
    if (socket !== next) return
    authenticated = false
    bound = false
    userBound.value = false
    // 连上了就重置退避，下一次掉线从 1 秒重新等起
    backoffIndex = 0
    // 首条消息必须是 `认证`，服务端会拒掉其它消息；令牌为空时不带这个字段（本机开发不校验）
    const authMessage: Record<string, unknown> = { t: '认证' }
    if (backendSettings.token.length > 0) authMessage.token = backendSettings.token
    sendAsIs(authMessage)
    broadcastLinkState('已连接', '后端已连接，等待认证')
  }

  next.onmessage = (events: MessageEvent) => {
    if (socket !== next) return
    if (typeof events.data !== 'string') return
    let message: DownMessage
    try {
      message = JSON.parse(events.data) as DownMessage
    } catch {
      return
    }
    routeDown(message)
  }

  next.onerror = () => {
    if (socket !== next) return
    broadcastLinkState('已断开', '后端 WebSocket 出错（检查后端是否已启动）')
  }

  next.onclose = () => {
    if (socket !== next) return
    socket = null
    authenticated = false
    bound = false
    userBound.value = false
    rejectQueue(pendingAuth, '后端连接已断开')
    rejectQueue(pendingReady, '后端连接已断开')
    settleAll('后端连接已断开')
    broadcastLinkState('已断开', '后端连接已关闭，正在自动重连…')
    // 掉线不是终点：后端本来就能独立运行，重连回来再补一次用户绑定即可
    scheduleReconnect()
  }
}

/**
 * 排一次重连。退避阶梯往上走，连上就由 `onopen` 重置。
 * `主动关闭`（用户点断开 / 改地址）时不排 —— 那种情况期望的就是断着。
 */
function scheduleReconnect(): void {
  if (manualClose || reconnectTimer !== null) return
  const delay = reconnectBackoffMs[Math.min(backoffIndex, reconnectBackoffMs.length - 1)]
  backoffIndex += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function disconnect(): void {
  manualClose = true
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const old = socket
  socket = null
  authenticated = false
  bound = false
  userBound.value = false
  if (old !== null) {
    // 先摘回调再关：否则 close 事件会被当成「意外断开」再结算一次
    old.onopen = null
    old.onmessage = null
    old.onerror = null
    old.onclose = null
    try {
      old.close()
    } catch {
    }
  }
  settleAll('后端连接已断开')
  rejectQueue(pendingAuth, '后端连接已断开')
  rejectQueue(pendingReady, '后端连接已断开')
  slotSubscriptions.clear()
  authResult.value = null
  broadcastLinkState('未连接', '已断开后端连接')
}

function isReady(): boolean {
  return isReadyDone()
}

function sendRequest(
  payload: Record<string, unknown>,
  timeoutHint: string,
  timeoutMs: number = requestTimeoutMs,
  authOnly = false,
): Promise<DownMessage> {
  const reqId = ++nextRequestId
  return new Promise<DownMessage>((settle, reject) => {
    // 超时从「入队」开始算：认证前挂起的请求也不能无限等（后端起不来时要能报错）
    const timer = setTimeout(() => {
      pendingAcks.delete(reqId)
      reject(new Error(timeoutHint))
    }, timeoutMs)

    const sendOut = (): void => {
      // 排队期间可能已经被超时/断线结算掉了，别再把陈旧请求发出去
      if (!pendingAcks.has(reqId)) return
      const connection = socket
      if (connection === null || connection.readyState !== WebSocket.OPEN) {
        pendingAcks.delete(reqId)
        clearTimeout(timer)
        reject(new Error('后端 WebSocket 还没连上'))
        return
      }
      try {
        connection.send(JSON.stringify({ ...payload, reqId }))
      } catch (error) {
        pendingAcks.delete(reqId)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }

    pendingAcks.set(reqId, { settle, reject, timer })
    // 首条以外的消息在门禁前都会被服务端拒掉；用户级请求只等门禁，槽位类还要等绑定
    if (authOnly) afterAuth(sendOut)
    else afterReady(sendOut)
  })
}

function settleAll(reason: string): void {
  for (const [reqId, item] of [...pendingAcks]) {
    pendingAcks.delete(reqId)
    clearTimeout(item.timer)
    item.reject(new Error(reason))
  }
}

function settle(message: DownMessage): void {
  const reqId = (message as { reqId?: number }).reqId
  if (typeof reqId !== 'number') return
  const item = pendingAcks.get(reqId)
  if (item === undefined) return
  pendingAcks.delete(reqId)
  clearTimeout(item.timer)
  item.settle(message)
}

function dispatchSlot(slot: number, action: (callback: BackendCallback) => void): void {
  const set = callbacksBySlot.get(slot)
  if (set === undefined) return
  for (const callback of [...set]) action(callback)
}

function resendSubscriptions(): void {
  for (const [slot, set] of slotSubscriptions) {
    if (set.size === 0) continue
    sendAsIs({ t: '订阅', reqId: ++nextRequestId, slot, events: [...set] })
  }
}

function routeDown(message: DownMessage): void {
  switch (message.t) {
    case '认证结果': {
      if (!message.ok) {
        const hint = message.message ?? '后端认证失败'
        backendLinkMessage.value = hint
        rejectQueue(pendingAuth, hint)
        rejectQueue(pendingReady, hint)
        broadcastLinkState('已断开', hint)
        return
      }
      authenticated = true
      authResult.value = message
      loadCommandTable(message.commandTable)
      backendLinkMessage.value = '后端门禁已通过'
      for (const set of callbacksBySlot.values()) {
        for (const callback of set) callback.onAuth?.(message)
      }
      // 用户级请求（登录 / 注册）在这里放行；槽位类要等 `用户结果`，
      // 否则会在用户没绑定时发出去，服务端只能回「连接还没认证」
      releaseQueue(pendingAuth)
      return
    }
    case '用户结果': {
      // 登出的回执也是「用户结果」，但它的用户名是空的 —— 那不叫绑上了
      const username = typeof message.username === 'string' ? message.username : ''
      bound = message.ok && username.length > 0
      userBound.value = bound
      if (bound) {
        releaseQueue(pendingReady)
        resendSubscriptions()
      } else {
        rejectQueue(pendingReady, message.ok ? '用户已登出' : (message.message ?? '用户没绑定上'))
      }
      settle(message)
      return
    }
    case '回执':
    case '回包':
    case '调试结果':
    case '通行证结果':
    case '远端配置结果':
    case '抓包落盘结果':
    case '脚本结果':
    case '心跳回执':
      settle(message)
      return
    case '槽位状态': {
      const state = message.state
      dispatchSlot(state.slot, (callback) => callback.onSlotState?.(state))
      return
    }
    case '日志': {
      const entries = message.entries
      dispatchSlot(message.slot, (callback) => callback.onLogs?.(entries))
      return
    }
    case '帧批': {
      const entries = message.entries
      dispatchSlot(message.slot, (callback) => callback.onFrames?.(entries))
      return
    }
    case '推送': {
      const { slot, name, cmdId, data } = message
      dispatchSlot(slot, (callback) => callback.onPushEvent?.(name, cmdId, data))
      return
    }
    case '脚本状态': {
      const { slot, runState, detail } = message
      dispatchSlot(slot, (callback) => callback.onScriptState?.(slot, runState, detail))
      return
    }
    case '降级': {
      const unsubscribeList = message.unsubscribe ?? []
      // 降级是连接级的（没有槽位字段），所以所有槽位本地都要把被停掉的事件划掉
      for (const events of unsubscribeList) {
        for (const set of slotSubscriptions.values()) set.delete(events)
      }
      for (const set of callbacksBySlot.values()) {
        for (const callback of set) callback.degraded?.(unsubscribeList, message.message)
      }
      return
    }
    case '错误':
      backendLinkMessage.value = message.message
      console.warn(`后端错误：${message.message}`)
      return
  }
}

function registerSlot(slot: number, callback: BackendCallback): () => void {
  ensureConnected()

  let set = callbacksBySlot.get(slot)
  if (set === undefined) {
    set = new Set<BackendCallback>()
    callbacksBySlot.set(slot, set)
  }
  set.add(callback)

  const existingSubscribe = slotSubscriptions.get(slot)
  if (existingSubscribe !== undefined && existingSubscribe.size > 0) {
    sendDirect({ t: '订阅', slot, events: [...existingSubscribe] })
  }
  callback.onConnState?.(backendLinkState.value, backendLinkMessage.value)

  return () => {
    const callbackSet = callbacksBySlot.get(slot)
    if (callbackSet === undefined || !callbackSet.delete(callback)) return
    if (callbackSet.size > 0) return
    callbacksBySlot.delete(slot)
    const currentSubs = slotSubscriptions.get(slot)
    if (currentSubs !== undefined && currentSubs.size > 0) {
      sendDirect({ t: '退订', slot, events: [...currentSubs] })
    }
  }
}

function subscribe(slot: number, events: EventName[]): void {
  let set = slotSubscriptions.get(slot)
  if (set === undefined) {
    set = new Set<EventName>()
    slotSubscriptions.set(slot, set)
  }
  const added = events.filter((item) => !set.has(item))
  if (added.length === 0) return
  for (const item of added) set.add(item)
  sendDirect({ t: '订阅', slot, events: added })
}

function unsubscribe(slot: number, events: EventName[]): void {
  const set = slotSubscriptions.get(slot)
  if (set !== undefined) {
    for (const item of events) set.delete(item)
  }
  sendDirect({ t: '退订', slot, events })
}

async function login(slot: number): Promise<{ ok: boolean; error?: string }> {
  const message = await sendRequest({ t: '登录', slot }, '登录超时', 30_000)
  if (message.t !== '回执') throw new Error('后端没有返回登录回执')
  return { ok: message.ok, error: message.ok ? undefined : (message.message ?? '登录失败') }
}

function collectGameAccount(message: { gameAccounts?: SlotSummary[] }): SlotSummary[] {
  return message.gameAccounts ?? []
}

function onBindResult(message: UserResultDown): UserBindResult {
  return {
    ok: message.ok,
    username: message.username,
    sessionToken: message.sessionToken,
    gameAccounts: collectGameAccount(message),
    error: message.ok ? undefined : (message.message ?? '用户没绑定上'),
  }
}

async function userLogin(params: userLoginParams): Promise<UserBindResult> {
  const isRestore = typeof params.token === 'string' && params.token.length > 0
  const message = await sendRequest(
    { t: '用户登录', ...params },
    isRestore ? '恢复会话超时' : '用户登录超时',
    30_000,
    true,
  )
  if (message.t !== '用户结果') throw new Error('后端没有返回用户结果')
  return onBindResult(message)
}

async function register(username: string, password: string): Promise<UserBindResult> {
  // scrypt 要跑上百毫秒，超时给宽一点
  const message = await sendRequest({ t: '注册', username, password }, '注册超时', 30_000, true)
  if (message.t !== '用户结果') throw new Error('后端没有返回用户结果')
  return onBindResult(message)
}

async function userLogout(): Promise<{ ok: boolean; error?: string }> {
  const message = await sendRequest({ t: '登出' }, '登出超时', 15_000, true)
  if (message.t !== '用户结果') throw new Error('后端没有返回用户结果')
  return { ok: message.ok, error: message.ok ? undefined : (message.message ?? '登出失败') }
}

async function addGameAccount(account: string, password: string): Promise<AddGameAccountResult> {
  const message = await sendRequest({ t: '加游戏账号', account, password }, '添加游戏账号超时', 20_000)
  if (message.t !== '回执') throw new Error('后端没有返回添加游戏账号回执')
  return {
    ok: message.ok,
    slot: message.slot,
    gameAccounts: collectGameAccount(message),
    error: message.ok ? undefined : (message.message ?? '添加游戏账号失败'),
  }
}

async function removeGameAccount(slot: number): Promise<RemoveGameAccountResult> {
  const message = await sendRequest({ t: '删游戏账号', slot }, '删除游戏账号超时')
  if (message.t !== '回执') throw new Error('后端没有返回删除游戏账号回执')
  return {
    ok: message.ok,
    gameAccounts: collectGameAccount(message),
    error: message.ok ? undefined : (message.message ?? '删除游戏账号失败'),
  }
}

/**
 * 登出 / 换用户时必须清一次：`槽位回调` 与 `槽位订阅` 都是按**槽位号**存的，
 * 而两个用户的槽位号会重叠（都是 1、2、3…），不清就会把上一个用户的状态推给下一个。
 */
function resetUserState(): void {
  bound = false
  userBound.value = false
  callbacksBySlot.clear()
  slotSubscriptions.clear()
  rejectQueue(pendingAuth, '用户已登出')
  rejectQueue(pendingReady, '用户已登出')
}

async function heartbeat(slot: number): Promise<{ serverTime: string; pendingAcks: number }> {
  // 心跳回执按请求号结算、不带槽位；参数保留只为对齐接口（前端↔后端这一层本来就是连接级的）
  void slot
  const message = await sendRequest({ t: '心跳' }, '后端心跳超时')
  if (message.t !== '心跳回执') throw new Error('后端没有返回心跳回执')
  return { serverTime: message.serverTime, pendingAcks: message.pendingAcks }
}

async function sendCommand(slot: number, name: string, params: DecodedMessage = {}): Promise<sendCommandResult> {
  const message = await sendRequest({ t: '发命令', slot, name, params }, `发命令超时：${name}`)
  if (message.t !== '回包') throw new Error('后端没有返回回包')
  return {
    ok: message.ok,
    error: message.error,
    respName: message.name,
    cmdId: message.cmdId,
    value: message.data,
  }
}

async function debugSend(
  slot: number,
  name: string,
  paramsJson: string,
): Promise<{ ok: boolean; error?: string; result?: DebugSendResult }> {
  const message = await sendRequest({ t: '调试发包', slot, name, paramsJson }, `调试发包超时：${name}`)
  if (message.t !== '调试结果') throw new Error('后端没有返回调试结果')
  return { ok: message.ok, error: message.error, result: message.result }
}

async function passport(
  slot: number,
  action: '发码' | '登录',
  params: DecodedMessage,
): Promise<PassportResult> {
  const message = await sendRequest({ t: '通行证', slot, action, params }, '通行证请求超时', 20_000)
  if (message.t !== '通行证结果') throw new Error('后端没有返回通行证结果')
  return {
    ok: message.ok,
    ret: message.ret,
    msg: message.msg,
    credential: message.credential,
    content: message.content,
    message: message.message,
  }
}

async function fetchRemoteConfig(route: string, version: string): Promise<RemoteConfigResult> {
  const message = await sendRequest({ t: '拉取远端配置', route, version }, '拉取远端配置超时', 12_000)
  if (message.t !== '远端配置结果') throw new Error('后端没有返回远端配置结果')
  return { ok: message.ok, url: message.url, text: message.text, data: message.data, message: message.message }
}

async function saveCapture(text?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  // 不带槽位：不传文本时服务端落它自己的环形缓冲；传了文本就是「前端已拼好的内容直接落盘」
  const payload: Record<string, unknown> = { t: '保存抓包' }
  if (text !== undefined && text.length > 0) payload.text = text
  const message = await sendRequest(payload, '保存抓包超时', 20_000)
  if (message.t !== '抓包落盘结果') throw new Error('后端没有返回抓包落盘结果')
  return {
    ok: message.ok,
    path: message.path,
    error: message.ok ? undefined : (message.message ?? '保存失败'),
  }
}

function clearLogs(slot: number): void {
  // 发了就不等回执：本地 store 已经把日志清了，回执没人看，等它只会让按钮卡住
  sendDirect({ t: '清日志', slot })
}

/** 脚本四条共用的收发：命令名不同，回包都是 `脚本结果` */
async function sendScriptRequest(
  command: '读脚本' | '存脚本' | '跑脚本' | '停脚本',
  slot: number,
  source?: string,
): Promise<ScriptResult> {
  const payload: Record<string, unknown> = { t: command, slot }
  if (source !== undefined) payload.source = source
  // 跑脚本可能是死循环被顶层超时断掉，但那也在后端同步完成，15s 够
  const message = await sendRequest(payload, `${command}超时`)
  if (message.t !== '脚本结果') throw new Error('后端没有返回脚本结果')
  return {
    ok: message.ok,
    source: message.source,
    runState: message.runState,
    detail: message.detail,
    error: message.ok ? undefined : (message.message ?? '脚本操作失败'),
  }
}

function readScript(slot: number): Promise<ScriptResult> {
  return sendScriptRequest('读脚本', slot)
}

function saveScript(slot: number, source: string): Promise<ScriptResult> {
  return sendScriptRequest('存脚本', slot, source)
}

function runScript(slot: number): Promise<ScriptResult> {
  return sendScriptRequest('跑脚本', slot)
}

function stopScript(slot: number): Promise<ScriptResult> {
  return sendScriptRequest('停脚本', slot)
}

export function createBackendClient(): BackendApi {
  return {
    connect,
    disconnect,
    isReady,
    registerSlot,
    login,
    userLogin,
    register,
    userLogout,
    addGameAccount,
    removeGameAccount,
    resetUserState,
    subscribe,
    unsubscribe,
    heartbeat,
    sendCommand,
    debugSend,
    passport,
    fetchRemoteConfig,
    saveCapture,
    clearLogs,
    readScript,
    saveScript,
    runScript,
    stopScript,
  }
}