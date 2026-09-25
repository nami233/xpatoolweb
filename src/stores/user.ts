/**
 * xpatoolweb 用户账号（不是游戏账号）。
 *
 * 用户级绑定是连接上的一个状态：`认证`（部署级门禁）之后发 `用户登录`/`注册`，
 * 服务端校验通过才把这条连接绑到租户 `u-<用户名>` 上、并按持久化记录建游戏账号槽位。
 * 所以在绑定成功之前，任何槽位类请求都发不出去（`后端客户端` 会排队）。
 *
 * 会话令牌**只在内存里**（服务端只存它的 sha256），刷新页面就没了 —— 进门必须手动登录，
 * 登录页的「记住密码」只负责把用户名/密码填好，不会替你提交。
 * 唯一的例外是「同一次页面生命周期内后端 WS 掉线重连」：那不算重新登录，拿内存里的令牌自动补一次绑定。
 */
import { ref, watch } from 'vue'
import { backendLinkState, userBound, getBackend } from '@/net/backend'
import type { UserBindResult } from '@/net/backend'
import type { SlotSummary } from '@shared/protocol/messages'

/** 历史版本把会话令牌存在这里换「免登录」；现在不再自动登录，顺手清掉这份遗留 */
try {
  localStorage.removeItem('xpatoolweb.会话')
} catch {
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const currentUser = ref('')
/** 只在这一个页面里有效（不落盘）：够「WS 掉线重连补一次绑定」用 */
const sessionToken = ref('')
/** 服务端给的游戏账号列表（唯一的真相来源，本地槽位表按它对齐） */
export const gameAccountList = ref<SlotSummary[]>([])
export const userMessage = ref('')
const binding = ref(false)

/** 同一条绑定请求只跑一次：路由守卫与「重连后恢复」可能同时发起 */
let inFlight: Promise<{ ok: boolean; error?: string }> | null = null

/**
 * 用户自己点了登出。登出的回执也是「用户结果」，会把 `已绑定用户` 打回 false，
 * 不挡一下就会立刻触发一次注定失败的「恢复会话」（令牌刚被吊销）。
 */
let manualLogout = false

function runBind(
  task: () => Promise<UserBindResult>,
  isRestore = false,
): Promise<{ ok: boolean; error?: string }> {
  if (inFlight !== null) return inFlight
  binding.value = true
  userMessage.value = ''
  const promise = (async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const result = await task()
      if (!result.ok) {
        const hint = result.error ?? '登录失败'
        userMessage.value = hint
        // 令牌失效（过期 / 被吊销 / 后端换了）：清掉，别拿它反复试
        if (isRestore) sessionToken.value = ''
        return { ok: false, error: hint }
      }
      currentUser.value = result.username
      if (result.sessionToken !== undefined && result.sessionToken.length > 0) {
        sessionToken.value = result.sessionToken
      }
      gameAccountList.value = [...result.gameAccounts]
      return { ok: true }
    } catch (error) {
      const hint = toErrorMessage(error)
      userMessage.value = hint
      return { ok: false, error: hint }
    }
  })()
  inFlight = promise
  void promise.finally(() => {
    inFlight = null
    binding.value = false
  })
  return promise
}

export function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  return runBind(() => getBackend().userLogin({ username, password }))
}

export function register(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  return runBind(() => getBackend().register(username, password))
}

/**
 * 拿内存里的令牌补一次用户绑定。**只在「这个页面还开着、后端 WS 掉线又连回来」时用** ——
 * 刷新页面后令牌就没了（见文件头），得重新登录。
 */
export function restoreSession(): Promise<{ ok: boolean; error?: string }> {
  if (sessionToken.value.length === 0) return Promise.resolve({ ok: false, error: '没有会话令牌' })
  return runBind(() => getBackend().userLogin({ token: sessionToken.value }), true)
}

/**
 * 登出 xpatoolweb 用户：服务端吊销令牌、解除绑定（槽位表随之回收），
 * 本地清干净。后端连不上也照样把本地清掉，否则用户被困在主页。
 */
export async function logout(): Promise<void> {
  manualLogout = true
  try {
    await getBackend().userLogout()
  } catch {
  } finally {
    getBackend().resetUserState()
    currentUser.value = ''
    sessionToken.value = ''
    gameAccountList.value = []
    userMessage.value = ''
    manualLogout = false
  }
}

/** 加游戏账号（同一个账号再填一次 = 改密码）。列表以服务端回执为准 */
export async function addGameAccount(account: string, password: string): Promise<string | null> {
  try {
    const result = await getBackend().addGameAccount(account, password)
    if (!result.ok) return result.error ?? '添加游戏账号失败'
    gameAccountList.value = [...result.gameAccounts]
    return null
  } catch (error) {
    return toErrorMessage(error)
  }
}

export async function removeGameAccount(slot: number): Promise<string | null> {
  try {
    const result = await getBackend().removeGameAccount(slot)
    if (!result.ok) return result.error ?? '删除游戏账号失败'
    gameAccountList.value = [...result.gameAccounts]
    return null
  } catch (error) {
    return toErrorMessage(error)
  }
}

/**
 * 掉线重连 / 后端重启后自动补一次用户绑定：重连只重做「门禁」那一半，
 * 用户绑定这一半要自己补，否则连接停在「已认证未绑定」，所有槽位请求都会排队到超时。
 *
 * 判据用 `已绑定用户` 而不是 `当前用户`：掉线时 `当前用户` 还是非空的，但服务端那侧已经解绑了，
 * 只有拿令牌重新走一次 `用户登录` 才算接上。
 */
watch([backendLinkState, userBound], ([state, bound]) => {
  if (state !== '已连接' || bound || manualLogout) return
  if (sessionToken.value.length === 0) return
  void restoreSession()
})

export function useUser() {
  return {
    currentUser,
    gameAccountList,
    userMessage,
    binding,
    login,
    register,
    restoreSession,
    logout,
    addGameAccount,
    removeGameAccount,
  }
}