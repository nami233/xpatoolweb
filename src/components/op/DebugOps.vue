<script setup lang="ts">
import { computed, ref } from 'vue'
import type { session } from '@/stores/session'
import { reconnectAllBackends } from '@/stores/session'
import { defaultBackendUrl, backendSettings, saveBackendSettings } from '@/config'
import { backendLinkMessage, backendLinkState, commandCandidates, commandName, cmdId } from '@/net/backend'

const props = defineProps<{
  session: session
}>()

const session = props.session

const sendCommandName = ref('QueryRoomC2S')
const sendParams = ref('{\n  "MapMod": 0\n}')
const sending = ref(false)
const sendResult = ref('')

const commonCommands: string[] = [
  'QueryRoomC2S',
  'QuickJoinRoomC2S',
  'CreateRoomC2S',
  'JoinRoomC2S',
  'SyncRoomC2S',
  'RoomReadyC2S',
]

const currentCommandId = computed(() => cmdId(sendCommandName.value))
const currentReplyName = computed(() => {
  const Id = currentCommandId.value
  if (Id === undefined) return ''
  const name = commandName(Id + 1)
  return name.startsWith('CMD=') ? '' : name
})

const backendUrl = ref(backendSettings.url)
const backendToken = ref(backendSettings.token)

function onReconnectBackend(): void {
  backendSettings.url = backendUrl.value.trim() || defaultBackendUrl
  backendSettings.token = backendToken.value.trim()
  saveBackendSettings()
  reconnectAllBackends()
  session.pushLog(`后端改用 ${backendSettings.url}，已重连`)
}

async function send(): Promise<void> {
  sending.value = true
  sendResult.value = ''
  const result = await session.sendDebugCommand(sendCommandName.value, sendParams.value)
  sending.value = false
  if (!result.ok) {
    sendResult.value = `发送失败：${result.error}`
    return
  }
  const r = result.result
  if (!r) {
    sendResult.value = '发送失败：没有结果'
    return
  }
  sendResult.value = [
    `发出 ${sendCommandName.value} CMD=${r.cmdId} 包体=${r.bodyLen} 字节`,
    `hex: ${r.sendHex || '(空包体)'}`,
    `回包 ${r.respName} 包体=${r.respLen} 字节`,
    r.respJson,
  ].join('\n')
}

function formatTime(time: number): string {
  if (!time) return '-'
  const d = new Date(time)
  return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
</script>

<template>
  <div class="页">
    <section class="块">
      <div class="块头">
        <h3>状态</h3>
        <div class="计数">
          <span :class="`状态-${session.linkState}`">
            {{ session.linkLabel }}{{ session.linkMessage ? `（${session.linkMessage}）` : '' }}
          </span>
          <span>{{ session.loginLabel }}</span>
        </div>
      </div>

      <dl class="键值">
        <dt>SESSIONID</dt>
        <dd>{{ session.sessionId }}</dd>
        <dt>玩家</dt>
        <dd v-if="session.loginInfo">
          id={{ session.loginInfo.playerId }} 昵称={{
            session.loginInfo.playerNick || session.loginInfo.accountNick
          }}
          等级={{ session.loginInfo.playerLevel }} 平台={{ session.loginInfo.plat || '-' }}
        </dd>
        <dd v-else>-</dd>
        <dt>服务端时间</dt>
        <dd>{{ session.serverNowTime }}</dd>
        <dt>心跳</dt>
        <dd>
          发 {{ session.heartbeat.sent }} / 收 {{ session.heartbeat.recv }}（间隔
          {{ session.heartbeat.intervalMs }}ms，最近发送
          {{ formatTime(session.heartbeat.lastSentAt) }}，最近回包
          {{ formatTime(session.heartbeat.lastRecvAt) }}）
        </dd>
        <dt>等待应答</dt>
        <dd>{{ session.pendingCalls }}</dd>
      </dl>

      <div class="行">
        <button :disabled="!session.isLogined" @click="session.sendHeartbeat()">手动心跳</button>
        <label class="内联">
          <input v-model="session.heartbeat.enabled" type="checkbox" />
          <span>启用自动心跳</span>
        </label>
        <button :disabled="session.pulling" @click="session.pullServerConfig()">
          {{ session.pulling ? '拉取中…' : '拉取服务器地址' }}
        </button>
        <button @click="session.disconnect()">断开本地连接</button>
      </div>
      <p class="提示">
        目标地址 / 版本这些配置现在只在源码里改（<code>src/config.ts</code>）；
        「拉取服务器地址」会把接口返回的地址打到下面的日志里，不一致就照它改源码。
        「断开本地连接」只清这一端的显示 —— 服务端那个槽位会话照旧跑着（要真删就用主页的「移除」）。
      </p>
    </section>

    <section class="块">
      <div class="块头">
        <h3>后端</h3>
        <div class="计数">
          <span>{{ backendLinkState }}{{ backendLinkMessage ? `（${backendLinkMessage}）` : '' }}</span>
        </div>
      </div>
      <div class="行">
        <input v-model="backendUrl" class="命令框" placeholder="ws://127.0.0.1:8787" />
        <input v-model="backendToken" class="命令框" placeholder="令牌（本机开发留空）" />
        <button @click="onReconnectBackend">重连后端</button>
      </div>
      <p class="提示">
        地址 / 令牌存在本机（localStorage 的 <code>xpatoolweb.后端</code>）；改完点「重连后端」
        所有账号都会重挂到新后端上。令牌是后端 <code>XPA_TOKEN</code> 的部署级门禁，后端没配就留空。
      </p>
    </section>

    <section class="块">
      <div class="块头">
        <h3>手动发包</h3>
        <div class="计数">
          <span v-if="currentCommandId !== undefined">CMD={{ currentCommandId }}</span>
          <span v-if="currentReplyName">回包 {{ currentReplyName }}</span>
          <span v-if="!session.isLogined" class="灰">（未登录，服务端不会受理）</span>
        </div>
      </div>

      <div class="发包行">
        <input
          v-model="sendCommandName"
          class="命令框"
          list="命令候选"
          placeholder="如 QueryRoomC2S"
        />
        <datalist id="命令候选">
          <option v-for="name in commandCandidates" :key="name" :value="name" />
        </datalist>
        <div class="常用">
          <button v-for="name in commonCommands" :key="name" class="小" @click="sendCommandName = name">
            {{ name }}
          </button>
        </div>
      </div>

      <textarea
        v-model="sendParams"
        class="参数框"
        rows="5"
        spellcheck="false"
        placeholder="参数（JSON，字段名照结构写）；留空表示发空包体"
        @keydown.ctrl.enter="send"
      />

      <div class="行">
        <button class="主 小" :disabled="sending || !session.isLogined" @click="send">
          {{ sending ? '发送中…' : '发送（Ctrl+Enter）' }}
        </button>
        <span class="灰">64 位整型要写字符串（如 "2770253"），bytes 写十六进制串</span>
      </div>

      <pre v-if="sendResult" class="结果">{{ sendResult }}</pre>
    </section>

    <section class="块">
      <div class="块头">
        <h3>这个账号的日志</h3>
        <button class="小" @click="session.clearLogs()">清空</button>
      </div>
      <ul class="日志">
        <li v-for="item in session.myLogs" :key="item.id" :class="`级-${item.level}`">
          <span class="时间">{{ formatTime(item.time) }}</span>
          <span>{{ item.text }}</span>
        </li>
        <li v-if="session.myLogs.length === 0" class="空">暂无日志</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.页 {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.块 {
  padding: 12px 14px;
  border: 1px solid #23262f;
  border-radius: 6px;
  background: #13161c;
}

.块头 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.块头 h3 {
  margin: 0;
  font-size: 14px;
}

.计数 {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
}

.状态-connected {
  color: #67c23a;
}

.状态-error,
.状态-closed {
  color: #f56c6c;
}

.键值 {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 6px 12px;
  margin: 10px 0 0;
  font-size: 13px;
}

.键值 dt {
  color: var(--muted);
}

.键值 dd {
  margin: 0;
  word-break: break-all;
}

.行 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

label.内联 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
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

.发包行 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
}

.命令框 {
  flex: 0 0 240px;
  padding: 5px 8px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
}

.常用 {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.参数框 {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  resize: vertical;
}

.结果 {
  margin: 10px 0 0;
  padding: 10px;
  max-height: 320px;
  overflow: auto;
  border: 1px solid #2b3038;
  border-radius: 4px;
  background: #101317;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.提示 {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.提示 code {
  padding: 1px 4px;
  border-radius: 3px;
  background: #14161c;
}

.灰 {
  color: var(--muted);
  font-size: 12px;
}

.日志 {
  max-height: 300px;
  margin: 10px 0 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  font-size: 12px;
}

.日志 li {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px solid #1c1f27;
}

.时间 {
  flex: 0 0 92px;
  color: var(--muted);
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

.空 {
  padding: 12px 0;
  color: var(--muted);
}
</style>