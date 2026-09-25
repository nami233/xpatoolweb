<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { usePacketLogStore } from '@/stores/packetLog'
import { useAccounts } from '@/stores/accounts'
import type { AccountSlot } from '@/stores/accounts'
import { commandCandidates, commandName, cmdId } from '@/net/backend'

const packetLog = usePacketLogStore()
const { slotList } = useAccounts()

const newFilter = ref('')
const autoScroll = ref(true)
const listRef = ref<HTMLElement | null>(null)

const sendableSlots = computed(() => slotList.filter((accountSlot) => accountSlot.session.isLogined))
const selectedSlot = ref<AccountSlot | null>(null)

watch(
  sendableSlots,
  (list) => {
    if (!list.includes(selectedSlot.value as AccountSlot)) selectedSlot.value = list[0] ?? null
  },
  { immediate: true },
)

const filteredCount = computed(() => packetLog.counters.filtered)

const commonCommands: string[] = [
  'QueryRoomC2S',
  'QuickJoinRoomC2S',
  'CreateRoomC2S',
  'JoinRoomC2S',
  'SyncRoomC2S',
  'RoomReadyC2S',
]
const sendCommandName = ref('QueryRoomC2S')
const sendParams = ref('{\n  "MapMod": 0\n}')
const sending = ref(false)
const sendResult = ref('')

const currentCommandId = computed(() => cmdId(sendCommandName.value))
const currentReplyName = computed(() => {
  const Id = currentCommandId.value
  if (Id === undefined) return ''
  const name = commandName(Id + 1)
  return name.startsWith('CMD=') ? '' : name
})

function addFilter(): void {
  packetLog.addFilter(newFilter.value)
  newFilter.value = ''
}

function onSaveCapture(): void {
  const accountSlot = selectedSlot.value ?? slotList[0]
  if (!accountSlot) return
  void accountSlot.session.saveCaptureToFile(packetLog.exportText())
}

async function send(): Promise<void> {
  const accountSlot = selectedSlot.value
  if (!accountSlot) return
  sending.value = true
  sendResult.value = ''
  const result = await accountSlot.session.sendDebugCommand(sendCommandName.value, sendParams.value)
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
    `账号 ${accountSlot.session.displayName}`,
    `发出 ${sendCommandName.value} CMD=${r.cmdId} 包体=${r.bodyLen} 字节`,
    `hex: ${r.sendHex || '(空包体)'}`,
    `回包 ${r.respName} 包体=${r.respLen} 字节`,
    r.respJson,
  ].join('\n')
}

function formatTime(time: number): string {
  const d = new Date(time)
  return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

watch(
  () => packetLog.entries.length,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    const el = listRef.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <div class="页">
    <section class="块">
      <div class="块头">
        <h2>抓包</h2>
        <div class="计数">
          <span>发送 {{ packetLog.counters.send }}</span>
          <span>接收 {{ packetLog.counters.recv }}</span>
          <span>已过滤 {{ filteredCount }}</span>
          <span>列表 {{ packetLog.entries.length }} / {{ packetLog.total }}</span>
        </div>
      </div>

      <div class="行">
        <label class="内联">
          <input v-model="packetLog.paused" type="checkbox" />
          <span>暂停记录</span>
        </label>
        <label class="内联">
          <input v-model="packetLog.filterEnabled" type="checkbox" />
          <span>启用过滤</span>
        </label>
        <label class="内联">
          <input v-model="autoScroll" type="checkbox" />
          <span>自动滚动</span>
        </label>
        <button class="小" @click="packetLog.clear()">清空</button>
        <button class="小" @click="onSaveCapture">保存到文件</button>
        <span class="灰">（保存交给桥接写进 %USERPROFILE%\jxpd）</span>
      </div>

      <div class="过滤">
        <span class="过滤标">过滤规则（命中任一即不打印，子串匹配；也能按账号过滤）：</span>
        <span v-for="(rule, index) in packetLog.filters" :key="`${rule}-${index}`" class="标签">
          {{ rule }}
          <button class="标签删" @click="packetLog.removeFilter(index)">x</button>
        </span>
        <span v-if="packetLog.filters.length === 0" class="灰">（无）</span>
        <input
          v-model="newFilter"
          class="过滤框"
          placeholder="如 CMD=5003 或手机号"
          @keyup.enter="addFilter"
        />
        <button class="小" @click="addFilter">添加</button>
      </div>
    </section>

    <section class="块">
      <div class="块头">
        <h2>手动发包</h2>
        <div class="计数">
          <span v-if="currentCommandId !== undefined">CMD={{ currentCommandId }}</span>
          <span v-if="currentReplyName">回包 {{ currentReplyName }}</span>
        </div>
      </div>

      <div class="行">
        <label class="内联">
          <span>用哪个账号发</span>
          <select v-model="selectedSlot">
            <option :value="null">（选一个已登录账号）</option>
            <option v-for="accountSlot in sendableSlots" :key="accountSlot.slot" :value="accountSlot">
              {{ accountSlot.session.displayName }}
            </option>
          </select>
        </label>
        <span v-if="sendableSlots.length === 0" class="灰">
          （没有已登录的账号，回主页面勾上账号点「登录账号」）
        </span>
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
        <button class="主 小" :disabled="sending || !selectedSlot" @click="send">
          {{ sending ? '发送中…' : '发送（Ctrl+Enter）' }}
        </button>
        <span class="灰">64 位整型要写字符串（如 "2770253"），bytes 写十六进制串</span>
      </div>

      <pre v-if="sendResult" class="结果">{{ sendResult }}</pre>
    </section>

    <section class="块 表块">
      <div class="表头">
        <span class="col-dir">方向</span>
        <span class="col-time">时间</span>
        <span class="col-acc">账号</span>
        <span class="col-cmd">命令</span>
        <span class="col-len">包体</span>
        <span class="col-sn">UPSN/DOWNSN</span>
        <span class="col-err">ERR</span>
        <span class="col-body">包体（前 128 字节）</span>
      </div>
      <div ref="listRef" class="表身">
        <div v-for="entry in packetLog.entries" :key="entry.id" class="行项">
          <span class="col-dir" :class="entry.direction === 'send' ? '发' : '收'">
            {{ entry.direction === 'send' ? '发 ->' : '收 <-' }}
          </span>
          <span class="col-time">{{ formatTime(entry.time) }}</span>
          <span class="col-acc">{{ entry.account || '-' }}</span>
          <span class="col-cmd">{{ entry.name }}</span>
          <span class="col-len">{{ entry.bodyLen }}</span>
          <span class="col-sn">{{ entry.upsn }}/{{ entry.downsn }}</span>
          <span class="col-err" :class="{ bad: entry.err !== 0 }">{{ entry.err }}</span>
          <span class="col-body">
            <code>{{ entry.hexPreview }}</code>
            <span class="灰"> | {{ entry.text }}</span>
          </span>
        </div>
        <p v-if="packetLog.entries.length === 0" class="空">
          暂无报文（回主页面登录账号后就有了）
        </p>
      </div>
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

.块头 h2 {
  margin: 0;
  font-size: 14px;
}

.计数 {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  color: var(--muted);
  font-size: 12px;
}

.行 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}

label.内联 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

select,
input {
  padding: 4px 8px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
}

button {
  padding: 4px 10px;
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

.过滤 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 12px;
}

.过滤标 {
  color: var(--muted);
}

.标签 {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid #3a3f4b;
  border-radius: 3px;
  background: #14161c;
}

.标签删 {
  padding: 0 2px;
  border: none;
  background: none;
  color: #f56c6c;
  font-size: 11px;
  cursor: pointer;
}

.过滤框 {
  width: 150px;
  padding: 3px 6px;
  font-size: 12px;
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

.表块 {
  padding: 12px 12px 0;
}

.表头,
.行项 {
  display: grid;
  grid-template-columns: 46px 92px 110px 170px 52px 130px 46px minmax(280px, 1fr);
  gap: 8px;
  align-items: baseline;
}

.表头 {
  padding-bottom: 6px;
  border-bottom: 1px solid #2a2e38;
  color: var(--muted);
  font-size: 12px;
}

.表身 {
  max-height: calc(100vh - 420px);
  overflow: auto;
}

.行项 {
  padding: 3px 0;
  border-bottom: 1px solid #1c1f27;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  white-space: nowrap;
}

.发 {
  color: #67c23a;
}

.收 {
  color: #7cb6e8;
}

.col-err.坏 {
  color: #f56c6c;
}

.col-body {
  overflow: hidden;
  text-overflow: ellipsis;
}

.灰 {
  color: var(--muted);
  font-size: 12px;
}

.空 {
  color: var(--muted);
  font-size: 13px;
}
</style>