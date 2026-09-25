/**
 * xpatoolweb 用户口令的哈希与校验。
 *
 * 用**异步** `scrypt`：`scryptSync` 会阻塞事件循环 50~100ms，而后端一直挂着一个 40ms 的
 * 推送泵，一阻塞就是所有连接的状态推送集体迟到。
 *
 * 落盘格式 `scrypt$<盐hex>$<哈希hex>`：自描述，将来换算法也能认出旧格式。
 */
import crypto from 'node:crypto'

const saltBytes = 16
const hashBytes = 64

function runScrypt(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((redeem, reject) => {
    crypto.scrypt(password, salt, length, (error, derive) => {
      if (error) reject(error)
      else redeem(derive)
    })
  })
}

export async function makePasswordHash(password: string): Promise<string> {
  const salt = crypto.randomBytes(saltBytes)
  const hash = await runScrypt(password, salt, hashBytes)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export async function verifyPassword(password: string, storedPassword: string): Promise<boolean> {
  const segment = storedPassword.split('$')
  if (segment.length !== 3 || segment[0] !== 'scrypt') return false
  const salt = Buffer.from(segment[1], 'hex')
  const expected = Buffer.from(segment[2], 'hex')
  if (salt.length === 0 || expected.length === 0) return false
  const actual = await runScrypt(password, salt, expected.length)
  // 长度不等时 timingSafeEqual 会直接抛，所以先比长度
  if (actual.length !== expected.length) return false
  return crypto.timingSafeEqual(actual, expected)
}