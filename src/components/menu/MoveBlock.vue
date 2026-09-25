<script setup lang="ts">
import { computed } from 'vue'
import type { session } from '@/stores/session'
import MenuButton from '@/components/MenuButton.vue'
import { getOperationActions } from '@/components/menu/actions'
import { birthNodeType, birthNodeTable, starUpCost, maxStarLevel, nodeNameTable } from '@/data/names'

const props = defineProps<{
  session: session
}>()

const battle = props.session.match
const room = props.session.room
const autoMove = props.session.autoMove
const moveAction = getOperationActions(battle).move
const toNum = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

const walkableNodes = computed(() => battle.walkCandidates)

function nodeTypeId(node: number): number {
  return battle.nodes.find((chunk) => chunk.node === node)?.type ?? 0
}

function nodeLabel(node: number): string {
  const type = nodeTypeId(node)
  const name = type === birthNodeType ? bornOwnerName(node) : nodeNameTable[type]
  return name ? `${node} ${name}` : String(node)
}

const myStarLevel = computed(() => battle.mine?.level ?? 0)
const myGold = computed(() => battle.mine?.gold ?? 0)
const starUpPrice = computed(() =>
  myStarLevel.value >= maxStarLevel ? undefined : starUpCost[myStarLevel.value],
)

function bornOwnerName(node: number): string {
  const table = birthNodeTable[toNum(room.room?.MapId)]
  const mySeat = room.my?.slot
  if (table) {
    const hit = Object.entries(table).find(([, nodes]) => nodes === node)
    if (hit) {
      const seat = Number(hit[0])
      return seat === mySeat ? '我的起始点' : `${seat + 1} 号位的起始点`
    }
  }
  return node === battle.myBornNode ? '我的起始点' : '别人的起始点'
}

function directionText(firstStep: number): string {
  return `→ 方向 ${firstStep}`
}
</script>

<template>
  <div class="op-subblock">
    <p v-if="!moveAction" class="op-muted">服务端没给移动动作（不是你的回合 / 还没投点）</p>
    <template v-else>
      <div class="op-row">
        <span class="op-muted">
          当前地块 {{ battle.currentPosition >= 0 ? nodeLabel(battle.currentPosition) : '—' }} · 来路
          {{ battle.currentFromNode >= 0 ? nodeLabel(battle.currentFromNode) : '—' }} ·
          <template v-if="battle.remainingSteps !== undefined">
            本次移动 {{ battle.diceSteps }} 步（已走 {{ battle.walkedSteps }}，剩
            {{ battle.remainingSteps }}）·</template
          >
          <template v-else>步数未知（还没投骰）·</template>
          相邻 {{ walkableNodes.length }} 个 · SN: {{ moveAction.Sn }}
          <template v-if="autoMove.serverDirection > 0">
            · 服务端预填方向 {{ autoMove.serverDirection }}<template v-if="autoMove.forceDirection">（说方向强制 → 自动走）</template><template
              v-else
            >（只是默认值；有多个方向可选时要你自己点）</template>
          </template>
          <template v-else-if="autoMove.forceDirection"> · 服务端说这一步方向由你定（来路限制已解除，可以后退），没给方向 → 要你自己点，不自动走</template>
        </span>
      </div>
      <p v-if="autoMove.state" class="op-muted">自动移动：{{ autoMove.state }}</p>
      <div class="op-row">
        <span class="op-muted">
          我的星级 {{ myStarLevel }}★ · 金币 {{ myGold }}<template v-if="starUpPrice !== undefined">
            · 升 {{ myStarLevel + 1 }}★ 要 {{ starUpPrice }} 金币（在保障点 / 起始点停下才能升）</template><template
            v-else
          >
            · 已满级（{{ maxStarLevel }}★）</template>
        </span>
      </div>
      <div class="op-row op-row--pair">
        <MenuButton
          v-for="node in walkableNodes"
          :key="node"
          :session="session"
          :message="directionText(node)"
          :action="moveAction"
          :payload="{ Direction: node }"
        />
      </div>
      <p v-if="walkableNodes.length === 0" class="op-muted">服务端没给相邻节点</p>
      <p v-else class="op-muted">
        按钮上写的就是**紧挨着的那一格**（`→ 方向 36`），发 `MoveC2S.Direction` 给它；
        之后走哪、在哪停（走满点数 / 路障 / 保障点停留选择）全由服务端推 `MoveS2C` 告诉大家，
        本地不推演。**地块号后面跟的是它的名字**（`27 商店`、`29 保障点`），名字来自地块配置表
        （按 `LandType` 查）；空地 / 本地还没收到地块数据时只有号。**只发 `Direction`**，
        客户端不填 `ForceDir` / `Path` / `LandEffect`（`RequestMoveC2S(sn, nextNodeId)` 就传这一个）。
      </p>
    </template>
  </div>
</template>
