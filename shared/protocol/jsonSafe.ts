/**
 * 解码结果 ↔ JSON 安全形态。
 *
 * 为什么需要它：协议栈解出来的东西里有 `bigint`（64 位整型）和 `Uint8Array`（bytes），
 * 这两样 `JSON.stringify` 一个会抛错、一个会变成 `{"0":1,"1":2}` 这种没法用的对象。
 *
 * 死线（前后端两侧都按这一条走，不能全量字符串化）：
 *   - `int32/uint32/sint32/fixed32/sfixed32/float/double/bool/string` **原样保留**；
 *   - **只有** 64 位整型转十进制字符串、`bytes` 转十六进制串、`map` 转普通对象。
 *
 * 为什么不能全量字符串化：组件层大量直读原始字段并做数值运算（`取数字(值.MovePoint)`、
 * `Array.isArray(...)` 探测数值数组），全变字符串会让它们失效；
 * 而保留 bigint 又过不了 JSON。两边现有的 `取数字/取字符串` helper 对
 * 「字符串化的 64 位」和「数字」都成立，所以只动 64 位是唯一安全的切法。
 */

/** 解码出来的消息（值与 `wire.ts` 的 `DecodedMessage` 同形，这里只取 JSON 无关的那部分契约） */
export type DecodedMessage = Record<string, unknown>

export function bytesToHex(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0')
  return text
}

export function hexToBytes(text: string): Uint8Array {
  const cleaned = text.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '')
  if (cleaned.length % 2 !== 0) throw new Error(`bytes 的十六进制长度必须是偶数：${text}`)
  const result = new Uint8Array(cleaned.length / 2)
  for (let i = 0; i < result.length; i += 1) result[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16)
  return result
}

/** 解码结果 → JSON 安全形态（64 位转字符串、bytes 转 hex 串） */
export function toJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  const type = typeof value
  if (type === 'bigint') return (value as bigint).toString()
  if (type === 'number' || type === 'string' || type === 'boolean') return value
  if (value instanceof Uint8Array) return bytesToHex(value)
  if (Array.isArray(value)) return value.map(toJson)
  if (type === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toJson(item)
    return out
  }
  return String(value)
}

/**
 * 「对局」补丁用的浅相等：逐字段比较，字段值本身按 JSON 文本比。
 *
 * 不用引用比较的原因：快照每次都是新造的对象，引用永远不等，会退化成「每次都全量发」。
 * 只在 `JSON化` 之后的值上用（那时没有 bigint，`JSON.stringify` 是安全的）。
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  return JSON.stringify(a) === JSON.stringify(b)
}