<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CandidateAction } from '@/stores/battle'
import type { session } from '@/stores/session'
import MenuButton from '@/components/MenuButton.vue'
import { getOperationActions } from '@/components/menu/actions'
import {
  cardNameTable,
  CardTarget,
  activeSkillId,
  activeSkillIdPve,
  skillNameTable,
  skillTargetTable,
  mapAdjacencyTable,
  displayName,
} from '@/data/names'
import type { CardTarget as CardTargetType } from '@/data/names'

const props = defineProps<{
  session: session
}>()

const battle = props.session.match
const room = props.session.room
const action = getOperationActions(battle)

const fieldCardAction = action.useCard
const battleAction = action.battleUseCard
const quickCardAction = action.quickCard

const mode = computed<'战斗' | '场外' | ''>(() => {
  if (battleAction.value) return '战斗'
  if (fieldCardAction.value) return '场外'
  return ''
})
function numberArray(actionValue: CandidateAction | undefined, fieldName?: string): number[] {
  if (!actionValue) return []
  const received = (name: string, value: unknown): number[] | null => {
    if (!Array.isArray(value) || value.length === 0) return null
    const converted = (value as unknown[]).map((item) => (typeof item === 'number' ? item : NaN))
    return converted.some((item) => Number.isNaN(item)) ? null : converted
  }
  if (fieldName !== undefined) return received(fieldName, actionValue.data[fieldName]) ?? []
  for (const [name, value] of Object.entries(actionValue.data)) {
    if (name === 'Info') continue
    const oneGroup = received(name, value)
    if (oneGroup) return oneGroup
  }
  return []
}

const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

function computeDistances(mapId: number, startNode: number): Map<number, number> {
  const result = new Map<number, number>()
  if (startNode < 0) return result
  const adjacencyTable = mapAdjacencyTable[mapId] ?? {}
  const getNeighbors = (node: number): number[] => adjacencyTable[node] ?? battle.knownEdges[node] ?? []
  result.set(startNode, 0)
  const queue = [startNode]
  while (queue.length > 0) {
    const when = queue.shift()
    if (when === undefined) break
    const distance = result.get(when) ?? 0
    for (const neighbor of getNeighbors(when)) {
      if (result.has(neighbor)) continue
      result.set(neighbor, distance + 1)
      queue.push(neighbor)
    }
  }
  return result
}

const distanceTable = computed(() => computeDistances(toNumber(room.room?.MapId), battle.currentPosition))

function distanceText(node: number): string {
  const value = distanceTable.value.get(node)
  return value === undefined ? '—' : String(value)
}


const prefilledCardId = computed(() => toNumber(fieldCardAction.value?.data?.CardId))

const outOfBattleCardList = computed(() => {
  // 服务端在 Data.CardId 里预填了要出的牌时，客户端只能出这一张（它会被自动发出去）
  if (prefilledCardId.value > 0) return [prefilledCardId.value]
  const given = numberArray(fieldCardAction.value, 'CanUseCardIds')
  if (given.length > 0) return given
  return [...new Set((battle.mine?.handCards ?? []).map((card) => card.cardId))]
})

const selectedFieldCard = ref(0)
const targetPlayers = ref<string[]>([])
const targetNodes = ref<number[]>([])
const effectSeq = ref(0)

watch(
  () => [fieldCardAction.value?.Sn, battleAction.value?.Sn],
  () => {
    selectedFieldCard.value = 0
    targetPlayers.value = []
    targetNodes.value = []
    effectSeq.value = 0
    selectedBattleCard.value = 0
    SkillTarget.value = ''
  },
)

watch(
  outOfBattleCardList,
  (list) => {
    if (!list.includes(selectedFieldCard.value)) selectedFieldCard.value = list[0] ?? 0
  },
  { immediate: true },
)

const selectedCardName = computed(() =>
  selectedFieldCard.value > 0 ? displayName(cardNameTable, selectedFieldCard.value) : '（还没选卡）',
)

const cardSemantic = computed(() => CardTarget(selectedFieldCard.value))
const targetType = computed(() => cardSemantic.value?.targetType ?? 2)
const range = computed(() => cardSemantic.value?.range)

const needTarget = computed(() => targetType.value === 2 || targetType.value === 3)

const canComputeDistance = computed(() => distanceTable.value.size > 1)

const distanceHint = computed(() => {
  if (canComputeDistance.value) return ''
  const mapId = toNumber(room.room?.MapId)
  if (mapAdjacencyTable[mapId] === undefined) {
    return `本地算不出距离（地图 ${mapId} 没 dump 过邻接表），射程不过滤`
  }
  return `本地算不出距离（读不到当前位置：NodeId=${battle.currentPosition}），射程不过滤`
})

const targetDetail = computed(() => {
  const rangeText = range.value === undefined ? '不限距离' : `${range.value} 格内`
  if (targetType.value === 2) return `指定角色（${rangeText}）`
  if (targetType.value === 3) return `指定地块（${rangeText}）`
  if (targetType.value === 1) return '对自己使用'
  return '无需选目标'
})

function computeRoleCandidates(
  semantic: CardTargetType | undefined,
): { id: string; name: string; position: number; distanceValue: number | null; distance: string }[] {
  const canTargetSelf = semantic?.canTargetSelf === true
  const canTargetMonster = semantic === undefined ? true : semantic.canTargetMonster === true
  const canTargetPlayer = semantic === undefined ? true : semantic.canTargetPlayer === true
  const selfOnly = semantic !== undefined && canTargetSelf && !canTargetPlayer && !canTargetMonster

  const names: { id: string; name: string; position: number }[] = []
  if (canTargetSelf && room.myId.length > 0) {
    names.push({ id: room.myId, name: '（我）', position: battle.currentPosition })
  }
  if (!selfOnly && canTargetPlayer) {
    for (const player of room.playerList) {
      if (player.id === room.myId) continue
      names.push({
        id: player.id,
        name: player.nick || player.id,
        position: toNumber((player.raw.Hero as Record<string, unknown> | undefined)?.NodeId),
      })
    }
  }
  if (!selfOnly && canTargetMonster) {
    for (const monster of battle.monsters) names.push({ id: monster.id, name: `${monster.nickname}（怪）`, position: monster.position })
  }

  const rangeValue = semantic?.range
  return names
    .map((item) => ({ ...item, distanceValue: distanceTable.value.get(item.position) ?? null, distance: distanceText(item.position) }))
    .filter((item) => rangeValue === undefined || item.distanceValue === null || item.distanceValue <= rangeValue)
}

const roleCandidates = computed(() => (targetType.value === 2 ? computeRoleCandidates(cardSemantic.value) : []))

const nodeCandidates = computed(() => {
  if (targetType.value !== 3) return []
  return battle.nodes
    .map((chunk) => ({ ...chunk, distanceValue: distanceTable.value.get(chunk.node) ?? null, distance: distanceText(chunk.node) }))
    .filter((chunk) => range.value === undefined || chunk.distanceValue === null || chunk.distanceValue <= range.value)
    .sort((a, b) => (a.distanceValue ?? 99) - (b.distanceValue ?? 99))
})

function toggle(list: number[] | string[], value: number | string): (number | string)[] {
  return list.some((item) => String(item) === String(value))
    ? list.filter((item) => String(item) !== String(value))
    : [...list, value]
}

const offFieldPayload = computed(() => {
  const card = selectedFieldCard.value > 0 ? selectedFieldCard.value : prefilledCardId.value
  const body: Record<string, unknown> = { UseSelectCardIndex: effectSeq.value, DevPoint: 0 }
  if (card > 0) body.CardId = card
  if (targetPlayers.value.length > 0) body.TargetIds = targetPlayers.value
  if (targetNodes.value.length > 0) body.TargetNodeIds = targetNodes.value
  return body
})


const selectedBattleCard = ref(0)
const cardCardCandidates = computed(() => battle.mine?.handCards ?? [])

const mineBattleEdge = computed(() => {
  const battleStat = battle.battleDetail
  if (!battleStat) return null
  if (battle.myBattleSide === '守方') return battleStat.defender
  if (battle.myBattleSide === '攻方') return battleStat.attacker
  return null
})
const myCost = computed(() => mineBattleEdge.value?.cost ?? 0)
const myCostLimit = computed(() => mineBattleEdge.value?.costLimit ?? 0)
const selectedCardCost = computed(
  () => cardCardCandidates.value.find((card) => card.uniqueId === selectedBattleCard.value)?.cost ?? 0,
)


const myHeroId = computed(() => battle.mine?.heroId ?? 0)
/** 主动技能有两版：PVP 是 `英雄id*100+1`，PVE 是它 +1 */
const myActiveSkillId = computed(() => activeSkillId(myHeroId.value))
const configureActiveSkillPve = computed(() => activeSkillIdPve(myHeroId.value))

const skillCds = computed<Record<number, number>>(() => {
  const my = room.playerList.find((player) => player.id === room.myId)
  const raw = (my?.raw.Hero as Record<string, unknown> | undefined)?.SkillCds
  if (!raw || typeof raw !== 'object') return {}
  const table: Record<number, number> = {}
  for (const [id, cd] of Object.entries(raw as Record<string, unknown>)) {
    const Id = toNumber(id)
    if (Id > 0) table[Id] = toNumber(cd)
  }
  return table
})

const selectedSkill = ref(0)
const manualSkillId = ref(0)
/** 技能目标：玩家/怪物都用它的 Player.Id（捕获里 5055 的 `TargetIds` 就是这个） */
const SkillTarget = ref('')
const serverSkillId = computed(() => toNumber(fieldCardAction.value?.data?.SkillId))

const skillToUse = computed(() => {
  if (selectedSkill.value > 0) return selectedSkill.value
  if (manualSkillId.value > 0) return manualSkillId.value
  if (myActiveSkillId.value > 0) return myActiveSkillId.value
  return serverSkillId.value
})

/** 技能目标语义：只有 `技能目标表` 里那 18 个技能需要选目标，其余留空即可 */
const skillSemantic = computed(() => skillTargetTable[skillToUse.value])

const skillRangeText = computed(() => {
  const semantic = skillSemantic.value
  if (semantic === undefined || semantic.range === undefined) return ''
  return semantic.invertRange === true ? `，要求超出 ${semantic.range} 格` : `，射程 ${semantic.range} 格内`
})

/**
 * 技能候选：英雄主动技能固定给两版 —— 一个 PVP（`英雄id*100+1`）、一个 PVE（+1），
 * 其余是服务端 `SkillCds` 里多出来的技能（卡牌给的之类）。
 * 目标用不着在这儿筛，服务端只认 `SkillId`。
 */
const skillCandidates = computed(() => {
  const table = new Map<number, string>()
  if (myActiveSkillId.value > 0) table.set(myActiveSkillId.value, 'PVP 主动')
  if (configureActiveSkillPve.value > 0) table.set(configureActiveSkillPve.value, 'PVE 主动')
  for (const id of Object.keys(skillCds.value)) {
    const Id = Number(id)
    if (Id > 0 && !table.has(Id)) table.set(Id, '其它')
  }
  return [...table.entries()].map(([id, label]) => ({ id, label, cd: skillCds.value[id] }))
})

// 选中的技能必须还在候选里（默认落在第一项，也就是 PVP 主动）
watch(
  skillCandidates,
  (list) => {
    if (!list.some((skill) => skill.id === selectedSkill.value)) selectedSkill.value = list[0]?.id ?? 0
  },
  { immediate: true },
)

const skillCdHint = computed(() => {
  const Id = skillToUse.value
  if (Id <= 0) return ''
  const cd = skillCds.value[Id] ?? 0
  return cd > 0 ? `技能 #${Id} 冷却中，还剩 ${cd} 回合` : ''
})

const skillUnavailable = computed(() => {
  if (skillToUse.value <= 0) return '英雄 id 还没下发，算不出主动技能 id'
  if (skillCdHint.value.length > 0) return skillCdHint.value
  if (skillSemantic.value !== undefined && SkillTarget.value.length === 0) return '这个技能必须选目标'
  return undefined
})

function skillName(Id: number): string {
  return skillNameTable[Id] ?? (Id === myActiveSkillId.value ? '主动技能' : `技能 ${Id}`)
}

const skillCooldownRow = computed(() =>
  skillCandidates.value.map((skill) => ({
    Id: skill.id,
    name: `${skill.label} ${skillName(skill.id)}`,
    cooldown: skill.cd ?? 0,
    selected: skill.id === skillToUse.value,
  })),
)

/**
 * 技能目标候选：**所有玩家 + 所有怪物**，本地一律不筛（射程 / 阵营都由服务端判，
 * 有的技能只认非怪的玩家，但列全了才好挑）。`技能目标表` 只用来提示与挡一下空目标。
 * 服务端不下发候选，`TargetIds` 里填的就是目标的 `Player.Id`。
 */
const skillTargetCandidates = computed(() => {
  const monsterIds = new Set(battle.monsters.map((monster) => monster.id))
  const names: { id: string; name: string; position: number; isMonster: boolean }[] = []
  if (room.myId.length > 0) {
    names.push({ id: room.myId, name: '（我）', position: battle.currentPosition, isMonster: false })
  }
  for (const player of room.playerList) {
    if (player.id === room.myId) continue
    const hero = player.raw.Hero as Record<string, unknown> | undefined
    const isMonster = monsterIds.has(player.id)
    const name = player.nick || player.id
    names.push({ id: player.id, name: isMonster ? `${name}（怪）` : name, position: toNumber(hero?.NodeId), isMonster })
  }
  // 怪物也可能只在 `room.房间.Monsters` 里（不在 `玩家列表`）
  for (const monster of battle.monsters) {
    if (!names.some((item) => item.id === monster.id)) {
      names.push({ id: monster.id, name: `${monster.nickname}（怪）`, position: monster.position, isMonster: true })
    }
  }
  return names.map((item) => ({ ...item, distance: distanceText(item.position) }))
})

const skillPayload = computed(() => {
  const body: Record<string, unknown> = { UseSkill: true, SkillId: skillToUse.value }
  if (SkillTarget.value.length > 0) body.TargetIds = [SkillTarget.value]
  return body
})

// 换技能就把目标清掉：不同技能的候选池不一样，留着旧 id 会发出去一个错的 `TargetIds`
watch(skillToUse, () => {
  SkillTarget.value = ''
})


const quickCardIds = computed(() => numberArray(quickCardAction.value, 'CanUseCardIds'))
const selectedQuickCard = ref(0)
const quickCardTarget = ref('')

const quickCardRoleCandidates = computed(() => computeRoleCandidates(CardTarget(selectedQuickCard.value)))
</script>

<template>
  <div class="op-subblock">
    <div class="op-sub">
      出牌
      <span v-if="mode === '战斗'" class="op-warn">自动识别：战斗出牌（CMD=5035）</span>
      <span v-else-if="mode === '场外'" class="op-muted">自动识别：场外出牌（CMD=5055）</span>
      <span v-else class="op-muted">服务端此刻没给可出的牌</span>
    </div>

    <template v-if="mode === '战斗'">
      <div class="op-row">
        <label class="op-label">手牌</label>
        <select v-model.number="selectedBattleCard" class="op-select">
          <option :value="0">（不指定卡 = 准备 OK）</option>
          <option v-for="card in cardCardCandidates" :key="card.uniqueId" :value="card.uniqueId">
            {{ displayName(cardNameTable, card.cardId) }} #{{ card.uniqueId }}（费用 {{ card.cost }}）
          </option>
        </select>
        <span class="op-muted">SN: {{ battleAction?.Sn }}</span>
      </div>
      <div class="op-row">
        <span v-if="mineBattleEdge" class="op-muted">
          我方剩余费用：<b :class="{ ok: myCost > 0 }">{{ myCost }}</b> / {{ myCostLimit }}
          <template v-if="selectedCardCost > 0"> · 选中牌要花 {{ selectedCardCost }}</template>
          <span v-if="myCost < selectedCardCost" class="op-warn"> · 费用不够</span>
        </span>
        <span v-else class="op-muted">还没收到战斗数据（1007），费用暂时按不限处理</span>
      </div>
      <div class="op-row">
        <MenuButton
          :session="session"
          message="出牌（战斗）"
          :action="battleAction"
          :payload="selectedBattleCard > 0 ? { CardUid: selectedBattleCard } : {}"
          :extraReason="
            selectedBattleCard === 0
              ? '先选一张牌（不选就点右边的「准备 OK」）'
              : !mineBattleEdge || myCost >= selectedCardCost
                ? undefined
                : `费用不够（剩 ${myCost}，这张要 ${selectedCardCost}）`
          "
        />
        <MenuButton
          :session="session"
          message="准备 OK（不出牌）"
          :action="battleAction"
          :extraReason="selectedBattleCard > 0 ? '左边选了卡就会出牌，要准备 OK 就先清掉' : undefined"
        />
      </div>
      <p class="op-muted">
        战斗里只能用带费用的战斗牌（费用就是自己那一侧 `BattleRole.Cost`，上限 `MaxCost`）；
        不选卡直接发就是「准备 OK」。
      </p>
    </template>

    <template v-else-if="mode === '场外'">
      <div class="op-row">
        <label class="op-label">手牌</label>
        <select v-model.number="selectedFieldCard" class="op-select">
          <option v-for="cardId in outOfBattleCardList" :key="cardId" :value="cardId">
            {{ displayName(cardNameTable, cardId) }}
          </option>
        </select>
        <span class="op-muted">SN: {{ fieldCardAction?.Sn }}</span>
        <span v-if="prefilledCardId > 0" class="op-warn">
          服务端预填了「{{ displayName(cardNameTable, prefilledCardId) }}」→ 会自动发出去（这里只是显示）
        </span>
      </div>

      <div class="目标区">
        <div class="目标头">
          <span>「{{ selectedCardName }}」</span>
          <span class="op-muted">{{ targetDetail }}</span>
          <span v-if="needTarget && distanceHint" class="op-warn">{{ distanceHint }}</span>
        </div>

        <template v-if="targetType === 2">
          <div class="op-row op-row--top">
            <span class="op-label">目标角色（{{ targetPlayers.length }}）</span>
            <span class="op-checks">
              <label
                v-for="item in roleCandidates"
                :key="item.id"
                class="op-check"
                :class="{ 选中: targetPlayers.includes(item.id) }"
              >
                <input
                  type="checkbox"
                  :checked="targetPlayers.includes(item.id)"
                  @change="targetPlayers = toggle(targetPlayers, item.id) as string[]"
                />
                {{ item.name }} <em class="op-muted">距{{ item.distance }}</em>
              </label>
              <span v-if="roleCandidates.length === 0" class="op-muted">（射程内没有可打的角色）</span>
            </span>
          </div>
        </template>

        <template v-else-if="targetType === 3">
          <div class="op-row op-row--top">
            <span class="op-label">目标地块（{{ targetNodes.length }}）</span>
            <span class="op-checks">
              <label
                v-for="chunk in nodeCandidates"
                :key="chunk.node"
                class="op-check"
                :class="{ 选中: targetNodes.includes(chunk.node) }"
              >
                <input
                  type="checkbox"
                  :checked="targetNodes.includes(chunk.node)"
                  @change="targetNodes = toggle(targetNodes, chunk.node) as number[]"
                />
                {{ chunk.node }}
                <em class="op-muted">距{{ chunk.distance }}</em>
              </label>
              <span v-if="nodeCandidates.length === 0" class="op-muted">（射程内没有可放的地块）</span>
            </span>
          </div>
        </template>

        <p v-else class="op-muted">这张卡不用选目标，选好卡直接执行就行。</p>
      </div>

      <div class="op-row">
        <label class="op-label">第几个效果</label>
        <input v-model.number="effectSeq" class="op-num" type="number" min="0" />
        <MenuButton
          :session="session"
          message="使用卡牌（场外）"
          :action="fieldCardAction"
          :payload="offFieldPayload"
          :extraReason="
            selectedFieldCard > 0 ? undefined : '先选一张卡（不想出牌就点上面的「投骰 / 继续移动」）'
          "
        />
      </div>

      <div class="op-row">
        <label class="op-label">角色技能</label>
        <select v-if="skillCandidates.length > 0" v-model.number="selectedSkill" class="op-select">
          <option v-for="skill in skillCandidates" :key="skill.id" :value="skill.id">
            {{ skill.label }}：{{ skillName(skill.id) }} #{{ skill.id }}{{
              skillTargetTable[skill.id] ? '（要选目标）' : ''
            }}{{ (skill.cd ?? 0) > 0 ? `（CD 剩 ${skill.cd} 回合）` : '（可用）' }}
          </option>
        </select>
        <input
          v-else
          v-model.number="manualSkillId"
          class="op-num"
          type="number"
          min="0"
          placeholder="技能 id"
          title="英雄数据里没拿到 SkillCds，手填技能 id"
        />
        <MenuButton
          :session="session"
          message="使用角色技能"
          :action="fieldCardAction"
          :payload="skillPayload"
          :extraReason="fieldCardAction === undefined ? '服务端没给场外动作' : skillUnavailable"
        />
        <span v-if="skillCdHint" class="op-warn">{{ skillCdHint }}</span>
        <span class="op-muted">
          发的是 5055 + `UseSkill` + `SkillId={{ skillToUse || '?' }}`（少了 SkillId 会被拒 ERR=10013）
        </span>
      </div>
      <div class="op-row">
        <label class="op-label">技能目标</label>
        <select v-model="SkillTarget" class="op-select">
          <option value="">（不指定）</option>
          <option v-for="item in skillTargetCandidates" :key="item.id" :value="item.id">
            {{ item.name }} #{{ item.id }}{{ item.distance === '—' ? '' : `（距 ${item.distance} 格）` }}
          </option>
        </select>
        <span v-if="skillSemantic" class="op-muted">
          这个技能**要选目标**：{{ skillSemantic.detail }}{{ skillRangeText }}。候选是全量玩家 + 怪物
          （本地不筛，射程/阵营交给服务端判），选中后多发一个 `TargetIds=[id]`。
        </span>
        <span v-else class="op-muted">
          本地没记这个技能的目标语义（`技能目标表` 里只有 18 个要选目标的技能），一般不用填；
          真要填就从候选中挑，发出去就是目标的 `Player.Id`。
        </span>
        <span v-if="skillTargetCandidates.length === 0" class="op-warn">
          没有可选目标（房间数据里还没有玩家/怪物？）
        </span>
      </div>
      <div class="op-row">
        <label class="op-label">冷却信息</label>
        <span v-if="skillCooldownRow.length === 0" class="op-muted">
          英雄数据里没拿到 SkillCds，现在按手填的 id 发（状态交给服务端判）
        </span>
        <span
          v-for="skill in skillCooldownRow"
          :key="skill.Id"
          class="技能"
          :class="{ ok: skill.cooldown <= 0, 警告: skill.cooldown > 0, 选中: skill.selected }"
          :title="`技能 id ${skill.Id}${skill.selected ? '（现在要发的就是它）' : ''}`"
        >
          {{ skill.name }} {{ skill.cooldown > 0 ? `剩 ${skill.cooldown} 回合` : '可用' }}
        </span>
      </div>
      <p class="op-muted">每回合只能出 1 张效果牌，技能与出牌共用这一条。</p>
    </template>
  </div>

  <div v-if="quickCardAction" class="op-subblock">
    <div class="op-sub">速用卡（CMD=5057）</div>
    <div class="op-row">
      <label class="op-label">速用卡</label>
      <select v-model.number="selectedQuickCard" class="op-select">
        <option :value="0">（选一张）</option>
        <option v-for="cardId in quickCardIds" :key="cardId" :value="cardId">
          {{ displayName(cardNameTable, cardId) }}
        </option>
      </select>
      <label class="op-label">目标</label>
      <select v-model="quickCardTarget" class="op-select">
        <option value="">（不指定）</option>
        <option v-for="item in quickCardRoleCandidates" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
      <span class="op-muted">SN: {{ quickCardAction.Sn }}</span>
    </div>
    <div class="op-row">
      <MenuButton
        :session="session"
        message="打出速用卡"
        :action="quickCardAction"
        :payload="{
          ...(selectedQuickCard > 0 ? { CardId: selectedQuickCard } : {}),
          ...(quickCardTarget ? { TargetId: quickCardTarget } : {}),
        }"
        :extraReason="selectedQuickCard > 0 ? undefined : '先选一张速用卡'"
      />
    </div>
  </div>
</template>

<style scoped>
.目标区 {
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px dashed #2b3038;
  border-radius: 4px;
}

.目标头 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-bottom: 4px;
  border-bottom: 1px solid #22262e;
  color: #cfd6e2;
  font-size: 12px;
}

.op-check {
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
}

.op-check.选中 {
  border-color: #4caf7d;
  color: #4caf7d;
}

.op-check em {
  font-style: normal;
}

.op-muted b.好 {
  color: #4caf7d;
  font-weight: 600;
}

.技能 {
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 12px;
}

.技能.好 {
  color: #4caf7d;
}

.技能.警告 {
  color: #e6a23c;
}

.技能.选中 {
  border-color: #3a4150;
  background: #22262e;
}
</style>