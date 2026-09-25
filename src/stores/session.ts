import { computed, markRaw, reactive, ref, watch } from 'vue'
import type {
  EventName,
  LogLevel,
  LogEntry,
  SlotState,
  FrameRecord,
  LinkState,
  LoginState,
  LoginInfo,
  PassportCredential,
  DebugSendResult,
  ScriptRunState,
} from '@shared/protocol/messages'
import type { DecodedMessage } from '@shared/protocol/jsonSafe'
import { getBackend, resetBackend } from '@/net/backend'
import type { BackendCallback, BackendApi, FrontLinkState } from '@/net/backend'
import { createRoomState } from '@/stores/room'
import { createMatchState } from '@/stores/battle'
import type { CandidateAction } from '@/stores/battle'
import { createAutoMove } from '@/stores/autoMove'
import { usePacketLogStore } from './packetLog'
import { monsterName, roomStateNameTable } from '@/data/names'
import { getActionSpec } from '@/data/battleActions'
import { serverHost, serverPort, configApiRoute, configApiVersion } from '@/config'

// 这几个名字原来定义在这里，现在归到共享契约里；这里只做转发，外面那堆组件不用改 import。
export type { LoginState, LogLevel, LogEntry, LoginInfo, DebugSendResult }

const LINK_STATE_LABEL: Record<LinkState, string> = {
  idle: '未连接',
  connecting: '连接中',
  'bridge-open': '已连后端',
  connected: '已连服务端',
  closed: '已断开',
  error: '出错',
}

const LOGIN_STATE_LABEL: Record<LoginState, string> = {
  idle: '未登录',
  pending: '登录中',
  logined: '已登录',
  failed: '登录失败',
}

const MAX_LOG_ITEMS = 300

/** 前端↔后端这条 WS 的保活间隔。游戏侧心跳由后端常驻发，不走这里。 */
const backendHeartbeatMs = 5000

const allEvents: EventName[] = ['状态', '日志', '帧', '推送', '脚本']

const runLogs = ref<LogEntry[]>([])
let nextLogId = 1

export function getRunLogs() {
  return runLogs
}

export function clearRunLogs(): void {
  runLogs.value = []
}

const toStr = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'bigint' ? value.toString() : ''
const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

/** 玩家 id 之类的 64 位字段走 JSON 是字符串；拿不到就当 0 号 */
function toId(value: unknown): string {
  const text = toStr(value)
  return text.length > 0 ? text : '0'
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 64 位整型走 JSON 只剩十进制字符串，用不了就退 0 */
function toBigint(value: unknown): bigint {
  const text = toStr(value)
  if (text.length === 0) return 0n
  try {
    return BigInt(text)
  } catch {
    return 0n
  }
}

function parseServerUrl(serverUrl: string): { host: string; port: number } | null {
  const cleaned = serverUrl.replace(/[`\s]/g, '')
  if (cleaned.length === 0) return null
  const colon = cleaned.lastIndexOf(':')
  if (colon <= 0) return { host: cleaned, port: 0 }
  const port = Number(cleaned.slice(colon + 1))
  return {
    host: cleaned.slice(0, colon),
    port: Number.isInteger(port) && port > 0 ? port : 0,
  }
}

export interface AccountSource {
  slot: number
  getAccount: () => string
}

/**
 * 已建会话的「重挂回调」动作。改完后端地址 / 令牌后要换后端实例，
 * 换完每个会话都得把回调挂到新实例上、把后端的槽位重新建起来。
 */
const allSession = new Set<() => void>()

export function reconnectAllBackends(): void {
  resetBackend()
  for (const reattach of [...allSession]) reattach()
}

export function createSession(origin: AccountSource) {
  const slot = origin.slot
  const account = computed(() => origin.getAccount().trim())

  const room = createRoomState()
  const match = createMatchState(room)
  const autoMove = createAutoMove({
    match,
    room,
    executeMatchAction: (action, field) => executeMatchAction(action, field),
    writeLog: (text) => pushLog(text),
  })

  const passportCredential = ref<PassportCredential | null>(null)
  const passportStatus = ref('')
  const passportBusy = ref(false)
  const passportDeviceId = ref('')

  // 下面这一整片都是「槽位状态」的影子（后端推什么这里就显示什么）。
  const linkState = ref<LinkState>('idle')
  const linkMessage = ref('')
  const loginState = ref<LoginState>('idle')
  const sessionId = ref(0n)
  const loginInfo = ref<LoginInfo | null>(null)
  const queueTime = ref(0)
  const banTime = ref(0n)
  const serverNowTime = ref(0n)

  const heartbeat = ref({
    /** 本地开关：门控前端↔后端这条 WS 的保活（游戏侧心跳后端无条件发） */
    enabled: true,
    intervalMs: backendHeartbeatMs,
    sent: 0,
    recv: 0,
    lastSentAt: 0,
    lastRecvAt: 0,
  })

  const pendingCalls = ref(0)
  const pulling = ref(false)

  // 脚本引擎的运行态由**后端**说了算（脚本跑在后端进程里，关掉页面照旧跑），
  // 这里只是把它显示出来，不做任何本地推断。
  const scriptRunStateValue = ref<ScriptRunState>('未载入')
  const scriptDetail = ref('还没写过脚本')

  // 后端槽位号：后端可能给出与本地不同的号（比如本地号已被别的租户占了），所以分开记。
  let backendSlot: number | null = null
  let deregisterCallback: (() => void) | null = null
  let attachedBackend: BackendApi | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  function pushLog(text: string, level: LogLevel = 'info'): void {
    runLogs.value.unshift({
      id: nextLogId++,
      time: Date.now(),
      level,
      slot,
      account: account.value,
      text,
    })
    if (runLogs.value.length > MAX_LOG_ITEMS) runLogs.value.length = MAX_LOG_ITEMS
  }

  function clearLogs(): void {
    runLogs.value = runLogs.value.filter((item) => item.slot !== slot)
    if (backendSlot !== null) getBackend().clearLogs(backendSlot)
  }

  const myLogs = computed(() => runLogs.value.filter((item) => item.slot === slot))

  // ---------------------------------------------------------------- 后端回调

  function handleConnectionState(state: FrontLinkState, message: string): void {
    if (state === '已断开' || state === '未连接') {
      clearSlotCache()
      pushLog(`后端链路: ${state}${message ? `（${message}）` : ''}`, 'warn')
      return
    }
    // 重连回来：重新对号 + 重订事件（都幂等）。本地的房间 / 对局状态先留着，
    // 等后端回放的全量帧覆盖；若后端说这个槽位没登录，`收到槽位状态` 会把它们清掉。
    if (state === '已连接') attachBackend()
    pushLog(`后端链路: ${state}${message ? `（${message}）` : ''}`, 'info')
  }

  /**
   * 每个槽位「已见过的最大后端日志 id」。后端订阅「日志」时会补发最近 300 条，
   * 刷新后本地日志是空的（正好拿回历史），而掉线重连时本地还在（不该又 unshift 一遍）。
   */
  const seenLogIds = new Map<number, number>()

  function handleLogs(entries: LogEntry[]): void {
    const slotId = entries[0]?.slot ?? -1
    let maxLogId = seenLogIds.get(slotId) ?? 0
    for (const entry of entries) {
      if (entry.id <= maxLogId) continue
      maxLogId = entry.id
      runLogs.value.unshift({ ...entry, id: nextLogId++ })
    }
    seenLogIds.set(slotId, maxLogId)
    if (runLogs.value.length > MAX_LOG_ITEMS) runLogs.value.length = MAX_LOG_ITEMS
  }

  function handleFrames(entries: FrameRecord[]): void {
    usePacketLogStore().recordBatch(account.value, entries)
  }

  /** 后端脚本引擎的运行态推送（跑 / 停 / 出错自动停用都走这里） */
  function handleScriptState(_slot: number, runState: ScriptRunState, detail: string): void {
    scriptRunStateValue.value = runState
    scriptDetail.value = detail
  }

  function handleSlotState(state: SlotState): void {
    linkState.value = state.gameLink
    linkMessage.value = state.linkMessage
    loginState.value = state.LoginState
    sessionId.value = toBigint(state.sessionNo)
    loginInfo.value = state.LoginInfo
    queueTime.value = state.queueTime
    banTime.value = toBigint(state.banTime)
    serverNowTime.value = toBigint(state.serverTime)
    pendingCalls.value = state.pendingAcks
    heartbeat.value.sent = state.heartbeat.sent
    heartbeat.value.recv = state.heartbeat.received
    heartbeat.value.lastSentAt = state.heartbeat.lastSent
    heartbeat.value.lastRecvAt = state.heartbeat.lastReceived
    if (state.heartbeat.intervalMs > 0) heartbeat.value.intervalMs = state.heartbeat.intervalMs
    passportCredential.value = state.passport.credential
    passportDeviceId.value = state.passport.deviceId || passportDeviceId.value
    if (state.passport.state.length > 0) passportStatus.value = state.passport.state
    passportBusy.value = state.passport.busy
    // 「我的Id」得在房间/对局推送之前就位 —— 后端是先推状态再放行后续帧的
    const my = state.LoginInfo?.playerId ?? ''
    if (my.length > 0) room.myId = my

    // 后端说这个槽位没登录（游戏服断了 / 重登过），本地就别再挂着房间与对局了 ——
    // 否则掉线重连后会留一个没有后端状态支撑的幽灵房间
    if (state.LoginState !== 'logined' && room.inRoom) {
      room.clearRoom()
      match.clear()
    }
  }

  function handleDegrade(unsubscribe: EventName[], message: string): void {
    pushLog(`后端降级：${message}（已停 ${unsubscribe.join('、')}）`, 'warn')
  }

  /** 后端把「推送」还原成一个命令名 + 已解码（JSON 化）的包体，这里按名字路由 */
  function onPush(name: string, _cmdId: number, data: DecodedMessage): void {
    switch (name) {
      // ------------------------------------------------------------ 房间
      case 'RoomNotifyS2C':
      case 'CreateRoomS2C':
      case 'JoinRoomS2C':
      case 'QuickJoinRoomS2C':
      case 'SyncRoomS2C':
        room.onRoom(data)
        return

      case 'OnlineSyncRoomIdS2C': {
        const roomId = toStr(data.RoomId)
        if (roomId === '' || roomId === '0') {
          room.clearRoom()
          return
        }
        pushLog(`服务端说你在房间 ${roomId}，自动同步房间状态…`)
        void syncRoom(roomId)
        return
      }

      case 'RoomReadyS2C':
        room.updatePlayerReady(toId(data.PlayerId), data.IsReady === true)
        return

      case 'RoomKickPlayerS2C': {
        const kicked = toId(data.PlayerId)
        const my = room.myId
        pushLog(kicked === my ? `你被踢出房间 ${room.roomId}` : `玩家 ${kicked} 被踢出房间`, 'warn')
        if (kicked === my) room.onKickedFromRoom()
        else room.removePlayer(kicked)
        return
      }

      case 'HeroBarBoxChangeS2C':
        room.onHeroBar(data)
        return

      case 'ChooseSkinS2C':
        room.onSkin(data)
        return

      case 'RefreshRoomStateS2C':
        room.updateLoadProgress(toId(data.PlayerId), toNumber(data.Progress))
        return

      case 'ExitRoomS2C': {
        if (data.Dissolve === true) {
          pushLog('房间已解散', 'warn')
          room.clearRoom()
          return
        }
        const leaver = toId(data.PlayerId)
        const my = room.myId
        if (leaver === my) {
          pushLog('你已离开房间', 'info')
          room.clearRoom()
          return
        }
        pushLog(`玩家 ${leaver} 离开了房间`, 'info')
        room.removePlayer(leaver)
        return
      }

      // ------------------------------------------------------------ 对局
      case 'RunningGameS2C':
        match.onRunFrame(data)
        return

      case 'PredictActionS2C':
        match.onPrediction(data)
        return

      case 'ReplaySnapshotS2C':
        match.onSnapshot(data)
        return

      case 'ActionStartNotifyS2C':
        match.onActionStart(data)
        return

      case 'RoundStartS2C':
        match.onTurnStart(data)
        return

      case 'LandBuffsS2C':
        match.onNodeBar(data)
        return

      case 'UpdateHeroAttrS2C': {
        match.onAttrChange(data)
        if (toId(data.PlayerId) !== room.myId) return
        const entry = (Array.isArray(data.EffectDatas) ? (data.EffectDatas as DecodedMessage[]) : [])
          .flatMap((item) =>
            Object.entries(item)
              .filter(
                ([name, packet]) =>
                  name !== 'PlayerId' &&
                  packet !== null &&
                  typeof packet === 'object' &&
                  Object.values(packet as Record<string, unknown>).some((v) => v !== undefined),
              )
              .map(([name, packet]) => `${name}=${JSON.stringify(packet)}`),
          )
        if (entry.length > 0) pushLog(`属性变化: ${entry.join('  ')}`)
        return
      }

      case 'MoveS2C':
        match.onMove(data)
        return

      // 追击（5034）/ 怪物突击（5214）：发起者会瞬移到目标那一格。
      // 这一跳不走 MoveS2C，是英雄落位的唯一来源，不认它就会从错的位置算方向。
      case 'PursuitS2C':
      case 'MonsterPursuitS2C': {
        match.onPursue(data)
        const prev = Array.isArray(data.FrontIds) ? (data.FrontIds as unknown[]) : []
        if (prev.length === 0) return
        const who = toId(data.PlayerId)
        pushLog(
          `${name === 'MonsterPursuitS2C' ? '怪物突击' : '追击'}: `
            + `${who === room.myId ? '我' : who} 落到地块 ${toNumber(data.NodeId)}`,
        )
        return
      }

      case 'ThrowDiceS2C': {
        if (toId(data.PlayerId) !== room.myId) return
        autoMove.reset()
        match.onDiceRoll(data)
        const diceValues = Array.isArray(data.Vals) ? (data.Vals as unknown[]).map(toNumber) : []
        pushLog(`投骰: ${diceValues.join('+') || '—'} 共 ${toNumber(data.MovePoint)} 步`)
        return
      }

      case 'MoveAgainS2C': {
        if (toId(data.PlayerId) !== room.myId) return
        match.onMoveAgain(data)
        const steps = toNumber(data.MovePoint)
        if (steps > 0) pushLog(`额外移动: +${steps} 步`)
        return
      }

      case 'GameProgressChangeS2C': {
        room.onProgressChange(data)
        const limit = room.progressLimit
        pushLog(`跑圈进度: ${toNumber(data.Progress)}${limit > 0 ? `/${limit}` : ''}`)
        return
      }

      case 'GameRoundChangeS2C': {
        room.onRoundChange(data)
        const round = toNumber(data.Round)
        if (round > 0) pushLog(`轮次: 第 ${round} 轮`)
        return
      }

      case 'BattleS2C':
        match.onBattle(data)
        return

      case 'MonsterRefreshS2C': {
        room.onMonster(data)
        const monster = data.Monster as DecodedMessage | undefined
        const hero = monster?.Hero as DecodedMessage | undefined
        if (monster) {
          const monsterId = toNumber(hero?.HeroId)
          pushLog(
            `怪物刷新: ${(monsterName[monsterId] ?? toStr(monster.Nick)) || `怪物 ${toStr(monster.Id)}`}`
              + `（id=${toStr(monster.Id)} 怪id=${monsterId} 位置=${toNumber(hero?.NodeId)}`
              + ` HP=${toNumber(hero?.Hp)}/${toNumber(hero?.MaxHp)}）`,
          )
        }
        return
      }

      case 'RoomHeroCardChangeS2C': {
        room.onHandCards(data)
        const who = toId(data.PlayerId)
        if (who === room.myId) {
          const card = Array.isArray(data.Cards) ? (data.Cards as DecodedMessage[]) : []
          pushLog(`手牌刷新: ${card.length} 张 [${card.map((c) => toStr(c.CardId)).join(', ')}]`)
        }
        return
      }

      default:
        return
    }
  }

  // ---------------------------------------------------------------- 心跳

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (!heartbeat.value.enabled) return
      void sendHeartbeat()
    }, backendHeartbeatMs)
  }

  async function sendHeartbeat(): Promise<void> {
    if (loginState.value !== 'logined') return
    try {
      const reply = await getBackend().heartbeat(backendSlot ?? slot)
      serverNowTime.value = toBigint(reply.serverTime)
      pendingCalls.value = reply.pendingAcks
    } catch (error) {
      pushLog(`心跳失败: ${String(error)}`, 'warn')
    }
  }

  let reportedLoading = false
  watch(
    () => room.roomState,
    (state) => {
      if (state !== 20) {
        reportedLoading = false
        return
      }
      if (reportedLoading) return
      reportedLoading = true
      void reportLoadingProgress(100)
    },
  )

  // 服务端预填就自动代答（对齐客户端 ActionLogic 的行为）
  function shouldAutoAnswer(action: CandidateAction): Record<string, unknown> | null {
    switch (action.commandName) {
      case 'BattleThrowDiceC2S':
      case 'MoveAgainC2S':
        return {}
      case 'ThrowDiceC2S':
        return action.data.IsNoOper === true || action.data.IsMoveNow === true ? {} : null
      case 'UseEffectCardC2S': {
        const card = toNumber(action.data.CardId)
        if (card <= 0) return null
        return { CardId: card, UseSelectCardIndex: 0, DevPoint: 0 }
      }
      default:
        return null
    }
  }

  const pendingAutoReplyCommands = ['BattleThrowDiceC2S', 'MoveAgainC2S', 'ThrowDiceC2S', 'UseEffectCardC2S']
  const autoAnswered = new Set<string>()

  watch(
    () =>
      pendingAutoReplyCommands
        .map((name) => {
          const action = match.getTodo(name)
          return action ? `${name}:${action.Sn}` : ''
        })
        .join('|'),
    () => {
      for (const name of pendingAutoReplyCommands) {
        const action = match.getTodo(name)
        if (!action) continue
        const key = `${name}:${action.Sn}`
        if (autoAnswered.has(key)) continue
        const field = shouldAutoAnswer(action)
        if (!field) continue
        autoAnswered.add(key)
        void executeMatchAction(action, field)
      }
    },
    { immediate: true },
  )

  // ---------------------------------------------------------------- 接后端

  /**
   * 把这条会话挂到后端上：需要时注册回调，然后**连 + 对号 + 订事件**。
   *
   * 幂等，可以反复调：`注册槽位`、`连`、`订阅` 都自带去重。三处会用到它 ——
   * 创建会话（刷新后一建出槽位就自动挂回去）、用户点登录、以及后端重连回来。
   *
   * 槽位会话由**服务端**按持久化记录建（槽位号就是那条记录的 id），前端不申请槽位，
   * 只是把号对上。掉线后 `后端客户端` 会清掉本地订阅记录，所以重连时得再订一次。
   */
  function attachBackend(): void {
    const backend = getBackend()
    if (attachedBackend !== backend) {
      // 换了实例（改地址 / 点了重连）：旧回调作废，后端那边的槽位号也得重新拿
      deregisterCallback?.()
      const callback: BackendCallback = {
        onConnState: (state, message) => handleConnectionState(state, message),
        onAuth: (result) => {
          // 认证是连接级的，每个槽位都会被通知一次；成功的走「已连接」那条日志，这里只说失败
          if (!result.ok) pushLog(`后端认证被拒：${result.message ?? '令牌不对'}`, 'error')
        },
        onSlotState: handleSlotState,
        onLogs: handleLogs,
        onFrames: handleFrames,
        onPushEvent: onPush,
        onScriptState: handleScriptState,
        degraded: handleDegrade,
      }
      // **先认下这个实例，再注册**：`注册槽位` 会同步回调一次当前链路状态，
      // 那时若正连着，`收到连接状态` 会回头再调一次 `接后端` —— 判据必须已经是新实例，
      // 否则「注册 → 回调 → 接后端 → 注册」会无限递归，直接栈溢出。
      attachedBackend = backend
      deregisterCallback = backend.registerSlot(slot, callback)
      clearSlotCache()
    }
    backend.connect()
    backendSlot = slot
    backend.subscribe(slot, allEvents)
  }

  /** 后端重启 / WS 掉线后，下标要重新对一次 */
  function clearSlotCache(): void {
    backendSlot = null
    stopHeartbeat()
  }

  function clearLocalState(): void {
    linkState.value = 'idle'
    linkMessage.value = ''
    loginState.value = 'idle'
    sessionId.value = 0n
    loginInfo.value = null
    queueTime.value = 0
    banTime.value = 0n
    pendingCalls.value = 0
    passportCredential.value = null
    passportStatus.value = ''
    passportBusy.value = false
    room.clearRoom()
    room.setHint('')
    match.clear()
  }

  /**
   * 断开这个槽位在**前端**的登录态（服务端的槽位照旧跑，这是「关掉浏览器也照常跑」的前提）。
   * 真正的下线手段是「移除账号」——服务端删记录并销毁槽位。
   */
  function disconnect(): void {
    stopHeartbeat()
    clearLocalState()
  }

  /** 移除账号用：这个槽位已经不存在了（服务端删游戏账号时一并销毁），本地只摘回调 */
  function destroy(): void {
    stopHeartbeat()
    allSession.delete(attachBackend)
    deregisterCallback?.()
    deregisterCallback = null
    attachedBackend = null
    backendSlot = null
    clearLocalState()
  }

  // 登录态一变就起停保活（两种后端实现都一样，不用各自去管定时器）
  watch(
    loginState,
    (state) => {
      if (state === 'logined') startHeartbeat()
      else stopHeartbeat()
    },
    { immediate: true },
  )

  watch(
    () => room.inRoom,
    (inRoom) => {
      if (!inRoom) match.clear()
    },
  )

  // ---------------------------------------------------------------- 业务

  async function sendCommand(
    commandName: string,
    params: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; error?: string; respName?: string; value?: DecodedMessage }> {
    if (loginState.value !== 'logined') return { ok: false, error: '还没登录，服务端不会受理业务请求' }
    try {
      return await getBackend().sendCommand(slot, commandName.trim(), params as DecodedMessage)
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  }

  async function sendDebugCommand(
    commandName: string,
    paramsJson: string,
  ): Promise<{ ok: boolean; error?: string; result?: DebugSendResult }> {
    if (paramsJson.trim().length > 0) {
      try {
        JSON.parse(paramsJson)
      } catch (error) {
        return { ok: false, error: `参数不是合法 JSON：${String(error)}` }
      }
    }
    try {
      return await getBackend().debugSend(slot, commandName.trim(), paramsJson)
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  }

  /**
   * 脚本四条。执意不做本地乐观更新：运行态一律以后端回执 / 推送为准，
   * 因为脚本跑在后端进程里，页面这端没有任何「权威」可言。
   */
  function onScriptReceipt(
    result: { ok: boolean; runState: ScriptRunState; detail: string; error?: string },
  ): void {
    scriptRunStateValue.value = result.runState
    scriptDetail.value = result.detail
  }

  async function readScript(): Promise<{ ok: boolean; source: string; error?: string }> {
    try {
      const result = await getBackend().readScript(slot)
      onScriptReceipt(result)
      return { ok: result.ok, source: result.source ?? '', error: result.error }
    } catch (error) {
      return { ok: false, source: '', error: toErrorMessage(error) }
    }
  }

  async function saveScript(source: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await getBackend().saveScript(slot, source)
      onScriptReceipt(result)
      // 语法错也让用户看见，所以照旧回 ok:false
      return { ok: result.ok, error: result.error }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  }

  async function runScript(): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await getBackend().runScript(slot)
      onScriptReceipt(result)
      return { ok: result.ok, error: result.error }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  }

  async function stopScript(): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await getBackend().stopScript(slot)
      onScriptReceipt(result)
      return { ok: result.ok, error: result.error }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  }

  async function queryRoomList(): Promise<void> {
    room.listLoading = true
    room.setHint('')
    const result = await sendCommand('QueryRoomC2S', { MapMod: room.mapMod })
    room.listLoading = false
    if (!result.ok) {
      room.setHint(result.error ?? '查询失败')
      pushLog(`查询房间列表失败: ${result.error}`, 'error')
      return
    }
    const entries = Array.isArray(result.value?.Items) ? (result.value.Items as DecodedMessage[]) : []
    room.setList(entries)
    pushLog(`房间列表: ${entries.length} 个（模式 ${room.mapMod}）`, 'success')
  }

  async function quickJoinRoom(): Promise<void> {
    room.setHint('')
    const result = await sendCommand('QuickJoinRoomC2S', { MapMod: room.mapMod })
    if (!result.ok) {
      room.setHint(result.error ?? '快速加入失败')
      pushLog(`快速加入失败: ${result.error}`, 'error')
      return
    }
    room.onRoom(result.value)
    pushLog(`快速加入成功，房间 ${room.roomId || '?'}`, 'success')
  }

  async function searchRoom(roomId: string): Promise<DecodedMessage | null> {
    const result = await sendCommand('SearchRoomC2S', { RoomId: roomId })
    if (!result.ok) {
      pushLog(`查房间失败: ${result.error}`, 'error')
      return null
    }
    return result.value ?? null
  }

  async function joinRoom(roomId: string, password: string, roomServerId: number): Promise<boolean> {
    const result = await sendCommand('JoinRoomC2S', {
      RoomId: roomId,
      Slot: 0,
      Pwd: password,
      RoomServerId: roomServerId,
    })
    if (!result.ok) {
      room.setHint(result.error ?? '进房失败')
      pushLog(`进房失败: ${result.error}`, 'error')
      return false
    }
    room.onRoom(result.value)
    pushLog(`已进入房间 ${room.roomId || roomId}`, 'success')
    return true
  }

  async function createRoom(params: {
    roomName: string
    password: string
    mode: number
    mapId: number
    condition: number
    thinkTime: number
    speed: number
    difficulty: number
    label: number
    skipStory: boolean
  }): Promise<boolean> {
    const result = await sendCommand('CreateRoomC2S', {
      Id: '0',
      Name: params.roomName,
      Pwd: params.password,
      MapId: params.mapId,
      MaxTime: 0,
      UpgradePlan: params.condition,
      TimePlan: params.thinkTime,
      LobbyId: '0',
      SpeedType: params.speed,
      Mode: params.mode,
      Difficulty: params.difficulty,
      SkipStory: params.skipStory,
      RoomLabel: params.label,
    })
    if (!result.ok) {
      room.setHint(result.error ?? '建房失败')
      pushLog(`建房失败: ${result.error}`, 'error')
      return false
    }
    room.onRoom(result.value)
    pushLog(`建房成功，房间 ${room.roomId || '?'}`, 'success')
    return true
  }

  async function updateRoom(params: {
    password: string
    mapId: number
    condition: number
    thinkTime: number
    speed: number
    difficulty: number
    label: number
    skipStory: boolean
  }): Promise<boolean> {
    const result = await sendCommand('ChangeRoomC2S', {
      Pwd: params.password,
      MapId: params.mapId,
      MaxTime: 0,
      UpgradePlan: params.condition,
      TimePlan: params.thinkTime,
      SpeedType: params.speed,
      Difficulty: params.difficulty,
      SkipStory: params.skipStory,
      RoomLabel: params.label,
    })
    if (!result.ok) {
      room.setHint(result.error ?? '改房间失败')
      pushLog(`改房间失败: ${result.error}`, 'error')
      return false
    }
    room.onRoom(result.value)
    pushLog(`房间设置已更新（MapId=${params.mapId}）`, 'success')
    return true
  }

  async function setReady(ready: boolean): Promise<void> {
    const result = await sendCommand('RoomReadyC2S', { IsReady: ready })
    if (!result.ok) {
      room.setHint(result.error ?? '准备失败')
      pushLog(`准备失败: ${result.error}`, 'error')
      return
    }
    pushLog(ready ? '已准备' : '已取消准备', 'success')
  }

  async function exitRoom(): Promise<void> {
    const result = await sendCommand('ExitRoomC2S')
    if (!result.ok) {
      room.setHint(result.error ?? '退出失败')
      pushLog(`退出房间失败: ${result.error}`, 'error')
      return
    }
    room.clearRoom()
    pushLog('已退出房间', 'success')
  }

  async function syncRoom(roomId: string): Promise<void> {
    const result = await sendCommand('SyncRoomC2S', { RoomId: roomId })
    if (!result.ok) {
      room.setHint(result.error ?? '同步失败')
      pushLog(`同步房间失败: ${result.error}`, 'error')
      return
    }
    room.onRoom(result.value)
  }

  async function startGame(addBot: boolean): Promise<void> {
    const result = await sendCommand('StartGameC2S', { IsAddBot: addBot })
    if (!result.ok) {
      room.setHint(result.error ?? '开始游戏失败')
      pushLog(`开始游戏失败: ${result.error}`, 'error')
      return
    }
    room.onRoom(result.value)
    pushLog('开始游戏请求已发出', 'success')
  }

  async function chooseHero(heroId: number): Promise<boolean> {
    const result = await sendCommand('ChoiceHeroC2S2', { HeroId: heroId })
    if (!result.ok) {
      room.setHint(result.error ?? '选英雄失败')
      pushLog(`选英雄失败: ${result.error}`, 'error')
      return false
    }
    pushLog(`已选英雄 ${heroId}（还没确认）`, 'success')
    return true
  }

  async function selectAndConfirmHero(heroId: number): Promise<void> {
    if (!(await chooseHero(heroId))) return
    await confirmHero()
  }

  async function confirmHero(): Promise<boolean> {
    const result = await sendCommand('AffirmHeroC2S', { Auto: false })
    if (!result.ok) {
      room.setHint(result.error ?? '确认英雄失败')
      pushLog(`确认英雄失败: ${result.error}`, 'error')
      return false
    }
    if (result.value?.HasChoice === true) {
      room.setHint(`英雄 ${result.value?.HeroId ?? ''} 被别人先确认了，换一个再来`)
      pushLog(`英雄 ${result.value?.HeroId ?? ''} 已被占用，需要重选`, 'warn')
      return false
    }
    pushLog(`已确认英雄 ${result.value?.HeroId ?? ''}，接着选皮肤`, 'success')
    return true
  }

  async function autoChooseHero(): Promise<void> {
    const result = await sendCommand('AffirmHeroC2S', { Auto: true })
    if (!result.ok) {
      room.setHint(result.error ?? '选英雄失败')
      pushLog(`自动选英雄失败: ${result.error}`, 'error')
      return
    }
    pushLog(`自动选英雄成功: HeroId=${result.value?.HeroId ?? '?'}`, 'success')
  }

  async function chooseSkin(adornId: number): Promise<boolean> {
    const heroId = room.myHeroId
    if (heroId <= 0) {
      room.setHint('还没选英雄，先把英雄确认了')
      return false
    }
    const result = await sendCommand('ChooseSkinC2S', {
      HeroId: heroId,
      UseAdorn: adornId,
      Affirmed: false,
    })
    if (!result.ok) {
      room.setHint(result.error ?? '选皮肤失败')
      pushLog(`选皮肤失败: ${result.error}`, 'error')
      return false
    }
    pushLog(`已选装饰 ${adornId}（还没确认）`, 'success')
    return true
  }

  async function confirmSkin(): Promise<void> {
    const heroId = room.myHeroId
    if (heroId <= 0) {
      room.setHint('还没选英雄，先把英雄确认了')
      return
    }
    const result = await sendCommand('ChooseSkinC2S', { HeroId: heroId, UseAdorn: 0, Affirmed: true })
    if (!result.ok) {
      room.setHint(result.error ?? '确认皮肤失败')
      pushLog(`确认皮肤失败: ${result.error}`, 'error')
      return
    }
    pushLog(`已确认皮肤（装饰 ${result.value?.UseAdorn ?? ''}）`, 'success')
  }

  async function selectAndConfirmSkin(adornId: number): Promise<void> {
    if (!(await chooseSkin(adornId))) return
    await confirmSkin()
  }

  async function reportLoadingProgress(progress: number): Promise<void> {
    const value = Math.max(0, Math.min(100, Math.round(progress)))
    const result = await sendCommand('RefreshRoomStateC2S', { Progress: value })
    if (!result.ok) {
      room.setHint(result.error ?? '上报加载进度失败')
      pushLog(`上报加载进度失败: ${result.error}`, 'error')
      return
    }
    pushLog(`已上报加载进度 ${value}%`, 'success')
  }

  async function executeMatchAction(
    action: CandidateAction,
    fieldsToSend: Record<string, unknown> = {},
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      ...fieldsToSend,
      Info: { Sn: action.Sn, UseTime: 0 },
    }
    const result = await sendCommand(action.commandName, body)
    if (!result.ok) {
      // 服务端拒包只说原因（如 11036 星币不足），得带上「在干什么」才知道是哪一步失败
      const actionName = getActionSpec(action.commandName)?.name ?? action.commandName
      room.setHint(`${actionName}失败：${result.error ?? '服务端没受理'}`)
      pushLog(`动作 ${action.commandName} 失败: ${result.error}`, 'error')
      return false
    }
    pushLog(`已发动作 ${action.commandName}（Sn=${action.Sn}）`, 'success')

    if (action.commandName === 'UseEffectCardC2S') match.onSkillCooldown(result.value)
    return true
  }

  async function saveCaptureToFile(text: string): Promise<void> {
    try {
      const result = await getBackend().saveCapture(text)
      if (!result.ok) {
        pushLog(`保存抓包失败: ${result.error ?? '未知错误'}`, 'error')
        return
      }
      pushLog(`抓包已保存: ${result.path}`, 'success')
    } catch (error) {
      pushLog(`保存抓包异常: ${String(error)}`, 'error')
    }
  }

  async function pullServerConfig(): Promise<void> {
    pulling.value = true
    try {
      const result = await getBackend().fetchRemoteConfig(configApiRoute, configApiVersion)
      if (!result.ok) {
        pushLog(
          `拉取失败: ${result.message ?? '未知错误'}${result.text ? ` / ${result.text}` : ''}`,
          'error',
        )
        return
      }
      pushLog(`远端配置: ${result.text}`)
      const serverUrl = String(result.data?.serverUrl ?? '')
      const parse = parseServerUrl(serverUrl)
      if (parse === null) {
        pushLog(`返回里没有可用的 serverUrl（原值: ${serverUrl || '空'}）`, 'warn')
        return
      }
      pushLog(
        `服务器地址：${parse.host}:${parse.port > 0 ? parse.port : serverPort}`
          + `（当前 config.ts 用的是 ${serverHost}:${serverPort}，不一致就改源码）`,
        'success',
      )
    } catch (error) {
      pushLog(`拉取异常: ${String(error)}`, 'error')
    } finally {
      pulling.value = false
    }
  }

  /**
   * 登录 = 后端拿持久化记录里的账号/密码去登通行证 + 连游戏服 + 发 ConnectC2S.
   * 这些以前都在这一端做，现在整体交给后端（凭据只留在后端内存里），
   * 前端连密码都没有 —— 它就是服务端那条记录。
   */
  async function login(): Promise<boolean> {
    if (account.value.length === 0) {
      pushLog('这个账号槽还没填账号', 'error')
      return false
    }

    // 服务端若已经登录着（刷新过、或后端一直在跑），`槽位会话.登录()` 会直接确认，不会重连
    attachBackend()

    loginState.value = 'pending'
    let result: { ok: boolean; error?: string }
    try {
      result = await getBackend().login(slot)
    } catch (error) {
      result = { ok: false, error: toErrorMessage(error) }
    }
    if (!result.ok) {
      loginState.value = 'failed'
      pushLog(`登录失败: ${result.error ?? '未知原因'}`, 'error')
      return false
    }
    return true
  }

  const displayName = computed(
    () => loginInfo.value?.playerNick || loginInfo.value?.accountNick || account.value || `账号 ${slot}`,
  )

  const isLogined = computed(() => loginState.value === 'logined')
  const linkLabel = computed(() => LINK_STATE_LABEL[linkState.value])
  const loginLabel = computed(() => LOGIN_STATE_LABEL[loginState.value])

  const gameName = computed(() => loginInfo.value?.playerNick || loginInfo.value?.accountNick || '')

  const phase = computed<string>(() => {
    if (loginState.value === 'pending') return '登录中…'
    if (loginState.value === 'failed') return '登录失败'
    if (!isLogined.value) return linkState.value === 'connecting' ? '连接中…' : '未登录'
    if (!room.inRoom) return '大厅'

    const state = room.roomState
    if (state === 10) return '选英雄'
    if (state === 15) return '选皮肤'
    if (state === 20) return '加载中'
    if (state === 30) return '对局结束'
    if (state !== 25) {
      if (state === 0 || state === 1) return room.my?.ready ? '已备战' : '备战中'
      return roomStateNameTable[state] ?? '房间中'
    }

    const todo = match.myActions.map((item) => item.commandName)
    const has = (...names: string[]): boolean => names.some((name) => todo.includes(name))

    if (autoMove.sending) return '移动中（自动）'
    if (has('BattleChoiceC2S', 'BattleUseCardC2S', 'BattleThrowDiceC2S')) {
      const identity = match.myBattleSide
      return identity.length > 0 ? `战斗中·${identity}` : '战斗中'
    }
    if (has('AbandonCardC2S')) return '弃牌'
    if (has('VoteC2S', 'VoteSelectC2S')) return '投票'
    if (has('SelectRelicC2S')) return '选筹码'
    if (has('PVEShopBuyC2S', 'ShopBuyC2S', 'BuyRelicC2S', 'VendorBuyCardC2S')) return '商店'
    if (has('MoveC2S', 'ChoiceDirectionC2S')) return autoMove.needDirection ? '选方向' : '移动中'
    if (has('ThrowDiceResultC2S')) return '选骰点'
    if (has('ThrowDiceC2S', 'MoveAgainC2S')) return '投骰'
    if (has('MonsterPursuitC2S', 'PursuitC2S')) return '怪物突击'
    if (
      has(
        'TriggerEventC2S',
        'SelectEventC2S',
        'TriggerHospitalC2S',
        'TriggerDestinyC2S',
        'TriggerDivinationC2S',
        'LotteryChoiceC2S',
        'LandChoiceTargetC2S',
        'SelectRewardCardC2S',
        'RollGoldC2S',
        'EventThrowDiceC2S',
        'BombThrowDiceC2S',
        'StartGambleC2S',
        'GambleThrowDicC2S',
        'SelectMechanismC2S',
        'NotifyStoryC2S',
        'AskReviveTeammateC2S',
      )
    )
      return '地块事件'
    if (has('UseEffectCardC2S')) return '出牌中'
    if (has('UseQuickCardC2S')) return '速用卡'
    if (has('StopOrContinueC2S')) return '保障点'
    if (todo.length > 0) return `待操作（${todo.length}）`
    return match.myTurn ? '等我操作' : `等 ${match.actorNickname}`
  })

  // 会话一建出来就把回调挂上、把 WS 连上：后端常驻，账号放着不动也一直在线
  allSession.add(attachBackend)
  attachBackend()

  return reactive({
    slot,
    account,
    gameName,
    phase,
    displayName,
    room: markRaw(room),
    match: markRaw(match),
    autoMove: markRaw(autoMove),
    passportCredential,
    passportStatus,
    passportBusy,
    passportDeviceId,
    linkState,
    linkMessage,
    linkLabel,
    pulling,
    loginState,
    loginLabel,
    isLogined,
    sessionId,
    loginInfo,
    queueTime,
    banTime,
    serverNowTime,
    heartbeat,
    pendingCalls,
    myLogs,
    pushLog,
    clearLogs,
    ScriptRunState: scriptRunStateValue,
    scriptDetail,
    readScript,
    saveScript,
    runScript,
    stopScript,
    disconnect,
    destroy,
    login,
    sendHeartbeat,
    pullServerConfig,
    sendDebugCommand,
    queryRoomList,
    quickJoinRoom,
    searchRoom,
    joinRoom,
    createRoom,
    updateRoom,
    setReady,
    startGame,
    chooseHero,
    selectAndConfirmHero,
    confirmHero,
    autoChooseHero,
    chooseSkin,
    confirmSkin,
    selectAndConfirmSkin,
    reportLoadingProgress,
    executeMatchAction,
    exitRoom,
    syncRoom,
    saveCaptureToFile,
  })
}

export type session = ReturnType<typeof createSession>