import { FrameSplitter, encodeFrame } from './frame.ts'
import type { Frame } from './frame.ts'
import { cmdName } from './cmds.ts'
// 用相对路径 + 显式 .ts：Node 的类型剥离不认识 Vite 的 `@/` 别名，也不改写说明符
import { errorMessage } from '../../src/data/names.ts'

const UPSN_START = 100
const RPC_TIMEOUT_MS = 15_000
const DEFAULT_VER: [number, number, number] = [1, 0, 0]

export type FrameDirection = 'send' | 'recv'

export type PushHandler = (frame: Frame) => void

interface PendingCall {
  cmdId: number
  resolve: (frame: Frame) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface RpcClientOptions {
  sendBytes: (bytes: Uint8Array) => void
  onFrame?: (direction: FrameDirection, frame: Frame) => void
  onError?: (message: string) => void
  timeoutMs?: number
}

export class RpcClient {
  private readonly splitter = new FrameSplitter()
  private readonly pending = new Map<string, PendingCall>()
  private readonly pushHandlers = new Map<number, Set<PushHandler>>()
  private readonly anyPushHandlers = new Set<PushHandler>()

  private upsn = UPSN_START
  private sessionId = 0n

  private readonly options: RpcClientOptions

  // 不用构造函数参数属性（`constructor(private readonly options)`）：
  // Node 的类型剥离是 strip-only，遇到参数属性会直接报错，跑不起来。
  constructor(options: RpcClientOptions) {
    this.options = options
  }

  setSessionId(sessionId: bigint): void {
    this.sessionId = sessionId
  }

  getSessionId(): bigint {
    return this.sessionId
  }

  onPush(cmdId: number, handler: PushHandler): () => void {
    let set = this.pushHandlers.get(cmdId)
    if (!set) {
      set = new Set()
      this.pushHandlers.set(cmdId, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  onAnyPush(handler: PushHandler): () => void {
    this.anyPushHandlers.add(handler)
    return () => this.anyPushHandlers.delete(handler)
  }

  call(
    cmdId: number,
    body: Uint8Array,
    timeoutMs = this.options.timeoutMs ?? RPC_TIMEOUT_MS,
  ): Promise<Frame> {
    const upsn = this.nextUpsn()
    const frame: Frame = {
      length: body.length,
      sessionId: this.sessionId,
      cmdId,
      ver1: DEFAULT_VER[0],
      ver2: DEFAULT_VER[1],
      ver3: DEFAULT_VER[2],
      upsn,
      downsn: 0n,
      err: 0,
      body,
    }

    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(upsn.toString())
        reject(new Error(`请求超时：${cmdName(cmdId)} (SN=${upsn})`))
      }, timeoutMs)

      this.pending.set(upsn.toString(), { cmdId, resolve, reject, timer })
      this.sendFrame(frame)
    })
  }

  handleChunk(chunk: Uint8Array): void {
    let frames: Frame[]
    try {
      frames = this.splitter.push(chunk)
    } catch (error) {
      this.options.onError?.(String(error))
      this.splitter.reset()
      return
    }
    for (const frame of frames) this.dispatch(frame)
  }

  dispose(): void {
    this.splitter.reset()
    for (const [key, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error(`连接已断开：${cmdName(call.cmdId)}`))
      this.pending.delete(key)
    }
    this.pushHandlers.clear()
    this.anyPushHandlers.clear()
    this.sessionId = 0n
    this.upsn = UPSN_START
  }

  private nextUpsn(): bigint {
    this.upsn += 1
    if (this.upsn >= 0x7fffffff) this.upsn = UPSN_START
    return BigInt(this.upsn)
  }

  private sendFrame(frame: Frame): void {
    this.options.onFrame?.('send', frame)
    this.options.sendBytes(encodeFrame(frame))
  }

  private dispatch(frame: Frame): void {
    this.options.onFrame?.('recv', frame)

    const call = frame.upsn === 0n ? undefined : this.pending.get(frame.upsn.toString())
    if (call) {
      clearTimeout(call.timer)
      this.pending.delete(frame.upsn.toString())
      // 服务端拒包时包体多半是空的，失败原因只有帧头这个码 —— 翻译成游戏里的原话
      if (frame.err !== 0) call.reject(new Error(errorMessage(frame.err)))
      else call.resolve(frame)
    }

    const handlers = this.pushHandlers.get(frame.cmdId)
    if (handlers) {
      for (const handler of [...handlers]) {
        try {
          handler(frame)
        } catch (error) {
          this.options.onError?.(`推送处理异常 ${cmdName(frame.cmdId)}: ${String(error)}`)
        }
      }
    }
    for (const handler of [...this.anyPushHandlers]) {
      try {
        handler(frame)
      } catch (error) {
        this.options.onError?.(`推送处理异常 ${cmdName(frame.cmdId)}: ${String(error)}`)
      }
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
