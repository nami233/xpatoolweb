/**
 * 槽位的「全量帧回放缓存」。
 *
 * 用途：前端刷新 / 断线重连回来时，光有一条 `槽位状态` 不够 —— 界面要能直接回到刷新前，
 * 就得把**最近的全量帧**重放一遍（房间、轮次、进度、地图、地块 Buff……）。
 *
 * 四条硬规矩：
 *  - **全量帧只留最新一条**（房间类 + 标量/幂等类），后到覆盖前一条。
 *  - **房间类共用一个槽**：`RoomNotifyS2C` / `SyncRoomS2C` / `CreateRoomS2C` / `JoinRoomS2C` /
 *    `QuickJoinRoomS2C` / `RunningGameS2C`(1003) / `ReplaySnapshotS2C`(1113) 都是「整份房间状态」，
 *    同一时刻只有最新那条有意义，后到覆盖前一条。
 *  - **位置类增量按到达顺序回放**（`MoveS2C` + `PursuitS2C`(5034) / `MonsterPursuitS2C`(5214)）：
 *    服务端只在开局推一次全量房间帧，之后所有位移都只走这几条帧。不缓存它们，
 *    刷新后每个头像都会停在开局（或上一次全量帧）那一格。
 *    它们排在全量帧之后按顺序回放，前端那条 `收到移动` / `收到追击` 就能自己把位置接回原样。
 *    追击 / 怪物突击是**瞬移落位**（落点+前路+来路），必须和 `MoveS2C` 混在同一条队列里
 *    保持先后 —— 分开存的话，突击之后回放会把瞬移之前那些步再走一遍，位置照样回不去。
 *    代价是前端 `已走步数` 会被重算一遍；该值只在「已投骰未走完」时显示，而 `投骰步数`
 *    来自同样不缓存的 `ThrowDiceS2C`，刷新后恒为 0，所以界面上看不到。
 *    `MoveAgainS2C` / `ThrowDiceS2C` 只是投骰结果、不带位置，仍然不回放。
 *  - **怪物刷新 `MonsterRefreshS2C` 按怪 id 留最新一条**：它是「一帧一个怪」的增量
 *    （`Monster` 不是 repeated），全量房间帧之后刷新出来的怪只能靠它，不回放就会整批消失。
 *    回放是安全的 —— 前端的 `收到怪物` 按 `Id` upsert，幂等。新的全量房间帧一到就整批作废：
 *    那帧自带的 `Monsters` 才是权威名单（`收到房间` 本来就会把 `房间` 整份替换掉）。
 */
import type { DecodedMessage } from '../../shared/protocol/jsonSafe.ts'

/** 房间类：共用一个槽，后到覆盖 */
const roomKind = new Set([
  'RoomNotifyS2C',
  'SyncRoomS2C',
  'CreateRoomS2C',
  'JoinRoomS2C',
  'QuickJoinRoomS2C',
  // 1003 全量房间帧
  'RunningGameS2C',
  // 1113 兜底快照（客户端订阅它来补轮次）
  'ReplaySnapshotS2C',
])

/** 标量 / 幂等类：各自一个槽 */
const singleItemKind = new Set([
  // 1071 进度（上限要用本地难度配置表，这里只负责把服务端说的当前值带回去）
  'GameProgressChangeS2C',
  // 1117 轮次（PVE 路径）
  'GameRoundChangeS2C',
  // 1015 轮次（主来源）
  'RoundStartS2C',
  'UpdateHeroAttrS2C',
  'HeroBarBoxChangeS2C',
  'LandBuffsS2C',
  'ActionStartNotifyS2C',
  'PredictActionS2C',
])

/**
 * 位置类增量：不进「最新一条」的表，按到达顺序排队回放（见文件头第三条）。
 * - `MoveS2C` 一步一步的位移；
 * - `PursuitS2C`(5034) / `MonsterPursuitS2C`(5214) 追击 / 怪物突击的瞬移落位。
 * 两类都是「位置事件」，必须混在同一条队列里保持先后（理由见文件头）。
 * `MoveAgainS2C` / `ThrowDiceS2C` 都不带位置。
 */
const positionKind = new Set(['MoveS2C', 'PursuitS2C', 'MonsterPursuitS2C'])

/**
 * 位置帧队列上限。只影响「队首那一步」的来路推断：位置本身由队尾决定，
 * 来路只看同一段里的前一个格子，所以丢最早的那些不会让位置出错。
 */
const positionFrameLimit = 400

/** 怪物刷新：一帧一个怪，按怪 id 留最新一条（见文件头第四条） */
const Monster = 'MonsterRefreshS2C'

/**
 * 回放顺序：房间 → 对局细节 → 行动。
 * `槽位状态` 由连接侧排在回放帧之前，所以这里的帧不用管「我是谁」（`房间.我的Id` 已经就位）。
 */
const order: string[] = ['房间', ...singleItemKind]

export interface replayFrame {
  name: string
  cmdId: number
  data: DecodedMessage
}

export class fullFrameCache {
  private readonly table = new Map<string, replayFrame>()

  /** 全量帧之后的位置增量，按到达顺序排队（见文件头第三条） */
  private positionFrame: replayFrame[] = []

  /** 全量帧之后刷新出来的怪，按怪 id 留最新一条（见文件头第四条） */
  private readonly monsterTable = new Map<string, replayFrame>()

  /**
   * 记一条。离开房间那两种帧会让整份缓存失效 —— 房间都没了，剩下的帧只会拼出幽灵状态。
   * `我的Id` 用来判 `RoomKickPlayerS2C` 被踢的是不是本人（不是本人就什么都不做）。
   */
  record(name: string, cmdId: number, data: DecodedMessage, myId: string): void {
    if (name === 'ExitRoomS2C') {
      this.clear()
      return
    }
    if (name === 'RoomKickPlayerS2C') {
      const kicked = String((data as Record<string, unknown>).PlayerId ?? '')
      // 我的Id 为空（还没登录）时必然不相等，不会误清
      if (kicked === myId) this.clear()
      return
    }
    if (positionKind.has(name)) {
      this.positionFrame.push({ name, cmdId, data })
      if (this.positionFrame.length > positionFrameLimit) this.positionFrame.shift()
      return
    }
    if (name === Monster) {
      const monster = (data as Record<string, unknown>).Monster
      const id =
        monster !== null && typeof monster === 'object'
          ? String((monster as Record<string, unknown>).Id ?? '')
          : ''
      // 前端拿不到 Id 就不会认这条帧，这里也别拿它占位
      if (id.length === 0 || id === '0') return
      this.monsterTable.set(id, { name, cmdId, data })
      return
    }
    if (!roomKind.has(name) && !singleItemKind.has(name)) return
    // 新的全量房间帧自带权威状态（`Hero.NodeId` 位置、`Monsters` 名单），
    // 它之前那些增量就作废了 —— 不清掉的话，回放会把位置拉回旧格、把死掉的怪复活。
    if (roomKind.has(name)) {
      this.positionFrame = []
      this.monsterTable.clear()
    }
    this.table.set(roomKind.has(name) ? '房间' : name, { name, cmdId, data })
  }

  clear(): void {
    this.table.clear()
    this.positionFrame = []
    this.monsterTable.clear()
  }

  getReplayFrames(): replayFrame[] {
    const out: replayFrame[] = []
    for (const key of order) {
      const item = this.table.get(key)
      if (item !== undefined) out.push(item)
    }
    // 怪排在全量帧之后：刷新出来的怪不在房间帧的 `Monsters` 里
    for (const frame of this.monsterTable.values()) out.push(frame)
    // 位置增量排最后：房间帧里的 `Hero.NodeId` 是旧值，必须让位移覆盖它。
    for (const frame of this.positionFrame) out.push(frame)
    return out
  }
}