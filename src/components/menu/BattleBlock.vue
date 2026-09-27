<script setup lang="ts">
import { computed } from 'vue'
import type { session } from '@/stores/session'
import MenuButton from '@/components/MenuButton.vue'
import { getOperationActions } from '@/components/menu/actions'
import { dodgeRequirement, minBattleDamage, chipNameTable, displayName } from '@/data/names'

const props = defineProps<{
  session: session
}>()

const battle = props.session.match
const action = getOperationActions(battle)

const defenseAction = action.defense
const askBattleAction = action.askBattle
const stopOrContinueAction = action.stopOrContinue
const chipAction = action.chip
const battleAction = action.battleUseCard

const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

const candidatesChip = computed<number[]>(() => {
  const raw = chipAction.value?.data?.Relics
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).map((item) => toNumber(item))
})

const battleDetail = computed(() => battle.battleDetail)

const dodgeHint = computed(() => {
  const battleStat = battleDetail.value
  if (!battleStat) return ''
  const myIsDefender = battle.myBattleSide === '守方'
  const opponent = myIsDefender ? battleStat.attacker : battleStat.defender
  const required = dodgeRequirement(opponent?.diceValue ?? 0)
  if (required === null) return ''
  return `对手骰点 ${opponent?.diceValue} `
})

const damageEstimate = computed(() => {
  const battleStat = battleDetail.value
  if (!battleStat) return ''
  const myIsDefender = battle.myBattleSide === '守方'
  const atk = myIsDefender ? battleStat.attacker : battleStat.defender
  const defender = myIsDefender ? battleStat.defender : battleStat.attacker
  if (!atk || !defender) return ''
  return `最终伤害 = max(${minBattleDamage}, 攻方最终攻击值 − 守方最终防御值)，当前 攻${atk.attack ?? 0} / 守${defender.defense ?? 0}`
})
</script>

<template>
  <div class="op-subblock">
    <div v-if="battleDetail" class="op-row">
      <span class="op-muted">
        攻方 {{ battleDetail.attacker?.nickname ?? '—' }}
        （{{ battleDetail.attacker?.ready ? '已准备' : '未准备' }}）· 守方
        {{ battleDetail.defender?.nickname ?? '—' }}
        （{{ battleDetail.defender?.ready ? '已准备' : '未准备' }}）
        <template v-if="battleDetail.defender?.dodge"> · 守方选了闪避</template>
      </span>
    </div>

    <span class="op-muted">战斗抉择 SN: {{ defenseAction?.Sn ?? '—' }}</span>
    <p v-if="dodgeHint" class="op-warn">{{ dodgeHint }}</p>
    <div class="op-row op-row--pair">
      <MenuButton :session="session" message="防御" :action="defenseAction" :payload="{ Dodge: false }" />
      <MenuButton :session="session" message="闪避" :action="defenseAction" :payload="{ Dodge: true }" />
    </div>
    <p v-if="damageEstimate" class="op-muted">{{ damageEstimate }}</p>

    <span class="op-muted">遭遇怪物 SN: {{ askBattleAction?.Sn ?? '—' }}</span>
    <div class="op-row op-row--pair">
      <MenuButton :session="session" message="攻击" :action="askBattleAction" :payload="{ IsBattle: true }" />
      <MenuButton :session="session" message="放过" :action="askBattleAction" :payload="{ IsBattle: false }" />
    </div>

    <span class="op-muted">保障点 / 起点 SN: {{ stopOrContinueAction?.Sn ?? '—' }}</span>
    <div class="op-row op-row--pair">
      <MenuButton :session="session" message="继续移动" :action="stopOrContinueAction" :payload="{ Stop: false }" />
      <MenuButton :session="session" message="停留" :action="stopOrContinueAction" :payload="{ Stop: true }" />
    </div>

    <span class="op-muted">筹码选择 SN: {{ chipAction?.Sn ?? '—' }}</span>
    <div class="op-row op-row--pair">
      <MenuButton
        v-for="(chipId, index) in candidatesChip"
        :key="index"
        :session="session"
        :message="`[${index}] ${displayName(chipNameTable, chipId)}`"
        :action="chipAction"
        :payload="{ Idx: index }"
      />
      <span v-if="candidatesChip.length === 0" class="op-muted">
        （服务端没给候选筹码；不是选筹码的时机）
      </span>
      <MenuButton
        v-if="chipAction"
        :session="session"
        message="重抽筹码"
        :action="chipAction"
        :payload="{ IsReroll: true }"
      />
    </div>
    <p v-if="chipAction" class="op-muted">
      重抽只发 `IsReroll=true`（不带 `Idx`）
    </p>

    <span class="op-muted">战斗出牌 SN: {{ battleAction?.Sn ?? '—' }}</span>
    <div class="op-row">
      <MenuButton :session="session" message="准备 OK" :action="battleAction" />
      <span class="op-muted">不选卡直接发 = 准备 OK（双方都 OK 后战斗自己往下走）</span>
    </div>

    <div class="op-row">
      <span class="op-muted">
        战斗投骰：双方准备 OK 后<strong>自动发送</strong>（5037 只回一条 `Info{Sn}`，不需要人点）
      </span>
    </div>
  </div>
</template>
