<script setup lang="ts">
import { computed, ref } from 'vue'
import type { session } from '@/stores/session'
import { birthNodeType, birthNodeTable, nodeNameTable, nodeCoordTable, nodeDetail, mapNameTable, heroNameTable, displayName } from '@/data/names'

const props = defineProps<{
  session: session
}>()

const battle = props.session.match
const room = props.session.room
const toNum = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

const radius = 14

function avatarUrl(heroId: number): string {
  return `/avatar/hero/${heroId}.webp`
}
function monsterAvatarUrl(monsterId: number): string {
  return `/avatar/monster/${monsterId}.webp`
}

const badImages = ref(new Set<string>())
function onImageError(key: string): void {
  if (badImages.value.has(key)) return
  badImages.value = new Set(badImages.value).add(key)
}

interface Occupant {
  image: string
  hint: string
  my: boolean
  key: string
}

const typeColors: Record<number, string> = {
  1: '#3d7bd9',
  2: '#3aa06a',
  7: '#c9a03a',
  8: '#5f6c85',
  12: '#2f9e9e',
  14: '#8a6fd0',
  15: '#cf8a3d',
  17: '#b8524f',
  19: '#9c4b6b',
  20: '#5aa0c9',
  21: '#7a5c3a',
  24: '#c9a03a',
}

const defaultColor = '#4a4f5c'

function type(node: number): number {
  return battle.nodes.find((chunk) => chunk.node === node)?.type ?? 0
}

const occupancy = computed(() => {
  const table = new Map<number, Occupant[]>()
  const put = (node: number, item: Occupant): void => {
    if (!Number.isFinite(node)) return
    const old = table.get(node)
    if (old) old.push(item)
    else table.set(node, [item])
  }
  for (const player of battle.playerDataList) {
    const name = player.heroId > 0 ? displayName(heroNameTable, player.heroId) : player.nickname
    put(player.position, {
      image: player.heroId > 0 ? avatarUrl(player.heroId) : '',
      hint: `玩家 ${player.nickname}（${name}）`,
      my: player.playerId === room.myId,
      key: `人${player.playerId}`,
    })
  }
  for (const monster of battle.monsters) {
    put(monster.position, {
      image: monster.heroId > 0 ? monsterAvatarUrl(monster.heroId) : '',
      hint: `怪物 ${monster.nickname}（id ${monster.heroId || monster.id}）`,
      my: false,
      key: `怪${monster.id}`,
    })
  }
  return table
})

const maxAvatars = 4

const placementTable: Record<number, { scale: number; offset: [number, number][] }> = {
  1: { scale: 1, offset: [[0, 0]] },
  2: { scale: 0.62, offset: [[-0.6, 0], [0.6, 0]] },
  3: { scale: 0.52, offset: [[0, -0.55], [-0.6, 0.5], [0.6, 0.5]] },
  4: { scale: 0.46, offset: [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]] },
}

interface AvatarSlot extends Occupant {
  cx: number
  cy: number
  r: number
}

const layout = computed(() => {
  const table = new Map<number, AvatarSlot[]>()
  for (const [node, person] of occupancy.value) {
    const point = positionByNode.value.get(node)
    if (!point) continue
    const drawable = person.filter((item) => item.image.length > 0 && !badImages.value.has(item.key)).slice(0, maxAvatars)
    if (drawable.length === 0) continue
    const spot = placementTable[drawable.length] ?? placementTable[1]
    const r = (radius - 1) * (spot?.scale ?? 1)
    table.set(
      node,
      drawable.map((item, i) => {
        const offset = spot?.offset[i] ?? [0, 0]
        return { ...item, cx: point.x + offset[0] * r, cy: point.y + offset[1] * r, r }
      }),
    )
  }
  return table
})

const clipPaths = computed(() =>
  [...layout.value.entries()].flatMap(([node, person]) =>
    person.map((item, i) => ({ id: `裁${node}-${i}`, cx: item.cx, cy: item.cy, r: item.r })),
  ),
)

function overflow(node: number): string {
  const extra = (occupancy.value.get(node) ?? []).length - maxAvatars
  return extra > 0 ? `+${extra}` : ''
}

function circleText(node: number): { text: string; fontSize: number } {
  const name = nodeNameTable[type(node)]
  return name ? { text: name, fontSize: Math.max(5, Math.min(10, 24 / name.length)) } : { text: String(node), fontSize: 11 }
}

const coords = computed(() => {
  const table = nodeCoordTable[toNum(room.room?.MapId)] ?? {}
  return Object.entries(table).map(([Id, [x, z]]) => ({ node: Number(Id), x, y: -z }))
})

const positionByNode = computed(() => new Map(coords.value.map((point) => [point.node, point])))

const view = computed(() => {
  if (coords.value.length === 0) return null
  const margin = radius * 3
  const left = Math.min(...coords.value.map((point) => point.x)) - margin
  const right = Math.max(...coords.value.map((point) => point.x)) + margin
  const top = Math.min(...coords.value.map((point) => point.y)) - margin
  const bottom = Math.max(...coords.value.map((point) => point.y)) + margin
  return { viewBox: `${left} ${top} ${right - left} ${bottom - top}` }
})

function bornOwnerName(node: number): string {
  const table = birthNodeTable[toNum(room.room?.MapId)]
  const mySeat = room.my?.slot
  const hit = table ? Object.entries(table).find(([, nodes]) => nodes === node) : undefined
  if (hit) {
    const seat = Number(hit[0])
    return seat === mySeat ? '我的起始点' : `${seat + 1} 号位的起始点`
  }
  return node === battle.myBornNode ? '我的起始点' : '别人的起始点'
}

function hoverText(node: number): string {
  const typeId = type(node)
  const row = [`${node} 号地块${nodeNameTable[typeId] ? `（${nodeNameTable[typeId]}）` : ''}`, nodeDetail(typeId) || '（没有说明）']
  if (typeId === birthNodeType) row.push(bornOwnerName(node))
  const person = occupancy.value.get(node) ?? []
  if (person.length > 0) row.push(person.map((item) => item.hint).join('、'))
  const nodeBuffs = battle.nodeBuff.get(node) ?? []
  if (nodeBuffs.length > 0) row.push(nodeBuffs.join('、'))
  if (node === battle.mine?.position) row.push('我在这里')
  return row.join('\n')
}
</script>

<template>
  <div class="地图">
    <svg v-if="view" class="画布" :viewBox="view.viewBox" preserveAspectRatio="xMidYMid meet">
      <defs>
        <clipPath v-for="head in clipPaths" :id="head.id" :key="head.id">
          <circle :cx="head.cx" :cy="head.cy" :r="head.r" />
        </clipPath>
      </defs>
      <g v-for="point in coords" :key="point.node">
        <title>{{ hoverText(point.node) }}</title>
        <circle
          v-if="battle.walkCandidates.includes(point.node)"
          :cx="point.x"
          :cy="point.y"
          :r="radius + 4"
          class="可走"
        />
        <circle :cx="point.x" :cy="point.y" :r="radius" :fill="typeColors[type(point.node)] ?? defaultColor" />
        <text
          v-if="!(layout.get(point.node)?.length)"
          :x="point.x"
          :y="point.y"
          :font-size="circleText(point.node).fontSize"
          class="名"
        >
          {{ circleText(point.node).text }}
        </text>
        <template v-for="(head, i) in layout.get(point.node) ?? []" :key="head.key">
          <image
            :href="head.image"
            :x="head.cx - head.r"
            :y="head.cy - head.r"
            :width="head.r * 2"
            :height="head.r * 2"
            :clip-path="`url(#裁${point.node}-${i})`"
            preserveAspectRatio="xMidYMid slice"
            class="头像"
            @error="onImageError(head.key)"
          />
        </template>
        <text
          v-if="overflow(point.node)"
          :x="point.x + radius * 0.75"
          :y="point.y + radius * 0.9"
          class="溢出"
        >
          {{ overflow(point.node) }}
        </text>
        <circle
          v-if="point.node === battle.mine?.position"
          :cx="point.x"
          :cy="point.y"
          :r="radius + 1"
          class="是我"
        />
        <circle
          v-if="(battle.nodeBuff.get(point.node) ?? []).length > 0"
          :cx="point.x + radius * 0.8"
          :cy="point.y - radius * 0.8"
          r="4"
          class="挂件"
        />
      </g>
    </svg>
    <p v-else class="灰">
      还没有「{{ displayName(mapNameTable, toNum(room.room?.MapId)) }}」的世界坐标 —— 在对局里用 
      调试 tab 的「输出地块世界坐标(对局中)」dump 一次，我再填进 names.ts 的 `地块坐标表`
    </p>
  </div>
</template>

<style scoped>
.地图 {
  width: 100%;
}

.画布 {
  display: block;
  width: 100%;
  max-height: 460px;
  background: #0f1217;
  border: 1px solid #23262f;
  border-radius: 6px;
}

.名 {
  fill: #f2f5fa;
  font-weight: 600;
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}

.溢出 {
  fill: #e8ebf0;
  font-size: 9px;
  font-weight: 600;
  text-anchor: middle;
  pointer-events: none;
}

.头像 {
  pointer-events: none;
}

.是我 {
  fill: none;
  stroke: #ffffff;
  stroke-width: 3;
}

.可走 {
  fill: none;
  stroke: #6f7b8f;
  stroke-width: 2;
  stroke-dasharray: 4 4;
}

.挂件 {
  fill: #e6a23c;
  stroke: #0f1217;
  stroke-width: 1.5;
}

.灰 {
  color: #7a8291;
}
</style>