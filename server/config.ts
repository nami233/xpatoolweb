/**
 * 后端配置：集中读全部 `XPA_*` 环境变量 + 安全默认值校验。
 *
 * 为什么不复用前端 `src/config.ts`：那边依赖 `import.meta.env`（Vite 专有），
 * Node 里加载不了；`账号上限`/`服务端地址` 这类常量两侧各写一份，改的时候一起改。
 */
import os from 'node:os'
import path from 'node:path'

/** 不带令牌也允许监听的地址（本机开发） */
const loopbackAddresses = new Set(['127.0.0.1', '::1', 'localhost'])

function readText(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value.length === 0 ? fallback : value
}

function readNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined || value.length === 0) return fallback
  const count = Number(value)
  return Number.isFinite(count) ? count : fallback
}

export const config = {
  /** 先读新名 `XPA_WS_HOST`，再回落到旧名 `XPA_BRIDGE_HOST` */
  wsHost: readText('XPA_WS_HOST', readText('XPA_BRIDGE_HOST', '127.0.0.1')),
  wsPort: readNumber('XPA_WS_PORT', readNumber('XPA_BRIDGE_PORT', 8787)),

  /** 空 = 不校验（本机开发），只当部署级门禁；用户身份一律由 用户登录/注册 决定 */
  token: readText('XPA_TOKEN', ''),

  /** 用户与游戏账号的落盘目录（`users.json` 放这里） */
  dataDir: readText('XPA_DATA_DIR', path.join(os.homedir(), '.xpatoolweb')),
  /** `XPA_ALLOW_REGISTER=0` 关掉自助注册（先发号再放人进来的部署用） */
  allowRegister: readText('XPA_ALLOW_REGISTER', '1') !== '0',

  pushMinIntervalMs: readNumber('XPA_PUSH_MIN_MS', 40),
  logRingLimit: readNumber('XPA_LOG_RING', 500),
  frameRingLimit: readNumber('XPA_FRAME_RING', 2000),
  /** 0 = 不回收槽位（默认；服务端单例要能一直挂着跑） */
  slotIdleMs: readNumber('XPA_SLOT_IDLE_MS', 0),
  /**
   * 没有任何前端连着时，账号桶还保留多久才回收（默认 1 小时）。
   * 单个用户可以在 `users.json` 里手写 `retainMs` 覆盖它（不加协议、不加 UI）。
   */
  slotRetainMs: readNumber('XPA_SLOT_RETAIN_MS', 3_600_000),

  configBase: readText(
    'XPA_CONFIG_BASE',
    'https://se-web-cn.feimogames.com:7878/api/hotaddressServer/get',
  ),
  passportBase: readText('XPA_PASSPORT_BASE', 'https://m-sdk.feimogames.com'),
  captureDir: readText('XPA_CAPTURE_DIR', path.join(os.homedir(), 'jxpd')),

  gameHost: readText('XPA_GAME_HOST', 'se-jump-cn-01.feimogames.com'),
  gamePort: readNumber('XPA_GAME_PORT', 8800),
  clientVersion: '3.2.0',

  /** 单个用户下能持久化多少条游戏账号（同时也就是槽位上限），与前端 `src/config.ts` 对齐 */
  accountLimit: 4,
}

export type BackendConfig = typeof config

/** 打时间戳日志。放在这里是因为它是服务端唯一一个「人人都会加载」的模块 */
export function log(...params: unknown[]): void {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...params)
}

/**
 * 监听在非回环地址却没配令牌 = 所有账号的会话裸奔在网上（谁连上来都能操作），
 * 这种情况宁可起不来，也不给一个「以为很安全」的默认值。
 */
export function verifySafeDefaults(): void {
  if (config.token.length > 0 || loopbackAddresses.has(config.wsHost)) return
  console.error(
    `[安全] 监听地址是 ${config.wsHost}（非本机）却没有设 XPA_TOKEN：任何人都能连上来操作全部账号。\n`
      + '       要么设 XPA_TOKEN=<密钥>，要么把监听地址改回 127.0.0.1。',
  )
  process.exit(1)
}