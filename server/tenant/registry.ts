/**
 * 用户名 → 租户 → 槽位表。
 *
 * 一个用户只能看到、也只能操作自己这一桶里的槽位。槽位号在用户内单调分配
 * （从 1 开始、只增、不复用）；「指定号」是给「按持久化记录建槽」用的 —— id 就是槽位号，
 * 所以后端重启、或者用户登出再登回来，前端手里的号依然对得上。
 *
 * **引用计数**：开放注册之后，每个登录过的用户都会留一个槽位表 + N 个槽位会话
 * （日志环 500 / 帧环 2000），不回收就是稳定泄漏。`取租户` 算「取得」，`释放租户` 算「归还」。
 *
 * **归零 ≠ 立刻回收**：前端刷新 / 关标签 / 断网都会让引用归零，而槽位（到游戏服的 TCP、
 * 登录态、房间与对局）必须继续跑 —— 这是「后端可独立运行、前端随时可断连」的前提。
 * 所以归零只是**起一个保留定时器**（时长按用户配置，默认 1 小时），到点还没人连回来才销毁。
 */
import { config, log } from '../config.ts'
import { slotSession } from './slot.ts'
import type { SlotSummary } from '../../shared/protocol/messages.ts'

export interface CreateResult {
  ok: boolean
  slotId?: number
  message?: string
}

export class SlotTable {
  private readonly slots = new Map<number, slotSession>()
  /** 单调分配用的下一个号 */
  private nextId = 1
  private readonly limit: number
  /** 没有任何连接绑着时，这个桶还活多久才被回收（用户级配置，见 `users.json` 的 `retainMs`） */
  readonly retainMs: number
  private recycleTimer: ReturnType<typeof setInterval> | null = null
  private retainTimer: ReturnType<typeof setTimeout> | null = null
  /** 有多少条连接正绑在这个租户上（归零就进入保留期） */
  private refCount = 0

  constructor(limit: number, retainMs: number) {
    this.limit = Math.max(1, limit)
    this.retainMs = Math.max(1, Math.floor(retainMs))
    // 默认为 0 = 不回收：槽位要能一直挂着跑（可远程的前提）
    if (config.slotIdleMs > 0) {
      this.recycleTimer = setInterval(
        () => this.recycleIdle(),
        Math.min(config.slotIdleMs, 60_000),
      )
    }
  }

  get(Id: number): slotSession | undefined {
    return this.slots.get(Id)
  }

  addRef(): void {
    this.refCount += 1
  }

  releaseRef(): void {
    this.refCount = Math.max(0, this.refCount - 1)
  }

  get noUserBound(): boolean {
    return this.refCount === 0
  }

  /** 有人连回来了：取消还没到点的回收 */
  stopRetainTimer(): void {
    if (this.retainTimer === null) return
    clearTimeout(this.retainTimer)
    this.retainTimer = null
  }

  /**
   * 引用归零后起保留定时器，到点执行 `到期`。
   * `unref()` 是必须的：否则一个挂着的账号桶会让进程退不出去。
   */
  startRetainTimer(expiresAt: () => void): void {
    this.stopRetainTimer()
    this.retainTimer = setTimeout(expiresAt, this.retainMs)
    this.retainTimer.unref()
  }

  create(account: string, password: string, specifiedId?: number): CreateResult {
    if (this.slots.size >= this.limit) {
      return { ok: false, message: `这个用户名下的游戏账号已达上限（${this.limit}）` }
    }

    let Id: number
    if (
      specifiedId !== undefined &&
      Number.isInteger(specifiedId) &&
      specifiedId > 0 &&
      !this.slots.has(specifiedId)
    ) {
      Id = specifiedId
      // 指定号占了就跳过去，别让后面的单调分配又发出同一个号
      if (Id >= this.nextId) this.nextId = Id + 1
    } else {
      while (this.slots.has(this.nextId)) this.nextId += 1
      Id = this.nextId++
    }

    this.slots.set(Id, new slotSession(Id, account, password))
    return { ok: true, slotId: Id }
  }

  remove(Id: number): boolean {
    const session = this.slots.get(Id)
    if (session === undefined) return false
    session.destroy()
    this.slots.delete(Id)
    return true
  }

  /** 心跳回执要汇总全部槽位在飞的应答数，所以得能拿到全量会话 */
  all(): slotSession[] {
    return [...this.slots.values()]
  }

  summary(): SlotSummary[] {
    return [...this.slots.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((session) => ({ slot: session.slot, account: session.account }))
  }

  destroy(): void {
    this.stopRetainTimer()
    if (this.recycleTimer !== null) {
      clearInterval(this.recycleTimer)
      this.recycleTimer = null
    }
    for (const session of this.slots.values()) session.destroy()
    this.slots.clear()
  }

  private recycleIdle(): void {
    const now = Date.now()
    for (const [Id, session] of [...this.slots]) {
      if (now - session.lastActive < config.slotIdleMs) continue
      log(`槽位 ${Id} 闲置超过 ${config.slotIdleMs}ms，回收`)
      session.destroy()
      this.slots.delete(Id)
    }
  }
}

export class TenantRegistry {
  private readonly bucket = new Map<string, SlotTable>()

  /** 取得（必要时创建）租户的槽位表，并把引用计数 +1。用完必须 `释放租户` */
  getTenant(tenant: string, retainMs: number): SlotTable {
    let table = this.bucket.get(tenant)
    if (table === undefined) {
      table = new SlotTable(config.accountLimit, retainMs)
      this.bucket.set(tenant, table)
    } else {
      // 还在保留期里被连回来了：撤销回收。保留时长以建表时那份为准
      table.stopRetainTimer()
    }
    table.addRef()
    return table
  }

  /**
   * 归还引用。归零**不销毁**，只起保留定时器 —— 前端刷新 / 关标签会让引用归零，
   * 但槽位里的游戏 TCP 与对局要照常跑，等前端连回来或保留期结束。
   */
  releaseTenant(tenant: string): void {
    const table = this.bucket.get(tenant)
    if (table === undefined) return
    table.releaseRef()
    if (!table.noUserBound) return
    table.startRetainTimer(() => {
      // 保留期里可能已经有人连回来了（那时定时器已被 `取租户` 停掉，这里是双保险）
      if (this.bucket.get(tenant) !== table) return
      if (!table.noUserBound) return
      table.destroy()
      this.bucket.delete(tenant)
      log(`租户 ${tenant} 已无连接超过 ${table.retainMs}ms，回收槽位表`)
    })
  }

  destroy(): void {
    for (const table of this.bucket.values()) table.destroy()
    this.bucket.clear()
  }
}