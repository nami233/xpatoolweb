import { decode, encode } from './wire.ts'
import { getSchema } from './generated/schemas.gen.ts'

export const AUTH_TYPE = {
  DEV: 0,
  STEAM: 1,
  TAP_TAP: 2,
  ABROAD: 3,
  CHINA: 4,
} as const

export const DEFAULT_PUBLIC_KEY = 't4UDM%2Q'

function getStruct(name: string) {
  const struct = getSchema(name)
  if (!struct) throw new Error(`协议结构不存在: ${name}（先跑 npm run gen:proto）`)
  return struct
}

export interface ChinaAuthOptions {
  gameId: string
  channelId: string
  appId: string
  sid: string
  extra?: string
  deviceId?: string
  clientVer?: string
  publicKey?: string
}

export function encodeConnectC2SChina(options: ChinaAuthOptions): Uint8Array {
  return encode(getStruct('ConnectC2S'), {
    PublicKey: options.publicKey ?? DEFAULT_PUBLIC_KEY,
    Auth: AUTH_TYPE.CHINA,
    ClientVer: options.clientVer ?? '',
    China: {
      GameId: options.gameId,
      ChannelId: options.channelId,
      AppId: options.appId,
      Sid: options.sid,
      Extra: options.extra ?? '',
      DeviceId: options.deviceId ?? '',
    },
  })
}

export function encodeHeartbeatC2S(clientTime: number): Uint8Array {
  return encode(getStruct('HeartbeatC2S'), { Client: BigInt(clientTime) })
}

export interface ConnectS2CData {
  CipherKey: string
  SessionId: bigint
  Account: Record<string, unknown>
  Player: Record<string, unknown>
  QueueTime: number
  Data: string
  BanTime: bigint
  NowTime: bigint
}

export function decodeConnectS2C(bytes: Uint8Array): ConnectS2CData {
  return decode(getStruct('ConnectS2C'), bytes) as unknown as ConnectS2CData
}

export interface HeartbeatS2CData {
  Client: bigint
  Server: bigint
}

export function decodeHeartbeatS2C(bytes: Uint8Array): HeartbeatS2CData {
  return decode(getStruct('HeartbeatS2C'), bytes) as unknown as HeartbeatS2CData
}
