/**
 * 用户脚本的 `node:vm` 沙箱。
 *
 * ## ⚠️ 这是「防手滑」，**不是**真安全隔离
 *
 * 挡得住的：
 *   - 误改引擎内存 —— 脚本拿到的 `game.state` 是 JSON 克隆，改它改不到引擎；
 *   - 同步死循环 —— 每次进沙箱跑回调都带 `timeout`；
 *   - 忘清理的定时器 —— 宿主登记表，`销毁()` 一次全清；
 *   - 直接摸 `process` / `require` / `setTimeout` —— 新 realm 里根本没有这些（白名单靠 vm 自带内建对象实现）。
 *
 * **挡不住的**：注入的宿主函数（`游戏.*`）沿 `.constructor.constructor` 能回到宿主全局，
 * 于是蓄意脚本仍然能拿到 `process`/`require`（读写文件、发网络请求、`process.exit()`）。
 * 要真隔离必须上 `worker_threads` + 受限 IPC，本项目不做。
 * 所以信任边界 = 「能改这个账号的人」= 拥有登录口令的人，`XPA_TOKEN` 门禁仍是唯一防线。
 *
 * ## 为什么要绕一圈 `__dispatch`
 *
 * `vm.runInContext(源码, 上下文, { timeout })` 的 `timeout` 只管**在沙箱里跑的代码**；
 * 宿主直接拿 vm 函数对象调用（`回调(游戏, 数据)`）是不受它管的 —— 回调里的 `while(true)` 会把后端挂死。
 * 所以钩子表放宿主侧、派发入口定义在沙箱里，每次都从沙箱进去调。
 */
import vm from 'node:vm'

/** 用户脚本里的一次回调。`数据` 是事件负荷（帧对象 / 待办动作 / 战斗摘要…） */
export type scriptCallback = (game: unknown, data: unknown) => unknown

/** 沙箱能做的宿主副作用。`引擎` 用它造 `游戏` 对象 */
export interface sandboxHost {
  /** 注册一个钩子（`game.when`），返回它在派发表里的索引 */
  registerHook(events: string, callback: scriptCallback): number
  /** 登记宿主计时器（`game.setTimer`），返回序号 */
  setTimer(callback: scriptCallback, Ms: number): number
  cancelTimer(seq: number): void
  /** `game.logs` / `console.*` 的落点 */
  log(text: string, level: string): void
}

export interface sandboxOptions {
  log: (text: string, level: string) => void
  /** 出错回报（引擎据此写日志 + 连续出错停用） */
  reportError: (error: string) => void
  /** 单次回调允许的同步执行时间 */
  callbackTimeoutMs: number
  /** 回调返回 Promise 时的看门狗 */
  asyncTimeoutMs: number
}

const maxSetTimerMs = 3_600_000

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clamp(value: number, min: number, limit: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(limit, Math.max(min, Math.trunc(value)))
}

/** 派发入口。定义在沙箱里，宿主只负责 `runInContext('__dispatch(...)')` */
const dispatchEntrySource = `
globalThis.__dispatch = function (index, dataJson) {
  const callback = globalThis.__hook[index]
  if (typeof callback !== 'function') return undefined
  return callback(globalThis.game, JSON.parse(dataJson))
}
globalThis.__dispatchTimer = function (seq) {
  const callback = globalThis.__timerCallback[seq]
  globalThis.__timerCallback[seq] = null
  if (typeof callback !== 'function') return undefined
  return callback(globalThis.game)
}
`

export class ScriptSandbox {
  readonly host: sandboxHost

  private readonly options: sandboxOptions
  private context: ReturnType<typeof vm.createContext> | null = null
  /** 事件名 → 钩子索引（一个事件可以挂多个） */
  private readonly eventTable = new Map<string, number[]>()
  private readonly hook: (scriptCallback | undefined)[] = []
  private readonly timerCallback: (scriptCallback | undefined)[] = []
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  private nextHook = 0
  private nextTimer = 0

  constructor(options: sandboxOptions) {
    this.options = options
    this.host = {
      registerHook: (events, callback) => {
        const index = this.nextHook
        this.nextHook += 1
        this.hook[index] = callback
        this.eventTable.set(events, [...(this.eventTable.get(events) ?? []), index])
        return index
      },
      setTimer: (callback, Ms) => {
        const seq = this.nextTimer
        this.nextTimer += 1
        this.timerCallback[seq] = callback
        const timers = setTimeout(() => {
          this.timers.delete(seq)
          this.runTimer(seq)
        }, clamp(Ms, 0, maxSetTimerMs))
        this.timers.set(seq, timers)
        return seq
      },
      cancelTimer: (seq) => {
        const timers = this.timers.get(seq)
        if (timers !== undefined) clearTimeout(timers)
        this.timers.delete(seq)
        this.timerCallback[seq] = undefined
      },
      log: (text, level) => this.options.log(text, level),
    }
  }

  /** 建一个新 realm 并把 `游戏` 注进去。**会丢弃旧 realm**（旧钩子里捕获的东西全部作废） */
  createContext(game: unknown): void {
    this.clearHooks()
    const console = {
      log: (...params: unknown[]) => this.logToConsole(params, 'info'),
      info: (...params: unknown[]) => this.logToConsole(params, 'info'),
      warn: (...params: unknown[]) => this.logToConsole(params, 'warn'),
      error: (...params: unknown[]) => this.logToConsole(params, 'error'),
      debug: (...params: unknown[]) => this.logToConsole(params, 'info'),
    }
    const context = vm.createContext({
      game,
      console: console,
      // 这两个数组是宿主侧的引用：脚本回调登记进来，宿主这边立刻就能看见
      __hook: this.hook,
      __timerCallback: this.timerCallback,
    })
    this.context = context
    vm.runInContext(dispatchEntrySource, context)
  }

  /** 只编译不执行。语法错会抛（带文件名与行号），由调用方接手 */
  compile(source: string, fileName: string): vm.Script {
    return new vm.Script(source, { filename: fileName })
  }

  runTopLevel(script: vm.Script, timeoutMs: number): void {
    const context = this.context
    if (context === null) throw new Error('沙箱还没建上下文')
    script.runInContext(context, { timeout: timeoutMs })
  }

  /** 把一次事件派给所有钩了它的回调。同步死循环由 `timeout` 断，异步回调看门狗计时 */
  async dispatchEvent(events: string, dataJson: string): Promise<void> {
    const indices = this.eventTable.get(events)
    if (indices === undefined) return
    for (const index of indices) {
      let result: unknown
      try {
        result = this.runSnippet(`__dispatch(${index}, ${JSON.stringify(dataJson)})`)
      } catch (error) {
        this.options.reportError(getMessage(error))
        continue
      }
      if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
        try {
          await this.awaitAsync(result as PromiseLike<unknown>)
        } catch (error) {
          this.options.reportError(getMessage(error))
        }
      }
    }
  }

  /** 丢弃全部钩子与定时器（重载 / 停止时用）。上下文由下一次 `新建上下文` 换掉 */
  clearHooks(): void {
    for (const timers of this.timers.values()) clearTimeout(timers)
    this.timers.clear()
    this.eventTable.clear()
    this.hook.length = 0
    this.timerCallback.length = 0
    this.nextHook = 0
    this.nextTimer = 0
  }

  destroy(): void {
    this.clearHooks()
    this.context = null
  }

  // ---------------------------------------------------------------- 内部

  private runTimer(seq: number): void {
    try {
      const result = this.runSnippet(`__dispatchTimer(${seq})`)
      if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
        void this.awaitAsync(result as PromiseLike<unknown>).catch((error: unknown) => {
          this.options.reportError(getMessage(error))
        })
      }
    } catch (error) {
      this.options.reportError(getMessage(error))
    }
  }

  private runSnippet(source: string): unknown {
    const context = this.context
    if (context === null) return undefined
    return vm.runInContext(source, context, { timeout: this.options.callbackTimeoutMs })
  }

  private awaitAsync(value: PromiseLike<unknown>): Promise<void> {
    return new Promise<void>((settle, reject) => {
      const setTimer = setTimeout(() => {
        reject(new Error(`异步回调超过 ${this.options.asyncTimeoutMs}ms 没结束`))
      }, this.options.asyncTimeoutMs)
      Promise.resolve(value).then(
        () => {
          clearTimeout(setTimer)
          settle()
        },
        (error: unknown) => {
          clearTimeout(setTimer)
          reject(error)
        },
      )
    })
  }

  private logToConsole(params: unknown[], level: string): void {
    this.options.log(
      params
        .map((item) => {
          if (typeof item === 'string') return item
          try {
            return JSON.stringify(item)
          } catch {
            return String(item)
          }
        })
        .join(' '),
      level,
    )
  }
}