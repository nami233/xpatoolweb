/**
 * 前端配置。
 *
 * 后端地址 / 令牌能在 localStorage 里改（键 `xpatoolweb.后端`）：
 * 不用重新打包就能指向别的后端。令牌是**部署级门禁**（后端没配 `XPA_TOKEN` 时用不上）。
 */
const backendSaveKey = 'xpatoolweb.后端'

interface BackendSave {
  url?: string
  token?: string
}

function readBackendSave(): BackendSave {
  try {
    const rawText = localStorage.getItem(backendSaveKey)
    if (!rawText) return {}
    const parse = JSON.parse(rawText) as unknown
    return parse && typeof parse === 'object' ? (parse as BackendSave) : {}
  } catch {
    return {}
  }
}

const persisted = readBackendSave()

export const defaultBackendUrl = import.meta.env.VITE_XPA_WS ?? 'ws://127.0.0.1:8787'

/** 运行时可变：`DebugOps.vue` 的地址输入框与「重连」按钮直接改这里 */
export const backendSettings = {
  url: typeof persisted.url === 'string' && persisted.url.length > 0 ? persisted.url : defaultBackendUrl,
  token: typeof persisted.token === 'string' ? persisted.token : '',
}

export function saveBackendSettings(): void {
  try {
    localStorage.setItem(backendSaveKey, JSON.stringify(backendSettings))
  } catch {
  }
}

export const serverHost = 'se-jump-cn-01.feimogames.com'
export const serverPort = 8800

export const clientVersion = '3.2.0'

export const configApiRoute = '110001958'
export const configApiVersion = '3.2.1'

export const accountLimit = 4