<script setup lang="ts">
import { computed, ref } from 'vue'
import { accountLimit } from '@/config'
import { mapNameTable, roomPlayerLimit } from '@/data/names'
import { useAccounts } from '@/stores/accounts'
import type { AccountSlot } from '@/stores/accounts'
import { getRunLogs, clearRunLogs } from '@/stores/session'
import { backendLinkState } from '@/net/backend'
import OperationDrawer from '@/components/OperationDrawer.vue'
import CreateRoomDialog from '@/components/room/CreateRoomDialog.vue'
import JoinRoomDialog from '@/components/room/JoinRoomDialog.vue'

const {
  slotList,
  loggedInCount,
  currentSlot,
  addAccount,
  removeAccount,
  loginSlot,
} = useAccounts()

const logs = getRunLogs()

const checkedSlots = computed(() => slotList.filter((accountSlot) => accountSlot.checked))

/** 后端这条 WS 断了：账号操作发不出去，先别让用户白点（会自动重连） */
const backendAvailable = computed(() => backendLinkState.value === '已连接')

const drawerAccounts = ref<AccountSlot[]>([])
const drawerOpen = computed(() => drawerAccounts.value.length > 0)

const menuOpen = ref(false)
const dialog = ref<'创建房间' | '进入房间' | null>(null)
const batchState = ref('')
const batchBusy = ref(false)

const consoleOpen = ref(true)
const batching = ref(false)

const nextListAccount = ref('')
const nextListPassword = ref('')
const addError = ref('')

async function clickAdd(): Promise<void> {
  const error = await addAccount(nextListAccount.value, nextListPassword.value)
  addError.value = error ?? ''
  if (error === null) {
    nextListAccount.value = ''
    nextListPassword.value = ''
  }
}

async function onRemoveAccount(accountSlot: AccountSlot): Promise<void> {
  if (!window.confirm(`移除账号「${accountSlot.account}」？（会同时断开它的连接）`)) return
  const error = await removeAccount(accountSlot)
  if (error !== null) window.alert(error)
}

function roomPlayerCountText(accountSlot: AccountSlot): string {
  const playerCount = accountSlot.session.room.roomPlayerCount
  return playerCount > 0 ? `${playerCount}/${roomPlayerLimit}` : '—'
}

function mapText(accountSlot: AccountSlot): string {
  const mapId = accountSlot.session.room.roomSettings.mapId
  if (mapId <= 0) return '—'
  return mapNameTable[mapId] ?? String(mapId)
}

function roundText(accountSlot: AccountSlot): string {
  const round = accountSlot.session.room.round
  return round > 0 ? String(round) : '—'
}

function progressText(accountSlot: AccountSlot): string {
  const room = accountSlot.session.room
  if (!room.inRoom) return '—'
  const limit = room.progressLimit
  return limit > 0 ? `${room.progress}/${limit}` : String(room.progress)
}

async function onLoginAccount(): Promise<void> {
  batching.value = true
  try {
    for (const accountSlot of checkedSlots.value) await loginSlot(accountSlot)
  } finally {
    batching.value = false
  }
}

function selectAll(): void {
  for (const accountSlot of slotList) accountSlot.checked = true
}

function clearChecked(): void {
  for (const accountSlot of slotList) accountSlot.checked = false
}

function onRowClick(accountSlot: AccountSlot): void {
  currentSlot.value = accountSlot
  accountSlot.checked = true
}

function onAccountAction(accountSlot: AccountSlot): void {
  currentSlot.value = accountSlot
  drawerAccounts.value = [accountSlot]
}

function closeDrawer(): void {
  drawerAccounts.value = []
}

function clickMenuItem(item: '创建房间' | '进入房间' | '退出房间'): void {
  menuOpen.value = false
  batchState.value = ''
  if (item === '退出房间') {
    void batchLeaveRooms()
    return
  }
  dialog.value = item
}

async function batchLeaveRooms(): Promise<void> {
  if (batchBusy.value) return
  const names = checkedSlots.value.filter((accountSlot) => accountSlot.session.isLogined && accountSlot.session.room.inRoom)
  if (names.length === 0) {
    batchState.value = '没有「勾选着、已登录、且在房间里」的账号'
    return
  }
  batchBusy.value = true
  try {
    const notQuit: string[] = []
    for (const accountSlot of names) {
      batchState.value = `账号 ${accountSlot.session.displayName} 退出房间…`
      await accountSlot.session.exitRoom()
      if (accountSlot.session.room.inRoom) notQuit.push(accountSlot.session.displayName)
      await new Promise((done) => setTimeout(done, 300))
    }
    batchState.value =
      notQuit.length === 0
        ? `${names.length} 个账号都退出房间了`
        : `账号 ${notQuit.join('、')} 没退出去（看控制台日志）`
  } finally {
    batchBusy.value = false
  }
}

function isCurrent(accountSlot: AccountSlot): boolean {
  return currentSlot.value === accountSlot
}

function formatTime(time: number): string {
  const d = new Date(time)
  return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
</script>

<template>
  <div class="页">
    <section class="控制台">
      <div class="控制台头">
        <h2>控制台</h2>
        <div class="控制台操作">
          <span class="灰">共 {{ logs.length }} 条</span>
          <button class="小" @click="consoleOpen = !consoleOpen">
            {{ consoleOpen ? '收起' : '展开' }}
          </button>
          <button class="小" @click="clearRunLogs()">清空</button>
        </div>
      </div>
      <ul v-if="consoleOpen" class="日志">
        <li v-for="item in logs" :key="item.id" :class="`级-${item.level}`">
          <span class="时间">{{ formatTime(item.time) }}</span>
          <span class="账号标">{{ item.account || `账号 ${item.slot}` }}</span>
          <span>{{ item.text }}</span>
        </li>
        <li v-if="logs.length === 0" class="空">暂无日志</li>
      </ul>
    </section>

    <div v-if="!backendAvailable" class="断线横幅">
      后端已断开，正在自动重连…（游戏账号仍在后端运行，无需重新登录）
    </div>

    <section class="账号条">
      <div class="账号数">账号 {{ loggedInCount }}/{{ accountLimit }}</div>
      <div class="按钮组">
        <button
          class="主"
          :disabled="!backendAvailable || batching || checkedSlots.length === 0"
          @click="onLoginAccount"
        >
          {{ batching ? '登录中…' : '登录账号' }}
        </button>
        <div class="批量">
          <button
            class="主"
            :disabled="checkedSlots.length === 0 || batchBusy"
            :title="checkedSlots.length === 0 ? '先在下面勾选账号（可多选）' : ''"
            @click="menuOpen = !menuOpen"
          >
            批量操作（勾选 {{ checkedSlots.length }} 个）▾
          </button>
          <ul v-if="menuOpen" class="菜单">
            <li @click="clickMenuItem('创建房间')">创建房间</li>
            <li @click="clickMenuItem('进入房间')">进入房间</li>
            <li @click="clickMenuItem('退出房间')">退出房间</li>
          </ul>
        </div>
      </div>
      <span v-if="batchState" class="灰">{{ batchState }}</span>
      <span v-else class="灰">
        顶部这几个按钮都只作用于<strong>勾选的</strong>账号（下面列表上方有全选/清空）：
        登录账号，以及批量操作里的创建房间 / 进入房间 / 退出房间；单个账号用行里的「操作」。
      </span>
    </section>

    <div v-if="menuOpen" class="菜单遮罩" @click="menuOpen = false" />

    <section class="列表块">
      <div class="列表工具">
        <button class="小" :disabled="slotList.length === 0" @click="selectAll">全选</button>
        <button class="小" :disabled="checkedSlots.length === 0" @click="clearChecked">清空</button>
        <span class="灰">已勾选 {{ checkedSlots.length }} / {{ slotList.length }}</span>
      </div>
      <div class="表头">
        <span class="c-勾">选</span>
        <span class="c-账号">账号</span>
        <span class="c-游戏名">游戏名</span>
        <span class="c-状态">状态</span>
        <span class="c-房间">房间号</span>
        <span class="c-地图">地图</span>
        <span class="c-人数">人数</span>
        <span class="c-轮次">轮次</span>
        <span class="c-进度">进度</span>
        <span class="c-观战码">观战码</span>
        <span class="c-操作">操作</span>
      </div>
      <div
        v-for="accountSlot in slotList"
        :key="accountSlot.slot"
        class="表行"
        :class="{ 当前: isCurrent(accountSlot) }"
        @click="onRowClick(accountSlot)"
      >
        <span class="c-勾" @click.stop>
          <input v-model="accountSlot.checked" type="checkbox" />
        </span>
        <span class="c-账号">{{ accountSlot.account }}</span>
        <span class="c-游戏名">{{ accountSlot.session.gameName || '—' }}</span>
        <span class="c-状态" :class="`态-${accountSlot.session.loginState}`">
          {{ accountSlot.session.phase }}
          <em v-if="!accountSlot.session.isLogined && accountSlot.session.linkMessage">
            {{ accountSlot.session.linkMessage }}
          </em>
        </span>
        <span class="c-房间">{{ accountSlot.session.room.roomId || '—' }}</span>
        <span class="c-地图" :title="mapText(accountSlot)">{{ mapText(accountSlot) }}</span>
        <span class="c-人数" :class="{ 满: accountSlot.session.room.roomPlayerCount >= roomPlayerLimit }">
          {{ roomPlayerCountText(accountSlot) }}
        </span>
        <span class="c-轮次">{{ roundText(accountSlot) }}</span>
        <span class="c-进度">{{ progressText(accountSlot) }}</span>
        <span class="c-观战码" :title="accountSlot.session.room.spectateCode">
          {{ accountSlot.session.room.spectateCode || '—' }}
        </span>
        <span class="c-操作">
          <button class="小 主" @click.stop="onAccountAction(accountSlot)">操作</button>
          <button
            v-if="!accountSlot.session.isLogined"
            class="小"
            :disabled="accountSlot.session.loginState === 'pending'"
            @click.stop="loginSlot(accountSlot)"
          >
            {{ accountSlot.session.loginState === 'pending' ? '登录中…' : '登录' }}
          </button>
          <button class="小 危险" @click.stop="onRemoveAccount(accountSlot)">移除</button>
        </span>
      </div>
      <p v-if="slotList.length === 0" class="空">
        还没有账号：在下面的「添加账号」里填账号 + 密码加进来。
      </p>
    </section>

    <section class="添加块">
      <h2>添加账号</h2>
      <div class="添加行">
        <label>
          <span>账号</span>
          <input
            v-model="nextListAccount"
            placeholder="手机号（推荐）或通行证账号"
            @keyup.enter="clickAdd"
          />
        </label>
        <label>
          <span>密码</span>
          <input
            v-model="nextListPassword"
            type="password"
            placeholder="通行证密码"
            @keyup.enter="clickAdd"
          />
        </label>
        <button
          class="主"
          :disabled="!backendAvailable || nextListAccount.trim().length === 0"
          @click="clickAdd"
        >
          添加账号
        </button>
        <span class="灰">账号 {{ slotList.length }}/{{ accountLimit }}</span>
        <span v-if="addError" class="错误">{{ addError }}</span>
        <span v-else class="灰">
          已存在同一个账号时只更新它的密码（改密码就这么改）；账号和密码都会存在服务端
        </span>
      </div>
    </section>

    <OperationDrawer v-if="drawerOpen" :accountList="drawerAccounts" @close="closeDrawer" />
    <CreateRoomDialog v-if="dialog === '创建房间'" @close="dialog = null" />
    <JoinRoomDialog v-if="dialog === '进入房间'" @close="dialog = null" />
  </div>
</template>

<style scoped>
.页 {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
}

.控制台 {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  padding: 10px 14px;
  border: 1px solid #23262f;
  border-radius: 6px;
  background: #13161c;
}

.控制台头 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.控制台头 h2 {
  margin: 0;
  font-size: 14px;
}

.控制台操作 {
  display: flex;
  align-items: center;
  gap: 8px;
}

.日志 {
  max-height: 190px;
  margin: 8px 0 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  font-size: 12px;
}

.日志 li {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  border-bottom: 1px solid #1c1f27;
}

.时间 {
  flex: 0 0 92px;
  color: var(--muted);
}

.账号标 {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 3px;
  background: #1c2027;
  color: #9aa4b2;
}

.级-success {
  color: #67c23a;
}

.级-warn {
  color: #e6a23c;
}

.级-error {
  color: #f56c6c;
}

.断线横幅 {
  padding: 8px 14px;
  border: 1px solid #6b5220;
  border-radius: 6px;
  background: #241d10;
  color: #e6a23c;
  font-size: 13px;
}

.账号条 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border: 1px solid #23262f;
  border-radius: 6px;
  background: #13161c;
}

.账号数 {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 1px;
}

.按钮组 {
  display: flex;
  gap: 8px;
}

.批量 {
  position: relative;
}

.菜单 {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 50;
  min-width: 150px;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid #2b3038;
  border-radius: 6px;
  background: #171b21;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.菜单 li {
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}

.菜单 li:hover {
  background: #22608f;
  color: #fff;
}

.菜单遮罩 {
  position: fixed;
  inset: 0;
  z-index: 45;
}

.列表块 {
  flex: 1;
  min-height: 0;
  padding: 10px 14px 14px;
  border: 1px solid #23262f;
  border-radius: 6px;
  background: #13161c;
  overflow-y: auto;
}

.表头,
.表行 {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
}

.列表工具 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.表头 {
  border-bottom: 1px solid #2a2e38;
  color: var(--muted);
  font-size: 12px;
}

.表行 {
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}

.表行 + .表行 {
  border-top: 1px solid #1c1f27;
}

.表行.当前 {
  background: #18222e;
  box-shadow: inset 2px 0 0 #3d7ebe;
}

.c-勾 {
  flex: 0 0 28px;
}

.c-账号 {
  flex: 1 1 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-游戏名 {
  flex: 0 0 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-状态 {
  flex: 0 0 190px;
  font-size: 12px;
  color: var(--muted);
}

.c-房间 {
  flex: 0 0 100px;
  color: #9aa4b2;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}

.c-地图 {
  flex: 0 0 130px;
  overflow: hidden;
  color: #9aa4b2;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-人数 {
  flex: 0 0 60px;
  color: #9aa4b2;
  font-size: 12px;
}

.c-人数.满 {
  color: #4caf7d;
}

.c-轮次 {
  flex: 0 0 46px;
  color: #9aa4b2;
  font-size: 12px;
}

.c-进度 {
  flex: 0 0 66px;
  color: #9aa4b2;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}

.c-观战码 {
  flex: 0 0 130px;
  overflow: hidden;
  color: #9aa4b2;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}

.c-操作 {
  flex: 0 0 186px;
  display: flex;
  gap: 6px;
}

.c-状态.态-logined {
  color: #67c23a;
}

.c-状态.态-pending {
  color: #e6a23c;
}

.c-状态.态-failed {
  color: #f56c6c;
}

.c-状态 em {
  color: #9aa4b2;
  font-style: normal;
}

.添加块 {
  flex: 0 0 auto;
  padding: 10px 14px;
  border: 1px solid #23262f;
  border-radius: 6px;
  background: #13161c;
}

.添加块 h2 {
  margin: 0 0 8px;
  font-size: 14px;
}

.添加行 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.添加行 label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.添加行 label > span {
  color: var(--muted);
  font-size: 12px;
}

.添加行 input {
  width: 200px;
  padding: 5px 8px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
}

.错误 {
  color: #f56c6c;
  font-size: 12px;
}

button.危险 {
  border-color: #6b3030;
  color: #e07b7b;
}

button.小 {
  padding: 2px 8px;
}

button {
  padding: 4px 12px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

button.主 {
  border-color: #3d7ebe;
  background: #22608f;
  color: #fff;
}

button.小 {
  padding: 2px 8px;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.灰 {
  color: var(--muted);
  font-size: 12px;
}

.空 {
  padding: 12px 0;
  color: var(--muted);
}
</style>