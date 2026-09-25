<script setup lang="ts">
import { computed, ref } from 'vue'
import type { session } from '@/stores/session'
import MenuButton from '@/components/MenuButton.vue'
import { getOperationActions } from '@/components/menu/actions'

const props = defineProps<{
  session: session
}>()

const battle = props.session.match
const assaultAction = getOperationActions(battle).assault

const localMonsters = computed(() => battle.monsters)

const candidateId = computed<string[]>(() => {
  const data = assaultAction.value?.data
  if (!data) return []
  const single = data.SelectId
  if (typeof single === 'bigint' || typeof single === 'number') {
    const text = String(single)
    if (text.length > 0 && text !== '0') return [text]
  }
  for (const [name, value] of Object.entries(data)) {
    if (name === 'Info' || !Array.isArray(value) || value.length === 0) continue
    const converted = (value as unknown[]).map((item) =>
      typeof item === 'bigint' || typeof item === 'number' ? String(item) : '',
    )
    if (converted.every((item) => item.length > 0)) return [...new Set(converted)]
  }
  return []
})

const targetCandidates = computed(() => {
  const table = new Map(localMonsters.value.map((monster) => [monster.id, monster]))
  for (const id of candidateId.value) {
    if (!table.has(id))
      table.set(id, { id, heroId: 0, nickname: `怪物 ${id}`, hp: 0, maxHp: 0, position: 0, type: 0 })
  }
  return [...table.values()]
})

const selectedMonster = ref('')
</script>

<template>
  <div class="op-subblock">
    <p v-if="!assaultAction" class="op-muted">服务端没给怪物突击动作（不在你的回合 / 没踩到突击门）</p>

    <template v-else>
      <div class="op-row">
        <span class="op-muted">
          SN: {{ assaultAction.Sn }} · 可选 {{ targetCandidates.length }} 只（服务端提示
          {{ candidateId.length }} 个 · 本地认到 {{ localMonsters.length }} 只）
        </span>
      </div>

      <p v-if="targetCandidates.length === 0" class="op-muted">
        没认到场上的怪：本地镜像里 `Room.Monsters` 是空的，服务端这条候选也没带目标。
        PvE 的怪是**刷新出来的**（服务端推 `MonsterRefreshS2C`，日志里会打「怪物刷新: …」）——
        刷新之后再展开这块就有了；如果日志里一直没有那条推送，就是这条连接没收到 1018。
      </p>

      <div class="op-row">
        <label class="op-label">目标怪物</label>
        <select v-model="selectedMonster" class="op-select">
          <option value="">（选一只）</option>
          <option v-for="monster in targetCandidates" :key="monster.id" :value="monster.id">
            {{ monster.nickname }}
            <template v-if="monster.maxHp > 0"> {{ monster.hp }}/{{ monster.maxHp }}</template>
            <template v-if="monster.position > 0"> · 位置 {{ monster.position }}</template>
            · id {{ monster.id }}
          </option>
        </select>
      </div>
      <div class="op-row">
        <MenuButton
          :session="session"
          message="突击该怪物"
          :action="assaultAction"
          :payload="selectedMonster ? { SelectId: selectedMonster } : {}"
          :extraReason="selectedMonster ? undefined : '先选一只怪'"
        />
        <MenuButton
          v-if="targetCandidates.length === 1"
          :session="session"
          :message="`直接突击 ${targetCandidates[0]?.nickname ?? ''}`"
          :action="assaultAction"
          :payload="{ SelectId: targetCandidates[0]?.id ?? '' }"
        />
        <MenuButton :session="session" message="取消（不突击）" :action="assaultAction" />
        <span class="op-muted">取消 = 不带 `SelectId` 发（服务端回 `Exit=true`，人继续移动）</span>
      </div>
    </template>
  </div>
</template>