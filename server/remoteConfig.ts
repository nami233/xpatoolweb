/**
 * 帮前端拉一次远端服务器地址配置（游戏 `WebServerConfig.GetWebServerUrl` 用的那个接口）。
 *
 * 为什么放服务端：`se-web-cn.feimogames.com:7878` 没有 CORS 头，浏览器直连会被跨域挡掉。
 * 从 `server/index.mjs` 移植，去掉了 `ws` 参数改成纯返回值。
 */
import { config, log } from './config.ts'

const timeoutMs = 10_000

/** route/version 只允许常规字符，避免被拼进 URL 搞出别的东西 */
const securityParams = /^[A-Za-z0-9_.-]{1,64}$/

export interface remoteConfigAck {
  ok: boolean
  url: string
  text: string
  data: Record<string, unknown> | null
  message?: string
}

export async function fetchRemoteConfig(route: string, version: string): Promise<remoteConfigAck> {
  if (!securityParams.test(route) || !securityParams.test(version)) {
    return { ok: false, url: '', text: '', data: null, message: 'route / version 含非法字符' }
  }

  const url = `${config.configBase}?route=${encodeURIComponent(route)}&version=${encodeURIComponent(version)}`
  log(`拉取远端配置: ${url}`)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const text = await response.text()
    if (!response.ok) {
      log(`远端配置 HTTP ${response.status}`)
      return { ok: false, url, text: text, data: null, message: `HTTP ${response.status}` }
    }
    let data: Record<string, unknown> | null = null
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      // 解析失败就把原文给前端看，不当作致命错误
    }
    log(`远端配置返回: ${text.slice(0, 200)}`)
    return { ok: true, url, text: text, data: data }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log(`远端配置请求失败: ${detail}`)
    return { ok: false, url, text: '', data: null, message: detail }
  }
}