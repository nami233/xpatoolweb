/**
 * 槽位的运行日志环形缓冲。
 *
 * 移植自 `src/stores/session.ts:82-171`，去掉 Vue 的 `ref`（服务端没有响应式），
 * 改成「数组 + 单调递增序号」：连接侧只要记住「已经发到哪个号」，就能算出增量，
 * 订阅时把游标回退到「最近 300 条」的第一条即可补发。
 */
import type { LogLevel, LogEntry } from '../../shared/protocol/states.ts'

/** 订阅某个槽位日志时先补发的条数（与前端 `MAX_LOG_ITEMS` 一致） */
export const logBackfillCount = 300

export class logRing {
  private readonly entries: LogEntry[] = []
  private nextId = 1
  private readonly limit: number
  private readonly slotId: number
  private readonly getAccount: () => string

  // 不用构造函数参数属性：Node 的类型剥离是 strip-only，遇到就报错
  constructor(slotId: number, limit: number, getAccount: () => string) {
    this.slotId = slotId
    this.limit = Math.max(1, limit)
    this.getAccount = getAccount
  }

  get latestId(): number {
    return this.nextId - 1
  }

  push(text: string, level: LogLevel = 'info'): void {
    this.entries.push({
      id: this.nextId++,
      time: Date.now(),
      level,
      slot: this.slotId,
      account: this.getAccount(),
      text,
    })
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
  }

  /** 取出 `id > 已发号` 的日志 */
  takeFrom(issuedId: number): LogEntry[] {
    return this.entries.filter((item) => item.id > issuedId)
  }

  /** 同上但只数个数，给「还有没有待发」的快速判断用（避免每 40ms 都分配一个数组） */
  pendingCount(issuedId: number): number {
    let count = 0
    for (const item of this.entries) if (item.id > issuedId) count += 1
    return count
  }

  /** 订阅时用来把游标回退到「最近 N 条」 */
  resendStart(): number {
    return Math.max(0, this.latestId - logBackfillCount)
  }

  clear(): void {
    this.entries.length = 0
  }
}