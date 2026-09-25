import type { FieldType, MessageSchema } from './wire.ts'

const is64Bit = (type: FieldType): boolean =>
  type === 'int64' ||
  type === 'uint64' ||
  type === 'sint64' ||
  type === 'fixed64' ||
  type === 'sfixed64'

function hexToBytes(text: string): Uint8Array {
  const cleaned = text.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '')
  if (cleaned.length % 2 !== 0) throw new Error(`bytes 的十六进制长度必须是偶数：${text}`)
  const result = new Uint8Array(cleaned.length / 2)
  for (let i = 0; i < result.length; i += 1) result[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16)
  return result
}

function singleValue(type: FieldType, schema: MessageSchema | undefined, value: unknown): unknown {
  switch (type) {
    case 'message':
      return fromJson(schema ?? {}, (value ?? {}) as Record<string, unknown>)
    case 'bytes':
      return typeof value === 'string' ? hexToBytes(value) : (value as Uint8Array)
    case 'bool':
      return Boolean(value)
    case 'string':
      return String(value)
    default:
      if (is64Bit(type)) {
        if (typeof value === 'bigint') return value
        return BigInt(typeof value === 'string' ? value.trim() : Math.trunc(Number(value)))
      }
      return Number(value)
  }
}

export function fromJson(
  schema: MessageSchema,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(schema)) {
    const rawValue = input[name]
    if (rawValue === undefined || rawValue === null) continue

    if (field.map) {
      const table = rawValue as Record<string, unknown>
      const converted: Record<string, unknown> = {}
      for (const [key, itemValue] of Object.entries(table)) converted[key] = singleValue(field.type, field.schema, itemValue)
      out[name] = converted
      continue
    }

    if (field.repeated) {
      const array = Array.isArray(rawValue) ? rawValue : [rawValue]
      out[name] = array.map((item) => singleValue(field.type, field.schema, item))
      continue
    }

    out[name] = singleValue(field.type, field.schema, rawValue)
  }
  return out
}

export function findUnknownFields(schema: MessageSchema, input: Record<string, unknown>): string[] {
  return Object.keys(input).filter((key) => !(key in schema))
}
