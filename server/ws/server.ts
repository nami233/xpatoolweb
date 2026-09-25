/**
 * JSON 协议侧的握手与连接表。
 *
 * 鉴权分两段：
 *   1. **连接级门禁**：首条必须是 `认证`，只校验 `XPA_TOKEN`（空则放行），回 `认证结果`。
 *   2. **用户级绑定**：`用户登录` / `注册` 校验口令后绑定租户 `u-<用户名>`，回 `用户结果`。
 *
 * 不变式加强为：**认证 + 已绑定用户** 之前不落地任何槽位（`连接.槽位表` 一直是 null）。
 *
 * 令牌来源按 `认证.令牌` → query `?令牌=` → 头 `x-xpa-token` 的顺序找。
 */
import type { IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import { config, log } from '../config.ts'
import { CMD_NAMES } from '../net/proto/generated/cmds.gen.ts'
import type {
  RegisterUp,
  UserLoginUp,
  LogoutUp,
  AddGameAccountUp,
  RemoveGameAccountUp,
  DownMessage,
} from '../../shared/protocol/messages.ts'
import type { UserStore } from '../user/store.ts'
import type { sessionHolder } from '../user/session.ts'
import type { ScriptStore } from '../user/scriptStore.ts'
import { makePasswordHash, verifyPassword } from '../user/password.ts'
import { connection } from './connection.ts'
import { parseUpMessage, readTextFrame } from './protocol.ts'
import type { TenantRegistry } from '../tenant/registry.ts'

/** `命令表` 是「号 → 名」的字符串键 Record，前端拿它反推 `CMD_OF` */
const commandTable: Record<string, string> = {}
for (const [Id, name] of Object.entries(CMD_NAMES)) commandTable[Id] = name

function checkUsername(username: string): string | null {
  if (username.length === 0) return '用户名不能为空'
  if (username.length > 32) return '用户名最长 32 个字符'
  if (/\s/.test(username)) return '用户名里不能有空白字符'
  return null
}

function checkPassword(password: string): string | null {
  if (password.length === 0) return '密码不能为空'
  if (password.length > 128) return '密码最长 128 个字符'
  return null
}

function tokenFromUrl(request: IncomingMessage): string | undefined {
  const rawText = request.url
  if (rawText === undefined) return undefined
  const questionMark = rawText.indexOf('?')
  if (questionMark < 0) return undefined
  const search = new URLSearchParams(rawText.slice(questionMark + 1))
  return search.get('令牌') ?? undefined
}

function tokenFromHead(request: IncomingMessage): string | undefined {
  const value = request.headers['x-xpa-token']
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

export class JsonServer {
  private readonly Registry: TenantRegistry
  private readonly user: UserStore
  private readonly session: sessionHolder
  private readonly script: ScriptStore
  private readonly connections = new Set<connection>()

  constructor(Registry: TenantRegistry, user: UserStore, session: sessionHolder, script: ScriptStore) {
    this.Registry = Registry
    this.user = user
    this.session = session
    this.script = script
  }

  /** 认证通过后才有资格接管这条连接；`首条` 是 `index.ts` 判模式时取走的那条 */
  takeOver(ws: WebSocket, request: IncomingMessage, firstItem: RawData): void {
    const peer = `${request.socket.remoteAddress}:${request.socket.remotePort}`
    log(`前端已连接（JSON 协议）: ${peer}`)

    const conn = new connection(ws, config, this.Registry, this.script, () => this.connections.delete(conn))
    this.connections.add(conn)

    const reply = (message: DownMessage): void => {
      conn.send(message)
    }

    /** 协议级错误：回一条 `错误` 再断开（不回执，因为没有可对应的请求号） */
    const disconnect = (detail: string): void => {
      log(`断开连接 (${peer}): ${detail}`)
      reply({ t: '错误', message: detail })
      ws.close(4001, detail)
      conn.destroy()
    }

    const rawText = readTextFrame(firstItem)
    if (rawText === null) {
      disconnect('首条消息必须是文本的 JSON')
      return
    }
    const parse = parseUpMessage(rawText)
    if (!parse.ok) {
      disconnect(parse.error)
      return
    }
    if (parse.message.t !== '认证') {
      disconnect('首条消息必须是 认证')
      return
    }

    const fixed = this.verifyGate(request, parse.message.token)
    if (!fixed.ok) {
      reply({ t: '认证结果', ok: false, commandTable: {}, message: fixed.reject })
      ws.close(4001, fixed.reject)
      conn.destroy()
      return
    }

    reply({ t: '认证结果', ok: true, commandTable })
    log(`连接已通过门禁: ${peer}`)

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        disconnect('认证之后的消息必须是文本 JSON')
        return
      }
      const rawUpText = readTextFrame(data)
      if (rawUpText === null) return
      const result = parseUpMessage(rawUpText)
      if (!result.ok) {
        reply({ t: '错误', message: result.error })
        return
      }
      const message = result.message
      if (message.t === '认证') {
        reply({ t: '错误', message: '这条连接已经认证过了' })
        return
      }
      // 碰落盘与会话的那几条要由服务器自己办；其余进连接的分派
      if (
        message.t === '注册'
        || message.t === '用户登录'
        || message.t === '登出'
        || message.t === '加游戏账号'
        || message.t === '删游戏账号'
      ) {
        void this.handleUser(conn, message)
        return
      }
      conn.handle(message)
    })

    ws.on('close', () => {
      log(`前端已断开: ${peer}`)
      conn.destroy()
    })

    ws.on('error', (error: Error) => {
      log(`WebSocket 错误 (${peer}):`, error.message)
      conn.destroy()
    })
  }

  /** 关掉全部连接（进程退出时用） */
  closeAll(): void {
    for (const conn of [...this.connections]) conn.destroy()
    this.connections.clear()
  }

  /** 连接级门禁：只认部署令牌，跟「是谁」无关（用户身份走 `用户登录`/`注册`） */
  private verifyGate(
    request: IncomingMessage,
    authToken: string | undefined,
  ): { ok: true } | { ok: false; reject: string } {
    if (config.token.length === 0) return { ok: true }
    const candidates = authToken ?? tokenFromUrl(request) ?? tokenFromHead(request)
    if (candidates === undefined || candidates.length === 0) return { ok: false, reject: '缺少令牌' }
    if (candidates !== config.token) return { ok: false, reject: '令牌不对' }
    return { ok: true }
  }

  // ---------------------------------------------------------------- 用户级

  private async handleUser(
    conn: connection,
    message: RegisterUp | UserLoginUp | LogoutUp | AddGameAccountUp | RemoveGameAccountUp,
  ): Promise<void> {
    try {
      if (message.t === '注册') return await this.handleRegister(conn, message)
      if (message.t === '用户登录') return await this.handleUserLogin(conn, message)
      if (message.t === '加游戏账号') return this.handleAddGameAccount(conn, message)
      if (message.t === '删游戏账号') return this.handleRemoveGameAccount(conn, message)
      this.handleLogout(conn, message)
    } catch (error) {
      conn.send({ t: '错误', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * 加游戏账号（覆盖式 upsert：同账号 = 改密码）。上限卡在这里，登录时按持久化记录建槽
   * 就不会撞上 `槽位表` 自己的「每租户 N 槽」上限。
   *
   * 已存在的那个号要**重建**槽位会话：槽位的账号/密码是建会话时拷进去的，
   * 不重建的话新密码只在文件里，登录还是用旧的（凭据也是缓存的 sid）。
   * 这件事由 `确保槽位` 按凭据指纹判断（指纹一致就复用，不一致才同号重建）。
   */
  private handleAddGameAccount(conn: connection, message: AddGameAccountUp): void {
    const username = conn.username
    if (username.length === 0) {
      this.sendAck(conn, { reqId: message.reqId, ok: false, message: '先登录再添加游戏账号' })
      return
    }
    const result = this.user.addGameAccount(username, message.account, message.password)
    const record = result.record
    if (!result.ok || record === undefined) {
      this.sendAck(conn, { reqId: message.reqId, ok: false, message: result.message ?? '添加游戏账号失败' })
      return
    }
    // 改密码时账号密码指纹变了，`确保槽位` 会自己同号重建；已存在的旧会话不动
    if (!conn.ensureSlot(record.id, record.account, record.password)) {
      log(`用户 ${username} 的游戏账号 ${record.id} 落盘了但建槽失败`)
      this.sendAck(conn, { reqId: message.reqId, ok: false, message: '这个游戏账号没建成槽位，重登一次试试' })
      return
    }
    this.sendAck(conn, { reqId: message.reqId, ok: true, slot: record.id })
  }

  private handleRemoveGameAccount(conn: connection, message: RemoveGameAccountUp): void {
    const username = conn.username
    if (username.length === 0) {
      this.sendAck(conn, { reqId: message.reqId, ok: false, message: '先登录再删除游戏账号' })
      return
    }
    const ok = this.user.removeGameAccount(username, message.slot)
    if (!ok) {
      this.sendAck(conn, { reqId: message.reqId, ok: false, slot: message.slot, message: '没有这个游戏账号' })
      return
    }
    conn.removeSlot(message.slot)
    // 槽位号就是游戏账号 id，删账号时把它名下的脚本一起清掉，别留孤儿
    this.script.remove(username, message.slot)
    this.sendAck(conn, { reqId: message.reqId, ok: true, slot: message.slot })
  }

  private async handleRegister(conn: connection, message: RegisterUp): Promise<void> {
    const reqId = message.reqId
    if (!config.allowRegister) {
      this.sendUserResult(conn, { reqId, ok: false, message: '这个后端没有开放自助注册' })
      return
    }
    const username = message.username.trim()
    const invalid = checkUsername(username) ?? checkPassword(message.password)
    if (invalid !== null) {
      this.sendUserResult(conn, { reqId, ok: false, message: invalid })
      return
    }
    if (this.user.getUser(username) !== undefined) {
      this.sendUserResult(conn, { reqId, ok: false, message: '这个用户名已经被注册了' })
      return
    }
    this.user.createUser(username, await makePasswordHash(message.password))
    const token = this.session.issue(username)
    this.bind(conn, username, token)
    this.sendUserResult(conn, { reqId, ok: true, username, sessionToken: token })
    log(`新用户已注册并登录: ${username}`)
  }

  private async handleUserLogin(conn: connection, message: UserLoginUp): Promise<void> {
    const reqId = message.reqId

    // 恢复会话：只认令牌，不重发令牌（服务端 TTL 是绝对时间戳，重发只会引入不一致）
    if (message.token !== undefined) {
      const username = this.session.verify(message.token)
      if (username === null) {
        this.sendUserResult(conn, { reqId, ok: false, message: '会话已过期，请重新登录' })
        return
      }
      this.bind(conn, username, message.token)
      this.sendUserResult(conn, { reqId, ok: true, username })
      return
    }

    const username = (message.username ?? '').trim()
    const password = message.password ?? ''
    const record = this.user.getUser(username)
    // 用户名不存在和口令不对回同一句话，别让撞库的人拿它当用户名探测器
    if (record === undefined || !(await verifyPassword(password, record.passwordHash))) {
      this.sendUserResult(conn, { reqId, ok: false, message: '用户名或密码不对' })
      return
    }
    const token = this.session.issue(username)
    this.bind(conn, username, token)
    this.sendUserResult(conn, { reqId, ok: true, username, sessionToken: token })
    log(`用户已登录: ${username}`)
  }

  private handleLogout(conn: connection, message: LogoutUp): void {
    this.session.revoke(conn.sessionToken)
    const username = conn.username
    conn.unbindUser()
    this.sendUserResult(conn, { reqId: message.reqId, ok: true })
    if (username.length > 0) log(`用户已登出: ${username}`)
  }

  /**
   * 绑定用户并把它的游戏账号逐条对成槽位会话：**槽位号就是持久化记录里的 id**，
   * 所以后端重启、或者刷新 / 登出再登回来，前端手里的号依然对得上。
   *
   * 用 `确保槽位` 而不是 `建槽位`：槽位表可能还在保留期里活着（断线重连 / 刷新回来），
   * 幂等复用才不会把同一个游戏账号建成两条。
   */
  private bind(conn: connection, username: string, token: string): void {
    conn.bindUser(username, token, this.user.getRetainMs(username))
    const record = this.user.getUser(username)
    if (record === undefined) return
    for (const item of [...record.gameAccounts].sort((a, b) => a.id - b.id)) {
      if (conn.ensureSlot(item.id, item.account, item.password)) continue
      log(`用户 ${username} 的游戏账号 ${item.id} 建槽失败（超过账号上限 ${config.accountLimit}？）`)
    }
  }

  /** 加 / 删游戏账号的回执：顺手带上完整列表，前端不必再问一次 */
  private sendAck(
    conn: connection,
    result: { reqId: number; ok: boolean; slot?: number; message?: string },
  ): void {
    conn.send({
      t: '回执',
      reqId: result.reqId,
      ok: result.ok,
      slot: result.slot,
      gameAccounts: conn.slotList(),
      message: result.message,
    })
  }

  private sendUserResult(
    conn: connection,
    result: {
      reqId: number
      ok: boolean
      username?: string
      sessionToken?: string
      message?: string
    },
  ): void {
    conn.send({
      t: '用户结果',
      reqId: result.reqId,
      ok: result.ok,
      username: result.username ?? '',
      sessionToken: result.sessionToken,
      gameAccounts: result.ok ? conn.slotList() : undefined,
      message: result.message,
    })
  }
}