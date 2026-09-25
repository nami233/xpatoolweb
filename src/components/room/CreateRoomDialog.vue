<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { session } from '@/stores/session'
import { useAccounts } from '@/stores/accounts'
import { accountLimit } from '@/config'
import {
  mapNameTable,
  displayName,
  lobbyModeList,
  roomModeTable,
  modeMapList,
  modeConditionList,
  thinkTimeTable,
  defaultThinkMs,
  gameSpeedTable,
  defaultGameSpeed,
  roomTagTable,
  difficultyNameTable,
  mapDifficultyList,
  isDifficultyBased,
  pveCondition,
} from '@/data/names'

const emit = defineEmits<{ close: [] }>()

const { slotList } = useAccounts()

const battleSlots = computed(() =>
  slotList.filter((accountSlot) => accountSlot.checked && accountSlot.session.isLogined).slice(0, accountLimit),
)

const modeCandidates = lobbyModeList.map((value) => ({ value, name: roomModeTable[value]?.name ?? String(value) }))

const mode = ref(lobbyModeList[0] ?? 1)

const form = ref({
  roomName: '',
  password: '',
  mapId: modeMapList(mode.value)[0] ?? 81003,
  condition: modeConditionList(mode.value)[0] ?? 1,
  thinkTime: defaultThinkMs,
  speed: defaultGameSpeed,
  difficulty: 0,
  label: 0,
  skipStory: false,
})

const mapCandidates = computed(() => modeMapList(mode.value))
const conditionCandidates = computed(() => modeConditionList(mode.value))
const PVE = computed(() => isDifficultyBased(mode.value))
const difficultyCandidates = computed(() => mapDifficultyList(Number(form.value.mapId)))
const pveConditionValue = computed(() => (PVE.value ? pveCondition(Number(form.value.difficulty)) : undefined))

watch(mode, () => {
  if (!mapCandidates.value.includes(form.value.mapId)) {
    form.value.mapId = mapCandidates.value[0] ?? 0
  }
  if (!PVE.value && !conditionCandidates.value.includes(form.value.condition)) {
    form.value.condition = conditionCandidates.value[0] ?? 1
  }
})

watch(
  () => [PVE.value, form.value.difficulty] as const,
  () => {
    const toPush = pveConditionValue.value
    if (toPush !== undefined) form.value.condition = toPush
  },
  { immediate: true },
)

watch(
  () => form.value.mapId,
  (mapId) => {
    if (!mapDifficultyList(Number(mapId)).includes(form.value.difficulty)) form.value.difficulty = 0
  },
)

const creatingRoom = ref(false)
const state = ref('')

async function getRoomServer(hostSession: session, roomId: string): Promise<number> {
  const hostRoomServerId = Number(hostSession.room.room?.RoomServerId ?? 0)
  if (hostRoomServerId > 0) return hostRoomServerId
  for (let i = 0; i < 3; i += 1) {
    const queryResult = await hostSession.searchRoom(roomId)
    if (queryResult) return Number(queryResult.RoomServerId ?? 0)
    await new Promise((done) => setTimeout(done, 400))
  }
  return 0
}

async function submit(): Promise<void> {
  if (creatingRoom.value) return
  const names = battleSlots.value
  if (names.length === 0) {
    state.value = '先在主页面勾选账号（已登录的）'
    return
  }
  const hostSlot = names[0]
  const guests = names.slice(1)
  if (!hostSlot) return

  const formValue = form.value
  const mapId = Number(formValue.mapId)
  if (!mapCandidates.value.includes(mapId)) {
    state.value = `模式「${roomModeTable[mode.value]?.name ?? mode.value}」不支持地图 ${mapId}，换一张地图或换个模式`
    return
  }
  if (PVE.value && pveConditionValue.value === undefined) {
    state.value = `难度「${difficultyNameTable[Number(formValue.difficulty)] ?? formValue.difficulty}」没有对应的条件映射，换一档再试`
    return
  }
  const slotsInRoom = guests.filter((accountSlot) => accountSlot.session.room.inRoom)
  if (slotsInRoom.length > 0) {
    state.value = `账号 ${slotsInRoom.map((accountSlot) => accountSlot.session.displayName).join('、')} 还在房间里，先「退出房间」`
    return
  }

  const host = hostSlot.session
  const hostName = host.displayName
  creatingRoom.value = true
  try {
    state.value =
      guests.length > 0
        ? `账号 ${hostName} 建房…（之后 ${guests.length} 个账号自动进房）`
        : `账号 ${hostName} 建房…`

    const created = await host.createRoom({
      roomName: formValue.roomName || (host.loginInfo?.playerNick ?? '网页房'),
      password: formValue.password,
      mode: mode.value,
      mapId,
      condition: Number(formValue.condition),
      thinkTime: Number(formValue.thinkTime),
      speed: Number(formValue.speed),
      difficulty: Number(formValue.difficulty),
      label: Number(formValue.label),
      skipStory: formValue.skipStory,
    })
    if (!created) {
      state.value = `账号 ${hostName} 建房失败（看控制台日志）`
      return
    }

    const roomId = host.room.roomId
    if (roomId.length === 0) {
      state.value = '建房成功但没拿到房间号'
      return
    }

    if (guests.length === 0) {
      emit('close')
      return
    }

    const roomServerId = await getRoomServer(host, roomId)
    state.value = `房间 ${roomId} 已建好，其他账号进房中…`
    const failedSlots: string[] = []
    for (const accountSlot of guests) {
      state.value = `账号 ${accountSlot.session.displayName} 正在进房 ${roomId}…`
      const joined = await accountSlot.session.joinRoom(roomId, formValue.password, roomServerId)
      if (!joined) failedSlots.push(accountSlot.session.displayName)
      await new Promise((done) => setTimeout(done, 400))
    }

    if (failedSlots.length === 0) {
      emit('close')
      return
    }
    state.value = `房间 ${roomId} 建好，但账号 ${failedSlots.join('、')} 没进去（看日志重试）`
  } finally {
    creatingRoom.value = false
  }
}
</script>

<template>
  <div class="窗层">
    <div class="遮罩" @click="emit('close')" />

    <section class="窗">
      <header class="窗头">
        <h3>创建房间</h3>
        <span class="灰">
          房主：{{ battleSlots[0]?.session.displayName ?? '（还没勾选账号）' }}
          <template v-if="battleSlots.length > 1">，另外 {{ battleSlots.length - 1 }} 个自动进房</template>
        </span>
        <button class="关" @click="emit('close')">×</button>
      </header>

      <p v-if="battleSlots.length === 0" class="提示 警告">
        先在主页面勾选账号（要已登录）再来建房。
      </p>

      <div class="表单">
        <label>
          <span>模式</span>
          <select v-model.number="mode">
            <option v-for="item in modeCandidates" :key="item.value" :value="item.value">
              {{ item.name }}（{{ item.value }}）
            </option>
          </select>
        </label>
        <label><span>房名</span><input v-model="form.roomName" placeholder="留空用昵称" /></label>
        <label><span>密码</span><input v-model="form.password" placeholder="留空=无密码" /></label>
        <label>
          <span>地图</span>
          <select v-model.number="form.mapId">
            <option v-for="map in mapCandidates" :key="map" :value="map">
              {{ displayName(mapNameTable, map) }}
            </option>
          </select>
        </label>
        <label>
          <span>条件</span>
          <select v-if="!PVE" v-model.number="form.condition">
            <option v-for="value in conditionCandidates" :key="value" :value="value">条件 {{ value }}</option>
          </select>
          <input
            v-else
            :value="pveConditionValue ?? '未知'"
            disabled
            title="合作挑战/畸变组件的条件由难度决定，不能手选"
          />
        </label>
        <label>
          <span>思考时间</span>
          <select v-model.number="form.thinkTime">
            <option v-for="(name, value) in thinkTimeTable" :key="value" :value="Number(value)">{{ name }}</option>
          </select>
        </label>
        <label>
          <span>速度</span>
          <select v-model.number="form.speed">
            <option v-for="(name, value) in gameSpeedTable" :key="value" :value="Number(value)">{{ name }}</option>
          </select>
        </label>
        <label>
          <span>难度</span>
          <select v-if="difficultyCandidates.length > 0" v-model.number="form.difficulty">
            <option v-for="value in difficultyCandidates" :key="value" :value="value">{{ value }} {{ difficultyNameTable[value] }}</option>
          </select>
          <input v-else :value="0" disabled title="这张图没有难度档位，Difficulty 固定发 0" />
        </label>
        <label>
          <span>房间标签</span>
          <select v-model.number="form.label">
            <option v-for="(name, value) in roomTagTable" :key="value" :value="Number(value)">{{ name }}</option>
          </select>
        </label>
        <label class="内联">
          <input v-model="form.skipStory" type="checkbox" />
          <span>跳过剧情</span>
        </label>
      </div>

      <p v-if="state" class="提示 警告">{{ state }}</p>
      <p class="提示">
        地图/条件/难度跟着模式与地图走（配置表决定的白名单），模式不支持的地图会被服务端直接拒。
        建完这个窗会自动关 —— 房间号 / 地图 / 人数 / 观战码都在账号列上看。
      </p>

      <footer class="窗脚">
        <button :disabled="creatingRoom" @click="emit('close')">取消</button>
        <button class="主" :disabled="creatingRoom || battleSlots.length === 0" @click="submit">
          {{ creatingRoom ? '建房中…' : `建房（${battleSlots.length} 个账号）` }}
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
  width: min(720px, 92vw);
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

.表单 input,
.表单 select {
  padding: 4px 6px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
}

.表单 input {
  width: 130px;
}

label.内联 {
  display: flex;
  align-items: center;
  gap: 6px;
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