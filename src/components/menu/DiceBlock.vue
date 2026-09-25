<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { session } from '@/stores/session'
import MenuButton from '@/components/MenuButton.vue'
import { getOperationActions } from '@/components/menu/actions'

const props = defineProps<{
  session: session
}>()

const actionTable = getOperationActions(props.session.match)
const rollDiceAction = actionTable.rollDice

const remoteDiceAction = actionTable.remoteDice

const maxPoint = computed(() => {
  const value = remoteDiceAction.value?.data?.MaxPoint
  return typeof value === 'number' && value > 0 ? value : 6
})

const remoteDiceValue = ref(6)
watch(
  () => remoteDiceAction.value?.Sn,
  () => {
    remoteDiceValue.value = maxPoint.value
  },
  { immediate: true },
)

const diceValid = computed(
  () => Number.isFinite(remoteDiceValue.value) && remoteDiceValue.value >= 1 && remoteDiceValue.value <= maxPoint.value,
)
</script>

<template>
  <div class="op-subblock">
    <div class="op-row">
      <MenuButton :session="session" message="投骰 / 继续移动" :action="rollDiceAction" />
      <span class="op-muted">
        <template v-if="rollDiceAction">
          SN: {{ rollDiceAction.Sn }}
          <template v-if="rollDiceAction.commandName === 'UseEffectCardC2S'">
            （出牌阶段：这一下 = 不选牌，直接进投骰/移动）
          </template>
        </template>
        <template v-else>服务端没给可推进的动作</template>
      </span>
    </div>

    <div v-if="remoteDiceAction" class="op-row">
      <label class="op-label">遥控骰子点数</label>
      <input v-model.number="remoteDiceValue" class="op-num" type="number" min="1" :max="maxPoint" />
      <MenuButton
        :session="session"
        message="指定骰点"
        :action="remoteDiceAction"
        :payload="{ Point: remoteDiceValue }"
        :extraReason="diceValid ? undefined : `点数要在 1~${maxPoint} 之间`"
      />
      <span class="op-muted">
        SN: {{ remoteDiceAction.Sn }} · 用了「遥控骰子」才可以定，范围 1~{{ maxPoint }}
      </span>
    </div>
  </div>
</template>
