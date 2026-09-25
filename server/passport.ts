/**
 * 通行证（feimo passport，`m-sdk.feimogames.com`）发码 / 登录。
 *
 * 这就是原来 `server/index.mjs` 里的同名逻辑，只是把「回执发给某条 ws」换成「返回值」，
 * 好让调用方（`tenant/slot.ts`）自己决定怎么用。整个流程必须在 Node 侧：
 * 签名是 MD5（浏览器没有），而且 `m-sdk` 没有 CORS 头。
 *
 * 报文是 form 表单、验证码字段叫 `smscode`、必须带 `channel`，这三个坑见原实现的注释。
 */
import crypto from 'node:crypto'
import { config, log } from './config.ts'
import type { PassportCredential } from '../shared/protocol/states.ts'

const passportTimeoutMs = 15_000

/** app_id → signKey，从 `global-metadata.dat` 的渠道常量里 dump 的 */
const channelTable: Record<string, { name: string; signKey: string }> = {
  '110001958': { name: 'TapTap PC 国服', signKey: '6586f8d6ab34f805997a06732fa181df' },
  '110001950': { name: '渠道 110001950', signKey: '67f6128727f2d8345a30d2d041797571' },
  '110001933': { name: 'Steam 国服', signKey: 'bd531da6ddaac750577e7664c25d673c' },
  '110001959': { name: '渠道 110001959', signKey: '6e3892a2ba61014897f85c2de4530f9e' },
  '110001949': { name: '渠道 110001949', signKey: '3fa10741d50db497778bbb6c67fa05ad' },
  '110001957': { name: '渠道 110001957', signKey: 'a4da22321c5f2eeb4501bd6c788f3e13' },
}

/** 登录成功后 `ConnectC2S(Auth=China)` 要用的其余固定字段 */
export const fixedPassportParams = {
  gameId: '120000182',
  channelId: '2',
  sdkVersion: '1.0.0.9',
  gameVersion: '3.2.1',
  os: 'windows',
  /** `BnSdkManager.Extra` 在 TapTap 渠道就是 `bn` */
  extra: 'bn',
}

/** 每条请求都要带的设备/渠道参数，值取自真实抓包；`channel` 缺了连密码都对不上 */
const passportDevice = {
  channel: 'test_junhai',
  device_id: '949eb54d52898f9e1688334f4a2a7fc2fed6f247',
  imei: '',
  oaid: '',
  ad_id: '',
  os_version: 'Windows 10  (10.0.19045) 64bit',
  device_name: 'QNLYS (Hasee Computer)',
}

type paramsTable = Record<string, string | number>

function formEncoded(params: paramsTable): string {
  return Object.keys(params)
    .map((key) => `${key}=${encodeURIComponent(String(params[key]))}`)
    .join('&')
}

/** 密码发送值：自盐双哈希 `md5(明文 + md5(明文))`；验证码是明文发的 */
function passwordHash(plaintext: string): string {
  const once = crypto.createHash('md5').update(plaintext, 'utf8').digest('hex')
  return crypto.createHash('md5').update(plaintext + once, 'utf8').digest('hex')
}

/** 签名：参数按 key 升序拼 `键=值`（无分隔符、空值也参与）后接 signKey 取 MD5 */
function passportSignature(params: paramsTable, signKey: string): string {
  const str =
    Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('') + signKey
  return crypto.createHash('md5').update(str, 'utf8').digest('hex')
}

export interface passportRequest {
  action: string
  appId?: string
  telNum?: string
  /** 前端传的是 `smsType`（不能叫 `type`，会和外层消息类型撞名） */
  smsType?: string
  loginType?: number
  code?: string
  userName?: string
  password?: string
  deviceId?: string
}

export interface passportAck {
  ok: boolean
  ret: string
  msg: string
  credential: PassportCredential | null
  content: Record<string, unknown> | null
  rawText: string
  url?: string
  message?: string
}

/** 失败原因翻译成人话（`session.ts` 的 `通行证说明` 原样搬过来） */
export function passportDetail(ret: string, msg: string, fallback?: string): string {
  const code: Record<string, string> = {
    '1': '成功',
    '2': '密码错误',
    '5': '手机号未绑定/未注册通行证账号',
    '6': '账号被限制',
  }
  const raw = msg || fallback || '未知错误'
  const fill = ret !== '' && ret !== '0' && ret !== '1' && code[ret] ? `（ret=${ret} ${code[ret]}）` : ''
  return `${raw}${fill}`
}

function fail(message: string, url?: string): passportAck {
  return { ok: false, ret: '', msg: '', credential: null, content: null, rawText: '', url, message }
}

export async function runPassport(request: passportRequest): Promise<passportAck> {
  const appId = String(request.appId ?? '110001958')
  const channel = channelTable[appId]
  if (!channel) return fail(`不认识的 app_id：${appId}`)

  const action = String(request.action ?? '')
  const time = String(Math.floor(Date.now() / 1000))
  const deviceId = String(request.deviceId ?? passportDevice.device_id)

  let path: string
  let params: paramsTable
  if (action === '发码') {
    path = '/account/sendCode'
    params = {
      tel_num: String(request.telNum ?? ''),
      app_id: appId,
      channel: passportDevice.channel,
      os: fixedPassportParams.os,
      time: time,
      type: String(request.smsType ?? 'smslogin'),
    }
  } else if (action === '登录') {
    path = '/account/authorize'
    params = {
      channel: passportDevice.channel,
      app_id: appId,
      sdk_version: fixedPassportParams.sdkVersion,
      device_id: deviceId,
      imei: passportDevice.imei,
      time: time,
      oaid: passportDevice.oaid,
      os: fixedPassportParams.os,
      login_type: Number(request.loginType ?? 3),
      os_version: passportDevice.os_version,
      device_name: passportDevice.device_name,
      ad_id: passportDevice.ad_id,
      and_id: deviceId,
    }
    if (params.login_type === 3) {
      params.tel_num = String(request.telNum ?? '')
      // 字段名是 smscode，发 `code` 服务端当空值处理 → 永远「验证码错误」
      params.smscode = String(request.code ?? '')
    } else {
      // 手机号走 tel_num + login_type=19（抓包实测），通行证账号走 user_name + login_type=1
      const account = String(request.userName ?? '')
      if (/^1\d{10}$/.test(account)) {
        params.login_type = 19
        params.tel_num = account
      } else {
        params.login_type = 1
        params.user_name = account
      }
      params.password = passwordHash(String(request.password ?? ''))
    }
  } else {
    return fail(`不认识的动作：${action}`)
  }

  params.sign = passportSignature(params, channel.signKey)
  const url = `${config.passportBase}${path}`
  log(`通行证 ${action} → ${url}`)
  // 日志里把明文凭证打码，免得留在控制台里
  log(
    `  参数: ${JSON.stringify({
      ...params,
      ...(params.password !== undefined ? { password: '***' } : {}),
      ...(params.smscode !== undefined ? { smscode: '***' } : {}),
    })}`,
  )

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formEncoded(params),
      signal: AbortSignal.timeout(passportTimeoutMs),
    })
    const rawText = await response.text()
    let data: Record<string, unknown> | null = null
    try {
      data = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      // 解析失败就把原文给调用方看
    }
    // ret 是字符串 "1" 表示成功（服务端返回的是字符串，不是数字）
    const ok = String(data?.ret ?? '0') === '1'
    const content = (data?.content ?? null) as Record<string, unknown> | null
    const credential: PassportCredential | null =
      action === '登录' && ok
        ? {
            sid: String(content?.authorize_code ?? ''),
            userId: String(content?.user_id ?? ''),
            // 这是 SDK 处理过的 `c:xxx` 串，不是登录账号，前端只作展示用
            userName: String(content?.user_name ?? ''),
            extra: fixedPassportParams.extra,
            gameId: fixedPassportParams.gameId,
            channelId: fixedPassportParams.channelId,
            appId,
            deviceId: deviceId,
          }
        : null
    log(`通行证 ${action} 返回 ret=${data?.ret ?? '?'} msg=${data?.msg ?? rawText.slice(0, 200)}`)
    return {
      ok: ok,
      ret: String(data?.ret ?? ''),
      msg: String(data?.msg ?? ''),
      credential,
      content,
      rawText,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log(`通行证 ${action} 失败: ${detail}`)
    return fail(detail, url)
  }
}