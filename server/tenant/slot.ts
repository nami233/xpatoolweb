/**
 * 单个槽位：一条到游戏服端的 TCP + `RpcClient` + 登录 + 游戏心跳 + 通行证凭据。
 *
 * 槽位是**服务端单例**，和 WS 连接的生命周期无关：浏览器关掉照旧跑（这是「可远程」的前提），
 * 多条 WS 连接可以订阅同一个槽位。
 *
 * 推送解码走 `onAnyPush` 一条通用通路（`cmdId → 命令名 → getSchema → decode → JSON化`），
 * 不再逐命令注册；只有 5002(`ConnectS2C`)/5004(`HeartbeatS2C`) 内部拦截、不发推送。
 */
import crypto from 'node:crypto'
import net from 'node:net'
import { RpcClient } from '../net/rpc.ts'
import { CMD } from '../net/cmds.ts'
import { CMD_NAMES, CMD_OF } from '../net/proto/generated/cmds.gen.ts'
import { getSchema } from '../net/proto/generated/schemas.gen.ts'
import { decode, encode } from '../net/proto/wire.ts'
import { fromJson, findUnknownFields } from '../net/proto/json.ts'
import {
  decodeConnectS2C,
  decodeHeartbeatS2C,
  encodeConnectC2SChina,
  encodeHeartbeatC2S,
} from '../net/proto/messages.ts'
import type { Frame } from '../net/frame.ts'
import { toReadableJson } from '../../shared/protocol/readableJson.ts'
import { toJson, bytesToHex } from '../../shared/protocol/jsonSafe.ts'
import type { DecodedMessage } from '../../shared/protocol/jsonSafe.ts'
import type {
  LoginInfo,
  LoginState,
  FrameDirection,
  SlotState,
  PassportCredential,
  DebugSendResult,
  LinkState,
  LogLevel,
} from '../../shared/protocol/states.ts'
import { config, log } from '../config.ts'
import { runPassport, passportDetail } from '../passport.ts'
import type { passportRequest, passportAck } from '../passport.ts'
import { logRing } from '../slot/log.ts'
import { frameRing, makeFrameRecord } from '../slot/capture.ts'
import { Fanout } from '../slot/push.ts'
import { fullFrameCache } from './replay.ts'
import { matchView } from '../game/view.ts'
import { ScriptEngine } from '../script/engine.ts'

/** 游戏心跳间隔 */
const heartbeatIntervalMs = 5000
/** 登录时等 TCP 建连的上限 */
const connectTimeoutMs = 10_000

/** 账号 + 密码的指纹：判「这个号上已有的槽位会话还能不能复用」（改过密码就重建） */
export function getCredentialFingerprint(account: string, password: string): string {
  return crypto.createHash('sha256').update(`${account.trim()}\u0000${password}`, 'utf8').digest('hex')
}

function commandName(Id: number): string {
  return CMD_NAMES[Id] ?? `CMD=${Id}`
}

function pickOptionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value)
}

/**
 * `rpc.ts` 在 `frame.err !== 0` 时抛的是 `错误文案(frame.err)`，形如「星币不足（ERR=11036）」。
 * 错误码就在文案里，反解一次比在 `RpcClient` 上再开个口子改动小。
 */
function errorCodeFromMessage(message: string): number | undefined {
  const found = /ERR=(\d+)/.exec(message)
  return found === null ? undefined : Number(found[1])
}

export interface sendCommandResult {
  ok: boolean
  error?: string
  errorCode?: number
  name?: string
  cmdId?: number
  sendReplyBody?: Uint8Array
  /** 未 JSON 化的解码结果（`Actions[].Data` 这类 bytes 已就地换成对象） */
  rawResponse?: Record<string, unknown>
  respBodyLen: number
}

export class slotSession {
  readonly slot: number
  readonly fanout = new Fanout()
  readonly logRing: logRing
  readonly frameRing: frameRing
  /** 最近的全量帧：前端断线重连回来时回放用（见 `replay.ts`） */
  readonly replay = new fullFrameCache()
  /**
   * 对局现场（脚本引擎读的那份状态）。与前端 `battle.ts` / `room.ts` 是两份实现，
   * 但走位折叠调的是同一份 `shared/game/move.ts`，防漂移约定见 `game/view.ts` 头部注释。
   */
  readonly match = new matchView({ getMyId: () => this.loginInfoValue?.playerId ?? '' })
  /**
   * 用户脚本引擎（一个槽位一个，脚本跑在后端进程里，页面关着照样跑）。
   * 存档在 `user/scriptStore.ts`，这里只管跑 —— 引擎不认识用户名。
   */
  readonly script = new ScriptEngine({
    slotId: () => this.slot,
    account: () => this.accountValue,
    myId: () => this.loginInfoValue?.playerId ?? '',
    getMatchState: () => this.match.getState(),
    getTodo: () => this.match.getMyAction(),
    sendCommand: (name, params) => this.sendCommand(name, params),
    log: (text, level) => this.writeLog(text, level),
    reportState: (runState, detail) => this.fanout.sent({ kind: '脚本', runState, detail }),
  })
  /** 建会话时的账号 + 密码指纹，`确保槽位` 靠它判「能不能复用这个会话」 */
  readonly credentialFingerprint: string
  /** 闲置回收用（`XPA_SLOT_IDLE_MS` 为 0 时不看它） */
  lastActive = Date.now()

  private accountValue: string
  private passwordValue: string
  private tcp: net.Socket | null = null
  private rpc: RpcClient | null = null

  private linkStateValue: LinkState = 'idle'
  private linkMessageStr = ''
  private loginStateValue: LoginState = 'idle'
  private loginInfoValue: LoginInfo | null = null
  private sessionNoValue = 0n
  private queueTimeValue = 0
  private banTimeValue = 0n
  private serverTimeValue = 0n
  private HeartbeatState = { sent: 0, received: 0, intervalMs: heartbeatIntervalMs, lastSent: 0, lastReceived: 0 }
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatInFlight = false
  private credential: PassportCredential | null = null
  private passportStateStr = ''
  private passportBusy = false
  private passportDeviceId = ''
  private destroyed = false

  // 不用构造函数参数属性：Node 的类型剥离是 strip-only，遇到就报错
  constructor(slotId: number, account: string, password: string) {
    this.slot = slotId
    this.accountValue = account.trim()
    this.passwordValue = password
    this.credentialFingerprint = getCredentialFingerprint(account, password)
    this.logRing = new logRing(slotId, config.logRingLimit, () => this.accountValue)
    this.frameRing = new frameRing(config.frameRingLimit)
  }

  get account(): string {
    return this.accountValue
  }

  get pendingAcks(): number {
    return this.rpc?.pendingCount ?? 0
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }

  /**
   * 走 getter 而不是直接比 `this.登录状态值`：状态是 5002 推送回调在「函数边界之外」写成
   * `logined` 的，TS 的流分析看不见，会把类型钉死在 `登录()` 开头赋的 `'pending'` 上而报错。
   */
  get loggedIn(): boolean {
    return this.loginStateValue === 'logined'
  }

  getServerTime(): string {
    return this.serverTimeValue.toString()
  }

  markActive(): void {
    this.lastActive = Date.now()
  }

  writeLog(text: string, level: LogLevel = 'info'): void {
    if (this.destroyed) return
    this.logRing.push(text, level)
    this.fanout.sent({ kind: '日志' })
  }

  getState(): SlotState {
    return {
      slot: this.slot,
      account: this.accountValue,
      gameLink: this.linkStateValue,
      linkMessage: this.linkMessageStr,
      LoginState: this.loginStateValue,
      LoginInfo: this.loginInfoValue,
      sessionNo: this.sessionNoValue.toString(),
      queueTime: this.queueTimeValue,
      banTime: this.banTimeValue.toString(),
      serverTime: this.serverTimeValue.toString(),
      heartbeat: { ...this.HeartbeatState },
      pendingAcks: this.pendingAcks,
      passport: {
        credential: this.credential,
        state: this.passportStateStr,
        busy: this.passportBusy,
        deviceId: this.passportDeviceId,
      },
    }
  }

  // ---------------------------------------------------------------- 登录 / 登出

  async login(): Promise<{ ok: boolean; message?: string }> {
    if (this.destroyed) return { ok: false, message: '槽位已销毁' }
    this.markActive()
    // 已经连着游戏服并登录成功：直接确认，别重走一遍。
    // 重连会把房间 / 对局状态整个丢掉，而「刷新页面 → 前端又点了一次登录」是常规路径。
    if (this.loginStateValue === 'logined' && this.tcp !== null) return { ok: true }
    if (this.accountValue.length === 0) return this.loginFailed('这个槽位还没填账号')

    this.loginStateValue = 'pending'
    // WS 已连、游戏服未连
    this.linkStateValue = 'bridge-open'
    this.linkMessageStr = '客户端已连接，准备连游戏服'
    this.fanout.sent({ kind: '状态' })
    this.writeLog(`开始登录：账号=${this.accountValue}`)

    // 1) 凭据：内存里还有 sid 就直接复用，省一次通行证往返（后端重启后必然要重新登）
    if (this.credential === null || this.credential.sid.length === 0) {
      if (this.passwordValue.length === 0) return this.loginFailed('这个槽位还没填密码（通行证账号密码登录要密码）')
      const result = await this.callPassport('登录', {
        loginType: 1,
        userName: this.accountValue,
        password: this.passwordValue,
      })
      if (!result.ok || result.credential === null || result.credential.sid.length === 0) {
        return this.loginFailed(`通行证登录失败：${passportDetail(result.ret, result.msg, result.message)}`)
      }
    }

    const credential = this.credential
    if (credential === null) return this.loginFailed('内部状态异常：通行证凭据没拿到')

    // 2) 连游戏服
    this.linkStateValue = 'connecting'
    this.linkMessageStr = `${config.gameHost}:${config.gamePort}`
    this.fanout.sent({ kind: '状态' })
    if (!(await this.connectGameServer())) {
      return this.loginFailed(
        `连不上服务端 ${config.gameHost}:${config.gamePort}（${this.linkMessageStr || '超时'}）`,
      )
    }

    // 3) ConnectC2S：回包（5002）由通用推送处理器内部拦截并落地登录信息
    const body = encodeConnectC2SChina({
      gameId: credential.gameId,
      channelId: credential.channelId,
      appId: credential.appId,
      sid: credential.sid,
      extra: credential.extra,
      deviceId: this.passportDeviceId || credential.deviceId,
      clientVer: config.clientVersion,
    })
    this.writeLog(
      `使用通行证凭据登录（gameId=${credential.gameId} channelId=${credential.channelId} appId=${credential.appId} sid 长度=${credential.sid.length}）`,
    )
    const client = this.rpc
    if (client === null) return this.loginFailed('内部状态异常：连接还没建立')
    try {
      await client.call(CMD.CONNECT_C2S, body)
    } catch (error) {
      return this.loginFailed(`登录失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!this.loggedIn) return this.loginFailed('服务端没有返回登录信息')
    return { ok: true }
  }

  logout(): { ok: boolean } {
    this.markActive()
    this.closeGameServer()
    this.replay.clear()
    this.match.clear()
    // 登出 = 网络断了，脚本再跑下去只会一路报错，直接停
    this.script.stop('账号已登出，脚本已停')
    this.loginStateValue = 'idle'
    this.linkStateValue = 'idle'
    this.linkMessageStr = ''
    this.loginInfoValue = null
    this.sessionNoValue = 0n
    this.queueTimeValue = 0
    this.banTimeValue = 0n
    this.serverTimeValue = 0n
    this.HeartbeatState = { sent: 0, received: 0, intervalMs: heartbeatIntervalMs, lastSent: 0, lastReceived: 0 }
    this.writeLog('已登出', 'info')
    this.fanout.sent({ kind: '状态' })
    return { ok: true }
  }

  private loginFailed(message: string): { ok: boolean; message: string } {
    log(`槽位 ${this.slot} 登录失败: ${message}`)
    this.loginStateValue = 'failed'
    this.writeLog(message, 'error')
    this.fanout.sent({ kind: '状态' })
    return { ok: false, message }
  }

  // ---------------------------------------------------------------- 通行证

  async callPassport(action: '发码' | '登录', params: Record<string, unknown>): Promise<passportAck> {
    if (this.destroyed) return { ok: false, ret: '', msg: '', credential: null, content: null, rawText: '', message: '槽位已销毁' }
    this.markActive()
    this.passportBusy = true
    this.passportStateStr = action === '发码' ? '正在发验证码…' : '正在登录通行证…'
    this.fanout.sent({ kind: '状态' })
    try {
      const request: passportRequest = {
        action,
        appId: pickOptionalText(params.appId),
        telNum: pickOptionalText(params.telNum),
        // 前端沿用旧字段名 `type` 传短信类型
        smsType: pickOptionalText(params.type ?? params.smsType),
        loginType: params.loginType === undefined ? undefined : Number(params.loginType),
        code: pickOptionalText(params.code),
        userName: pickOptionalText(params.userName),
        password: pickOptionalText(params.password),
        deviceId: this.passportDeviceId.length > 0 ? this.passportDeviceId : undefined,
      }
      const result = await runPassport(request)
      if (result.ok && result.credential !== null) {
        this.credential = result.credential
        if (result.credential.deviceId.length > 0) this.passportDeviceId = result.credential.deviceId
        this.passportStateStr = `通行证登录成功，sid 长度 ${result.credential.sid.length}`
      } else if (!result.ok) {
        this.passportStateStr = `通行证失败：${passportDetail(result.ret, result.msg, result.message)}`
      }
      return result
    } finally {
      this.passportBusy = false
      this.fanout.sent({ kind: '状态' })
    }
  }

  // ---------------------------------------------------------------- 发命令

  async sendCommand(name: string, params: Record<string, unknown> = {}): Promise<sendCommandResult> {
    this.markActive()
    const client = this.rpc
    if (client === null || this.tcp === null) {
      return { ok: false, error: '还没建立连接（先登录这个账号）', respBodyLen: 0 }
    }
    if (this.loginStateValue !== 'logined') {
      return { ok: false, error: '还没登录，服务端不会受理业务请求', respBodyLen: 0 }
    }

    const commandNameStr = name.trim()
    const cmdId = CMD_OF[commandNameStr]
    if (cmdId === undefined) {
      return {
        ok: false,
        error: `命令表里没有「${commandNameStr}」，检查拼写（区分大小写，比如 QueryRoomC2S）`,
        respBodyLen: 0,
      }
    }
    const struct = getSchema(commandNameStr)
    if (!struct) return { ok: false, error: `没有「${commandNameStr}」的结构定义`, respBodyLen: 0 }

    const unknown = findUnknownFields(struct, params)
    if (unknown.length > 0) {
      return { ok: false, error: `这些字段不在 ${commandNameStr} 里：${unknown.join(', ')}`, respBodyLen: 0 }
    }

    let body: Uint8Array
    try {
      body = encode(struct, fromJson(struct, params))
    } catch (error) {
      return { ok: false, error: `打包失败：${String(error)}`, respBodyLen: 0 }
    }

    try {
      const frame = await client.call(cmdId, body)
      const respName = commandName(frame.cmdId)
      const responseStruct = getSchema(respName)
      const rawResponse = responseStruct === undefined ? undefined : decode(responseStruct, frame.body)
      if (rawResponse !== undefined) this.decodeActionData(respName, rawResponse)
      return {
        ok: true,
        name: respName,
        cmdId: frame.cmdId,
        sendReplyBody: body,
        rawResponse,
        respBodyLen: frame.body.length,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message, errorCode: errorCodeFromMessage(message), respBodyLen: 0 }
    }
  }

  async debugSend(
    commandNameStr: string,
    paramsJson: string,
  ): Promise<{ ok: boolean; error?: string; result?: DebugSendResult }> {
    let raw: Record<string, unknown> = {}
    if (paramsJson.trim().length > 0) {
      try {
        const parse = JSON.parse(paramsJson) as unknown
        if (parse === null || typeof parse !== 'object' || Array.isArray(parse)) {
          return { ok: false, error: '参数必须是 JSON 对象' }
        }
        raw = parse as Record<string, unknown>
      } catch (error) {
        return { ok: false, error: `参数不是合法 JSON：${String(error)}` }
      }
    }

    const result = await this.sendCommand(commandNameStr, raw)
    if (!result.ok) return { ok: false, error: result.error }

    const sendReplyBody = result.sendReplyBody ?? new Uint8Array(0)
    return {
      ok: true,
      result: {
        cmdId: CMD_OF[commandNameStr.trim()] ?? 0,
        bodyLen: sendReplyBody.length,
        sendHex: bytesToHex(sendReplyBody),
        respName: result.name ?? '',
        respLen: result.respBodyLen,
        // 可读 JSON 让 bytes 带 `hex:` 前缀，与今天前端调试面板看到的一致
        respJson: result.rawResponse === undefined ? '(没有该回包的结构定义)' : toReadableJson(result.rawResponse),
      },
    }
  }

  clearLogs(): void {
    this.logRing.clear()
  }

  destroy(): void {
    this.destroyed = true
    this.replay.clear()
    this.match.clear()
    this.script.destroy()
    this.closeGameServer()
  }

  // ---------------------------------------------------------------- 游戏链路

  private connectGameServer(): Promise<boolean> {
    return new Promise<boolean>((settle) => {
      this.closeGameServer()

      const client = new RpcClient({
        sendBytes: (bytes) => {
          if (this.tcp !== null && this.tcp.writable) this.tcp.write(bytes)
        },
        onFrame: (direction, frame) => this.recordFrame(direction, frame),
        onError: (message) => this.writeLog(message, 'error'),
      })
      client.onAnyPush((frame) => this.onPush(frame))
      this.rpc = client

      const target = `${config.gameHost}:${config.gamePort}`
      const socket = net.connect({ host: config.gameHost, port: config.gamePort })
      this.tcp = socket
      // 与游戏 `USocket.GenClientSocket` 一致，关掉 Nagle
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 30_000)

      let settled = false
      const timeout = setTimeout(() => {
        this.linkStateValue = 'error'
        this.linkMessageStr = '连接超时'
        this.writeLog(`连接游戏服务端超时：${target}`, 'error')
        this.fanout.sent({ kind: '状态' })
        wrapUp(false)
      }, connectTimeoutMs)
      const wrapUp = (result: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        settle(result)
      }

      socket.on('connect', () => {
        log(`槽位 ${this.slot} 已连接游戏服务端: ${target}`)
        this.linkStateValue = 'connected'
        this.linkMessageStr = target
        this.writeLog(`已连接游戏服务端 ${target}`, 'success')
        this.fanout.sent({ kind: '状态' })
        wrapUp(true)
      })

      socket.on('data', (chunk) => this.rpc?.handleChunk(chunk))

      socket.on('error', (error) => {
        this.linkStateValue = 'error'
        this.linkMessageStr = error.message
        this.writeLog(`游戏服务端连接错误: ${error.message}`, 'error')
        this.fanout.sent({ kind: '状态' })
        wrapUp(false)
      })

      socket.on('close', () => {
        // 被新连接换掉的旧套接（`关游戏服` 里 destroy）不该改状态
        if (this.tcp !== socket) return
        this.tcp = null
        this.stopGameHeartbeat()
        if (this.destroyed) return
        this.linkStateValue = 'closed'
        this.loginStateValue = 'idle'
        this.writeLog('游戏服务端连接已断开', 'warn')
        this.fanout.sent({ kind: '状态' })
      })
    })
  }

  private closeGameServer(): void {
    this.stopGameHeartbeat()
    const client = this.rpc
    this.rpc = null
    if (client !== null) client.dispose()
    const socket = this.tcp
    this.tcp = null
    if (socket !== null) {
      socket.removeAllListeners()
      socket.destroy()
    }
  }

  // ---------------------------------------------------------------- 游戏心跳

  private startGameHeartbeat(): void {
    this.stopGameHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      void this.sendGameHeartbeat()
    }, this.HeartbeatState.intervalMs)
  }

  private stopGameHeartbeat(): void {
    if (this.heartbeatTimer === null) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private async sendGameHeartbeat(): Promise<void> {
    const client = this.rpc
    // 一次只允许一个心跳在飞，避免积压
    if (this.heartbeatInFlight || client === null || this.loginStateValue !== 'logined') return
    this.heartbeatInFlight = true
    this.HeartbeatState.sent += 1
    this.HeartbeatState.lastSent = Date.now()
    this.fanout.sent({ kind: '状态' })
    try {
      await client.call(CMD.HEARTBEAT_C2S, encodeHeartbeatC2S(Date.now()))
    } catch (error) {
      this.writeLog(`心跳失败: ${String(error)}`, 'warn')
    } finally {
      this.heartbeatInFlight = false
    }
  }

  // ---------------------------------------------------------------- 推送解码

  private recordFrame(direction: FrameDirection, frame: Frame): void {
    if (this.destroyed) return
    this.markActive()
    this.frameRing.push(makeFrameRecord(direction as FrameDirection, frame))
    this.fanout.sent({ kind: '帧' })
  }

  private onPush(frame: Frame): void {
    if (frame.cmdId === CMD.CONNECT_S2C) {
      this.onLoginResponse(frame)
      return
    }
    if (frame.cmdId === CMD.HEARTBEAT_S2C) {
      this.onHeartbeatAck(frame)
      return
    }
    const name = commandName(frame.cmdId)
    const struct = getSchema(name)
    if (struct === undefined) return
    const value = decode(struct, frame.body)
    this.decodeActionData(name, value)
    const payload = toJson(value) as DecodedMessage
    // 先记进回放缓存再扇出：两者用的是同一个对象，前端重连时拿到的就是这份
    this.replay.record(name, frame.cmdId, payload, this.loginInfoValue?.playerId ?? '')
    // 后端对局现场：与 WS 连接无关，页面关着照样更新（脚本引擎读的就是它）
    this.match.feed(name, payload)
    // 脚本钩的是「这一帧之后」的状态，所以排在 `对局.喂` 后面
    this.script.dispatch(name, payload)
    this.fanout.sent({ kind: '推送', name, cmdId: frame.cmdId, data: payload })
  }

  private onLoginResponse(frame: Frame): void {
    if (frame.err !== 0) return
    const data = decodeConnectS2C(frame.body)
    this.rpc?.setSessionId(data.SessionId)
    this.sessionNoValue = data.SessionId
    this.queueTimeValue = data.QueueTime
    this.banTimeValue = data.BanTime
    this.serverTimeValue = data.NowTime
    const accountPacket = data.Account
    const playerPacket = data.Player
    this.loginInfoValue = {
      accountId: String(accountPacket.AccountId ?? 0n),
      accountNick: String(accountPacket.Nick ?? ''),
      playerId: String(playerPacket.Id ?? 0n),
      playerNick: String(playerPacket.Nick ?? ''),
      playerLevel: Number(playerPacket.Level ?? 0),
      serverId: String(playerPacket.ServerId ?? ''),
      plat: String(accountPacket.Plat ?? ''),
    }
    this.loginStateValue = 'logined'
    this.writeLog(
      `登录成功: 玩家id=${this.loginInfoValue.playerId}`
        + ` 昵称=${this.loginInfoValue.playerNick || this.loginInfoValue.accountNick}`
        + ` SESSIONID=${data.SessionId}`,
      'success',
    )
    if (data.QueueTime > 0) this.writeLog(`服务端提示排队: ${data.QueueTime} 秒`, 'warn')
    if (data.BanTime > 0n) this.writeLog(`账号封禁至 ${data.BanTime}`, 'error')
    // 重新登录 = 新会话，旧房间的全量帧作废（服务端会重新下发 OnlineSyncRoomIdS2C 之类）
    this.replay.clear()
    this.startGameHeartbeat()
    this.fanout.sent({ kind: '状态' })
  }

  private onHeartbeatAck(frame: Frame): void {
    const data = decodeHeartbeatS2C(frame.body)
    this.HeartbeatState.received += 1
    this.HeartbeatState.lastReceived = Date.now()
    this.serverTimeValue = data.Server
    this.fanout.sent({ kind: '状态' })
  }

  /**
   * `RunningGameS2C` / `PredictActionS2C` 的 `Actions[i].Data` 是 bytes，
   * 这里按 `Actions[i].Id` 就地解成对象 —— 前端 `battle.ts` 的 `解候选数据` 因此可以退化成恒等函数。
   */
  private decodeActionData(name: string, value: Record<string, unknown>): void {
    if (name !== 'RunningGameS2C' && name !== 'PredictActionS2C') return
    const actionTable = value.Actions
    if (!Array.isArray(actionTable)) return
    for (const item of actionTable) {
      if (item === null || typeof item !== 'object') continue
      const action = item as Record<string, unknown>
      const subStruct = getSchema(commandName(Number(action.Id ?? 0)))
      if (subStruct === undefined || !(action.Data instanceof Uint8Array)) continue
      action.Data = decode(subStruct, action.Data)
    }
  }
}