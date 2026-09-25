/**
 * 后端服务入口。
 *
 * 只有一个协议：首条必须是文本 JSON 且顶层有 `t`（`ws/server` 会要求它是 `认证`）。
 * 旧桥接那套「TCP 原始字节透传 + `type` 控制指令」已经删掉了，所以首条不合法就直接拒掉，
 * 不再有「判定之后这条连接固定走哪套」的分流。
 *
 * 启动：npm run server
 */
import { WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import { config, log, verifySafeDefaults } from './config.ts'
import { TenantRegistry } from './tenant/registry.ts'
import { UserStore } from './user/store.ts'
import { ScriptStore } from './user/scriptStore.ts'
import { sessionHolder } from './user/session.ts'
import { JsonServer } from './ws/server.ts'
import { readTextFrame } from './ws/protocol.ts'

verifySafeDefaults()

const Registry = new TenantRegistry()
const user = new UserStore()
// 用户数据读不动就直接退出（见 用户存储.载入），不能装作空库往下跑
await user.load()
// 脚本读不动只警告当空库（见 脚本存储.载入），不会拖垮进程
const script = new ScriptStore()
await script.load()
const jsonServer = new JsonServer(Registry, user, new sessionHolder(user), script)

const wss = new WebSocketServer({ host: config.wsHost, port: config.wsPort })

wss.on('listening', () => {
  const mode = config.token.length > 0 ? '已启用令牌校验' : '无令牌（仅本机开发）'
  log(`后端服务已启动: ws://${config.wsHost}:${config.wsPort}（${mode}）`)
})

wss.on('error', (error: Error) => {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') {
    log(
      `后端服务启动失败: 端口 ${config.wsPort} 已被占用。`
        + '是不是已经开着一个 `npm run server`？先关掉再启动。',
    )
    return
  }
  log('后端服务错误:', error.message)
})

wss.on('connection', (ws, request) => {
  const peer = `${request.socket.remoteAddress}:${request.socket.remotePort}`
  // `once` 会先解绑自己再回调，所以判定完这条消息也能原样交给接管方处理
  ws.once('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      log(`断开连接 (${peer}): 首条消息必须是文本的 JSON`)
      ws.close(4001, '首条消息必须是文本的 JSON')
      return
    }
    const rawText = readTextFrame(data)
    if (rawText === null) {
      log(`断开连接 (${peer}): 首条消息读不出文本`)
      ws.close(4001, '首条消息读不出文本')
      return
    }
    let isJsonProtocol = false
    try {
      const value: unknown = JSON.parse(rawText)
      isJsonProtocol =
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).t === 'string'
    } catch {
      isJsonProtocol = false
    }
    if (!isJsonProtocol) {
      log(`断开连接 (${peer}): 首条消息不是本后端的协议（缺 t 字段）`)
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: '错误', message: '首条消息必须是带 t 的 JSON（先发 认证）' }))
      }
      ws.close(4001, '首条消息不是本后端的协议')
      return
    }
    jsonServer.takeOver(ws, request, data)
  })
})

let closed = false
const close = (signal: string): void => {
  if (closed) return
  closed = true
  log(`收到 ${signal}，正在关闭后端服务…`)
  jsonServer.closeAll()
  for (const ws of wss.clients) ws.close()
  Registry.destroy()
  wss.close(() => process.exit(0))
  // 万一有客户端不应答关闭帧，别让进程一直挂着
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => close('SIGINT'))
process.on('SIGTERM', () => close('SIGTERM'))