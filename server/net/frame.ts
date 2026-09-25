export const FRAME_HEADER_LEN = 35

const MAX_BODY_LEN = 8 * 1024 * 1024

export interface FrameHeader {
  length: number
  sessionId: bigint
  cmdId: number
  ver1: number
  ver2: number
  ver3: number
  upsn: bigint
  downsn: bigint
  err: number
}

export interface Frame extends FrameHeader {
  body: Uint8Array
}

export function encodeFrame(frame: Frame): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_LEN + frame.body.length)
  const view = new DataView(out.buffer)
  view.setInt32(0, frame.body.length, false)
  view.setBigInt64(4, frame.sessionId, false)
  view.setInt16(12, frame.cmdId, false)
  out[14] = frame.ver1 & 0xff
  out[15] = frame.ver2 & 0xff
  out[16] = frame.ver3 & 0xff
  view.setBigInt64(17, frame.upsn, false)
  view.setBigInt64(25, frame.downsn, false)
  view.setInt16(33, frame.err, false)
  out.set(frame.body, FRAME_HEADER_LEN)
  return out
}

export function decodeHeader(view: DataView, offset = 0): FrameHeader {
  return {
    length: view.getInt32(offset, false),
    sessionId: view.getBigInt64(offset + 4, false),
    cmdId: view.getInt16(offset + 12, false),
    ver1: view.getUint8(offset + 14),
    ver2: view.getUint8(offset + 15),
    ver3: view.getUint8(offset + 16),
    upsn: view.getBigInt64(offset + 17, false),
    downsn: view.getBigInt64(offset + 25, false),
    err: view.getInt16(offset + 33, false),
  }
}

export class FrameSplitter {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf, 0)
    merged.set(chunk, this.buf.length)
    this.buf = merged

    const frames: Frame[] = []
    while (this.buf.length >= FRAME_HEADER_LEN) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
      const header = decodeHeader(view)
      if (header.length < 0 || header.length > MAX_BODY_LEN) {
        const bad = header.length
        this.buf = new Uint8Array(0)
        throw new Error(`包头非法，LENGTH=${bad}，数据流已错位`)
      }

      const frameLen = FRAME_HEADER_LEN + header.length
      if (this.buf.length < frameLen) break

      frames.push({
        ...header,
        body: this.buf.slice(FRAME_HEADER_LEN, frameLen),
      })
      this.buf = this.buf.slice(frameLen)
    }
    return frames
  }

  reset(): void {
    this.buf = new Uint8Array(0)
  }
}
