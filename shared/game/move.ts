/**
 * 对局「走位」折叠 —— **唯一一份实现**，前后端共用。
 *
 * ⚠️ 改这里 = 同时影响 `src/stores/battle.ts`（前端显示 + 自动移动）与
 *    `server/game/view.ts`（后端脚本引擎）。两处都必须保持行为一致，别只改一边。
 *
 * 纯 TS：不 import Vue、不碰 DOM、入参出参都是普通值。只依赖 `src/data/names.ts`
 * 的静态邻接表（那个目录已经在 `tsconfig.server.json` 的 include 里，Node 侧能直接加载）。
 *
 * 为什么值得单独抽：D1–D5 五个 bug 全落在这条链路上（0 号地块合法、NodeIds 不含出发点、
 * 服务端 FrontNodeIds 会过期、怪物突击的瞬移要另认帧、打「方向抉择」后要解除来路限制），
 * 前端和后端各写一份必然会漂移。
 */
import { mapAdjacency } from '../../src/data/names.ts'

/**
 * 走位态里位置/来路/步数的「-1 = 不知道」约定：
 * 地块 0 是**合法**地块，所以只有 -1 表示未知（服务端 `BackNodeId` 没值时推的也是 -1）。
 */
export interface MoveState {
  /** 我自己最后一次落地的那一格（服务端 `MoveS2C` / `PursuitS2C` 推出来的） */
  landedNode: number
  /** 来路 = 站在当前位置时「上一格」在哪。参考工程 `Core.Unit.UnitLand.CanSelectedLandId(from)` */
  fromNode: number
  /** 本次移动已经走了几格（服务端 `NodeIds` 只含新踩到的地块，不含出发点） */
  walkedSteps: number
  /** `MoveS2C` 沿途攒出来的边（静态邻接表只有部分图，靠这个补） */
  knownEdges: Record<number, number[]>
  /** 所有玩家最后一次落地：`[玩家id] → 地块号` */
  positionByPlayer: Record<string, number>
}

export function initialMoveState(): MoveState {
  return { landedNode: -1, fromNode: -1, walkedSteps: 0, knownEdges: {}, positionByPlayer: {} }
}

/**
 * 把「起点 → 经过的每一格」记成无向边。记边不排除 0 号地块。
 */
export function computeKnownEdges(
  prev: Record<number, number[]>,
  startNode: number,
  visited: number[],
): Record<number, number[]> {
  const nextEdges: Record<number, number[]> = { ...prev }
  const record = (a: number, b: number): void => {
    if (a < 0 || b < 0 || a === b) return
    nextEdges[a] = [...new Set([...(nextEdges[a] ?? []), b])]
    nextEdges[b] = [...new Set([...(nextEdges[b] ?? []), a])]
  }
  if (startNode >= 0) record(startNode, visited[0] ?? -1)
  for (let i = 1; i < visited.length; i += 1) record(visited[i - 1] ?? -1, visited[i] ?? -1)
  return nextEdges
}

/**
 * 我自己现在在哪：本地落点优先，没有就回落到服务端给的备用位置
 * （前端是 `位置表[我的Id] ?? Hero.NodeId`，后端同理）。
 */
export function computeCurrentPosition(landedNode: number, fallbackPosition: number): number {
  return landedNode >= 0 ? landedNode : fallbackPosition
}

/**
 * 收 `MoveS2C` 之后的走位折叠。
 *
 * `NodeIds` 里只有「新踩到的格子」，不含出发点，所以起点要自己补：
 * 我自己 = 当前位置（0 是合法地块，只有 -1 才算未知），别人 = 他自己的上一条落地。
 */
export function applyMove(
  state: MoveState,
  params: { who: string; myId: string; myFallbackPosition: number; visited: number[] },
): MoveState {
  const { who, myId, myFallbackPosition, visited } = params
  if (visited.length === 0) return state

  const startNode = who === myId ? computeCurrentPosition(state.landedNode, myFallbackPosition) : (state.positionByPlayer[who] ?? -1)
  const knownEdges = computeKnownEdges(state.knownEdges, startNode, visited)

  if (who.length === 0) return { ...state, knownEdges }

  const newLandedNode = visited[visited.length - 1] ?? -1
  if (newLandedNode < 0) return { ...state, knownEdges }

  const positionByPlayer = { ...state.positionByPlayer, [who]: newLandedNode }
  if (who !== myId) return { ...state, knownEdges, positionByPlayer }

  return {
    landedNode: newLandedNode,
    // 来路 = 上一格（一段里有多个格子就取倒数第二个，只有一格就取出发点）
    fromNode: visited.length >= 2 ? (visited[visited.length - 2] ?? -1) : startNode,
    // 服务端推送的每个节点都算一步（实测 `MovePoint` == 各段 `NodeIds` 长度之和），
    // 所以是 += 经过.length，不是 length - 1（出发点不在 NodeIds 里，不该扣）。
    walkedSteps: state.walkedSteps + visited.length,
    knownEdges,
    positionByPlayer,
  }
}

/**
 * 反推来路。服务端 `Hero.FrontNodeIds` = 这一步能走的方向，那「邻接里不在 FrontNodeIds 里的那个」
 * 就是来路（参考工程 `Core.Unit.UnitLand.GetFromLandId`）。
 */
export function computeFromNode(args: {
  fromNode: number
  frontNodes: number[]
  mapId: number
  position: number
  heroBackNodeId: number
}): number {
  if (args.fromNode >= 0) return args.fromNode
  if (args.frontNodes.length === 0) return args.heroBackNodeId
  const adjacency = mapAdjacency(args.mapId, args.position)
  const inferred = adjacency.find((node) => !args.frontNodes.includes(node))
  return inferred === undefined ? args.heroBackNodeId : inferred
}

/**
 * 可走候选。三道判据依次是：
 *
 * 1. **强制选方向**（服务端刚打完「方向抉择」这类卡，预测动作 `MoveC2S.Data.ForceDir === true`）：
 *    来路限制解除，全部邻接（含回头路）都合法；服务端旧 `FrontNodeIds` 是按旧来路算的，不能用。
 * 2. 服务端 `FrontNodeIds` 就是权威答案，但它只在对应 `NodeId` 与当前位置一致时才新鲜 ——
 *    走出去以后服务端不会再推 `FrontNodeIds`（`UpdateHeroAttrS2C` 的 `Place` 段实测恒为空）。
 * 3. 否则本地按 `CanSelectedLandId(来路)` 推：邻接去掉来路；静态邻接表缺的用「已知边」补。
 */
export function computeWalkCandidates(args: {
  position: number
  forceDirection: boolean
  mapId: number
  frontNodes: number[]
  serverPosition: number
  knownEdges: Record<number, number[]>
  fromNode: number
}): number[] {
  const sortedAsc = (table: number[]): number[] => [...table].sort((a, b) => a - b)
  if (args.position < 0) return []

  const localAdjacency = (): number[] => {
    const adjacency = mapAdjacency(args.mapId, args.position)
    return adjacency.length > 0 ? adjacency : (args.knownEdges[args.position] ?? [])
  }

  if (args.forceDirection) {
    const allNodes = localAdjacency()
    return allNodes.length > 0 ? sortedAsc(allNodes) : sortedAsc(args.frontNodes)
  }

  if (args.frontNodes.length > 0 && args.serverPosition === args.position) return sortedAsc(args.frontNodes)

  const allNodes = localAdjacency()
  if (allNodes.length === 0) return sortedAsc(args.frontNodes)
  const withoutBackEdge = allNodes.filter((node) => node !== args.fromNode)
  return sortedAsc(withoutBackEdge.length > 0 ? withoutBackEdge : allNodes)
}