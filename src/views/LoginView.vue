<script setup lang="ts">
import { computed, ref } from 'vue'
import { goHome } from '@/router'
import { useUser } from '@/stores/user'
import { backendLinkState, backendLinkMessage } from '@/net/backend'

const { login, register, userMessage, binding } = useUser()

const mode = ref<'登录' | '注册'>('登录')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const rememberPassword = ref(false)

const rememberKey = 'xpatoolweb.记住密码'

/** 勾了「记住密码」就把用户名/密码明文存在这台浏览器里，下次打开自动填好 */
function readRemembered(): { username: string; password: string } | null {
  try {
    const rawText = localStorage.getItem(rememberKey)
    if (rawText === null) return null
    const value = JSON.parse(rawText) as { username?: unknown; password?: unknown }
    if (typeof value.username !== 'string' || typeof value.password !== 'string') return null
    return { username: value.username, password: value.password }
  } catch {
    return null
  }
}

function saveRemembered(usernameValue: string, passwordValue: string): void {
  try {
    localStorage.setItem(rememberKey, JSON.stringify({ username: usernameValue, password: passwordValue }))
  } catch {
  }
}

function clearRemembered(): void {
  try {
    localStorage.removeItem(rememberKey)
  } catch {
  }
}

const lastRemembered = readRemembered()
if (lastRemembered !== null) {
  username.value = lastRemembered.username
  password.value = lastRemembered.password
  rememberPassword.value = true
}

/** 当场取消勾选就立刻忘掉，不必等到下次提交 */
function toggleRemember(): void {
  if (!rememberPassword.value) clearRemembered()
}

const invalidName = computed(() => {
  const name = username.value.trim()
  return name.length > 0 && (name.length > 32 || /\s/.test(name))
})

const canSubmit = computed(
  () =>
    username.value.trim().length > 0
    && !invalidName.value
    && password.value.length > 0
    && (mode.value === '登录' || password.value === confirmPassword.value),
)

function toggleMode(): void {
  mode.value = mode.value === '登录' ? '注册' : '登录'
  userMessage.value = ''
  confirmPassword.value = ''
}

async function submit(): Promise<void> {
  if (!canSubmit.value || binding.value) return
  const name = username.value.trim()
  const result = mode.value === '登录' ? await login(name, password.value) : await register(name, password.value)
  if (!result.ok) return
  // 注册模式下不动上一次记住的那份（别把别人的密码顺手删了）
  if (mode.value === '登录') {
    if (rememberPassword.value) saveRemembered(name, password.value)
    else clearRemembered()
  }
  // 绑定成了，接下来只是切页面；切不过去就把原因写在卡片上，别让人只看到「点了没反应」
  const fail = await goHome()
  if (fail !== null) {
    userMessage.value = `已登录，但${fail}`
    return
  }
  password.value = ''
  confirmPassword.value = ''
}
</script>

<template>
  <div class="登录页">
    <section class="卡片">
      <h2>xpatoolweb</h2>
      <p class="说明">
        用 xpatoolweb 账号登录。游戏账号由你在登录后自己添加，按账号隔离存在服务端。
      </p>

      <div class="切换">
        <button :class="{ 选中: mode === '登录' }" @click="mode = '登录'">登录</button>
        <button :class="{ 选中: mode === '注册' }" @click="mode = '注册'">注册</button>
      </div>

      <label>
        <span>用户名</span>
        <input v-model="username" placeholder="登录本工具用的名字" @keyup.enter="submit" />
      </label>
      <label>
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          :placeholder="mode === '登录' ? '登录密码' : '设一个密码'"
          @keyup.enter="submit"
        />
      </label>
      <label v-if="mode === '注册'">
        <span>再输一遍</span>
        <input v-model="confirmPassword" type="password" placeholder="确认密码" @keyup.enter="submit" />
      </label>

      <div v-if="mode === '登录'" class="记住行">
        <input id="记住密码" v-model="rememberPassword" type="checkbox" @change="toggleRemember" />
        <label for="记住密码">记住密码（下次打开自动填好，明文存在这台浏览器里）</label>
      </div>

      <p v-if="invalidName" class="错误">用户名不超过 32 个字符，且不能有空白字符</p>
      <p v-else-if="mode === '注册' && confirmPassword.length > 0 && password !== confirmPassword" class="错误">
        两次输入的密码不一样
      </p>
      <p v-if="userMessage" class="错误">{{ userMessage }}</p>

      <button class="主" :disabled="!canSubmit || binding" @click="submit">
        {{ binding ? '处理中…' : mode === '登录' ? '登录' : '注册并进入' }}
      </button>

      <p class="灰">后端：{{ backendLinkState }}<template v-if="backendLinkMessage"> · {{ backendLinkMessage }}</template></p>
      <p class="灰">
        注册可以关掉（后端设 <code>XPA_ALLOW_REGISTER=0</code>）；关掉后只能用已有账号登录。
      </p>
    </section>
  </div>
</template>

<style scoped>
.登录页 {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 6vh;
}

.卡片 {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 360px;
  padding: 20px 22px 18px;
  border: 1px solid #23262f;
  border-radius: 8px;
  background: #13161c;
}

.卡片 h2 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 1px;
}

.说明 {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.切换 {
  display: flex;
  gap: 6px;
  margin: 4px 0 2px;
}

.切换 button {
  flex: 1;
  padding: 5px 0;
}

button {
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #1b1f27;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

button.主 {
  background: #22608f;
  border-color: #3d7ebe;
  color: #fff;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.切换 button.选中 {
  border-color: #3d7ebe;
  background: #22608f;
  color: #fff;
}

label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

label > span {
  flex: 0 0 62px;
  color: var(--muted);
  font-size: 12px;
}

label input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
}

.错误 {
  margin: 0;
  color: #f56c6c;
  font-size: 12px;
}

.记住行 {
  display: flex;
  align-items: center;
  gap: 6px;
}

.记住行 label {
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.主 {
  margin-top: 6px;
  padding: 7px 0;
}

.灰 {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

code {
  padding: 0 3px;
  border-radius: 3px;
  background: #1c2027;
}
</style>