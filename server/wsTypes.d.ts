/**
 * `ws@8.21.3` 包里没有自带类型声明（目录里没有任何 `.d.ts`），本仓库又不新增依赖，
 * 所以在这里声明我们实际用到的那一小部分 API。
 *
 * 注意：这个文件里**不能**有顶层 import/export，否则会从「全局环境声明」变成
 * 「模块增强」，`declare module 'ws'` 就失效了（ws 本身没有可被增强的类型）。
 */
declare module 'ws' {
  import type { EventEmitter } from 'node:events'
  import type { IncomingMessage } from 'node:http'

  type RawData = Buffer | ArrayBuffer | Buffer[]

  class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0
    static readonly OPEN: 1
    static readonly CLOSING: 2
    static readonly CLOSED: 3

    readonly CONNECTING: 0
    readonly OPEN: 1
    readonly CLOSING: 2
    readonly CLOSED: 3

    readonly readyState: number
    readonly bufferedAmount: number
    readonly protocol: string
    binaryType: string

    send(data: string | Uint8Array, options?: { binary?: boolean }, cb?: (err?: Error) => void): void
    close(code?: number, reason?: string): void
    terminate(): void

    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: string | symbol, listener: (...args: never[]) => void): this
    once(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this
    once(event: string | symbol, listener: (...args: never[]) => void): this
  }

  interface WebSocketServerOptions {
    host?: string
    port?: number
    path?: string
    noServer?: boolean
    clientTracking?: boolean
    maxPayload?: number
  }

  class WebSocketServer extends EventEmitter {
    constructor(options?: WebSocketServerOptions, callback?: () => void)

    readonly clients: Set<WebSocket>

    close(cb?: (error?: Error) => void): void

    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this
    on(event: 'listening', listener: () => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: string | symbol, listener: (...args: never[]) => void): this
    once(event: string | symbol, listener: (...args: never[]) => void): this
  }

  export { WebSocket, WebSocketServer }
  export type { RawData, WebSocketServerOptions }
}