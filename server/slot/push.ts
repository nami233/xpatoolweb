/**
 * 槽位事件扇出 + 连接侧推送泵（40ms 合流 + 背压降级）。
 *
 * 槽位是服务端单例、与 WS 连接解耦，所以事件走「扇出器 → 各连接」的分发；
 * 每个连接自己一个泵：脏了才排一次定时器，到点把这一窗口内攒下的东西一次发完（尾沿必发），
 * 避免一条推送一个 JSON 帧把 WS 打爆。
 */
import type { DownMessage } from '../../shared/protocol/messages.ts'
import type { EventName, ScriptRunState } from '../../shared/protocol/states.ts'
import type { DecodedMessage } from '../../shared/protocol/jsonSafe.ts'

export type slotEvent =
  | { kind: '状态' }
  | { kind: '日志' }
  | { kind: '帧' }
  | { kind: '推送'; name: string; cmdId: number; data: DecodedMessage }
  /** 用户脚本的运行态变了（订阅 `脚本` 的连接才收得到） */
  | { kind: '脚本'; runState: ScriptRunState; detail: string }

export class Fanout {
  private readonly listener = new Set<(events: slotEvent) => void>()

  /** 返回注销函数 */
  subscribe(listen: (events: slotEvent) => void): () => void {
    this.listener.add(listen)
    return () => this.listener.delete(listen)
  }

  sent(events: slotEvent): void {
    for (const listen of [...this.listener]) {
      // 一个连接出错不能影响别的连接
      try {
        listen(events)
      } catch {
      }
    }
  }
}

export interface pumpHost {
  /** 当前 WS 发送缓冲字节数，用来判背压 */
  bufferSize(): number
  send(message: DownMessage): void
  /** 取本 tick 要发的帧批（≤300 条），返回 null 表示没有 */
  getFrameBatch(): DownMessage | null
  getLogs(): DownMessage | null
  /** 取本 tick 的其余待发消息（槽位状态 / 推送 / …） */
  getRest(): DownMessage[]
  hasPending(): boolean
  /** 连续超限后通知宿主：已被自动退订的事件 */
  degraded(unsubscribe: EventName[], message: string): void
}

/** 缓冲超过它就认为这个前端跟不上了 */
const backpressureThresholdBytes = 2 * 1024 * 1024
/** 连续这么多个 tick 超限就降级 */
const maxOverLimit = 3

export class pushPump {
  private readonly host: pumpHost
  private readonly minIntervalMs: number
  private timers: ReturnType<typeof setTimeout> | null = null
  private overLimitCount = 0

  constructor(host: pumpHost, minIntervalMs: number) {
    this.host = host
    this.minIntervalMs = Math.max(0, minIntervalMs)
  }

  /** 标脏：窗口内多次调用只排一次定时器 */
  trigger(): void {
    if (this.timers !== null) return
    this.timers = setTimeout(() => this.run(), this.minIntervalMs)
  }

  stop(): void {
    if (this.timers === null) return
    clearTimeout(this.timers)
    this.timers = null
  }

  private run(): void {
    this.timers = null
    const overLimit = this.host.bufferSize() > backpressureThresholdBytes

    if (overLimit) {
      this.overLimitCount += 1
      // 只丢帧批（体积最大、丢一点不影响业务）；日志 / 推送 / 状态是业务数据，照发
      this.host.getFrameBatch()
      for (const message of this.host.getRest()) this.host.send(message)
      if (this.overLimitCount >= maxOverLimit) {
        this.overLimitCount = 0
        this.host.degraded(['帧'], '连接积压超过 2MB，已自动停止帧推送')
      }
    } else {
      this.overLimitCount = 0
      const frameBatch = this.host.getFrameBatch()
      if (frameBatch !== null) this.host.send(frameBatch)
      const logs = this.host.getLogs()
      if (logs !== null) this.host.send(logs)
      for (const message of this.host.getRest()) this.host.send(message)
    }

    // 尾沿必发：这一窗口没发完（帧/日志超过每批上限）就再排一次
    if (this.host.hasPending()) this.trigger()
  }
}