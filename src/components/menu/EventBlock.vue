<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CandidateAction } from '@/stores/battle'
import type { session } from '@/stores/session'
import MenuButton from '@/components/MenuButton.vue'
import { getOperationActions } from '@/components/menu/actions'
import { cardNameTable, displayName } from '@/data/names'

const props = defineProps<{
  session: session
}>()

const battle = props.session.match
const room = props.session.room
const action = getOperationActions(battle)

const divinationAction = action.divination
const lotteryAction = action.lottery
const selectEventAction = action.selectEvent
const selectRewardCardAction = action.selectRewardCard
const pursueAction = action.pursue
const nodeTargetAction = action.nodeTarget

const confirmItems = computed(() =>
  [
    { name: '确认（事件）', action: action.events.value, detail: '事件窗的确认' },
    { name: '确认（命运）', action: action.destiny.value, detail: '个人命运的确认' },
    { name: '确认（医院）', action: action.hospital.value, detail: '医院治疗确认' },
  ].filter((item) => item.action !== undefined) as { name: string; action: CandidateAction; detail: string }[],
)

const diceItems = computed(() =>
  [
    { name: '事件投骰', action: action.eventRollDice.value },
    { name: '掷金币', action: action.rollGold.value },
    { name: '炸弹骰', action: action.bombDice.value },
  ].filter((item) => item.action !== undefined) as { name: string; action: CandidateAction }[],
)

function numberArray(actionValue: CandidateAction | undefined, fieldName?: string): number[] {
  if (!actionValue) return []
  if (fieldName !== undefined) {
    const value = actionValue.data[fieldName]
    return Array.isArray(value) ? (value as unknown[]).map(Number) : []
  }
  for (const [name, value] of Object.entries(actionValue.data)) {
    if (name === 'Info' || !Array.isArray(value) || value.length === 0) continue
    const converted = (value as unknown[]).map((item) => (typeof item === 'number' ? item : NaN))
    if (!converted.some((item) => Number.isNaN(item))) return converted
  }
  return []
}

const divinationOptions = computed(() => numberArray(divinationAction.value, 'CanChoiceIds'))
const divinationChoice = ref(0)
watch(
  divinationOptions,
  (options) => {
    divinationChoice.value = options[0] ?? 0
  },
  { immediate: true },
)

const lotteryNumbers = ref<number[]>([])
const betCount = computed(() => lotteryNumbers.value.length)

function toggleId(Id: number): void {
  lotteryNumbers.value = lotteryNumbers.value.includes(Id)
    ? lotteryNumbers.value.filter((item) => item !== Id)
    : [...lotteryNumbers.value, Id]
}

const selectedEvents = ref<number[]>([])

const rewardCardCandidates = computed(() => numberArray(selectRewardCardAction.value, 'CardIds'))
const rewardCardIndex = ref(-1)
watch(
  rewardCardCandidates,
  (list) => {
    rewardCardIndex.value = list.length > 0 ? 0 : -1
  },
  { immediate: true },
)
const rewardCardPayload = computed(() => ({ CardIds: rewardCardCandidates.value, Idx: rewardCardIndex.value }))

function toggle(list: number[], value: number): number[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

const pursueCandidates = computed(() =>
  room.playerList.filter((player) => player.id !== room.myId).map((player) => player.id),
)

const nodeTargetSelected = ref<string[]>([])
const nodeTargetCandidates = computed(() => room.playerList)

function toggleText(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

const hasContent = computed(
  () =>
    confirmItems.value.length > 0 ||
    diceItems.value.length > 0 ||
    divinationAction.value !== undefined ||
    lotteryAction.value !== undefined ||
    selectEventAction.value !== undefined ||
    selectRewardCardAction.value !== undefined ||
    pursueAction.value !== undefined ||
    nodeTargetAction.value !== undefined,
)
</script>

<template>
  <div v-if="hasContent" class="op-subblock">
    <div class="op-sub">地块 / 事件确认</div>

    <div v-if="confirmItems.length > 0" class="op-row op-row--pair">
      <MenuButton
        v-for="item in confirmItems"
        :key="item.name"
        :session="session"
        :message="item.name"
        :action="item.action"
        :title="item.detail"
      />
    </div>
    <p v-else class="op-muted">现在没有要确认的事件（踩到事件/医院地块时才会出现）</p>

    <template v-for="item in diceItems" :key="item.name">
      <span class="op-muted">{{ item.name }} SN: {{ item.action.Sn }}</span>
      <div class="op-row op-row--pair">
        <MenuButton :session="session" :message="item.name" :action="item.action" />
      </div>
    </template>

    <template v-if="divinationAction">
      <span class="op-muted">占卜选牌 SN: {{ divinationAction.Sn }}</span>
      <div class="op-row op-row--pair">
        <template v-if="divinationOptions.length > 0">
          <MenuButton
            v-for="item in divinationOptions"
            :key="item"
            :session="session"
            :message="`选 ${item}`"
            :action="divinationAction"
            :payload="{ Id: item }"
          />
        </template>
        <template v-else>
          <input v-model.number="divinationChoice" class="op-num" type="number" min="0" />
          <MenuButton :session="session" message="选这个" :action="divinationAction" :payload="{ Id: divinationChoice }" />
        </template>
      </div>
    </template>

    <template v-if="lotteryAction">
      <span class="op-muted">
        彩票选号 SN: {{ lotteryAction.Sn }} · 已选 {{ betCount }} 注（1-12 不重复）
      </span>
      <div class="op-row op-row--pair">
        <button
          v-for="Id in 12"
          :key="Id"
          class="小"
          :class="{ 选中: lotteryNumbers.includes(Id) }"
          @click="toggleId(Id)"
        >
          {{ Id }}
        </button>
      </div>
      <div class="op-row">
        <MenuButton
          :session="session"
          message="按选号下注"
          :action="lotteryAction"
          :payload="{ Vals: lotteryNumbers }"
          :extraReason="betCount === 0 ? '先点号码' : undefined"
        />
        <MenuButton
          :session="session"
          message="随机 1 注"
          :action="lotteryAction"
          :payload="{ Vals: [1 + Math.floor(Math.random() * 12)] }"
        />
      </div>
      <p class="op-muted">只发 `Vals`（选中的号码）；注数由 `Vals` 的长度决定。</p>
    </template>

    <template v-if="selectEventAction">
      <span class="op-muted">选事件 SN: {{ selectEventAction.Sn }}</span>
      <div class="op-row op-row--pair">
        <button
          v-for="item in numberArray(selectEventAction)"
          :key="item"
          class="小"
          :class="{ 选中: selectedEvents.includes(item) }"
          @click="selectedEvents = toggle(selectedEvents, item)"
        >
          {{ item }}
        </button>
        <MenuButton
          :session="session"
          message="确认选中的事件"
          :action="selectEventAction"
          :payload="{ Events: selectedEvents }"
          :extraReason="selectedEvents.length === 0 ? '先点事件' : undefined"
        />
      </div>
    </template>

    <template v-if="selectRewardCardAction">
      <span class="op-muted">
        选奖励卡 SN: {{ selectRewardCardAction.Sn }} · 候选 {{ rewardCardCandidates.length }} 张（选 1 张）
      </span>
      <div class="op-row op-row--pair">
        <button
          v-for="(cardId, index) in rewardCardCandidates"
          :key="index"
          class="小"
          :class="{ 选中: rewardCardIndex === index }"
          @click="rewardCardIndex = index"
        >
          [{{ index }}] {{ displayName(cardNameTable, cardId) }}
        </button>
        <span v-if="rewardCardCandidates.length === 0" class="op-muted">（服务端没给候选卡）</span>
        <MenuButton
          :session="session"
          message="确认选中的卡"
          :action="selectRewardCardAction"
          :payload="rewardCardPayload"
          :extraReason="rewardCardIndex < 0 ? '先点一张卡' : undefined"
        />
      </div>
      <p class="op-muted">发 `CardIds` = 服务端给的整份候选 + `Idx` = 你选的那张的下标。</p>
    </template>

    <template v-if="pursueAction">
      <span class="op-muted">追击 SN: {{ pursueAction.Sn }}（选一个别的玩家追上去）</span>
      <div class="op-row op-row--pair">
        <MenuButton
          v-for="id in pursueCandidates"
          :key="id"
          :session="session"
          :message="`追击 ${room.playerList.find((item) => item.id === id)?.nick || id}`"
          :action="pursueAction"
          :payload="{ SelectPlayerId: id }"
        />
        <span v-if="pursueCandidates.length === 0" class="op-muted">（房间里没有别的玩家）</span>
        <MenuButton
          :session="session"
          message="不追（离开）"
          :action="pursueAction"
          :payload="{ SelectPlayerId: '0' }"
        />
      </div>
      <p class="op-muted">
        目标不从动作 `Data` 来（`PursuitC2S` 只有 `SelectPlayerId`），是客户端自己按房间玩家列出来的；
        不追 = 发 `SelectPlayerId=0`。
      </p>
    </template>

    <template v-if="nodeTargetAction">
      <span class="op-muted">地块目标 SN: {{ nodeTargetAction.Sn }}</span>
      <div class="op-row op-row--top">
        <span class="op-label">目标（{{ nodeTargetSelected.length }} 个）</span>
        <span class="op-checks">
          <label v-for="player in nodeTargetCandidates" :key="player.id" class="op-check">
            <input
              type="checkbox"
              :checked="nodeTargetSelected.includes(player.id)"
              @change="nodeTargetSelected = toggleText(nodeTargetSelected, player.id)"
            />
            {{ player.id === room.myId ? '（我）' : player.nick || player.id }}
          </label>
        </span>
      </div>
      <div class="op-row">
        <MenuButton
          :session="session"
          message="确认目标"
          :action="nodeTargetAction"
          :payload="{ TargetIds: nodeTargetSelected }"
          :extraReason="nodeTargetSelected.length === 0 ? '先勾目标' : undefined"
        />
        <MenuButton :session="session" message="退出" :action="nodeTargetAction" :payload="{ Exit: true }" />
      </div>
    </template>

    <p v-if="battle.nodes.length > 0" class="op-muted">我在 {{ battle.mine?.position ?? '—' }}</p>
  </div>
</template>

<style scoped>
.小 {
  padding: 2px 8px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.小.选中 {
  border-color: #4caf7d;
  color: #4caf7d;
}
</style>
