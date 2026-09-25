<script setup lang="ts">
import { computed } from 'vue'
import type { session } from '@/stores/session'
import { getOperationActions } from '@/components/menu/actions'
import { urgentCommands } from '@/data/battleActions'
import DiceBlock from '@/components/menu/DiceBlock.vue'
import CardBlock from '@/components/menu/CardBlock.vue'
import DiscardBlock from '@/components/menu/DiscardBlock.vue'
import MoveBlock from '@/components/menu/MoveBlock.vue'
import BattleBlock from '@/components/menu/BattleBlock.vue'
import ShopBlock from '@/components/menu/ShopBlock.vue'
import MonsterBlock from '@/components/menu/MonsterBlock.vue'
import EventBlock from '@/components/menu/EventBlock.vue'

const props = defineProps<{
  session: session
}>()

const battle = props.session.match
const autoMove = props.session.autoMove
const action = getOperationActions(battle)

const available = computed(() => ({
  rollDice: action.rollDice.value !== undefined || action.remoteDice.value !== undefined,
  useCard: action.useCard.value !== undefined || action.battleUseCard.value !== undefined || action.quickCard.value !== undefined,
  discardCard: action.discardCard.value !== undefined,
  move: action.move.value !== undefined,
  battle:
    action.defense.value !== undefined ||
    action.askBattle.value !== undefined ||
    action.stopOrContinue.value !== undefined ||
    action.chip.value !== undefined ||
    action.battleUseCard.value !== undefined,
  shop:
    action.cardShop.value !== undefined ||
    action.multiShop.value !== undefined ||
    action.vendor.value !== undefined ||
    action.chipShop.value !== undefined,
  assault: action.assault.value !== undefined,
  nodes:
    action.events.value !== undefined ||
    action.destiny.value !== undefined ||
    action.hospital.value !== undefined ||
    action.divination.value !== undefined ||
    action.lottery.value !== undefined ||
    action.selectEvent.value !== undefined ||
    action.selectRewardCard.value !== undefined ||
    action.pursue.value !== undefined ||
    action.nodeTarget.value !== undefined ||
    action.eventRollDice.value !== undefined ||
    action.rollGold.value !== undefined ||
    action.bombDice.value !== undefined,
}))

const todoCount = computed(() => Object.values(available.value).filter(Boolean).length)

const urgentCount = computed(() => battle.myActions.filter((item) => urgentCommands.has(item.commandName)).length)

const battleSummary = computed(() => {
  const battleStat = battle.battleDetail
  if (!battleStat || !battleStat.attacker || !battleStat.defender) return ''
  return `${battleStat.attacker.nickname} 打 ${battleStat.defender.nickname}`
})

const needBattleResponse = computed(() => battle.battlePendingResponse.length > 0)
</script>

<template>
  <div class="菜单">
    <section class="待办">
      <div class="待办头">
        <strong>需要你操作</strong>
        <span class="标" :class="battle.myTurn ? '标--我' : ''">
          {{ battle.myTurn ? '轮到我' : '响应型' }}
        </span>
        <span class="op-muted">行动者：{{ battle.actorNickname }}</span>
        <span v-if="todoCount > 0" class="op-muted">共 {{ todoCount }} 类可做</span>
        <span v-if="urgentCount > 0" class="op-warn">
          有超时的 {{ urgentCount }} 项（不处理会被系统替你选）
        </span>
      </div>

      <div v-if="battle.battleRunning && battleSummary" class="战斗条">
        <span class="战斗标">战斗中</span>
        <span class="op-muted">
          {{ battleSummary }}
          <template v-if="battle.myBattleSide">
            · 我是{{ battle.myBattleSide }}
            <template v-if="battle.myBattleSide === '守方'">（要选 防御 / 闪避）</template>
          </template>
          <template v-if="battle.battleDetail?.attacker?.diceValue || battle.battleDetail?.defender?.diceValue">
            · 骰点 攻{{ battle.battleDetail?.attacker?.diceValue ?? 0 }} / 守{{ battle.battleDetail?.defender?.diceValue ?? 0 }}
          </template>
        </span>
        <span v-if="needBattleResponse" class="op-warn">服务端正在等你响应</span>
      </div>

      <div class="op-row">
        <span class="op-muted">自动移动：直路自动走，岔路口 / 遭遇才停下问人</span>
        <span v-if="autoMove.state" class="op-muted">{{ autoMove.state }}</span>
        <span v-else-if="autoMove.nextNode" class="op-muted">
          下一格 → {{ autoMove.nextNode.node }}（{{ autoMove.nextNode.origin }}，即将自动走）
        </span>
        <span v-else-if="autoMove.needDirection" class="op-warn">
          要你选方向：服务端没指定下一格，请在下面「方向选择」里点一个
        </span>
      </div>

      <template v-if="todoCount > 0">
        <DiceBlock v-if="available.rollDice" :session="session" />
        <CardBlock v-if="available.useCard" :session="session" />
        <DiscardBlock v-if="available.discardCard" :session="session" />
        <MoveBlock v-if="available.move" :session="session" />
        <BattleBlock v-if="available.battle" :session="session" />
        <ShopBlock v-if="available.shop" :session="session" />
        <MonsterBlock v-if="available.assault" :session="session" />
        <EventBlock v-if="available.nodes" :session="session" />
      </template>
      <p v-else class="op-muted 待办空">
        现在没有要你做的操作（{{ battle.actorNickname }} 正在行动）。
        想提前发某条命令，展开下面的「自定义操作」。
      </p>
    </section>

    <details class="自定义">
      <summary>自定义操作（全部 8 块，拿不到 Sn 的按钮是灰的）</summary>
      <DiceBlock :session="session" />
      <CardBlock :session="session" />
      <DiscardBlock :session="session" />
      <MoveBlock :session="session" />
      <BattleBlock :session="session" />
      <ShopBlock :session="session" />
      <MonsterBlock :session="session" />
      <EventBlock :session="session" />
      <slot />
    </details>
  </div>
</template>

<style scoped>
.菜单 {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.待办 {
  padding: 10px 12px;
  border: 1px solid #2f4a63;
  border-radius: 6px;
  background: #121a22;
}

.待办头 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid #223243;
  font-size: 13px;
}

.标 {
  padding: 1px 8px;
  border-radius: 10px;
  background: #2b3038;
  color: #9aa4b2;
  font-size: 11px;
}

.标--我 {
  background: #22608f;
  color: #fff;
}

.待办空 {
  margin: 8px 0 0;
}

.战斗条 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px solid #a4553c;
  border-radius: 4px;
  background: #2a1d18;
}

.战斗标 {
  padding: 1px 8px;
  border-radius: 10px;
  background: #a4553c;
  color: #fff;
  font-size: 12px;
}

.自定义 {
  margin-top: 2px;
}

.自定义 > summary {
  padding: 6px 0;
  border-bottom: 1px solid #2b3038;
  color: #e6ebf2;
  font-size: 13px;
  cursor: pointer;
}

.自定义[open] > summary {
  margin-bottom: 4px;
}
</style>
