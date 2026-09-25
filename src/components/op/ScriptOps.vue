<script setup lang="ts">
/**
 * 脚本页签：写一段 JS，让它在**后端进程**里钩住游戏事件。
 *
 * 三条要记住的事（界面上也写着）：
 *  1. 脚本跑在后端，页面关掉照旧跑；这里的「运行态」只是后端的投影。
 *  2. 源码存后端（`scripts.json`），本地的 localStorage 只存草稿。
 *  3. 「保存」会重新编译，正在跑的那份会停下来，要再点一次运行。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { session } from '@/stores/session'

const props = defineProps<{
  session: session
}>()

const session = props.session

const source = ref('')
/** 后端存档的那份：与 `源码` 不等就是「改动过」（草稿态） */
const savedSource = ref('')
const loading = ref(true)
const busy = ref(false)
const hint = ref('')
const hintLevel = ref<'info' | 'success' | 'error'>('info')

const draftKey = `xpatoolweb.脚本.草稿.${session.slot}`

const changed = computed(() => source.value !== savedSource.value)

const runStateClass = computed(() => {
  switch (session.ScriptRunState) {
    case '运行中':
      return '态-运行中'
    case '出错停用':
      return '态-出错'
    case '已停止':
      return '态-已停止'
    default:
      return '态-未载入'
  }
})

function toast(text: string, level: 'info' | 'success' | 'error' = 'info'): void {
  hint.value = text
  hintLevel.value = level
}

onMounted(() => {
  // 没登录时后端那个槽位还没建出来，问了也是白问（会一路等到超时）
  if (session.isLogined) void pullOnce()
})

// 登录完了再拉：进抽屉时还没登录是常规路径
watch(
  () => session.isLogined,
  (value, prevValue) => {
    if (value && !prevValue) void pullOnce()
  },
)

async function pullOnce(): Promise<void> {
  loading.value = true
  const result = await session.readScript()
  loading.value = false
  if (!result.ok) {
    toast(`读取脚本失败：${result.error ?? '未知原因'}`, 'error')
    return
  }
  savedSource.value = result.source
  // 本地草稿优先：用户上一版没保存就走了，别让后端的旧存档盖掉它
  let draft: string | null = null
  try {
    draft = localStorage.getItem(draftKey)
  } catch {
    draft = null
  }
  source.value = draft ?? result.source
  if (changed.value) toast('本地草稿与后端存档不同，下面显示的是草稿；点「保存」写回后端')
}

// 只写本地：草稿不落后端，用户点保存才算数
watch(source, (value) => {
  try {
    localStorage.setItem(draftKey, value)
  } catch {
    // 隐私模式下 localStorage 会抛，草稿丢了不影响主流程
  }
})

async function onSave(): Promise<void> {
  busy.value = true
  hint.value = ''
  const result = await session.saveScript(source.value)
  busy.value = false
  if (!result.ok) {
    toast(`保存失败：${result.error ?? '未知原因'}`, 'error')
    return
  }
  savedSource.value = source.value
  toast('已保存到后端。保存会重新编译，脚本已停下，点「运行」才会跑', 'success')
}

async function saveAndRun(): Promise<void> {
  busy.value = true
  hint.value = ''
  const save = await session.saveScript(source.value)
  if (!save.ok) {
    busy.value = false
    toast(`保存失败：${save.error ?? '未知原因'}`, 'error')
    return
  }
  savedSource.value = source.value
  const run = await session.runScript()
  busy.value = false
  if (!run.ok) {
    toast(`运行失败：${run.error ?? '未知原因'}`, 'error')
    return
  }
  toast('脚本已在后端跑起来', 'success')
}

async function onRun(): Promise<void> {
  busy.value = true
  hint.value = ''
  const result = await session.runScript()
  busy.value = false
  if (!result.ok) {
    toast(`运行失败：${result.error ?? '未知原因'}`, 'error')
    return
  }
  toast('脚本已在后端跑起来', 'success')
}

async function stop(): Promise<void> {
  busy.value = true
  hint.value = ''
  const result = await session.stopScript()
  busy.value = false
  if (!result.ok) {
    toast(`停止失败：${result.error ?? '未知原因'}`, 'error')
    return
  }
  toast('脚本已停', 'success')
}

function discardChanges(): void {
  source.value = savedSource.value
  toast('已回到后端存档的那一份')
}
</script>

<template>
  <div class="页">
    <section class="块">
      <div class="块头">
        <h3>脚本引擎</h3>
        <div class="计数">
          <span :class="runStateClass">{{ session.ScriptRunState }}</span>
          <span class="灰">{{ session.scriptDetail }}</span>
        </div>
      </div>

      <div class="行">
        <button
          class="主"
          :disabled="busy || loading || !session.isLogined"
          @click="saveAndRun"
        >
          {{ busy ? '处理中…' : '保存并运行' }}
        </button>
        <button :disabled="busy || loading || !session.isLogined" @click="onSave">保存</button>
        <button
          :disabled="busy || loading || !session.isLogined || changed || session.ScriptRunState === '运行中'"
          @click="onRun"
        >
          运行
        </button>
        <button
          :disabled="busy || loading || session.ScriptRunState !== '运行中'"
          @click="stop"
        >
          停止
        </button>
        <button v-if="changed" class="小" :disabled="busy" @click="discardChanges">丢弃改动</button>
        <span v-if="changed" class="灰">未保存</span>
        <span v-if="!session.isLogined" class="灰">（未登录，后端建不出槽位）</span>
      </div>

      <p v-if="hint" class="提示" :class="`提示-${hintLevel}`">{{ hint }}</p>

      <textarea
        v-model="source"
        class="源码框"
        rows="16"
        spellcheck="false"
        :disabled="loading && session.isLogined"
        placeholder="game.when('待办', (game, action) => { game.logs('待办 ' + action.commandName) })"
        @keydown.ctrl.enter="saveAndRun"
      />
      <p class="提示">
        脚本跑在后端进程里，页码关掉也照旧跑；「运行态」是后端报回来的。
        事件名可以写服务端命令名（如 <code>MoveS2C</code>）、语义名（
        <code>进入对局</code> / <code>离开房间</code> / <code>轮次</code> /
        <code>待办</code> / <code>战斗开始</code> / <code>战斗结束</code>）或别名（
        <code>move</code> / <code>MonsterRefresh</code> / <code>progress</code> /
        <code>attrChange</code>）。接口文档见
        <code>.trae/documents/脚本引擎接口文档.md</code>。
        脚本里的 <code>console.log</code> 与 <code>game.logs()</code> 都进下面的日志。
      </p>
    </section>

    <section class="块">
      <div class="块头">
        <h3>这个账号的日志</h3>
        <button class="小" @click="session.clearLogs()">清空</button>
      </div>
      <ul class="日志">
        <li v-for="item in session.myLogs" :key="item.id" :class="`级-${item.level}`">
          <span class="时间">{{ new Date(item.time).toLocaleTimeString() }}</span>
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
  font-size: 12px;
}

.态-运行中 {
  color: #67c23a;
}

.态-出错 {
  color: #f56c6c;
}

.态-未载入,
.态-已停止 {
  color: var(--muted);
}

.行 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
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

.源码框 {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 10px;
  padding: 8px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}

.提示 {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.提示-success {
  color: #67c23a;
}

.提示-error {
  color: #f56c6c;
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
  max-height: 260px;
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