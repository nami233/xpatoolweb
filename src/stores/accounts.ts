/**
 * 主页的账号槽列表。
 *
 * 游戏账号由**服务端**按用户持久化（槽位号 = 记录 id），这里不再存任何东西：
 * 槽列表只是 `用户.游戏账号列表` 的本地镜像 —— 那份列表才是真相，
 * 加 / 删都以服务端回执为准，本地据此建、销毁会话。
 */
import { computed, markRaw, reactive, ref, watch } from 'vue'
import { createSession } from '@/stores/session'
import type { session } from '@/stores/session'
import { addGameAccount, removeGameAccount, gameAccountList } from '@/stores/user'
import type { SlotSummary } from '@shared/protocol/messages'

/** 老存档（游戏账号连密码一起放在浏览器里那版）：现在账号在服务端，留着只会误导 */
const legacySaveKey = 'xpatoolweb.accounts'

function clearLegacySave(): void {
  try {
    localStorage.removeItem(legacySaveKey)
  } catch {
  }
}

clearLegacySave()

export interface AccountSlot {
  slot: number
  account: string
  checked: boolean
  session: session
}

function createSlot(slot: number, accountName: string): AccountSlot {
  const account = ref(accountName)
  const checked = ref(false)
  const session = createSession({
    slot,
    getAccount: () => account.value,
  })

  return reactive({
    slot,
    account,
    checked,
    session: markRaw(session),
  })
}

const slotList = reactive<AccountSlot[]>([])
const currentSlot = ref<AccountSlot | null>(null)

function destroySlot(accountSlot: AccountSlot): void {
  accountSlot.session.destroy()
  accountSlot.session.clearLogs()
  const position = slotList.indexOf(accountSlot)
  if (position >= 0) slotList.splice(position, 1)
  if (currentSlot.value === accountSlot) currentSlot.value = null
}

function syncSlotList(list: SlotSummary[]): void {
  const serverSlots = new Set(list.map((item) => item.slot))
  for (const accountSlot of [...slotList]) {
    if (serverSlots.has(accountSlot.slot)) continue
    destroySlot(accountSlot)
  }
  for (const item of list) {
    const existing = slotList.find((accountSlot) => accountSlot.slot === item.slot)
    if (existing !== undefined) {
      existing.account = item.account
      continue
    }
    const accountSlot = createSlot(item.slot, item.account)
    accountSlot.checked = slotList.length === 0
    slotList.push(accountSlot)
  }
}

// 服务端说了算：登录 / 加 / 删 / 登出的结果都会让这份列表变一次
watch(gameAccountList, (list) => syncSlotList([...list]), { immediate: true, deep: true })

/** 添加游戏账号（同一账号再填一次 = 改密码）。返回错误文案，null 表示成功 */
async function addAccount(accountName: string, password: string): Promise<string | null> {
  const name = accountName.trim()
  if (name.length === 0) return '账号不能为空'
  if (password.length === 0) return '密码不能为空'
  return addGameAccount(name, password)
}

/** 移除游戏账号：服务端删记录 + 销毁槽位，本地列表跟着回执对齐 */
async function removeAccount(accountSlot: AccountSlot): Promise<string | null> {
  return removeGameAccount(accountSlot.slot)
}

const loggedInCount = computed(() => slotList.filter((accountSlot) => accountSlot.session.isLogined).length)

async function loginSlot(accountSlot: AccountSlot): Promise<boolean> {
  if (accountSlot.session.isLogined || accountSlot.session.loginState === 'pending') return accountSlot.session.isLogined
  return accountSlot.session.login()
}

export function useAccounts() {
  return {
    slotList,
    loggedInCount,
    currentSlot,
    addAccount,
    removeAccount,
    loginSlot,
  }
}