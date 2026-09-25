<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CandidateAction } from '@/stores/battle'
import type { session } from '@/stores/session'
import { toReadableJson } from '@shared/protocol/readableJson'
import { getActionSpec } from '@/data/battleActions'
import type { Control } from '@/data/battleActions'
import { cardNameTable, displayName } from '@/data/names'

const props = defineProps<{
  action: CandidateAction
  session: session
}>()

const session = props.session
const battle = session.match
const room = session.room

const canOperate = computed(() => session.isLogined)

const draft = ref('{}')

const spec = computed(() => getActionSpec(props.action.commandName))

function readDraftObject(): Record<string, unknown> {
  try {
    const value = JSON.parse(draft.value) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeField(field: string, value: unknown): void {
  const cur = readDraftObject()
  if (value === undefined) delete cur[field]
  else cur[field] = value
  draft.value = JSON.stringify(cur, null, 2)
}

function toggleField(field: string, value: number | string): void {
  const prev = readDraftObject()[field]
  const list = Array.isArray(prev) ? (prev as unknown[]).map((item) => String(item)) : []
  const text = String(value)
  const nextList = list.includes(text) ? list.filter((item) => item !== text) : [...list, text]
  writeField(field, nextList.length > 0 ? nextList : undefined)
}

function readField(field: string): unknown {
  return readDraftObject()[field]
}

function hasFieldValue(field: string, value: number | string): boolean {
  const cur = readField(field)
  if (!Array.isArray(cur)) return false
  return (cur as unknown[]).map((item) => String(item)).includes(String(value))
}

function isSelected(field: string, value: number | string): boolean {
  const cur = readField(field)
  return cur !== undefined && cur !== null && String(cur) === String(value)
}

function controlName(control: Control): string {
  switch (control.kind) {
    case '数字':
      return control.name
    case '开关':
      return '怎么选'
    case '节点':
      return control.field === 'Direction' ? '往哪走' : '目标节点（可不选）'
    case '玩家':
      return '目标玩家（可不选）'
    case '怪物':
      return '选哪只怪'
    case '卡':
      return '用哪张卡'
    case '手牌':
      return '选我的手牌（唯一 id）'
    case '整数多选':
      return '选（可多选）'
    case '整数单选':
      return '选一个'
    default:
      return ''
  }
}

function countValueGroups(fieldName?: string): { name: string; value: (number | string)[] }[] {
  const collectGroup = (name: string, rawValue: unknown): { name: string; value: (number | string)[] } | null => {
    if (!Array.isArray(rawValue) || rawValue.length === 0) return null
    const converted: (number | string)[] = []
    for (const item of rawValue as unknown[]) {
      if (typeof item === 'number') converted.push(item)
      else if (typeof item === 'bigint') converted.push(item.toString())
      else return null
    }
    return { name, value: converted }
  }

  if (fieldName !== undefined) {
    const oneGroup = collectGroup(fieldName, props.action.data[fieldName])
    return oneGroup ? [oneGroup] : []
  }

  const group: { name: string; value: (number | string)[] }[] = []
  for (const [name, value] of Object.entries(props.action.data)) {
    if (name === 'Info') continue
    const oneGroup = collectGroup(name, value)
    if (oneGroup) group.push(oneGroup)
  }
  return group
}

function availableNodes(control: Control): number[] {
  if (control.kind === '节点' && control.allNodes) return battle.nodes.map((chunk) => chunk.node)
  return battle.mine?.walkableNodes ?? []
}

function cardCandidates(control: Control): (number | string)[] {
  const specified = control.kind === '卡' ? control.candidates : undefined
  if (specified !== undefined) return countValueGroups(specified)[0]?.value ?? []
  return [...new Set((battle.mine?.handCards ?? []).map((card) => card.cardId))]
}

function playerCandidates(): { id: string; name: string }[] {
  return room.playerList.map((player) => ({
    id: player.id,
    name: player.id === room.myId ? '（我）' : player.nick || player.id,
  }))
}

function onNumberInput(field: string, events: Event): void {
  writeField(field, Number((events.target as HTMLInputElement).value || 0))
}

function onIntInput(field: string, multiSelect: boolean, events: KeyboardEvent): void {
  const value = Number((events.target as HTMLInputElement).value)
  if (multiSelect) toggleField(field, value)
  else writeField(field, value)
}

async function execute(): Promise<void> {
  await session.executeMatchAction(props.action, readDraftObject())
}
</script>

<template>
  <div class="动作">
    <div class="动作头">
      <strong>{{ spec?.name ?? action.commandName }}</strong>
      <span class="muted">{{ action.commandName }} · Id={{ action.cmdId }} · Sn={{ action.Sn }}</span>
      <span v-if="battle.myTurn" class="tag">我的回合</span>
      <span v-else class="tag">需要我响应</span>
    </div>
    <p v-if="spec" class="hint">{{ spec.detail }}</p>
    <p v-else class="hint warn">
      这个命令还没有登记画法，只能用下面的 JSON 编辑器手填（字段名看上面的「服务端给的参数」）。
    </p>

    <div v-for="(control, seq) in spec?.Control ?? []" :key="seq" class="控件">
      <span class="标签">{{ controlName(control) }}</span>
      <span v-if="control.kind === '无'" class="muted">不需要填参数，直接执行</span>

      <template v-else-if="control.kind === '开关'">
        <button
          class="ghost small"
          :class="{ 选中: readField(control.field) === true }"
          :disabled="!canOperate"
          @click="writeField(control.field, true)"
        >
          {{ control.on }}
        </button>
        <button
          class="ghost small"
          :class="{ 选中: readField(control.field) === false }"
          :disabled="!canOperate"
          @click="writeField(control.field, false)"
        >
          {{ control.off }}
        </button>
      </template>

      <template v-else-if="control.kind === '数字'">
        <input
          class="数字"
          type="number"
          :value="readField(control.field) ?? control.defaultValue ?? ''"
          @input="onNumberInput(control.field, $event)"
        />
        <span v-if="control.hint" class="muted">{{ control.hint }}</span>
      </template>

      <template v-else-if="control.kind === '节点'">
        <template v-if="control.multiSelect">
          <button
            v-for="node in availableNodes(control)"
            :key="node"
            class="ghost small"
            :class="{ 选中: hasFieldValue(control.field, node) }"
            :disabled="!canOperate"
            @click="toggleField(control.field, node)"
          >
            {{ node }}
            <em v-if="battle.mine?.position === node">·我</em>
          </button>
        </template>
        <template v-else>
          <button
            v-for="node in availableNodes(control)"
            :key="node"
            class="ghost small"
            :class="{ 选中: isSelected(control.field, node) }"
            :disabled="!canOperate"
            @click="writeField(control.field, node)"
          >
            → {{ node }}
          </button>
        </template>
        <span v-if="availableNodes(control).length === 0" class="muted">（没有可选节点）</span>
      </template>

      <template v-else-if="control.kind === '玩家'">
        <button
          v-for="item in playerCandidates()"
          :key="item.id"
          class="ghost small"
          :class="{ 选中: control.multiSelect ? hasFieldValue(control.field, item.id) : isSelected(control.field, item.id) }"
          :disabled="!canOperate"
          @click="control.multiSelect ? toggleField(control.field, item.id) : writeField(control.field, item.id)"
        >
          {{ item.name }}
        </button>
        <span v-if="playerCandidates().length === 0" class="muted">（服务端还没下发玩家）</span>
      </template>

      <template v-else-if="control.kind === '怪物'">
        <button
          v-for="monster in battle.monsters"
          :key="monster.id"
          class="ghost small"
          :class="{ 选中: isSelected(control.field, monster.id) }"
          :disabled="!canOperate"
          @click="writeField(control.field, monster.id)"
        >
          {{ monster.nickname }} <em>{{ monster.hp }}/{{ monster.maxHp }}</em>
        </button>
        <span v-if="battle.monsters.length === 0" class="muted">（场上没有怪物）</span>
      </template>

      <template v-else-if="control.kind === '卡'">
        <button
          v-for="cardId in cardCandidates(control)"
          :key="cardId"
          class="ghost small"
          :class="{ 选中: isSelected(control.field, cardId) }"
          :disabled="!canOperate"
          @click="writeField(control.field, cardId)"
        >
          {{ displayName(cardNameTable, Number(cardId)) }}
        </button>
        <span v-if="cardCandidates(control).length === 0" class="muted">（没有可选的卡）</span>
      </template>

      <template v-else-if="control.kind === '手牌'">
        <button
          v-for="card in battle.mine?.handCards ?? []"
          :key="card.uniqueId"
          class="ghost small"
          :class="{
            选中: control.multiSelect ? hasFieldValue(control.field, card.uniqueId) : isSelected(control.field, card.uniqueId),
          }"
          :disabled="!canOperate"
          @click="control.multiSelect ? toggleField(control.field, card.uniqueId) : writeField(control.field, card.uniqueId)"
        >
          {{ displayName(cardNameTable, card.cardId) }} <em>#{{ card.uniqueId }}</em>
        </button>
        <span v-if="(battle.mine?.handCards.length ?? 0) === 0" class="muted">（我没有手牌）</span>
      </template>

      <template v-else-if="control.kind === '整数多选' || control.kind === '整数单选'">
        <template v-for="group in countValueGroups(control.candidates)" :key="group.name">
          <span class="分组名">{{ group.name }}</span>
          <button
            v-for="value in group.value"
            :key="value"
            class="ghost small"
            :class="{
              选中: control.kind === '整数多选' ? hasFieldValue(control.field, value) : isSelected(control.field, value),
            }"
            :disabled="!canOperate"
            @click="control.kind === '整数多选' ? toggleField(control.field, value) : writeField(control.field, value)"
          >
            {{ value }}
          </button>
        </template>
        <span v-if="countValueGroups(control.candidates).length === 0" class="muted">（Data 里没有候选项）</span>
        <span class="muted">手填：</span>
        <input
          class="数字"
          type="number"
          placeholder="值"
          @keyup.enter="onIntInput(control.field, control.kind === '整数多选', $event)"
        />
      </template>
    </div>

    <details class="上下文">
      <summary>服务端给的参数（只读，仅作参考）</summary>
      <pre>{{ toReadableJson(action.data) }}</pre>
    </details>

    <details class="上下文" open>
      <summary>我要发的字段（可手改）</summary>
      <textarea v-model="draft" class="草稿" rows="3"></textarea>
      <p class="hint">执行时会自动补上 `Info: { Sn: {{ action.Sn }}, UseTime: 0 }`。</p>
    </details>

    <div class="actions">
      <button class="primary small" :disabled="!canOperate" @click="execute">
        执行 {{ spec?.name ?? action.commandName }}
      </button>
      <button class="ghost small" :disabled="!canOperate" @click="draft = '{}'">清空参数</button>
    </div>
  </div>
</template>

<style scoped>
.动作 {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid #2b3038;
  border-radius: 4px;
}

.动作头 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.muted {
  color: var(--muted);
}

.hint {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.hint.warn {
  color: #e0a33e;
}

.tag {
  padding: 1px 6px;
  border-radius: 3px;
  background: #22608f;
  color: #fff;
  font-size: 11px;
}

.控件 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.控件 .标签 {
  min-width: 132px;
  color: var(--muted);
  font-size: 12px;
}

.分组名 {
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 3px;
  background: #22262e;
  color: var(--muted);
  font-size: 11px;
}

.选中 {
  border-color: #4caf7d !important;
  color: #4caf7d;
}

.数字 {
  width: 88px;
  padding: 3px 6px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-size: 12px;
}

.上下文 {
  margin-top: 10px;
}

.上下文 summary {
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.上下文 pre {
  max-height: 240px;
  margin: 6px 0 0;
  padding: 8px;
  border: 1px solid #22262e;
  border-radius: 4px;
  background: #14171c;
  color: #9aa4b2;
  font-size: 12px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.草稿 {
  width: 100%;
  margin-top: 8px;
  padding: 8px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  resize: vertical;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.actions button {
  margin: 0;
}

em {
  color: var(--muted);
  font-style: normal;
}
</style>