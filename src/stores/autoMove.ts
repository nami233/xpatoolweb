import { computed, reactive, ref, watch } from 'vue'
import type { CandidateAction, MatchState } from '@/stores/battle'
import type { roomState } from '@/stores/room'
import { mapAdjacency } from '@/data/names'

const stepIntervalMs = 700
const maxSteps = 999999

export interface AutoMoveDeps {
  match: MatchState
  room: roomState
  executeMatchAction: (action: CandidateAction, fieldsToSend?: Record<string, unknown>) => Promise<boolean>
  writeLog?: (text: string) => void
}

export function createAutoMove(deps: AutoMoveDeps) {
  const battle = deps.match
  const room = deps.room

  const currentPosition = computed(() => battle.currentPosition)

  const walkedSteps = ref(0)
  const lastSn = ref('')
  const sending = ref(false)
  const state = ref('')

  const serverDirection = computed(() => {
    const action = battle.getTodo('MoveC2S')
    if (!action) return 0
    const rawValue = action.data?.Direction
    const node = typeof rawValue === 'number' ? rawValue : Number(rawValue ?? 0)
    return Number.isFinite(node) && node > 0 ? node : 0
  })

  const walkCandidates = computed(() => battle.walkCandidates)

  const forceDirection = computed(() => battle.forceDirection)

  const nextNode = computed<{ Sn: string; node: number; origin: string } | null>(() => {
    const action = battle.getTodo('MoveC2S')
    if (!action) return null
    if (forceDirection.value && serverDirection.value > 0) {
      return { Sn: action.Sn, node: serverDirection.value, origin: '服务端强制方向' }
    }
    // 服务端说这一步方向由玩家自己定（来路限制已解除）又没预填方向 → 停下等人，别替他自动走。
    if (forceDirection.value) return null
    if (!hasAdjacency.value) return null
    const first = walkCandidates.value[0]
    if (walkCandidates.value.length === 1 && first !== undefined) {
      return { Sn: action.Sn, node: first, origin: '唯一方向' }
    }
    return null
  })

  const hasAdjacency = computed(() => {
    if (mapAdjacency(Number(room.room?.MapId ?? 0), currentPosition.value).length > 0) return true
    // 静态邻接表只有部分图，靠 MoveS2C 攒出来的「已知边」也算数。
    return (battle.knownEdges[currentPosition.value] ?? []).length > 0
  })

  const needDirection = computed(
    () => battle.getTodo('MoveC2S') !== undefined && nextNode.value === null,
  )

  const lastStopSn = ref('')

  watch([nextNode, serverDirection, forceDirection, walkCandidates], () => {
    const action = battle.getTodo('MoveC2S')
    if (!action) {
      lastStopSn.value = ''
      return
    }
    if (nextNode.value !== null || lastStopSn.value === action.Sn) return
    lastStopSn.value = action.Sn
    const fromNode = battle.currentFromNode
    const localText = hasAdjacency.value
      ? `本地可选 [${walkCandidates.value.join(', ')}]${fromNode >= 0 ? `（来路 ${fromNode}）` : '（来路未知）'}`
      : '本地没有这张图的邻接表'
    const serverMessage =
      serverDirection.value > 0
        ? `服务端预填 Direction=${serverDirection.value}${forceDirection.value ? ' 且说方向强制' : '（没说强制）'}`
        : forceDirection.value
          ? '服务端说这一步方向由玩家自己定（来路限制已解除，可以后退）'
          : '服务端没预填方向'
    state.value = `停下等人：${localText}；${serverMessage}`
    deps.writeLog?.(`自动移动: 停下等人 —— ${localText}；${serverMessage}`)
  })

  const pendingResend = ref(false)

  function getTargetStep(): { Sn: string; node: number; origin: string } | null {
    const target = nextNode.value
    if (!target) return null
    if (target.Sn === lastSn.value) return null
    if (walkedSteps.value >= maxSteps) {
      state.value = `已连走 ${maxSteps} 格，自动停下（走到下一段会重新开始）`
      return null
    }
    return target
  }

  function stepOnce(): void {
    const target = getTargetStep()
    if (!target) return
    if (sending.value) {
      pendingResend.value = true
      return
    }
    sending.value = true
    void (async () => {
      try {
        await new Promise((done) => setTimeout(done, stepIntervalMs))
        if (nextNode.value?.Sn !== target.Sn) return
        lastSn.value = target.Sn
        walkedSteps.value += 1
        state.value = `自动走第 ${walkedSteps.value} 格 → ${target.node}（${target.origin}）`
        const action = battle.getTodo('MoveC2S')
        if (!action) return
        await deps.executeMatchAction(action, { Direction: target.node })
      } finally {
        sending.value = false
        if (pendingResend.value) {
          pendingResend.value = false
          stepOnce()
        }
      }
    })()
  }

  watch(nextNode, () => stepOnce())

  function reset(): void {
    walkedSteps.value = 0
    lastSn.value = ''
  }

  watch(() => battle.getTodo('MoveC2S')?.Sn, (Sn) => {
    if (Sn === undefined) reset()
  })

  return reactive({
    state,
    reset,
    walkedSteps,
    needDirection,
    nextNode,
    walkCandidates,
    serverDirection,
    forceDirection,
    sending,
  })
}

export type AutoMoveState = ReturnType<typeof createAutoMove>