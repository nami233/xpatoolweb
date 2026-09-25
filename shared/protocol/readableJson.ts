/**
 * 把「解码结果」打成给人看的 JSON 文本（调试用）。
 *
 * 与 `jsonSafe.ts` 的区别：这里是**只读展示**，所以 bytes 带上 `hex:` 前缀以便一眼看出是二进制；
 * `jsonSafe.ts` 是要走 JSON 通道回传的，bytes 只能是不带前缀的裸 hex 串（否则前端 `从JSON`
 * 会把 `hex:` 当成十六进制再解一次）。
 */
export function toReadableJson(value: unknown, indent = 2): string {
  return JSON.stringify(
    value,
    (_key, rawValue) => {
      if (typeof rawValue === 'bigint') return (rawValue as bigint).toString()
      if (rawValue instanceof Uint8Array) {
        let text = ''
        for (const bytes of rawValue as Uint8Array) text += bytes.toString(16).padStart(2, '0')
        return `hex:${text}`
      }
      return rawValue
    },
    indent,
  )
}