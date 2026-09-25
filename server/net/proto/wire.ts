
const WIRE_VARINT = 0
const WIRE_64BIT = 1
const WIRE_LEN = 2
const WIRE_32BIT = 5

export type FieldType =
  | 'int32'
  | 'int64'
  | 'sint32'
  | 'sint64'
  | 'uint32'
  | 'uint64'
  | 'fixed32'
  | 'fixed64'
  | 'sfixed32'
  | 'sfixed64'
  | 'float'
  | 'double'
  | 'bool'
  | 'enum'
  | 'string'
  | 'bytes'
  | 'message'

export interface FieldDef {
  no: number
  type: FieldType
  repeated?: boolean
  map?: boolean
  mapKey?: FieldType
  schema?: MessageSchema
  schemaName?: string
}

export type MessageSchema = Record<string, FieldDef>

export type DecodedMessage = Record<string, unknown>

function wireTypeOf(type: FieldType): number {
  switch (type) {
    case 'int32':
    case 'int64':
    case 'sint32':
    case 'sint64':
    case 'uint32':
    case 'uint64':
    case 'bool':
    case 'enum':
      return WIRE_VARINT
    case 'fixed64':
    case 'sfixed64':
    case 'double':
      return WIRE_64BIT
    case 'fixed32':
    case 'sfixed32':
    case 'float':
      return WIRE_32BIT
    default:
      return WIRE_LEN
  }
}

function isDefaultValue(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'int32':
    case 'sint32':
    case 'uint32':
    case 'enum':
    case 'fixed32':
    case 'sfixed32':
    case 'float':
    case 'double':
      return value === 0
    case 'int64':
    case 'sint64':
    case 'uint64':
    case 'fixed64':
    case 'sfixed64':
      return value === 0n || value === 0
    case 'bool':
      return value === false
    case 'string':
      return typeof value === 'string' && value.length === 0
    case 'bytes':
      return value instanceof Uint8Array && value.length === 0
    default:
      return false
  }
}

class ByteWriter {
  private buf = new Uint8Array(128)
  private len = 0

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + extra) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  byte(value: number): void {
    this.ensure(1)
    this.buf[this.len++] = value & 0xff
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length)
    this.buf.set(bytes, this.len)
    this.len += bytes.length
  }

  varint(value: bigint): void {
    let v = BigInt.asUintN(64, value)
    while (v > 0x7fn) {
      this.byte(Number(v & 0x7fn) | 0x80)
      v >>= 7n
    }
    this.byte(Number(v))
  }

  tag(no: number, wireType: number): void {
    this.varint(BigInt((no << 3) | wireType))
  }

  uint32(value: number): void {
    this.ensure(4)
    new DataView(this.buf.buffer).setUint32(this.len, value >>> 0, true)
    this.len += 4
  }

  int32(value: number): void {
    this.ensure(4)
    new DataView(this.buf.buffer).setInt32(this.len, value | 0, true)
    this.len += 4
  }

  float32(value: number): void {
    this.ensure(4)
    new DataView(this.buf.buffer).setFloat32(this.len, value, true)
    this.len += 4
  }

  uint64(value: bigint): void {
    this.ensure(8)
    new DataView(this.buf.buffer).setBigUint64(this.len, BigInt.asUintN(64, value), true)
    this.len += 8
  }

  int64(value: bigint): void {
    this.ensure(8)
    new DataView(this.buf.buffer).setBigInt64(this.len, BigInt.asIntN(64, value), true)
    this.len += 8
  }

  float64(value: number): void {
    this.ensure(8)
    new DataView(this.buf.buffer).setFloat64(this.len, value, true)
    this.len += 8
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

class ByteReader {
  pos = 0
  private readonly buf: Uint8Array

  constructor(buf: Uint8Array) {
    this.buf = buf
  }

  get remaining(): number {
    return this.buf.length - this.pos
  }

  byte(): number {
    return this.buf[this.pos++] ?? 0
  }

  varint(): bigint {
    let result = 0n
    let shift = 0n
    for (;;) {
      const b = this.byte()
      result |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7n
    }
    return result
  }

  lenDelimited(): Uint8Array {
    const size = Number(this.varint())
    const available = Math.max(0, Math.min(size, this.buf.length - this.pos))
    const out = this.buf.subarray(this.pos, this.pos + available)
    this.pos += available
    return out
  }

  view(length: number): DataView | null {
    if (this.pos + length > this.buf.length) {
      this.pos = this.buf.length
      return null
    }
    return new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, length)
  }

  uint32(): number {
    const view = this.view(4)
    if (!view) return 0
    this.pos += 4
    return view.getUint32(0, true)
  }

  int32(): number {
    const view = this.view(4)
    if (!view) return 0
    this.pos += 4
    return view.getInt32(0, true)
  }

  float32(): number {
    const view = this.view(4)
    if (!view) return 0
    this.pos += 4
    return view.getFloat32(0, true)
  }

  uint64(): bigint {
    const view = this.view(8)
    if (!view) return 0n
    this.pos += 8
    return view.getBigUint64(0, true)
  }

  int64(): bigint {
    const view = this.view(8)
    if (!view) return 0n
    this.pos += 8
    return view.getBigInt64(0, true)
  }

  float64(): number {
    const view = this.view(8)
    if (!view) return 0
    this.pos += 8
    return view.getFloat64(0, true)
  }

  skip(wireType: number): boolean {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint()
        return true
      case WIRE_64BIT:
        if (this.pos + 8 > this.buf.length) return false
        this.pos += 8
        return true
      case WIRE_LEN: {
        const size = Number(this.varint())
        if (!Number.isFinite(size) || size < 0 || this.pos + size > this.buf.length) return false
        this.pos += size
        return true
      }
      case WIRE_32BIT:
        if (this.pos + 4 > this.buf.length) return false
        this.pos += 4
        return true
      default:
        return false
    }
  }
}

const textDecoder = new TextDecoder('utf-8')
const textEncoder = new TextEncoder()

function unzigzag(value: bigint): bigint {
  return (value >> 1n) ^ -(value & 1n)
}

function zigzag(value: bigint): bigint {
  return (value << 1n) ^ (value >> 63n)
}

function defaultForType(type: FieldType): unknown {
  switch (type) {
    case 'int32':
    case 'sint32':
    case 'uint32':
    case 'enum':
    case 'fixed32':
    case 'sfixed32':
    case 'float':
    case 'double':
      return 0
    case 'int64':
    case 'sint64':
    case 'uint64':
    case 'fixed64':
    case 'sfixed64':
      return 0n
    case 'bool':
      return false
    case 'string':
      return ''
    case 'bytes':
      return new Uint8Array(0)
    default:
      return {}
  }
}

function fieldDefault(field: FieldDef): unknown {
  if (field.map) return {}
  if (field.repeated) return []
  return defaultForType(field.type)
}

function readValue(reader: ByteReader, type: FieldType, schema?: MessageSchema): unknown {
  switch (type) {
    case 'int32':
      return Number(BigInt.asIntN(32, reader.varint()))
    case 'sint32':
      return Number(BigInt.asIntN(32, unzigzag(reader.varint())))
    case 'uint32':
      return Number(BigInt.asUintN(32, reader.varint()))
    case 'enum':
      return Number(BigInt.asIntN(32, reader.varint()))
    case 'int64':
      return BigInt.asIntN(64, reader.varint())
    case 'sint64':
      return BigInt.asIntN(64, unzigzag(reader.varint()))
    case 'uint64':
      return BigInt.asUintN(64, reader.varint())
    case 'bool':
      return reader.varint() !== 0n
    case 'fixed32':
      return reader.uint32()
    case 'sfixed32':
      return reader.int32()
    case 'float':
      return reader.float32()
    case 'fixed64':
      return reader.uint64()
    case 'sfixed64':
      return reader.int64()
    case 'double':
      return reader.float64()
    case 'string':
      return textDecoder.decode(reader.lenDelimited())
    case 'bytes':
      return reader.lenDelimited()
    case 'message':
      return decode(schema ?? {}, reader.lenDelimited())
  }
}

function writeValue(writer: ByteWriter, type: FieldType, value: unknown, schema?: MessageSchema): void {
  switch (type) {
    case 'int32':
    case 'enum':
      writer.varint(BigInt(Math.trunc(Number(value))))
      break
    case 'sint32':
      writer.varint(zigzag(BigInt(Math.trunc(Number(value)))))
      break
    case 'uint32':
      writer.varint(BigInt.asUintN(32, BigInt(Math.trunc(Number(value)))))
      break
    case 'int64':
    case 'uint64':
      writer.varint(BigInt(value as bigint))
      break
    case 'sint64':
      writer.varint(zigzag(BigInt(value as bigint)))
      break
    case 'bool':
      writer.varint(value ? 1n : 0n)
      break
    case 'fixed32':
      writer.uint32(Number(value))
      break
    case 'sfixed32':
      writer.int32(Number(value))
      break
    case 'float':
      writer.float32(Number(value))
      break
    case 'fixed64':
      writer.uint64(BigInt(value as bigint))
      break
    case 'sfixed64':
      writer.int64(BigInt(value as bigint))
      break
    case 'double':
      writer.float64(Number(value))
      break
    case 'string': {
      const bytes = textEncoder.encode(String(value))
      writer.varint(BigInt(bytes.length))
      writer.raw(bytes)
      break
    }
    case 'bytes': {
      const bytes = value as Uint8Array
      writer.varint(BigInt(bytes.length))
      writer.raw(bytes)
      break
    }
    case 'message': {
      const bytes = encode(schema ?? {}, value as Record<string, unknown>)
      writer.varint(BigInt(bytes.length))
      writer.raw(bytes)
      break
    }
  }
}

function readMapping(entry: Uint8Array, field: FieldDef): [string, unknown] {
  const keyType = field.mapKey ?? 'string'
  const reader = new ByteReader(entry)
  let key: unknown = keyType === 'string' ? '' : defaultForType(keyType)
  let value: unknown = defaultForType(field.type)
  while (reader.remaining > 0) {
    const tag = Number(reader.varint())
    const no = tag >>> 3
    const wireType = tag & 0x7
    if (no === 1) key = readValue(reader, keyType)
    else if (no === 2) value = readValue(reader, field.type, field.schema)
    else reader.skip(wireType)
  }
  return [String(key), value]
}

function isNumberType(type: FieldType): boolean {
  return type !== 'message' && type !== 'string' && type !== 'bytes'
}

export function decode(schema: MessageSchema, bytes: Uint8Array): DecodedMessage {
  const byNo = new Map<number, [string, FieldDef]>()
  for (const [name, field] of Object.entries(schema)) byNo.set(field.no, [name, field])

  const out: DecodedMessage = {}
  for (const [name, field] of Object.entries(schema)) out[name] = fieldDefault(field)

  const reader = new ByteReader(bytes)
  while (reader.remaining > 0) {
    const tag = Number(reader.varint())
    const no = tag >>> 3
    const wireType = tag & 0x7
    const hit = byNo.get(no)
    if (!hit) {
      if (!reader.skip(wireType)) break
      continue
    }

    const [name, field] = hit
    const isPackedArray = field.repeated && isNumberType(field.type) && wireType === WIRE_LEN
    // map 字段的 field.type 是「值」的类型，但线上永远是 LEN 包一条 entry，
    // 所以不能用 wireTypeOf(field.type) 去卡它（否则 map<sfixed32,...> 会被整段跳过）。
    if (!field.map && wireTypeOf(field.type) !== wireType && !isPackedArray) {
      if (!reader.skip(wireType)) break
      continue
    }

    try {
      if (field.map) {
        const [key, value] = readMapping(reader.lenDelimited(), field)
        ;(out[name] as Record<string, unknown>)[key] = value
      } else if (isPackedArray) {
        const segment = new ByteReader(reader.lenDelimited())
        while (segment.remaining > 0) (out[name] as unknown[]).push(readValue(segment, field.type))
      } else if (field.repeated) {
        ;(out[name] as unknown[]).push(readValue(reader, field.type, field.schema))
      } else {
        out[name] = readValue(reader, field.type, field.schema)
      }
    } catch {
      break
    }
  }

  return out
}

export function encode(schema: MessageSchema, value: Record<string, unknown>): Uint8Array {
  const writer = new ByteWriter()
  for (const [name, field] of Object.entries(schema)) {
    const raw = value[name]
    if (raw === undefined || raw === null) continue

    if (field.map) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const pick = new ByteWriter()
        pick.tag(1, wireTypeOf(field.mapKey ?? 'string'))
        writeValue(pick, field.mapKey ?? 'string', key)
        pick.tag(2, wireTypeOf(field.type))
        writeValue(pick, field.type, value, field.schema)
        const bytes = pick.finish()
        writer.tag(field.no, WIRE_LEN)
        writer.varint(BigInt(bytes.length))
        writer.raw(bytes)
      }
      continue
    }

    const items = field.repeated ? (raw as unknown[]) : [raw]

    if (field.repeated && isNumberType(field.type)) {
      const element = items.filter((item) => item !== undefined && item !== null)
      if (element.length > 0) {
        const pick = new ByteWriter()
        for (const item of element) writeValue(pick, field.type, item, field.schema)
        const bytes = pick.finish()
        writer.tag(field.no, WIRE_LEN)
        writer.varint(BigInt(bytes.length))
        writer.raw(bytes)
      }
      continue
    }

    for (const item of items) {
      if (item === undefined || item === null) continue
      if (!field.repeated && isDefaultValue(field.type, item)) continue

      writer.tag(field.no, wireTypeOf(field.type))
      writeValue(writer, field.type, item, field.schema)
    }
  }
  return writer.finish()
}
