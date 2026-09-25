<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { session } from '@/stores/session'
import MenuButton from '@/components/MenuButton.vue'
import { getOperationActions } from '@/components/menu/actions'
import { cardNameTable, displayName } from '@/data/names'

const props = defineProps<{
  session: session
}>()

const battle = props.session.match
const discardAction = getOperationActions(battle).discardCard

const handCards = computed(() => battle.mine?.handCards ?? [])

const selectedCardIds = ref<number[]>([])

watch(
  () => discardAction.value?.Sn,
  () => {
    selectedCardIds.value = []
  },
)

const candidateUniqueIds = computed<number[]>(() => {
  const data = discardAction.value?.data
  if (!data) return []
  for (const [name, value] of Object.entries(data)) {
    if (name === 'Info' || !Array.isArray(value) || value.length === 0) continue
    const converted = (value as unknown[]).map((item) => (typeof item === 'number' ? item : NaN))
    if (!converted.some((item) => Number.isNaN(item))) return converted
  }
  return []
})

const availableHandCards = computed(() =>
  candidateUniqueIds.value.length > 0
    ? handCards.value.filter((card) => candidateUniqueIds.value.includes(card.uniqueId))
    : handCards.value,
)

function toggle(uniqueId: number): void {
  selectedCardIds.value = selectedCardIds.value.includes(uniqueId)
    ? selectedCardIds.value.filter((item) => item !== uniqueId)
    : [...selectedCardIds.value, uniqueId]
}

const discardCount = computed(() => candidateUniqueIds.value.length || 1)
</script>

<template>
  <div class="op-subblock">
    <p v-if="!discardAction" class="op-muted">
      服务端没给弃牌动作（手牌没超上限 / 不在你的回合）
    </p>
    <template v-else>
      <div class="op-row">
        <span class="op-muted">
          手牌 {{ handCards.length }} 张，这次要弃 {{ discardCount }} 张 ·
          SN: {{ discardAction.Sn }}
          <template v-if="candidateUniqueIds.length > 0">（服务端已给出可弃的那几张）</template>
        </span>
      </div>
      <div class="op-row op-row--top">
        <span class="op-label">选手牌（{{ selectedCardIds.length }} 张）</span>
        <span class="op-checks">
          <label v-for="card in availableHandCards" :key="card.uniqueId" class="op-check">
            <input type="checkbox" :checked="selectedCardIds.includes(card.uniqueId)" @change="toggle(card.uniqueId)" />
            {{ displayName(cardNameTable, card.cardId) }} #{{ card.uniqueId }}
          </label>
        </span>
        <span v-if="availableHandCards.length === 0" class="op-muted">（没有可选的手牌）</span>
      </div>
      <div class="op-row">
        <MenuButton
          :session="session"
          message="弃掉选中的牌"
          :action="discardAction"
          :payload="{ CardUniqueIds: selectedCardIds }"
          :extraReason="selectedCardIds.length === 0 ? '先勾要弃的牌' : undefined"
        />
        <MenuButton
          :session="session"
          message="弃第一张（最快）"
          :action="discardAction"
          :payload="{ CardUniqueIds: availableHandCards.slice(0, discardCount).map((card) => card.uniqueId) }"
          :extraReason="availableHandCards.length === 0 ? '没有可选的手牌' : undefined"
        />
      </div>
    </template>
  </div>
</template>
