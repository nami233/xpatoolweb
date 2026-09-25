/**
 * 会话令牌的签发 / 校验 / 吊销。
 *
 * 令牌是 32 字节随机数的十六进制串（64 字符），明文只交给浏览器，落盘只落 `sha256`。
 * TTL 是**绝对时间戳**（7 天），不是「每次用就续期」—— 恢复会话时不重发令牌，
 * 免得出现「服务端把 TTL 续了、浏览器那份却没更新」的不一致。
 */
import crypto from 'node:crypto'
import { hashToken } from './store.ts'
import type { UserStore } from './store.ts'

const ttlMs = 7 * 24 * 60 * 60 * 1000

export class sessionHolder {
  private readonly store: UserStore

  // 不用构造函数参数属性：Node 的类型剥离是 strip-only，遇到就报错
  constructor(store: UserStore) {
    this.store = store
  }

  /** 返回明文令牌（只在这一刻存在于服务端内存里，之后服务端只认得它的哈希） */
  issue(username: string): string {
    const token = crypto.randomBytes(32).toString('hex')
    this.store.writeSession(hashToken(token), { username, expiresAt: Date.now() + ttlMs })
    return token
  }

  /** 过期或不存在都返回 null（过期的顺手删掉） */
  verify(token: string): string | null {
    if (token.length === 0) return null
    const hash = hashToken(token)
    const record = this.store.getSession(hash)
    if (record === undefined) return null
    if (record.expiresAt <= Date.now()) {
      this.store.removeSession(hash)
      return null
    }
    return record.username
  }

  revoke(token: string): void {
    if (token.length === 0) return
    this.store.removeSession(hashToken(token))
  }
}