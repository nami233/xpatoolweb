/**
 * 上行消息的类型守卫。
 *
 * 前端传来的东西一律当成不可信输入：先过这里，才能进到 `连接` 的分派里。
 * 判据只有 `t`（不能用 `type` —— `passport` 那条上行的参数里已经有个业务字段叫 `type`）。
 *
 * `认证`/`用户登录`/`注册`/`登出`/`加游戏账号`/`删游戏账号` 这六条虽然也在这张表里，
 * 但它们要碰落盘与会话，由 `服务器` 直接办，不进 `连接` 的分派。
 */
import type { RawData } from 'ws'
import type { UpMessage } from '../../shared/protocol/messages.ts'
import type { EventName } from '../../shared/protocol/states.ts'

export type ParseUpResult = { ok: true; message: UpMessage } | { ok: false; error: string }

/** ws 交出来的帧是 Buffer / ArrayBuffer / Buffer[] 三种之一，统一转成 utf8 文本 */
export function readTextFrame(data: RawData): string | null {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return null
}

const validEvents = new Set<string>(['状态', '日志', '帧', '推送', '脚本'])

function bad(error: string): ParseUpResult {
  return { ok: false, error }
}

function ok(message: UpMessage): ParseUpResult {
  return { ok: true, message }
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function getReqId(record: Record<string, unknown>): number | null {
  const value = record.reqId
  return isInteger(value) && value >= 0 ? value : null
}

/** 槽位号是服务端分配的，必然 ≥ 1 */
function getSlotId(record: Record<string, unknown>): number | null {
  const value = record.slot
  return isInteger(value) && value > 0 ? value : null
}

function getEventTable(value: unknown): EventName[] | null {
  if (!Array.isArray(value)) return null
  const out: EventName[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !validEvents.has(item)) continue
    out.push(item as EventName)
  }
  return out
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function parseUpMessage(rawText: string): ParseUpResult {
  let value: unknown
  try {
    value = JSON.parse(rawText)
  } catch {
    return bad('上行消息不是合法 JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad('上行消息必须是对象')
  const record = value as Record<string, unknown>
  const t = record.t
  if (typeof t !== 'string') return bad('上行消息缺少 t 字段')

  switch (t) {
    case '认证': {
      const token = record.token
      if (token !== undefined && typeof token !== 'string') return bad('令牌必须是字符串')
      return ok({ t: '认证', token: typeof token === 'string' ? token : undefined })
    }

    case '心跳': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('心跳缺少合法的 请求号')
      return ok({ t: '心跳', reqId })
    }

    case '加游戏账号': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('加游戏账号缺少合法的 请求号')
      if (typeof record.account !== 'string') return bad('加游戏账号的 账号 必须是字符串')
      if (typeof record.password !== 'string') return bad('加游戏账号的 密码 必须是字符串')
      return ok({ t: '加游戏账号', reqId, account: record.account, password: record.password })
    }

    case '删游戏账号': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('删游戏账号缺少合法的 请求号')
      const slot = getSlotId(record)
      if (slot === null) return bad('删游戏账号缺少合法的 槽位')
      return ok({ t: '删游戏账号', reqId, slot })
    }

    case '用户登录': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('用户登录缺少合法的 请求号')
      const username = record.username
      const password = record.password
      const token = record.token
      if (username !== undefined && typeof username !== 'string') return bad('用户名必须是字符串')
      if (password !== undefined && typeof password !== 'string') return bad('密码必须是字符串')
      if (token !== undefined && typeof token !== 'string') return bad('令牌必须是字符串')
      const hasToken = typeof token === 'string' && token.length > 0
      const hasCredentials = typeof username === 'string' && typeof password === 'string'
      if (!hasToken && !hasCredentials) return bad('用户登录要么给 令牌，要么给 用户名 + 密码')
      return ok({
        t: '用户登录',
        reqId,
        username: typeof username === 'string' ? username : undefined,
        password: typeof password === 'string' ? password : undefined,
        token: hasToken ? token : undefined,
      })
    }

    case '注册': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('注册缺少合法的 请求号')
      if (typeof record.username !== 'string' || typeof record.password !== 'string') {
        return bad('注册需要字符串的 用户名/密码')
      }
      return ok({ t: '注册', reqId, username: record.username, password: record.password })
    }

    case '登出': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('登出缺少合法的 请求号')
      return ok({ t: '登出', reqId })
    }

    case '清日志': {
      const reqId = getReqId(record)
      if (reqId === null) return bad(`${t} 缺少合法的 请求号`)
      const slot = getSlotId(record)
      if (slot === null) return bad(`${t} 缺少合法的 槽位`)
      return ok({ t: '清日志', reqId, slot })
    }

    case '读脚本':
    case '跑脚本':
    case '停脚本': {
      const reqId = getReqId(record)
      if (reqId === null) return bad(`${t} 缺少合法的 请求号`)
      const slot = getSlotId(record)
      if (slot === null) return bad(`${t} 缺少合法的 槽位`)
      if (t === '读脚本') return ok({ t: '读脚本', reqId, slot })
      if (t === '跑脚本') return ok({ t: '跑脚本', reqId, slot })
      return ok({ t: '停脚本', reqId, slot })
    }

    case '存脚本': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('存脚本缺少合法的 请求号')
      const slot = getSlotId(record)
      if (slot === null) return bad('存脚本缺少合法的 槽位')
      if (typeof record.source !== 'string') return bad('存脚本的 源码 必须是字符串')
      return ok({ t: '存脚本', reqId, slot, source: record.source })
    }

    case '登录': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('登录缺少合法的 请求号')
      const slot = getSlotId(record)
      if (slot === null) return bad('登录缺少合法的 槽位')
      return ok({ t: '登录', reqId, slot })
    }

    case '订阅':
    case '退订': {
      const reqId = getReqId(record)
      if (reqId === null) return bad(`${t} 缺少合法的 请求号`)
      const slot = getSlotId(record)
      if (slot === null) return bad(`${t} 缺少合法的 槽位`)
      const events = getEventTable(record.events)
      if (events === null) return bad(`${t} 的 事件 必须是数组`)
      if (t === '订阅') return ok({ t: '订阅', reqId, slot, events })
      return ok({ t: '退订', reqId, slot, events })
    }

    case '发命令': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('发命令缺少合法的 请求号')
      const slot = getSlotId(record)
      if (slot === null) return bad('发命令缺少合法的 槽位')
      if (typeof record.name !== 'string' || record.name.trim().length === 0) return bad('发命令缺少 名')
      const params = record.params
      if (params !== undefined && asObject(params) === null) return bad('发命令的 参数 必须是对象')
      return ok({
        t: '发命令',
        reqId,
        slot,
        name: record.name,
        params: params === undefined ? undefined : (params as Record<string, unknown>),
      })
    }

    case '调试发包': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('调试发包缺少合法的 请求号')
      const slot = getSlotId(record)
      if (slot === null) return bad('调试发包缺少合法的 槽位')
      if (typeof record.name !== 'string' || record.name.trim().length === 0) return bad('调试发包缺少 名')
      if (typeof record.paramsJson !== 'string') return bad('调试发包的 参数JSON 必须是字符串')
      return ok({ t: '调试发包', reqId, slot, name: record.name, paramsJson: record.paramsJson })
    }

    case '通行证': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('通行证缺少合法的 请求号')
      const slot = getSlotId(record)
      if (slot === null) return bad('通行证缺少合法的 槽位')
      if (record.action !== '发码' && record.action !== '登录') return bad('通行证的 动作 只能是 发码/登录')
      const params = asObject(record.params)
      if (params === null) return bad('通行证的 参数 必须是对象')
      return ok({ t: '通行证', reqId, slot, action: record.action, params })
    }

    case '拉取远端配置': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('拉取远端配置缺少合法的 请求号')
      if (typeof record.route !== 'string' || typeof record.version !== 'string') {
        return bad('拉取远端配置需要字符串的 路由/版本')
      }
      return ok({ t: '拉取远端配置', reqId, route: record.route, version: record.version })
    }

    case '保存抓包': {
      const reqId = getReqId(record)
      if (reqId === null) return bad('保存抓包缺少合法的 请求号')
      const slot = record.slot
      if (slot !== undefined && !(isInteger(slot) && slot > 0)) return bad('槽位必须是正整数')
      if (record.text !== undefined && typeof record.text !== 'string') return bad('文本必须是字符串')
      return ok({
        t: '保存抓包',
        reqId,
        slot: isInteger(slot) && slot > 0 ? slot : undefined,
        text: typeof record.text === 'string' ? record.text : undefined,
      })
    }

    default:
      return bad(`不认识的上行消息 t=${t}`)
  }
}