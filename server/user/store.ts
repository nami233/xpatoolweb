/**
 * xpatoolweb 用户 + 游戏账号的落盘（单文件 `users.json`，见 `配置.数据目录`）。
 *
 * ```
 * { version: 1,
 *   user: { [username]: { username, passwordHash, createdAt, retainMs?, gameAccounts: [{ id, account, password }] } },
 *   session: { [sha256(会话令牌)]: { username, expiresAt } } }
 * ```
 *
 * `retainMs` 是给手改的：没有任何前端连着时，这个用户的账号桶保留多久才回收。
 * 没有这个字段就回落 `config.slotRetainMs`。因为用户记录是整份读进内存、整份写回，
 * 手改的值不会在落盘时被抹掉。
 *
 * 两条硬规矩：
 *  - **原子写**：先写 `users.json.tmp` 再 `rename`，中途断电不会留下半个文件。
 *  - **串行化**：所有落盘排一条 Promise 队列，并发请求不会互相覆盖。
 *
 * 会话令牌的明文只留在浏览器，这里只落 sha256；而且会话放在**独立顶级字段**、不塞进用户记录
 * —— 每加一个游戏账号都要重写用户记录，放一起会让每次加账号都顺带重写一遍会话表。
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, log } from '../config.ts'

export interface GameAccountRecord {
  /**
   * 用户内自增、不复用的正整数。**它同时就是槽位号** —— 这样「同号恢复」天然成立，
   * `protocol.ts` 里「槽位是正整数」那条约束也不用改。
   */
  id: number
  account: string
  password: string
}

export interface UserRecord {
  username: string
  /** `scrypt$<盐hex>$<哈希hex>`，见 `password.ts` */
  passwordHash: string
  createdAt: number
  /** 手改项：这个用户的账号桶断连后保留多久（毫秒）。缺省回落 `config.slotRetainMs` */
  retainMs?: number
  gameAccounts: GameAccountRecord[]
}

export interface SessionRecord {
  username: string
  expiresAt: number
}

interface PersistedData {
  version: number
  user: Record<string, UserRecord>
  session: Record<string, SessionRecord>
}

const structVersion = 1

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

export interface AddGameAccountResult {
  ok: boolean
  record?: GameAccountRecord
  message?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function collectGameAccountTable(value: unknown): GameAccountRecord[] {
  if (!Array.isArray(value)) return []
  const out: GameAccountRecord[] = []
  for (const item of value) {
    if (!isObject(item)) continue
    const id = item.id
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue
    if (typeof item.account !== 'string' || typeof item.password !== 'string') continue
    out.push({ id, account: item.account, password: item.password })
  }
  return out
}

function collectUserTable(value: unknown): Record<string, UserRecord> {
  const out: Record<string, UserRecord> = {}
  if (!isObject(value)) return out
  for (const [username, item] of Object.entries(value)) {
    if (!isObject(item)) continue
    if (typeof item.passwordHash !== 'string' || item.passwordHash.length === 0) continue
    out[username] = {
      username,
      passwordHash: item.passwordHash,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      // 手写的值可能是个负数 / NaN / 字符串，收不下就当没写
      retainMs:
        typeof item.retainMs === 'number' && Number.isFinite(item.retainMs) && item.retainMs > 0
          ? item.retainMs
          : undefined,
      gameAccounts: collectGameAccountTable(item.gameAccounts),
    }
  }
  return out
}

function collectSessionTable(value: unknown): Record<string, SessionRecord> {
  const out: Record<string, SessionRecord> = {}
  if (!isObject(value)) return out
  for (const [hash, item] of Object.entries(value)) {
    if (!isObject(item)) continue
    if (typeof item.username !== 'string' || typeof item.expiresAt !== 'number') continue
    out[hash] = { username: item.username, expiresAt: item.expiresAt }
  }
  return out
}

export class UserStore {
  readonly file: string
  private data: PersistedData = { version: structVersion, user: {}, session: {} }
  private writeQueue: Promise<void> = Promise.resolve()

  constructor() {
    this.file = path.join(config.dataDir, 'users.json')
  }

  /**
   * 启动时读一次。文件不在 = 空库；**存在却读不动就直接退出** ——
   * 装作空库继续跑的话，下一次落盘就把用户数据洗掉了。
   */
  async load(): Promise<void> {
    let rawText: string
    try {
      rawText = await fsp.readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      log(`读不了用户数据文件 ${this.file}:`, error instanceof Error ? error.message : error)
      process.exit(1)
    }
    let parse: unknown
    try {
      parse = JSON.parse(rawText)
    } catch (error) {
      log(`用户数据文件 ${this.file} 不是合法 JSON:`, error instanceof Error ? error.message : error)
      process.exit(1)
    }
    if (!isObject(parse)) {
      log(`用户数据文件 ${this.file} 的顶层不是对象`)
      process.exit(1)
    }
    this.data = {
      version: structVersion,
      user: collectUserTable(parse.user),
      session: collectSessionTable(parse.session),
    }
    const expiresAt = this.clearExpiredSessions()
    log(
      `已载入用户数据 ${this.file}：用户 ${Object.keys(this.data.user).length} 个`
        + `，有效会话 ${Object.keys(this.data.session).length} 条`
        + (expiresAt > 0 ? `（清掉过期会话 ${expiresAt} 条）` : ''),
    )
  }

  // ---------------------------------------------------------------- 用户

  getUser(username: string): UserRecord | undefined {
    return this.data.user[username]
  }

  /** 这个用户的账号桶断连后保留多久：记录里手改的值优先，否则全局默认 */
  getRetainMs(username: string): number {
    return this.data.user[username]?.retainMs ?? config.slotRetainMs
  }

  createUser(username: string, passwordHash: string): UserRecord {
    const record: UserRecord = { username, passwordHash, createdAt: Date.now(), gameAccounts: [] }
    this.data.user[username] = record
    this.queuePersist()
    return record
  }

  /**
   * 覆盖式 upsert：同一个游戏账号再填一次就是改密码（对齐原来前端「添加账号」的行为，
   * 用户不必先删后加）。上限卡在这一步 —— 登录时按持久化记录建槽，就不会撞上
   * `槽位表` 自己的「每租户 N 槽」上限。
   */
  addGameAccount(username: string, account: string, password: string): AddGameAccountResult {
    const user = this.getUser(username)
    if (user === undefined) return { ok: false, message: '先登录再添加游戏账号' }
    const cleaned = account.trim()
    if (cleaned.length === 0) return { ok: false, message: '游戏账号不能为空' }
    if (password.length === 0) return { ok: false, message: '游戏账号密码不能为空' }

    const existing = user.gameAccounts.find((item) => item.account === cleaned)
    if (existing !== undefined) {
      existing.password = password
      this.queuePersist()
      return { ok: true, record: existing }
    }
    if (user.gameAccounts.length >= config.accountLimit) {
      return { ok: false, message: `一个用户最多 ${config.accountLimit} 个游戏账号` }
    }
    const record: GameAccountRecord = {
      id: user.gameAccounts.reduce((max, item) => Math.max(max, item.id), 0) + 1,
      account: cleaned,
      password,
    }
    user.gameAccounts.push(record)
    this.queuePersist()
    return { ok: true, record }
  }

  removeGameAccount(username: string, id: number): boolean {
    const user = this.getUser(username)
    if (user === undefined) return false
    const bit = user.gameAccounts.findIndex((item) => item.id === id)
    if (bit < 0) return false
    user.gameAccounts.splice(bit, 1)
    this.queuePersist()
    return true
  }

  // ---------------------------------------------------------------- 会话

  getSession(hash: string): SessionRecord | undefined {
    return this.data.session[hash]
  }

  writeSession(hash: string, record: SessionRecord): void {
    this.data.session[hash] = record
    this.queuePersist()
  }

  removeSession(hash: string): void {
    if (this.data.session[hash] === undefined) return
    delete this.data.session[hash]
    this.queuePersist()
  }

  /** 返回清掉的条数 */
  clearExpiredSessions(): number {
    const now = Date.now()
    let count = 0
    for (const [hash, record] of Object.entries(this.data.session)) {
      if (record.expiresAt > now) continue
      delete this.data.session[hash]
      count += 1
    }
    return count
  }

  // ---------------------------------------------------------------- 落盘

  /** 排队落盘。返回的 Promise 只用来串联队列，调用方不用等 */
  queuePersist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.persistOnce()).catch((error: unknown) => {
      log('用户数据落盘失败:', error instanceof Error ? error.message : String(error))
    })
    return this.writeQueue
  }

  private async persistOnce(): Promise<void> {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = `${this.file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    // rename 是原子的：读者要么看到旧文件，要么看到新文件，不会看到半个
    await fsp.rename(tmp, this.file)
  }
}