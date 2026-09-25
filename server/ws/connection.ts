/**
 * 一条前端 WS 连接。
 *
 * 职责：把上行消息分派到「租户 → 槽位」、记住本连接订阅了哪些槽位的哪些事件、
 * 再用推送泵把槽位事件按 40ms 合流后下发。
 *
 * **断线只脱离、不销毁**：槽位是租户级的，前端刷新 / 关标签 / 断网都只让引用计数归零，
 * 槽位里的游戏 TCP 与对局继续跑，由保留定时器负责最终回收（见 `tenant/registry.ts`）。
 * 所以这里订阅时会先推一条当前 `槽位状态`，再把最近的全量帧回放一遍，界面就能回到断线前。
 *
 * 请求↔回执的关联很朴素：上行消息自带 `请求号`，处理完就地带着同一个号回一条
 * （`回执`/`回包`/`调试结果`/…），所以这里不需要挂一张 pending 表。
 */
import { WebSocket } from 'ws'
import type {
  DownMessage,
  UpMessage,
  LoginUp,
  SubscribeUp,
  UnsubscribeUp,
  SendCommandUp,
  DebugSendUp,
  PassportUp,
  FetchRemoteConfigUp,
  SaveCaptureUp,
  ClearLogsUp,
  ReadScriptUp,
  SaveScriptUp,
  RunScriptUp,
  StopScriptUp,
  HeartbeatUp,
  SlotSummary,
} from '../../shared/protocol/messages.ts'
import type { EventName } from '../../shared/protocol/states.ts'
import { toJson } from '../../shared/protocol/jsonSafe.ts'
import type { DecodedMessage } from '../../shared/protocol/jsonSafe.ts'
import { config } from '../config.ts'
import type { BackendConfig } from '../config.ts'
import { fetchRemoteConfig as runRemoteConfig } from '../remoteConfig.ts'
import { saveCaptureFile, captureText } from '../slot/capture.ts'
import { pushPump } from '../slot/push.ts'
import type { pumpHost, slotEvent } from '../slot/push.ts'
import type { TenantRegistry, SlotTable } from '../tenant/registry.ts'
import { getCredentialFingerprint } from '../tenant/slot.ts'
import type { slotSession } from '../tenant/slot.ts'
import type { ScriptStore } from '../user/scriptStore.ts'

/** 帧批 / 日志一次最多带这么多条，剩下的下一批接着发 */
const batchLimit = 300

interface subscriptionState {
  events: Set<EventName>
  logCursor: number
  frameCursor: number
  deregister: () => void
}

export class connection implements pumpHost {
  private readonly ws: WebSocket
  private readonly configValue: BackendConfig
  private readonly Registry: TenantRegistry
  private readonly script: ScriptStore
  private readonly closeCallback: () => void
  private readonly pump: pushPump

  private usernameValue = ''
  private sessionTokenValue = ''
  private tenantName = ''
  private SlotTable: SlotTable | null = null
  private readonly subscriptionTable = new Map<number, subscriptionState>()
  private readonly dirtySlots = new Set<number>()
  private pendingQueue: DownMessage[] = []
  private closed = false

  // 不用构造函数参数属性：Node 的类型剥离是 strip-only，遇到就报错
  constructor(
    ws: WebSocket,
    configValue: BackendConfig,
    Registry: TenantRegistry,
    script: ScriptStore,
    closeCallback: () => void,
  ) {
    this.ws = ws
    this.configValue = configValue
    this.Registry = Registry
    this.script = script
    this.closeCallback = closeCallback
    this.pump = new pushPump(this, configValue.pushMinIntervalMs)
  }

  get tenant(): string {
    return this.tenantName
  }

  get username(): string {
    return this.usernameValue
  }

  /** 登出时服务端要靠它吊销会话记录（服务端只认 sha256，明文得从这条连接上取） */
  get sessionToken(): string {
    return this.sessionTokenValue
  }

  /**
   * 绑定到某个用户。**不变式**：只有这里和 `脱离用户` 会动 `槽位表`，
   * 所以「没绑定用户之前不落地任何槽位」靠 `槽位表 === null` 兜住。
   *
   * `retainMs` 是用户级的账号桶保留时长（`users.json` 里可手改），透传给注册表建表时用。
   *
   * 换用户必须整体清订阅：`订阅表` 以槽位号为键，而 `态.注销` 捕获的是**旧**槽位会话的
   * `扇出`，不清就会「旧会话的推送打进这条连接，`取其余` 却用新槽位表查同一个号」→ 状态串号。
   */
  bindUser(username: string, sessionToken: string, retainMs: number): void {
    this.detachUser()
    this.usernameValue = username
    this.sessionTokenValue = sessionToken
    this.tenantName = `u-${username}`
    this.SlotTable = this.Registry.getTenant(this.tenantName, retainMs)
  }

  /** 回到「已认证未绑定」态（登出用） */
  unbindUser(): void {
    this.detachUser()
  }

  /**
   * 回到「已认证未绑定」态。**断线与登出都走这里**，只归还引用、不销毁槽位 ——
   * 槽位表归零后进入保留期，到点还没人连回来才由注册表回收。
   */
  private detachUser(): void {
    this.clearSubscriptions()
    // 归还租户引用：最后一条连接走了，槽位表进入保留期（前端刷新后还能连回来）
    if (this.tenantName.length > 0) this.Registry.releaseTenant(this.tenantName)
    this.tenantName = ''
    this.usernameValue = ''
    this.sessionTokenValue = ''
    this.SlotTable = null
  }

  /** 整体清订阅 + 清待发，并把泵里可能还排着的那个定时器停掉 */
  private clearSubscriptions(): void {
    for (const slotId of [...this.subscriptionTable.keys()]) this.dropSubscription(slotId)
    this.dirtySlots.clear()
    this.pendingQueue = []
    this.pump.stop()
  }

  slotList(): SlotSummary[] {
    return this.SlotTable === null ? [] : this.SlotTable.summary()
  }

  /**
   * 幂等建槽（号就是持久化记录里的 id）。**不能**直接调 `表.新建`：
   * 号被占时它会走 else 分支发一个新号，于是同一个游戏账号被建成两个槽位、
   * 前端手里的号也对不上 —— 而「槽位表还在 + 又绑一次用户」正是刷新 / 重连的常规路径。
   *
   * 账号与密码指纹都一致就复用现有会话；不一致（改过密码）才丢订阅并同号重建。
   */
  ensureSlot(Id: number, account: string, password: string): boolean {
    const table = this.SlotTable
    if (table === null) return false
    const existing = table.get(Id)
    if (existing !== undefined) {
      if (existing.account === account.trim() && existing.credentialFingerprint === getCredentialFingerprint(account, password)) return true
      // 旧会话的扇出还会打进这条连接，必须先摘订阅
      this.dropSubscription(Id)
      table.remove(Id)
    }
    return table.create(account, password, Id).ok
  }

  /** 摘订阅 + 销毁槽位会话（`删游戏账号` 用：删记录与销毁槽位是一件事） */
  removeSlot(Id: number): boolean {
    const table = this.SlotTable
    const ok = table !== null && table.remove(Id)
    if (ok) this.dropSubscription(Id)
    return ok
  }

  send(message: DownMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(message))
  }

  destroy(): void {
    if (this.closed) return
    this.closed = true
    // 先退订再归还租户引用：退订要靠槽位会话的扇出，租户桶被回收之后就拿不到了
    this.detachUser()
    this.pump.stop()
    this.closeCallback()
  }

  // ---------------------------------------------------------------- 上行分派

  handle(message: UpMessage): void {
    void this.dispatch(message)
  }

  private async dispatch(message: UpMessage): Promise<void> {
    try {
      switch (message.t) {
        // 认证由 服务器 处理，能走到这里说明是重复发送
        case '认证':
          return
        case '心跳':
          return this.replyHeartbeat(message)
        case '登录':
          return await this.login(message)
        case '订阅':
          return this.subscribe(message)
        case '退订':
          return this.unsubscribe(message)
        case '发命令':
          return await this.sendCommand(message)
        case '调试发包':
          return await this.debugSend(message)
        case '通行证':
          return await this.passport(message)
        case '拉取远端配置':
          return await this.fetchRemoteConfig(message)
        case '保存抓包':
          return await this.saveCapture(message)
        case '清日志':
          return this.clearLogs(message)
        case '读脚本':
          return this.readScript(message)
        case '存脚本':
          return this.saveScript(message)
        case '跑脚本':
          return this.runScript(message)
        case '停脚本':
          return this.stopScript(message)
      }
    } catch (error) {
      this.send({ t: '错误', message: error instanceof Error ? error.message : String(error) })
    }
  }

  private replyHeartbeat(message: HeartbeatUp): void {
    const sessions = this.SlotTable === null ? [] : this.SlotTable.all()
    const pendingAcks = sessions.reduce((acc, session) => acc + session.pendingAcks, 0)
    const serverTime = sessions.map((session) => session.getServerTime()).find((value) => value !== '0') ?? '0'
    this.send({ t: '心跳回执', reqId: message.reqId, serverTime, pendingAcks })
  }

  private async login(message: LoginUp): Promise<void> {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.send({ t: '回执', reqId: message.reqId, ok: false, slot: message.slot, message: '没有这个槽位' })
      return
    }
    // 账号/密码由服务端从持久化记录里带进槽位，前端不再参与
    const result = await session.login()
    this.send({ t: '回执', reqId: message.reqId, ok: result.ok, slot: message.slot, message: result.message })
    // 必须在后续业务推送之前把这个连接的状态送过去：前端要靠 `登录信息.playerId` 才知道「我是谁」，
    // 否则房间/对局推送全都会走偏。这里直接发、不走推送泵，确保顺序在前。
    if (result.ok) this.pushStateNow(message.slot)
  }

  private clearLogs(message: ClearLogsUp): void {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.send({ t: '回执', reqId: message.reqId, ok: false, slot: message.slot, message: '没有这个槽位' })
      return
    }
    session.clearLogs()
    this.send({ t: '回执', reqId: message.reqId, ok: true, slot: message.slot })
  }

  // ---------------------------------------------------------------- 脚本

  /**
   * 脚本存在 `scripts.json` 里（按 用户名 + 槽位号 各存各的），引擎只持有编译产物。
   * 所以「读」从存储拿源码，「载入 / 跑 / 停」都是引擎的动作 —— 回执统一带
   * 引擎当前的 `运行态` + `说明`，前端不必再等异步推来的 `脚本状态`。
   */
  private replyScript(
    reqId: number,
    slotId: number,
    session: slotSession,
    result: { ok: boolean; message?: string; source?: string },
  ): void {
    this.send({
      t: '脚本结果',
      reqId,
      slot: slotId,
      ok: result.ok,
      source: result.source,
      runState: session.script.getRunState(),
      detail: session.script.getDetail(),
      message: result.message,
    })
  }

  private replyScriptNoSlot(reqId: number, slotId: number): void {
    this.send({
      t: '脚本结果',
      reqId,
      slot: slotId,
      ok: false,
      runState: '未载入',
      detail: '没有这个槽位',
      message: '没有这个槽位',
    })
  }

  private readScript(message: ReadScriptUp): void {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.replyScriptNoSlot(message.reqId, message.slot)
      return
    }
    const source = this.script.get(this.usernameValue, message.slot) ?? ''
    // 顺手把存档载进引擎（只编译、不跑）：否则「存过但从没跑过」会显示成「未载入」
    if (source.length > 0 && session.script.getRunState() === '未载入') session.script.load(source)
    this.replyScript(message.reqId, message.slot, session, { ok: true, source })
  }

  private saveScript(message: SaveScriptUp): void {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.replyScriptNoSlot(message.reqId, message.slot)
      return
    }
    // 先落盘再载入：语法错的也存下来（用户下一版还得改它），载入失败会带着错误信息回去
    this.script.save(this.usernameValue, message.slot, message.source)
    const load = session.script.load(message.source)
    this.replyScript(message.reqId, message.slot, session, { ok: load.ok, message: load.error })
  }

  private runScript(message: RunScriptUp): void {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.replyScriptNoSlot(message.reqId, message.slot)
      return
    }
    const start = session.script.start()
    this.replyScript(message.reqId, message.slot, session, { ok: start.ok, message: start.error })
  }

  private stopScript(message: StopScriptUp): void {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.replyScriptNoSlot(message.reqId, message.slot)
      return
    }
    session.script.stop('已手动停止')
    this.replyScript(message.reqId, message.slot, session, { ok: true })
  }

  // ---------------------------------------------------------------- 订阅

  private subscribe(message: SubscribeUp): void {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.send({ t: '回执', reqId: message.reqId, ok: false, slot: message.slot, message: '没有这个槽位' })
      return
    }

    let state = this.subscriptionTable.get(message.slot)
    if (state === undefined) {
      const slotId = message.slot
      state = {
        events: new Set(),
        // 游标挂在高位 = 先不发任何历史日志，等下面订阅到「日志」时再回退到「最近 N 条」
        logCursor: Number.MAX_SAFE_INTEGER,
        frameCursor: session.frameRing.total,
        deregister: session.fanout.subscribe((events) => this.slotEventOf(slotId, events)),
      }
      this.subscriptionTable.set(slotId, state)
    }

    let newSubscriptionPush = false
    for (const name of message.events) {
      if (state.events.has(name)) continue
      state.events.add(name)
      if (name === '日志') state.logCursor = session.logRing.resendStart()
      // 帧只从订阅这一刻开始记，不回放历史
      if (name === '帧') state.frameCursor = session.frameRing.total
      if (name === '状态') this.dirtySlots.add(message.slot)
      if (name === '推送') newSubscriptionPush = true
    }

    // 新订上「推送」= 前端刚挂到这条连接上（首次登录 / 刷新 / 断线重连）。
    // 先把当前状态排进去，再按固定顺序回放全量帧，界面就能回到断线前。
    // 必须在 `泵.触发()` 之前入队：`取其余()` 是先脏状态、再待发队列，顺序才不会倒。
    if (newSubscriptionPush) {
      if (!state.events.has('状态')) this.pendingQueue.push({ t: '槽位状态', state: session.getState() })
      for (const frame of session.replay.getReplayFrames()) {
        this.pendingQueue.push({
          t: '推送',
          slot: message.slot,
          name: frame.name,
          cmdId: frame.cmdId,
          data: frame.data,
        })
      }
    }

    this.pump.trigger()
    this.send({ t: '回执', reqId: message.reqId, ok: true, slot: message.slot })
  }

  private unsubscribe(message: UnsubscribeUp): void {
    this.unsubscribeEvents(message.slot, message.events)
    this.send({ t: '回执', reqId: message.reqId, ok: true, slot: message.slot })
  }

  private unsubscribeEvents(slotId: number, events: EventName[]): void {
    const state = this.subscriptionTable.get(slotId)
    if (state === undefined) return
    for (const name of events) state.events.delete(name)
    if (state.events.size === 0) this.dropSubscription(slotId)
  }

  private dropSubscription(slotId: number): void {
    const state = this.subscriptionTable.get(slotId)
    if (state === undefined) return
    state.deregister()
    this.subscriptionTable.delete(slotId)
    this.dirtySlots.delete(slotId)
  }

  private pushStateNow(slotId: number): void {
    const session = this.SlotTable?.get(slotId)
    if (session === undefined) return
    this.send({ t: '槽位状态', state: session.getState() })
  }

  private slotEventOf(slotId: number, events: slotEvent): void {
    if (this.closed) return
    const state = this.subscriptionTable.get(slotId)
    if (state === undefined) return

    switch (events.kind) {
      case '状态':
        if (!state.events.has('状态')) return
        this.dirtySlots.add(slotId)
        break
      case '日志':
        if (!state.events.has('日志')) return
        break
      case '帧':
        if (!state.events.has('帧')) return
        break
      case '推送':
        if (!state.events.has('推送')) return
        this.pendingQueue.push({
          t: '推送',
          slot: slotId,
          name: events.name,
          cmdId: events.cmdId,
          data: events.data,
        })
        break
      case '脚本':
        if (!state.events.has('脚本')) return
        this.pendingQueue.push({
          t: '脚本状态',
          slot: slotId,
          runState: events.runState,
          detail: events.detail,
        })
        break
    }
    this.pump.trigger()
  }

  // ---------------------------------------------------------------- 业务请求

  private async sendCommand(message: SendCommandUp): Promise<void> {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.send({ t: '回包', reqId: message.reqId, slot: message.slot, ok: false, error: '没有这个槽位' })
      return
    }
    const result = await session.sendCommand(message.name, message.params ?? {})
    if (!result.ok) {
      this.send({
        t: '回包',
        reqId: message.reqId,
        slot: message.slot,
        ok: false,
        error: result.error,
        errorCode: result.errorCode,
      })
      return
    }
    this.send({
      t: '回包',
      reqId: message.reqId,
      slot: message.slot,
      ok: true,
      name: result.name,
      cmdId: result.cmdId,
      data: toJson(result.rawResponse) as DecodedMessage,
    })
  }

  private async debugSend(message: DebugSendUp): Promise<void> {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.send({ t: '调试结果', reqId: message.reqId, slot: message.slot, ok: false, error: '没有这个槽位' })
      return
    }
    const produced = await session.debugSend(message.name, message.paramsJson)
    this.send({
      t: '调试结果',
      reqId: message.reqId,
      slot: message.slot,
      ok: produced.ok,
      result: produced.result,
      error: produced.error,
    })
  }

  private async passport(message: PassportUp): Promise<void> {
    const session = this.SlotTable?.get(message.slot)
    if (session === undefined) {
      this.send({
        t: '通行证结果',
        reqId: message.reqId,
        slot: message.slot,
        ok: false,
        ret: '',
        msg: '',
        credential: null,
        content: null,
        message: '没有这个槽位',
      })
      return
    }
    const result = await session.callPassport(message.action, message.params)
    this.send({
      t: '通行证结果',
      reqId: message.reqId,
      slot: message.slot,
      ok: result.ok,
      ret: result.ret,
      msg: result.msg,
      credential: result.credential,
      content: result.content,
      url: result.url,
      message: result.message,
    })
  }

  private async fetchRemoteConfig(message: FetchRemoteConfigUp): Promise<void> {
    const result = await runRemoteConfig(message.route, message.version)
    this.send({
      t: '远端配置结果',
      reqId: message.reqId,
      ok: result.ok,
      url: result.url,
      text: result.text,
      data: result.data,
      message: result.message,
    })
  }

  private saveCapture(message: SaveCaptureUp): void {
    let text = message.text
    if (text === undefined) {
      const session = message.slot === undefined ? undefined : this.SlotTable?.get(message.slot)
      if (session === undefined) {
        this.send({
          t: '抓包落盘结果',
          reqId: message.reqId,
          ok: false,
          message: '没指定槽位，服务端不知道要落哪一份抓包',
        })
        return
      }
      text = captureText(session.frameRing.all())
    }
    const result = saveCaptureFile(config.captureDir, text)
    this.send({
      t: '抓包落盘结果',
      reqId: message.reqId,
      ok: result.ok,
      path: result.path,
      message: result.message,
    })
  }

  // ---------------------------------------------------------------- 推送泵宿主

  bufferSize(): number {
    return this.ws.bufferedAmount
  }

  getFrameBatch(): DownMessage | null {
    for (const [slotId, state] of this.subscriptionTable) {
      if (!state.events.has('帧')) continue
      const session = this.SlotTable?.get(slotId)
      if (session === undefined) continue
      const pendingSend = session.frameRing.takeFrom(state.frameCursor)
      if (pendingSend.length === 0) continue
      const batch = pendingSend.slice(0, batchLimit)
      state.frameCursor += batch.length
      return { t: '帧批', slot: slotId, entries: batch }
    }
    return null
  }

  getLogs(): DownMessage | null {
    for (const [slotId, state] of this.subscriptionTable) {
      if (!state.events.has('日志')) continue
      const session = this.SlotTable?.get(slotId)
      if (session === undefined) continue
      const pendingSend = session.logRing.takeFrom(state.logCursor)
      if (pendingSend.length === 0) continue
      const batch = pendingSend.slice(0, batchLimit)
      state.logCursor = batch[batch.length - 1].id
      return { t: '日志', slot: slotId, entries: batch }
    }
    return null
  }

  getRest(): DownMessage[] {
    const out: DownMessage[] = []
    for (const slotId of [...this.dirtySlots]) {
      this.dirtySlots.delete(slotId)
      const state = this.subscriptionTable.get(slotId)
      if (state === undefined || !state.events.has('状态')) continue
      const session = this.SlotTable?.get(slotId)
      if (session === undefined) continue
      out.push({ t: '槽位状态', state: session.getState() })
    }
    if (this.pendingQueue.length > 0) {
      out.push(...this.pendingQueue)
      this.pendingQueue = []
    }
    return out
  }

  hasPending(): boolean {
    if (this.pendingQueue.length > 0 || this.dirtySlots.size > 0) return true
    for (const [slotId, state] of this.subscriptionTable) {
      const session = this.SlotTable?.get(slotId)
      if (session === undefined) continue
      if (state.events.has('帧') && session.frameRing.pendingCount(state.frameCursor) > 0) return true
      if (state.events.has('日志') && session.logRing.pendingCount(state.logCursor) > 0) return true
    }
    return false
  }

  degraded(unsubscribe: EventName[], message: string): void {
    for (const slotId of [...this.subscriptionTable.keys()]) this.unsubscribeEvents(slotId, unsubscribe)
    this.send({ t: '降级', message: message, unsubscribe })
  }
}