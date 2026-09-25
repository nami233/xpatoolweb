/**
 * 用户脚本引擎：一个游戏账号（槽位）一个实例。
 *
 * 职责：
 *  - 持有 `脚本沙箱`（跑代码）和注入沙箱的 `游戏` 门面（脚本唯一的对外通道）；
 *  - 把服务端推送翻成「事件」派给脚本（同名命令 + 中文别名 + 语义事件）；
 *  - 串行化：同一时刻只有一次派发在跑，脚本里 `await` 也不会和下一帧交错；
 *  - 出错兜底：单次报错不改运行态，**连续 3 次**自动停用（防一个坏脚本把日志刷爆）。
 *
 * 不碰落盘、不碰 WS、不认识用户名 —— 存档由 `user/scriptStore.ts` 管，发命令由槽位发。
 *
 * ## 运行态
 *
 * ```
 * 未载入 ──载入()──▶ 已停止 ──启动()──▶ 运行中 ──停止()/登出──▶ 已停止
 *                       ▲                  └──连续出错 3 次──▶ 出错停用
 *                       └──────────────── 重新载入() ──────────┘
 * ```
 *
 * `载入` 只编译不执行（`存脚本` 走它），`启动` 才跑顶层并补发当前状态。
 */
import type { Script } from 'node:vm'
import type { LogLevel, ScriptRunState } from '../../shared/protocol/states.ts'
import type { matchSnapshot, todoAction } from '../game/view.ts'
import { CMD_NAMES } from '../net/proto/generated/cmds.gen.ts'
import { ScriptSandbox } from './sandbox.ts'
import type { scriptCallback } from './sandbox.ts'

/** 顶层脚本允许跑多久（建上下文之后一次性执行的那段） */
const topTimeoutMs = 3_000
/** 单次回调允许的同步执行时间 —— 超了当场抛「Script execution timed out」 */
const callbackTimeoutMs = 2_000
/** 回调返回 Promise 时的看门狗（够 `await game.sendAction(...)` 等一轮游戏服往返） */
const asyncTimeoutMs = 30_000
/** 连续这么多轮派发都出错就自动停用 */
const maxConsecutiveErrors = 3
/** 脚本日志的限速：每秒最多这么多条，多的丢 */
const logsPerSecondLimit = 50
const logTextLimit = 1_000

/** `房间状态名[25]` = 对局中（`src/data/names.ts`） */
const isMatchRunning = 25

/** 上下行都可能带的大整数走 JSON 是字符串，这里统一当字符串比 */
const getText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** 沙箱里抛的 Error 是**另一个 realm** 的，`instanceof Error` 不成立，所以统一走 `String()` 兜底 */
function getMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function getField(payload: unknown, name: string): unknown {
  if (payload === null || typeof payload !== 'object') return undefined
  return (payload as Record<string, unknown>)[name]
}

function normalizeLevel(value: unknown): LogLevel {
  return value === 'success' || value === 'warn' || value === 'error' ? value : 'info'
}

/** 一次事件派发：`事件` 是脚本 `当()` 里写的那个名字 */
interface pendingDispatch {
  events: string
  data: unknown
}

// ---------------------------------------------------------------- 事件名

/**
 * 中文别名：写 `game.when('移动', …)` 就等于同时钩住这三个命令。
 * 名字只在**对外**这一层出现，内部照旧全用服务端命令名。
 */
const aliasTable: Record<string, string[]> = {
  move: ['MoveS2C', 'PursuitS2C', 'MonsterPursuitS2C'],
  MonsterRefresh: ['MonsterRefreshS2C'],
  progress: ['GameProgressChangeS2C'],
  attrChange: ['UpdateHeroAttrS2C'],
}

/** `属性变化` 只报我自己的（别人的属性变化不派，要就自己钩 `UpdateHeroAttrS2C`） */
const aliasFilter: Record<string, (payload: unknown, myId: string) => boolean> = {
  attrChange: (payload, myId) => myId.length > 0 && getText(getField(payload, 'PlayerId')) === myId,
}

/** 语义事件：不是某一帧，而是「前后两帧比出来的变化」 */
const semanticEventName = ['进入对局', '离开房间', '轮次', '待办', '战斗开始', '战斗结束']

/** `当()` 时校验用的总表：服务端命令名 + 语义名 + 别名 */
const hookableEvents = new Set<string>([
  ...Object.values(CMD_NAMES),
  ...semanticEventName,
  ...Object.keys(aliasTable),
])

// ---------------------------------------------------------------- 基线（比变化用）

interface baseline {
  roomId: string
  roomState: number
  round: number
  /** 空串 = 没在战斗 */
  battleId: string
  battleEnd: boolean
  /** 已经报给过脚本的待办键（`命令名:Sn`） */
  todoKey: Set<string>
}

function todoKey(action: todoAction): string {
  return `${action.commandName}:${action.Sn}`
}

function emptyBaseline(): baseline {
  return { roomId: '', roomState: 0, round: 0, battleId: '', battleEnd: false, todoKey: new Set() }
}

function recordBaseline(state: matchSnapshot): baseline {
  const battle = state.battle
  return {
    roomId: state.room.roomId,
    roomState: state.room.state,
    round: state.room.round,
    battleId: battle === null ? '' : battle.Id,
    battleEnd: battle === null ? false : battle.end,
    todoKey: new Set(state.todo.map(todoKey)),
  }
}

/**
 * 前后两帧比出来的语义事件。用 `空基线()` 当旧值调用一次 = 「把现在长什么样补报一轮」，
 * 这正是 `启动()` 之后要做的事。
 */
function computeSemanticEvents(state: matchSnapshot, prev: baseline): pendingDispatch[] {
  const out: pendingDispatch[] = []
  const room = state.room

  // 旧号非空、新号空 = 离开（被踢 / 退房 / 解散都走这里，`对局视图` 已经把它们都折成清空）
  if (prev.roomId.length > 0 && room.roomId.length === 0) out.push({ events: '离开房间', data: {} })
  if (prev.roomState !== isMatchRunning && room.state === isMatchRunning) {
    out.push({ events: '进入对局', data: state })
  }
  if (room.round !== prev.round && room.round > 0) {
    out.push({ events: '轮次', data: { round: room.round, mapId: room.mapId, difficulty: room.difficulty } })
  }

  for (const action of state.todo) {
    if (prev.todoKey.has(todoKey(action))) continue
    out.push({ events: '待办', data: action })
  }

  const battle = state.battle
  if (prev.battleId.length === 0) {
    if (battle !== null) out.push({ events: '战斗开始', data: battle })
  } else if (!prev.battleEnd && (battle === null || battle.end)) {
    // 战斗整块消失（清空 / 换房间）也算结束，此时没有新战报就交个空对象
    out.push({ events: '战斗结束', data: battle ?? {} })
  }

  return out
}

// ---------------------------------------------------------------- 对外接口

/** 脚本 `game.sendAction` 的回执（只报成败，回包内容让脚本去钩对应的 S2C） */
export interface sendActionResult {
  ok: boolean
  error?: string
  errorCode?: number
  /** 服务端回包的命令名 */
  name?: string
}

/** 引擎要外面给的东西。槽位侧注入，引擎自己不碰网络与落盘 */
export interface engineHook {
  slotId: () => number
  account: () => string
  /** 登录后的 `playerId`；没登录时是空串 */
  myId: () => string
  getMatchState: () => matchSnapshot
  getTodo: () => todoAction[]
  sendCommand: (name: string, params: Record<string, unknown>) => Promise<sendActionResult>
  log: (text: string, level: LogLevel) => void
  reportState: (runState: ScriptRunState, detail: string) => void
}

export interface loadResult {
  ok: boolean
  error?: string
}

export class ScriptEngine {
  private readonly hook: engineHook
  private readonly sandbox: ScriptSandbox
  /** 注入沙箱的那个 `游戏`。**每个新 realm 都注入同一个对象** */
  private readonly game: Record<string, unknown>

  private compiled: Script | null = null
  private runStateValue: ScriptRunState = '未载入'
  private detailValue = '还没写过脚本'
  private baseline: baseline = emptyBaseline()

  /** 派发串行队列：同一时刻只跑一次，钩子之间不会互相插队 */
  private queue: Promise<void> = Promise.resolve()
  private consecutiveErrors = 0

  private logWindow = 0
  private logCount = 0
  private rateLimited = false

  constructor(hook: engineHook) {
    this.hook = hook
    this.sandbox = new ScriptSandbox({
      log: (text, level) => this.logScript(text, level),
      reportError: (error) => this.reportScriptError(error),
      callbackTimeoutMs,
      asyncTimeoutMs,
    })
    this.game = this.createGame()
  }

  // ---------------------------------------------------------------- 状态

  getRunState(): ScriptRunState {
    return this.runStateValue
  }

  getDetail(): string {
    return this.detailValue
  }

  /** 只编译不执行。语法错回 `ok:false`，且**不动现状**（正在跑的旧脚本继续跑） */
  load(source: string): loadResult {
    const text = typeof source === 'string' ? source : ''
    let artifact: Script
    try {
      artifact = this.sandbox.compile(text, `脚本-槽位${this.hook.slotId()}.js`)
    } catch (error) {
      const message = `脚本语法有问题：${getMessage(error)}`
      this.hook.log(`[脚本] ${message}`, 'error')
      return { ok: false, error: message }
    }
    this.compiled = artifact
    // 源码换了就把正在跑的那份拆掉（钩子 / 定时器全部作废），跑不跑由用户再点一次
    this.sandbox.clearHooks()
    this.baseline = emptyBaseline()
    this.consecutiveErrors = 0
    this.logCount = 0
    this.setState('已停止', '脚本已保存，点「运行」开始跑')
    return { ok: true }
  }

  /**
   * 跑顶层 + 补发当前状态。**不 await 那些派发** —— 立刻回 `运行中`，
   * 之后回调里出的错走 `脚本状态` 推送和日志，不把这一次请求挂住。
   */
  start(): loadResult {
    const artifact = this.compiled
    if (artifact === null) return { ok: false, error: '这个槽位还没保存过脚本' }

    // 重跑 = 先拆干净旧的（钩子 / 定时器 / 旧 realm 里捕获的一切都作废）
    this.sandbox.clearHooks()
    this.consecutiveErrors = 0
    this.logCount = 0
    this.sandbox.createContext(this.game)

    try {
      this.sandbox.runTopLevel(artifact, topTimeoutMs)
    } catch (error) {
      const message = `脚本一上来就抛错：${getMessage(error)}`
      this.baseline = emptyBaseline()
      this.sandbox.clearHooks()
      this.setState('已停止', message)
      this.hook.log(`[脚本] ${message}`, 'error')
      return { ok: false, error: message }
    }

    this.setState('运行中', '正在跑')
    // 顶层跑完立刻补报一轮「现在长什么样」：进入对局 / 轮次 / 当前每条待办
    const state = this.hook.getMatchState()
    this.baseline = recordBaseline(state)
    this.queueDispatch(computeSemanticEvents(state, emptyBaseline()))
    return { ok: true }
  }

  /** 停掉（登出 / 手动停 / 换源码前）。已经在停着的就不重复报状态 */
  stop(detail: string): void {
    if (this.runStateValue !== '运行中') return
    this.sandbox.clearHooks()
    this.baseline = emptyBaseline()
    this.consecutiveErrors = 0
    this.setState('已停止', detail)
  }

  /** 槽位销毁：不再报状态（没人听了），把定时器和上下文一并丢掉 */
  destroy(): void {
    this.sandbox.destroy()
    this.runStateValue = this.compiled === null ? '未载入' : '已停止'
    this.detailValue = '槽位已销毁'
  }

  /**
   * 来了一帧。**同步**把事件算好（读的是这一帧之后的状态）再排队派发 ——
   * 若拖到队列里才算，连续两帧会让前一次比对看见后一帧的结果，变化就被吞掉了。
   */
  dispatch(name: string, payload: unknown): void {
    if (this.runStateValue !== '运行中') return
    const state = this.hook.getMatchState()
    // 先跟旧基线比出事件，**再**把基线推到新状态 —— 顺序反了就永远比不出变化
    const eventTable = this.computeEvents(name, payload, state)
    this.baseline = recordBaseline(state)
    this.queueDispatch(eventTable)
  }

  // ---------------------------------------------------------------- 内部

  private computeEvents(name: string, payload: unknown, state: matchSnapshot): pendingDispatch[] {
    // 服务端命令名本身也是一类事件，所以同一条推送可能派三次：原名、别名、语义事件
    const out: pendingDispatch[] = [{ events: name, data: payload }]
    for (const [alias, commandNames] of Object.entries(aliasTable)) {
      if (!commandNames.includes(name)) continue
      const filter = aliasFilter[alias]
      if (filter !== undefined && !filter(payload, this.hook.myId())) continue
      out.push({ events: alias, data: payload })
    }
    for (const item of computeSemanticEvents(state, this.baseline)) out.push(item)
    return out
  }

  private queueDispatch(eventTable: pendingDispatch[]): void {
    if (eventTable.length === 0) return
    this.queue = this.queue
      .then(async () => {
        // 计数按**一轮派发**算，不是按每个事件算 —— 一条推送可能派好几个事件，
        // 其中大半没有钩子（无错可犯），按事件清会把真正的连续出错抹平
        const prev = this.consecutiveErrors
        for (const item of eventTable) {
          // 中途被停掉 / 被自动停用，剩下的就不派了
          if (this.runStateValue !== '运行中') return
          await this.sandbox.dispatchEvent(item.events, JSON.stringify(item.data ?? null))
        }
        // 这一轮一次错都没犯，就把「连续出错」清零
        if (this.consecutiveErrors === prev) this.consecutiveErrors = 0
      })
      .catch(() => {})
  }

  private setState(state: ScriptRunState, detail: string): void {
    this.runStateValue = state
    this.detailValue = detail
    this.hook.reportState(state, detail)
  }

  private reportScriptError(error: string): void {
    this.consecutiveErrors += 1
    // 这里直写日志环，不走限速（出错信息被限速丢掉才是最糟的）
    this.hook.log(`[脚本] 出错: ${error}`, 'error')
    if (this.consecutiveErrors >= maxConsecutiveErrors) {
      this.sandbox.clearHooks()
      this.baseline = emptyBaseline()
      this.setState('出错停用', `连续出错 ${maxConsecutiveErrors} 次，已自动停用：${error}`)
    }
  }

  /** `game.logs` / `console.*` 的落点。脚本进了死循环狂打日志时按秒限速 */
  private logScript(text: unknown, level: unknown): void {
    const line = (getText(text) ?? String(text)).slice(0, logTextLimit)
    const now = Date.now()
    if (now - this.logWindow >= 1000) {
      this.logWindow = now
      this.logCount = 0
      this.rateLimited = false
    }
    if (this.logCount >= logsPerSecondLimit) {
      if (!this.rateLimited) {
        this.rateLimited = true
        this.hook.log(`[脚本] 一秒内日志超过 ${logsPerSecondLimit} 条，本秒内后面的已丢弃`, 'warn')
      }
      return
    }
    this.logCount += 1
    this.hook.log(`[脚本] ${line}`, normalizeLevel(level))
  }

  // ---------------------------------------------------------------- 游戏门面

  /**
   * 注入沙箱的 `游戏`。**属性全是 getter / 箭头闭包**（不缓存值），
   * 因为槽位号之外的东西都会变：我的Id 随登录、状态随每一帧。
   */
  private createGame(): Record<string, unknown> {
    const engine = this
    return {
      get slot(): number {
        return engine.hook.slotId()
      },
      get account(): string {
        return engine.hook.account()
      },
      get myId(): string {
        return engine.hook.myId()
      },
      /** 当前全貌（JSON 克隆：脚本改它改不到引擎内存） */
      get state(): unknown {
        return engine.getStateSnapshot()
      },
      /** 不传命令名就回全部；只认字符串 */
      todo(commandName?: unknown): unknown {
        return engine.getTodoSnapshot(commandName)
      },
      sendAction(commandName: unknown, field?: unknown): unknown {
        return engine.sendAction(commandName, field)
      },
      when(events: unknown, callback: unknown): number {
        return engine.addHook(events, callback)
      },
      setTimer(callback: unknown, Ms: unknown): number {
        return engine.registerTimer(callback, Ms)
      },
      cancelTimer(seq: unknown): void {
        engine.cancelTimer(seq)
      },
      logs(text: unknown, level?: unknown): void {
        engine.logScript(text, level)
      },
    }
  }

  private getStateSnapshot(): unknown {
    return JSON.parse(
      JSON.stringify({
        slot: this.hook.slotId(),
        account: this.hook.account(),
        myId: this.hook.myId(),
        match: this.hook.getMatchState(),
      }),
    )
  }

  private getTodoSnapshot(commandName: unknown): unknown {
    const allNodes = this.hook.getTodo()
    const name = getText(commandName)
    const pick = name === null ? allNodes : allNodes.filter((item) => item.commandName === name)
    return JSON.parse(JSON.stringify(pick))
  }

  private addHook(events: unknown, callback: unknown): number {
    const name = getText(events)?.trim() ?? ''
    if (name.length === 0) throw new Error('game.when 的第一个参数要是事件名（字符串）')
    if (!hookableEvents.has(name)) {
      throw new Error(`没有「${name}」这个事件。可用：服务端命令名（如 MoveS2C）、${Object.keys(aliasTable).join('/')}、${semanticEventName.join('/')}`)
    }
    if (typeof callback !== 'function') throw new Error(`game.when('${name}', …) 的第二个参数要是函数`)
    return this.sandbox.host.registerHook(name, callback as scriptCallback)
  }

  private registerTimer(callback: unknown, Ms: unknown): number {
    if (typeof callback !== 'function') throw new Error('game.setTimer 的第一个参数要是函数')
    const count = typeof Ms === 'number' ? Ms : Number(Ms)
    if (!Number.isFinite(count) || count < 0) throw new Error('game.setTimer 的第二个参数要是非负毫秒数')
    return this.sandbox.host.setTimer(callback as scriptCallback, count)
  }

  private cancelTimer(seq: unknown): void {
    const count = typeof seq === 'number' ? seq : Number(seq)
    if (Number.isFinite(count)) this.sandbox.host.cancelTimer(count)
  }

  private sendAction(commandName: unknown, field: unknown): Promise<sendActionResult> {
    const name = getText(commandName)?.trim() ?? ''
    if (name.length === 0) return Promise.resolve({ ok: false, error: '命令名不能为空' })

    const item = this.hook.getTodo().find((action) => action.commandName === name)
    if (item === undefined) {
      const message = `现在没有「${name}」这条待办，动作没发出去`
      this.logScript(message, 'warn')
      return Promise.resolve({ ok: false, error: message })
    }

    // 沙箱里的对象（`Object.prototype` 是那边的）不能直接喂 protobuf 打包器，
    // JSON 走一遍落成宿主侧的普通对象
    const raw: unknown = JSON.parse(JSON.stringify(field ?? {}))
    const body: Record<string, unknown> =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    // `Info.Sn` 是服务端认「哪条预测动作」的唯一凭据，脚本传什么都会被这里盖掉
    body.Info = { Sn: item.Sn, UseTime: 0 }

    return this.hook.sendCommand(name, body).then(
      (result) => ({ ok: result.ok, error: result.error, errorCode: result.errorCode, name: result.name }),
      (error: unknown) => ({ ok: false, error: getMessage(error) }),
    )
  }
}