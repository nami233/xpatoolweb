<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAccounts } from '@/stores/accounts'
import { accountLimit } from '@/config'

const emit = defineEmits<{ close: [] }>()

const { slotList } = useAccounts()

const battleSlots = computed(() =>
  slotList.filter((accountSlot) => accountSlot.checked && accountSlot.session.isLogined).slice(0, accountLimit),
)

const roomId = ref('')
const password = ref('')

const joiningRoom = ref(false)
const state = ref('')

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

async function submit(): Promise<void> {
  if (joiningRoom.value) return
  const names = battleSlots.value
  const Id = roomId.value.trim()
  if (names.length === 0) {
    state.value = '先在主页面勾选账号（要已登录）'
    return
  }
  if (Id.length === 0) {
    state.value = '先填房间号'
    return
  }

  const slotsInRoom = names.filter((accountSlot) => accountSlot.session.room.inRoom)
  if (slotsInRoom.length > 0) {
    state.value = `账号 ${slotsInRoom.map((accountSlot) => accountSlot.session.displayName).join('、')} 还在房间里，先「退出房间」`
    return
  }

  const scout = names[0]
  if (!scout) return

  joiningRoom.value = true
  try {
    state.value = `查房间 ${Id}…`
    const queryResult = await scout.session.searchRoom(Id)
    if (!queryResult) {
      state.value = `查不到房间 ${Id}（房间号错了 / 房间已解散，看控制台日志）`
      return
    }
    const roomServerId = toNumber(queryResult.RoomServerId)
    const hasPassword = queryResult.IsPwd === true
    if (hasPassword && password.value.length === 0) {
      state.value = `房间 ${Id} 有密码，先填密码再进`
      return
    }

    const failedSlots: string[] = []
    for (const accountSlot of names) {
      state.value = `账号 ${accountSlot.session.displayName} 正在进房 ${Id}…`
      const joined = await accountSlot.session.joinRoom(Id, hasPassword ? password.value : '', roomServerId)
      if (!joined) failedSlots.push(accountSlot.session.displayName)
      await new Promise((done) => setTimeout(done, 400))
    }

    state.value =
      failedSlots.length === 0
        ? `${names.length} 个账号都进了房间 ${Id}`
        : `进了房间 ${Id}，但账号 ${failedSlots.join('、')} 没进去（看日志重试）`
  } finally {
    joiningRoom.value = false
  }
}
</script>

<template>
  <div class="窗层">
    <div class="遮罩" @click="emit('close')" />

    <section class="窗">
      <header class="窗头">
        <h3>进入房间</h3>
        <span class="灰">{{ battleSlots.length }} 个账号依次进房</span>
        <button class="关" @click="emit('close')">×</button>
      </header>

      <p v-if="battleSlots.length === 0" class="提示 警告">
        先在主页面勾选账号（要已登录）再来进房。
      </p>

      <div class="表单">
        <label><span>房间号</span><input v-model="roomId" placeholder="要进的房间号" /></label>
        <label><span>密码</span><input v-model="password" placeholder="房间有密码才填" /></label>
      </div>

      <p v-if="state" class="提示 警告">{{ state }}</p>
      <p class="提示">
        会先按房间号查一次（拿房间服、判断有没有密码），再让每个账号依次进房；
        房间号 / 人数在账号列上能看到是否真的进去了。
      </p>

      <footer class="窗脚">
        <button :disabled="joiningRoom" @click="emit('close')">关闭</button>
        <button
          class="主"
          :disabled="joiningRoom || battleSlots.length === 0 || roomId.trim().length === 0"
          @click="submit"
        >
          {{ joiningRoom ? '进房中…' : '进房' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.窗层 {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
}

.遮罩 {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
}

.窗 {
  position: relative;
  width: min(520px, 92vw);
  max-height: 88vh;
  overflow-y: auto;
  padding: 14px 16px;
  border: 1px solid #2b3038;
  border-radius: 8px;
  background: #13161c;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
}

.窗头 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid #23262f;
}

.窗头 h3 {
  margin: 0;
  font-size: 15px;
}

.关 {
  margin-left: auto;
  padding: 2px 10px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 16px;
  line-height: 1.2;
  cursor: pointer;
}

.表单 {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 12px;
}

.表单 label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.表单 label > span {
  color: var(--muted);
  font-size: 12px;
}

.表单 input {
  width: 170px;
  padding: 4px 6px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
}

.窗脚 {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid #23262f;
}

button {
  padding: 5px 14px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

button.主 {
  border-color: #3d7ebe;
  background: #22608f;
  color: #fff;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.提示 {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.提示.警告 {
  color: #e0a33e;
}

.灰 {
  color: var(--muted);
  font-size: 12px;
}
</style>