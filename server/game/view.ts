/**
 * 槽位级「对局现场」——后端脚本引擎读的就是这份状态。
 *
 * 为什么不是把 `src/stores/battle.ts` + `src/stores/room.ts` 搬过来：那两个文件深度耦合
 * Vue 的 `ref/computed/watch`，`battle.ts` 还 import 了浏览器侧的 `@/net/backend`，而且
 * `tsconfig.server.json` 的 include 里根本没有 `src/stores/**`。所以后端只复刻脚本要用的子集。
 *
 * 防漂移约定（**改动必须同一 commit 内同时改前后端**）：
 *   1. 走位（位置 / 来路 / 可走候选 / 已知边 / 强制选方向）**不是**两份实现 ——
 *      调 `shared/game/move.ts`，与前端同一份代码。
 *   2. 其余字段映射逐条标注 `// 对照 xxx.ts:行号`，对应关系也写进了接口文档的「前后端对照表」。
 *
 * 纯 TS：不 import Vue、不碰 DOM、不开连接。`喂()` 由 `槽位会话.收到推送` 调（在 `回放.记` 之后）。
 */
import {
  initialMoveState,
  applyMove,
  computeCurrentPosition,
  computeWalkCandidates,
  computeFromNode,
} from '../../shared/game/move.ts'
import type { MoveState } from '../../shared/game/move.ts'
import type { DecodedMessage } from '../../shared/protocol/jsonSafe.ts'
import { CMD_NAMES } from '../net/proto/generated/cmds.gen.ts'
import {
  activeSkillId,
  buffName,
  cardCost,
  monsterName,
  skillNameTable,
  progressLimit as queryProgressLimit,
} from '../../src/data/names.ts'

const toStr = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'bigint' ? value.toString() : ''
const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))
const asObject = (value: unknown): DecodedMessage | undefined =>
  value !== null && typeof value === 'object' ? (value as DecodedMessage) : undefined

/** 一条属于我的候选动作（`PredictActionS2C.Actions` 里挑出来的），对照 `battle.ts:21-27` */
export interface todoAction {
  commandName: string
  cmdId: number
  Sn: string
  playerId: string
  data: DecodedMessage
}

export interface mySnapshot {
  nickname: string
  playerId: string
  heroId: number
  position: number
  fromNode: number
  walkCandidates: number[]
  forceDirection: boolean
  gold: number
  hp: number
  maxHp: number
  attack: number
  defense: number
  moveNode: number
  level: number
  handCards: { uniqueId: number; cardId: number; cost: number }[]
  buffs: { name: string; remainingTurns: number; depth: number }[]
  skillCooldown: { name: string; cooldown: number }[]
  chip: number[]
  walkableNodes: number[]
}

export interface playerSnapshot {
  id: string
  nickname: string
  slot: number
  position: number
  heroId: number
  hp: number
  maxHp: number
  gold: number
  moveNode: number
  level: number
}

export interface monsterSnapshot {
  id: string
  heroId: number
  nickname: string
  position: number
  hp: number
  maxHp: number
  type: number
}

export interface battleEdgeSnapshot {
  id: string
  nickname: string
  heroId: number
  hp: number
  attack: number
  defense: number
  diceValue: number
  dodge: boolean
  useCard: number[]
  ready: boolean
  cost: number
  costLimit: number
}

export interface battleSnapshot {
  Id: string
  end: boolean
  pursue: boolean
  attacker: battleEdgeSnapshot | null
  defender: battleEdgeSnapshot | null
}

export interface matchSnapshot {
  myId: string
  room: {
    state: number
    roomId: string
    mapId: number
    difficulty: number
    round: number
    progress: number
    progressLimit: number
  }
  my: mySnapshot | null
  players: playerSnapshot[]
  monsters: monsterSnapshot[]
  actor: { id: string; nickname: string; dead: boolean; hospitalized: boolean; skipThisTurn: boolean }
  myTurn: boolean
  /** `剩余步数` 为 null = 这一步没有投骰（`投骰步数` 为 0），与前端 `剩余步数` 的 undefined 同义 */
  rollDice: { diceSteps: number; walkedSteps: number; remainingSteps: number | null }
  todo: todoAction[]
  battle: battleSnapshot | null
}

export class matchView {
  private readonly getMyId: () => string
  /** 房间全量快照（`RoomNotifyS2C` / `RunningGameS2C` / `ReplaySnapshotS2C` 的 `Room`） */
  private roomValue: DecodedMessage | null = null
  /** 走位折叠态，唯一实现在 `shared/game/move.ts` */
  private moveState: MoveState = initialMoveState()
  private diceStepsValue = 0
  private lastPrediction: DecodedMessage[] = []
  private actorValue = ''
  private actorFlagValue = { dead: false, hospitalized: false, skipThisTurn: false }
  private battleValue: DecodedMessage | null = null

  constructor(options: { getMyId: () => string }) {
    this.getMyId = options.getMyId
  }

  get myId(): string {
    return this.getMyId()
  }

  clear(): void {
    this.roomValue = null
    this.moveState = initialMoveState()
    this.diceStepsValue = 0
    this.lastPrediction = []
    this.actorValue = ''
    this.actorFlagValue = { dead: false, hospitalized: false, skipThisTurn: false }
    this.battleValue = null
  }

  // ---------------------------------------------------------------- 分派

  /** 结构对照前端 `src/stores/session.ts` 的 `收到推送`（L258-449） */
  feed(name: string, data: DecodedMessage | null | undefined): void {
    if (!data) return
    switch (name) {
      // ------------------------------------------------------------ 房间
      case 'RoomNotifyS2C':
      case 'CreateRoomS2C':
      case 'JoinRoomS2C':
      case 'QuickJoinRoomS2C':
      case 'SyncRoomS2C':
        this.onRoom(data)
        return

      case 'OnlineSyncRoomIdS2C': {
        const roomId = toStr(data.RoomId)
        // 非 0 时前端会去 QueryRoomC2S 拉一次全量；后端不主动发（重登后脚本已按登出停掉，
        // 这个窗口里没有脚本在跑），等下一帧全量房自己过来。
        if (roomId === '' || roomId === '0') this.clear()
        return
      }

      case 'RoomReadyS2C':
        this.updatePlayerField(toStr(data.PlayerId), 'RoomReady', data.IsReady === true)
        return

      case 'RoomKickPlayerS2C':
        // 被踢 = 自己离开房间
        if (toStr(data.PlayerId) === this.myId) this.clear()
        else this.removePlayer(toStr(data.PlayerId))
        return

      case 'RefreshRoomStateS2C':
        this.updatePlayerField(toStr(data.PlayerId), 'Progress', toNumber(data.Progress))
        return

      case 'ExitRoomS2C': {
        if (data.Dissolve === true) {
          this.clear()
          return
        }
        const leaver = toStr(data.PlayerId)
        if (leaver.length === 0 || leaver === this.myId) this.clear()
        else this.removePlayer(leaver)
        return
      }

      // ------------------------------------------------------------ 对局
      case 'RunningGameS2C':
        this.onRoom(data)
        this.syncMyPosition()
        return

      case 'ReplaySnapshotS2C': {
        this.onRoom(asObject(data.Room))
        const who = toStr(data.PlayerId)
        if (who.length > 0) this.actorValue = who
        this.syncMyPosition()
        return
      }

      case 'PredictActionS2C': {
        const action = Array.isArray(data.Actions) ? (data.Actions as DecodedMessage[]) : []
        if (action.length === 0) return
        this.lastPrediction = action
        return
      }

      case 'ActionStartNotifyS2C':
        this.actorValue = toStr(data.PlayerId)
        this.actorFlagValue = {
          dead: data.IsDie === true,
          hospitalized: data.IsHospital === true,
          skipThisTurn: data.IsStopRound === true,
        }
        return

      case 'RoundStartS2C': {
        this.onRound(toNumber(data.Round))
        const who = toStr(data.PlayerId)
        const cooldownTable = asObject(data.SkillCds)
        if (who.length > 0 && cooldownTable !== undefined) this.mergeHero(who, { SkillCds: cooldownTable })
        return
      }

      case 'UpdateHeroAttrS2C':
        this.onAttrChange(data)
        return

      case 'MoveS2C':
        this.onMove(data)
        return

      // 追击（5034）/ 怪物突击（5214）：发起者直接瞬移到目标那一格，`MoveS2C` 里没有这一跳。
      // 不认它 → 后端算出来的位置停在突击之前那一格 → `可走候选` 全错。
      case 'PursuitS2C':
      case 'MonsterPursuitS2C':
        this.onPursue(data)
        return

      case 'ThrowDiceS2C':
        if (toStr(data.PlayerId) !== this.myId) return
        this.onDiceRoll(data)
        return

      case 'MoveAgainS2C':
        if (toStr(data.PlayerId) !== this.myId) return
        this.onMoveAgain(data)
        return

      case 'GameProgressChangeS2C':
        if (this.roomValue === null) return
        this.roomValue = { ...this.roomValue, GameProgress: toNumber(data.Progress) }
        return

      case 'GameRoundChangeS2C':
        this.onRound(toNumber(data.Round))
        return

      case 'BattleS2C': {
        const battleStat = asObject(data.Battle)
        if (battleStat !== undefined) this.battleValue = battleStat
        return
      }

      case 'MonsterRefreshS2C': {
        const monster = asObject(data.Monster)
        if (monster === undefined || this.roomValue === null) return
        const id = toStr(monster.Id)
        if (id.length === 0 || id === '0') return
        const old = Array.isArray(this.roomValue.Monsters)
          ? (this.roomValue.Monsters as unknown[])
          : []
        const position = old.findIndex((item) => toStr(asObject(item)?.Id) === id)
        const next = [...old]
        if (position >= 0) next[position] = monster
        else next.push(monster)
        this.roomValue = { ...this.roomValue, Monsters: next }
        return
      }

      case 'RoomHeroCardChangeS2C': {
        const card = data.Cards
        if (!Array.isArray(card)) return
        this.mergeHero(toStr(data.PlayerId), { Cards: card })
        return
      }

      default:
        return
    }
  }

  // ---------------------------------------------------------------- 房间

  /** 对照 `room.ts:107-112`：两种帧形状（直接是 Room，或带一层 Room）都要认 */
  private onRoom(value: DecodedMessage | undefined): void {
    if (value === undefined) return
    const candidates = value.Players !== undefined ? value : asObject(value.Room)
    if (candidates === undefined) return
    this.roomValue = candidates
  }

  private onRound(round: number): void {
    // 对照 `room.ts:139-143`：轮次只增不减，且 0 不当轮次
    if (round <= 0 || this.roomValue === null) return
    this.roomValue = { ...this.roomValue, Round: round }
  }

  private rawPlayer(): DecodedMessage[] {
    const table = this.roomValue?.Players
    return Array.isArray(table) ? (table as DecodedMessage[]) : []
  }

  private getPlayer(playerId: string): DecodedMessage | undefined {
    if (playerId.length === 0) return undefined
    return this.rawPlayer().find((player) => toStr(player.Id) === playerId)
  }

  private getHero(playerId: string): DecodedMessage | undefined {
    return asObject(this.getPlayer(playerId)?.Hero)
  }

  private get myHero(): DecodedMessage | undefined {
    return this.getHero(this.myId)
  }

  /** 对照 `room.ts:205-221`。这里原地改（后端没有响应式），不必造新对象 */
  private mergeHero(playerId: string, field: Record<string, unknown>): void {
    if (playerId.length === 0 || playerId === '0') return
    const hero = this.getHero(playerId)
    if (hero === undefined) return
    Object.assign(hero, field)
  }

  private updatePlayerField(playerId: string, key: string, value: unknown): void {
    if (playerId.length === 0 || playerId === '0') return
    const player = this.getPlayer(playerId)
    if (player === undefined) return
    player[key] = value
  }

  private removePlayer(playerId: string): void {
    if (this.roomValue === null) return
    const rest = this.rawPlayer().filter((player) => toStr(player.Id) !== playerId)
    this.roomValue = { ...this.roomValue, Players: rest }
  }

  // ---------------------------------------------------------------- 走位

  private getMapId(): number {
    return toNumber(this.roomValue?.MapId)
  }

  private computeFrontNodes(): number[] {
    const raw = this.myHero?.FrontNodeIds
    return Array.isArray(raw) ? (raw as unknown[]).map(toNumber) : []
  }

  /** 对照 `battle.ts:219-222` 的 `我的.位置`（`位置表 ?? Hero.NodeId`），没英雄时才是 -1 */
  private getMyFallbackPosition(): number {
    const myEntry = this.moveState.positionByPlayer[this.myId]
    if (myEntry !== undefined) return myEntry
    const hero = this.myHero
    return hero === undefined ? -1 : toNumber(hero.NodeId)
  }

  private myPosition(): number {
    // 对照 `battle.ts:115-117`
    return computeCurrentPosition(this.moveState.landedNode, this.getMyFallbackPosition())
  }

  private myFromNode(): number {
    // 对照 `battle.ts:119-127`
    return computeFromNode({
      fromNode: this.moveState.fromNode,
      frontNodes: this.computeFrontNodes(),
      mapId: this.getMapId(),
      position: this.myPosition(),
      heroBackNodeId: toNumber(this.myHero?.BackNodeId),
    })
  }

  private getForceDirection(): boolean {
    // 对照 `battle.ts:133`：只取预测动作 `MoveC2S.Data.ForceDir` 一个信号源
    return this.getTodo('MoveC2S')?.data?.ForceDir === true
  }

  private myWalkCandidates(): number[] {
    // 对照 `battle.ts:135-145`
    return computeWalkCandidates({
      position: this.myPosition(),
      forceDirection: this.getForceDirection(),
      mapId: this.getMapId(),
      frontNodes: this.computeFrontNodes(),
      serverPosition: toNumber(this.myHero?.NodeId),
      knownEdges: this.moveState.knownEdges,
      fromNode: this.moveState.fromNode,
    })
  }

  /** 全量房间帧里 Hero 的位置才是权威的（对照 `battle.ts:375-386`） */
  private syncMyPosition(): void {
    const hero = this.myHero
    if (hero === undefined) return
    const frontNodeCount = Array.isArray(hero.FrontNodeIds) ? (hero.FrontNodeIds as unknown[]).length : 0
    if (frontNodeCount === 0) return
    const node = toNumber(hero.NodeId)
    if (node < 0 || node === this.moveState.landedNode) return
    this.moveState = {
      ...this.moveState,
      landedNode: node,
      positionByPlayer: { ...this.moveState.positionByPlayer, [this.myId]: node },
      // 位置变了，本地记的来路作废，改由 FrontNodeIds 反推（GetFromLandId）
      fromNode: -1,
    }
  }

  private onMove(value: DecodedMessage): void {
    const who = toStr(value.PlayerId)
    const visited = Array.isArray(value.NodeIds) ? (value.NodeIds as unknown[]).map(toNumber) : []
    if (visited.length === 0) return
    // 折叠逻辑与前端同一份（`shared/game/move.ts`）。备用位置要在应用之前取，读的是旧态。
    this.moveState = applyMove(this.moveState, {
      who,
      myId: this.myId,
      myFallbackPosition: this.getMyFallbackPosition(),
      visited,
    })
  }

  /** 对照 `battle.ts:462-486` */
  private onPursue(value: DecodedMessage): void {
    const who = toStr(value.PlayerId)
    if (who.length === 0 || who === '0') return
    // `FrontIds` 空的帧没有落位（真落位一定带可走方向）
    const prev = Array.isArray(value.FrontIds) ? (value.FrontIds as unknown[]).map(toNumber) : []
    if (prev.length === 0) return
    // 地块 0 合法，缺字段才是「没给」
    if (value.NodeId === undefined || value.NodeId === null) return
    const node = toNumber(value.NodeId)
    const hasNext = value.BackId !== undefined && value.BackId !== null
    const after = toNumber(value.BackId)

    this.mergeHero(who, {
      NodeId: node,
      FrontNodeIds: prev,
      ...(hasNext ? { BackNodeId: after } : {}),
    })
    this.moveState = { ...this.moveState, positionByPlayer: { ...this.moveState.positionByPlayer, [who]: node } }

    if (who !== this.myId) return
    this.moveState = { ...this.moveState, landedNode: node, fromNode: hasNext ? after : -1 }
  }

  private onDiceRoll(value: DecodedMessage): void {
    // 对照 `battle.ts:488-494`
    const steps = toNumber(value.MovePoint)
    if (steps <= 0) return
    this.diceStepsValue = steps
    this.moveState = { ...this.moveState, walkedSteps: 0 }
  }

  private onMoveAgain(value: DecodedMessage): void {
    // 对照 `battle.ts:496-501`
    const steps = toNumber(value.MovePoint)
    if (steps <= 0) return
    this.diceStepsValue += steps
  }

  // ---------------------------------------------------------------- 属性变化

  /** 对照 `battle.ts:538-542` */
  private getHeroMap(playerId: string, fieldName: string): Record<string, unknown> {
    const table = this.getHero(playerId)?.[fieldName]
    return table !== null && typeof table === 'object' ? { ...(table as Record<string, unknown>) } : {}
  }

  private onAttrChange(value: DecodedMessage): void {
    // 对照 `battle.ts:529-536`
    const list = value.EffectDatas
    if (!Array.isArray(list)) return
    const outerId = toStr(value.PlayerId)
    for (const item of list as DecodedMessage[]) this.mergeAttrs(item, outerId)
  }

  /** 对照 `battle.ts:556-625`（逐字段同判据） */
  private mergeAttrs(effect: DecodedMessage, outerId: string): void {
    const pick = (name: string): DecodedMessage | undefined => asObject(effect[name])

    const currentValue = (
      packet: DecodedMessage,
      currentKey: string,
      rawKey: string,
      changeKey: string,
    ): number | undefined => {
      if (packet[currentKey] !== undefined) return toNumber(packet[currentKey])
      if (packet[rawKey] !== undefined && packet[changeKey] !== undefined)
        return toNumber(packet[rawKey]) + toNumber(packet[changeKey])
      return undefined
    }

    const field: Record<string, unknown> = {}
    const gold = pick('Gold')
    if (gold) {
      const value = currentValue(gold, 'CurrGold', 'OriGold', 'ChangeGold')
      if (value !== undefined) field.Gold = value
    }
    const hp = pick('Hp')
    if (hp) {
      const value = currentValue(hp, 'CurrHp', 'OriHp', 'ChangeHp')
      if (value !== undefined) field.Hp = value
      if (hp.MaxHp !== undefined) field.MaxHp = toNumber(hp.MaxHp)
    }
    const atk = pick('Atk')
    if (atk?.CurrAtk !== undefined) field.Attack = toNumber(atk.CurrAtk)
    const def = pick('Def')
    if (def?.CurrDef !== undefined) field.Defense = toNumber(def.CurrDef)
    const lv = pick('Lv')
    if (lv?.CurrLv !== undefined) field.Lv = toNumber(lv.CurrLv)

    const playerId = toStr(effect.PlayerId) || outerId

    const cd = pick('Cd')
    if (cd?.Cd !== undefined && toNumber(cd.Cd) > 0) {
      const heroId = toNumber(this.getHero(playerId)?.HeroId)
      const skillId = activeSkillId(heroId)
      if (skillId > 0) {
        const table = this.getHeroMap(playerId, 'SkillCds')
        table[skillId] = toNumber(cd.Cd)
        field.SkillCds = table
      }
    }

    const buff = pick('Buff')
    if (buff) {
      const all = asObject(buff.Buffs)
      const one = asObject(buff.Buff)
      if (all !== undefined && Object.keys(all).length > 0) {
        field.Buffs = all
      } else if (one !== undefined) {
        const uid = toStr(one.UniqueId)
        if (uid.length > 0) {
          const table = this.getHeroMap(playerId, 'Buffs')
          // Op=2 是移除
          if (toNumber(buff.Op) === 2) delete table[uid]
          else table[uid] = one
          field.Buffs = table
        }
      }
    }

    if (Object.keys(field).length === 0) return
    this.mergeHero(playerId, field)
  }

  // ---------------------------------------------------------------- 待办

  /** 对照 `battle.ts:231-246`：优先最近一条 `PredictActionS2C`，否则回落 `Room.Predicts` */
  private getCandidateActions(): DecodedMessage[] {
    if (this.lastPrediction.length > 0) return this.lastPrediction
    const table = this.roomValue?.Predicts
    return Array.isArray(table) ? (table as DecodedMessage[]) : []
  }

  /** 对照 `battle.ts:248-253`：只要我的（脚本引擎靠它拿「全部待办」） */
  getMyAction(): todoAction[] {
    const my = this.myId
    if (my.length === 0) return []
    return this.getCandidateActions()
      .map((action) => {
        const cmdId = toNumber(action.Id)
        return {
          cmdId,
          commandName: CMD_NAMES[cmdId] ?? `CMD=${cmdId}`,
          Sn: toStr(action.Sn),
          playerId: toStr(action.PlayerId),
          // 后端 `槽位会话.解动作数据` 已把 `Actions[].Data` 就地解成对象
          data: asObject(action.Data) ?? {},
        }
      })
      .filter((item) => item.playerId === my)
  }

  getTodo(commandName: string): todoAction | undefined {
    return this.getMyAction().find((item) => item.commandName === commandName)
  }

  // ---------------------------------------------------------------- 快照

  /** 对照 `battle.ts:149-213` */
  private readMySnapshot(): mySnapshot | null {
    const hero = this.myHero
    if (hero === undefined) return null

    const rawHandCards = hero.Cards
    const handCards = Array.isArray(rawHandCards)
      ? (rawHandCards as DecodedMessage[]).map((card) => ({
          uniqueId: toNumber(card.UniqueId),
          cardId: toNumber(card.CardId),
          cost:
            toNumber(card.BattleCost) >= 0
              ? toNumber(card.BattleCost)
              : (cardCost[toNumber(card.CardId)] ?? 0),
        }))
      : []

    const buffs: { name: string; remainingTurns: number; depth: number }[] = []
    const rawBuff = asObject(hero.Buffs)
    if (rawBuff !== undefined) {
      for (const item of Object.values(rawBuff)) {
        const entries = asObject(item)
        const name = buffName[toNumber(entries?.BuffId)]
        if (name === undefined) continue
        buffs.push({ name, remainingTurns: toNumber(entries?.KeepRound), depth: toNumber(entries?.Progress) })
      }
    }

    const activeSkill = activeSkillId(toNumber(hero.HeroId))
    const rawCooldown = asObject(hero.SkillCds)
    const skillCooldown =
      rawCooldown === undefined
        ? []
        : Object.entries(rawCooldown)
            .map(([skillId, cooldown]) => ({ skillId: toNumber(skillId), cooldown: toNumber(cooldown) }))
            .filter((item) => item.skillId > 0)
            .sort((a, b) => a.skillId - b.skillId)
            .map((item) => ({
              name: skillNameTable[item.skillId] ?? (item.skillId === activeSkill ? '主动技能' : `技能 ${item.skillId}`),
              cooldown: item.cooldown,
            }))

    const rawChip = asObject(hero.SelectRelics)
    const chip =
      rawChip === undefined
        ? []
        : Object.keys(rawChip)
            .map(toNumber)
            .sort((a, b) => a - b)

    return {
      nickname: toStr(this.getPlayer(this.myId)?.Nick) || this.myId,
      playerId: this.myId,
      heroId: toNumber(hero.HeroId),
      // 位置取走位折叠的结果（权威），不是 Hero.NodeId 那一份可能过期的
      position: this.myPosition(),
      fromNode: this.myFromNode(),
      walkCandidates: this.myWalkCandidates(),
      forceDirection: this.getForceDirection(),
      gold: toNumber(hero.Gold),
      hp: toNumber(hero.Hp),
      maxHp: toNumber(hero.MaxHp),
      attack: toNumber(hero.Attack),
      defense: toNumber(hero.Defense),
      moveNode: toNumber(hero.MovePoint),
      level: toNumber(hero.Lv),
      handCards,
      buffs,
      skillCooldown,
      chip,
      walkableNodes: this.computeFrontNodes(),
    }
  }

  /** 对照 `battle.ts:199`：位置优先用走位表 */
  private readPlayerSnapshot(player: DecodedMessage): playerSnapshot | null {
    const hero = asObject(player.Hero)
    if (hero === undefined) return null
    const id = toStr(player.Id)
    return {
      id,
      nickname: toStr(player.Nick) || id,
      slot: toNumber(player.Slot),
      position: this.moveState.positionByPlayer[id] ?? toNumber(hero.NodeId),
      heroId: toNumber(hero.HeroId),
      hp: toNumber(hero.Hp),
      maxHp: toNumber(hero.MaxHp),
      gold: toNumber(hero.Gold),
      moveNode: toNumber(hero.MovePoint),
      level: toNumber(hero.Lv),
    }
  }

  /** 对照 `battle.ts:324-351`：`Room.Monsters` 与「玩家列表里 MonsterType != 0 的」合并，按 id 去重 */
  private readMonsterSnapshot(): monsterSnapshot[] {
    const received = new Map<string, DecodedMessage>()
    const put = (item: DecodedMessage | undefined): void => {
      if (item === undefined) return
      const id = toStr(item.Id)
      if (id.length > 0 && id !== '0') received.set(id, item)
    }

    const table = this.roomValue?.Monsters
    if (Array.isArray(table)) for (const item of table as DecodedMessage[]) put(item)
    for (const player of this.rawPlayer()) {
      if (toNumber(asObject(player.Hero)?.MonsterType) !== 0) put(player)
    }

    return [...received.values()].map((item) => {
      const hero = asObject(item.Hero)
      const monsterId = toNumber(hero?.HeroId)
      const id = toStr(item.Id)
      return {
        id,
        heroId: monsterId,
        nickname: (monsterName[monsterId] ?? toStr(item.Nick)) || `怪物 ${id}`,
        hp: toNumber(hero?.Hp),
        maxHp: toNumber(hero?.MaxHp),
        position: this.moveState.positionByPlayer[id] ?? toNumber(hero?.NodeId),
        type: toNumber(hero?.MonsterType),
      }
    })
  }

  /** 对照 `battle.ts:290-322` */
  private readBattleSnapshot(): battleSnapshot | null {
    const battleStat = this.battleValue ?? asObject(this.roomValue?.Battle) ?? null
    if (battleStat === null) return null
    const prepareTable = asObject(battleStat.CardUseState) ?? {}
    const draw = (edge: DecodedMessage | undefined): battleEdgeSnapshot | null => {
      if (edge === undefined) return null
      const id = toStr(edge.PlayerId)
      const hero = this.getHero(id)
      const monster = this.readMonsterSnapshot().find((item) => item.id === id)
      return {
        id,
        nickname: toStr(this.getPlayer(id)?.Nick) || monster?.nickname || id,
        heroId: toNumber(edge.HeroId) || toNumber(hero?.HeroId),
        hp: hero !== undefined ? toNumber(hero.Hp) : (monster?.hp ?? 0),
        attack: toNumber(edge.Atk),
        defense: toNumber(edge.Def),
        diceValue: toNumber(edge.Point),
        dodge: edge.Dodge === true,
        useCard: Array.isArray(edge.UseCards) ? (edge.UseCards as unknown[]).map(toNumber) : [],
        ready: prepareTable[id] === true,
        cost: toNumber(edge.Cost),
        costLimit: toNumber(edge.MaxCost),
      }
    }
    return {
      Id: toStr(battleStat.BattleId),
      end: battleStat.IsEnd === true,
      pursue: battleStat.IsPursuit === true,
      attacker: draw(asObject(battleStat.Attacker)),
      defender: draw(asObject(battleStat.Defender)),
    }
  }

  /** 每次现造一个普通对象（本来就是 JSON 可序列化的克隆，脚本改它改不到引擎内存） */
  getState(): matchSnapshot {
    const mapId = this.getMapId()
    const difficulty = toNumber(this.roomValue?.Difficulty)
    const actor = this.actorValue
    return {
      myId: this.myId,
      room: {
        state: toNumber(this.roomValue?.State),
        roomId: toStr(this.roomValue?.Id),
        mapId,
        difficulty,
        round: toNumber(this.roomValue?.Round),
        progress: toNumber(this.roomValue?.GameProgress),
        // 服务端 MaxProgress 恒等于 Progress（是镜像不是上限），上限只能查本地难度配置表
        progressLimit: queryProgressLimit(mapId, difficulty) ?? 0,
      },
      my: this.readMySnapshot(),
      players: this.rawPlayer()
        .map((player) => this.readPlayerSnapshot(player))
        .filter((item): item is playerSnapshot => item !== null),
      monsters: this.readMonsterSnapshot(),
      actor: {
        id: actor,
        nickname: toStr(this.getPlayer(actor)?.Nick) || actor,
        dead: this.actorFlagValue.dead,
        hospitalized: this.actorFlagValue.hospitalized,
        skipThisTurn: this.actorFlagValue.skipThisTurn,
      },
      myTurn: actor.length > 0 && actor === this.myId,
      rollDice: {
        diceSteps: this.diceStepsValue,
        walkedSteps: this.moveState.walkedSteps,
        remainingSteps:
          this.diceStepsValue > 0 ? Math.max(0, this.diceStepsValue - this.moveState.walkedSteps) : null,
      },
      todo: this.getMyAction(),
      battle: this.readBattleSnapshot(),
    }
  }
}