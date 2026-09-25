import { computed, reactive, ref } from 'vue'
import type { DecodedMessage } from '@shared/protocol/jsonSafe'
import { commandName as commandNameOf } from '@/net/backend'
import type { RoomPlayer, roomState } from '@/stores/room'
// 走位折叠（位置 / 来路 / 可走候选 / 已知边）的唯一实现，后端脚本引擎用的是同一份
import { computeCurrentPosition, computeFromNode, computeWalkCandidates, applyMove } from '@shared/game/move'
import {
  buffName,
  activeSkillId,
  birthNodeType,
  birthNodeTable,
  nodeBuffName,
  cardCost,
  monsterName,
  skillNameTable,
} from '@/data/names'

const toStr = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'bigint' ? value.toString() : ''
const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

export interface CandidateAction {
  cmdId: number
  commandName: string
  playerId: string
  Sn: string
  data: DecodedMessage
}

export interface MyMatchData {
  nickname: string
  playerId: string
  heroId: number
  position: number
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

function decodeCandidateData(raw: unknown): DecodedMessage {
  // 后端把 Actions[].Data 这类 bytes 就地解成对象了，前端只做一次形状收窄。
  return raw !== null && typeof raw === 'object' ? (raw as DecodedMessage) : {}
}

export function createMatchState(room: roomState) {
  const actor = ref('')
  const actorFlag = ref({ dead: false, hospitalized: false, skipThisTurn: false })

  const lastPrediction = ref<{ roomRound: number; action: DecodedMessage[] } | null>(null)

  const roundStart = ref<DecodedMessage | null>(null)

  // 键是地块号。LandBuffsWrap.NodeId 是 sfixed32（解码出来是 number），别再走字符串转换。
  const nodeBuffPackets = ref<Record<number, DecodedMessage>>({})

  const lastAttrChange = ref<DecodedMessage | null>(null)

  const battleMirror = ref<DecodedMessage | null>(null)

  const battleCommands = new Set(['BattleUseCardC2S', 'BattleThrowDiceC2S', 'BattleChoiceC2S'])

  // 0 号地块是合法地块，所以「不知道」只能用 -1 表示（服务端自己也是这么标的：
  // BackNodeId 没值时推的就是 -1）。
  const landedNode = ref(-1)

  // 来路 = 站在当前位置时「上一格」在哪。参考工程 Core.Unit.UnitLand.CanSelectedLandId(from)
  // 用它算可选方向（邻接去掉 from），所以它必须准确。
  const fromNode = ref(-1)

  const diceSteps = ref(0)

  const walkedSteps = ref(0)

  const remainingSteps = computed<number | undefined>(() =>
    diceSteps.value > 0 ? Math.max(0, diceSteps.value - walkedSteps.value) : undefined,
  )

  const positionByPlayer = ref<Record<string, number>>({})

  const inferBornNode = ref(-1)

  const myBornNode = computed(() => {
    // 服务端 Hero.BeBornNodeId 是权威来源（所有地图都下发，实测 slot0/1/2/3 = 0/23/18/5）。
    // 它在「还没开局」时是缺省 0，所以只有 > 0 才敢信；本地位次表兜住 0 号位与老对局。
    const serverBorn = toNumber(myHero.value?.BeBornNodeId)
    if (serverBorn > 0) return serverBorn
    const table = birthNodeTable[toNumber(room.room?.MapId)]
    const fixedBornNode = table?.[toNumber(room.my?.slot)]
    return fixedBornNode !== undefined ? fixedBornNode : inferBornNode.value
  })

  const knownEdges = ref<Record<number, number[]>>({})

  const myHero = computed<DecodedMessage | undefined>(() => {
    const my = room.playerList.find((player) => player.id === room.myId)
    return my?.raw.Hero as DecodedMessage | undefined
  })

  const frontNodes = computed(() => {
    const raw = myHero.value?.FrontNodeIds
    return Array.isArray(raw) ? (raw as unknown[]).map(toNumber) : []
  })

  // 服务端快照里「我」的位置（Hero.NodeId）。只要它和当前位置一致，Hero.FrontNodeIds 就是新鲜的。
  const serverPosition = computed(() => toNumber(myHero.value?.NodeId))

  const currentPosition = computed(() =>
    computeCurrentPosition(landedNode.value, mine.value?.position ?? -1),
  )

  const currentFromNode = computed(() =>
    computeFromNode({
      fromNode: fromNode.value,
      frontNodes: frontNodes.value,
      mapId: toNumber(room.room?.MapId),
      position: currentPosition.value,
      heroBackNodeId: toNumber(myHero.value?.BackNodeId),
    }),
  )

  // 服务端把这一步标成「方向必须由玩家选」时（比如刚打完「方向抉择」卡 20011）：
  // 信号的落点是预测动作 MoveC2S 的 Data.ForceDir（field 3），同一时刻的 ThrowDiceS2C.ForceDir
  // 也是 true。语义 = 来路限制解除（客户端 ResetFromLandId(-1) → CanSelectedLandId 返回全部邻接），
  // 所以既能原路后退，也不许套用「只剩一个方向就自动走」的启发式。
  const forceDirection = computed(() => getTodo('MoveC2S')?.data?.ForceDir === true)

  const walkCandidates = computed(() =>
    computeWalkCandidates({
      position: currentPosition.value,
      forceDirection: forceDirection.value,
      mapId: toNumber(room.room?.MapId),
      frontNodes: frontNodes.value,
      serverPosition: serverPosition.value,
      knownEdges: knownEdges.value,
      fromNode: fromNode.value,
    }),
  )

  const inMatch = computed(() => room.roomState === 25)

  function readPlayerMatchData(player: RoomPlayer): MyMatchData | null {
    const hero = player.raw.Hero as DecodedMessage | undefined
    if (!hero) return null
    const rawHandCards = hero.Cards
    const handCards = Array.isArray(rawHandCards)
      ? (rawHandCards as DecodedMessage[]).map((card) => ({
          uniqueId: toNumber(card.UniqueId),
          cardId: toNumber(card.CardId),
          cost: toNumber(card.BattleCost) >= 0 ? toNumber(card.BattleCost) : (cardCost[toNumber(card.CardId)] ?? 0),
        }))
      : []
    const buffs: { name: string; remainingTurns: number; depth: number }[] = []
    const rawBuff = hero.Buffs
    if (rawBuff && typeof rawBuff === 'object') {
      for (const item of Object.values(rawBuff as Record<string, DecodedMessage>)) {
        const name = buffName[toNumber(item?.BuffId)]
        if (name === undefined) continue
        buffs.push({
          name,
          remainingTurns: toNumber(item?.KeepRound),
          depth: toNumber(item?.Progress),
        })
      }
    }
    const activeSkill = activeSkillId(toNumber(hero.HeroId))
    const rawCooldown = hero.SkillCds
    const skillCooldown =
      rawCooldown && typeof rawCooldown === 'object'
        ? Object.entries(rawCooldown as Record<string, unknown>)
            .map(([skillId, cooldown]) => ({ skillId: toNumber(skillId), cooldown: toNumber(cooldown) }))
            .filter((item) => item.skillId > 0)
            .sort((a, b) => a.skillId - b.skillId)
            .map((item) => ({
              name: skillNameTable[item.skillId] ?? (item.skillId === activeSkill ? '主动技能' : `技能 ${item.skillId}`),
              cooldown: item.cooldown,
            }))
        : []
    const rawWalkNodes = hero.FrontNodeIds
    const walkableNodes = Array.isArray(rawWalkNodes) ? (rawWalkNodes as unknown[]).map(toNumber) : []
    const rawChip = hero.SelectRelics
    const chip =
      rawChip && typeof rawChip === 'object'
        ? Object.keys(rawChip as Record<string, unknown>)
            .map(toNumber)
            .sort((a, b) => a - b)
        : []
    return {
      nickname: player.nick || player.id,
      playerId: player.id,
      heroId: toNumber(hero.HeroId),
      position: positionByPlayer.value[player.id] ?? toNumber(hero.NodeId),
      gold: toNumber(hero.Gold),
      hp: toNumber(hero.Hp),
      maxHp: toNumber(hero.MaxHp),
      attack: toNumber(hero.Attack),
      defense: toNumber(hero.Defense),
      moveNode: toNumber(hero.MovePoint),
      level: toNumber(hero.Lv),
      handCards,
      chip,
      walkableNodes,
      buffs,
      skillCooldown,
    }
  }

  const playerDataList = computed<MyMatchData[]>(() =>
    room.playerList.map(readPlayerMatchData).filter((item): item is MyMatchData => item !== null),
  )

  const mine = computed<MyMatchData | null>(() => {
    const my = room.playerList.find((player) => player.id === room.myId)
    return my ? readPlayerMatchData(my) : null
  })

  const myTurn = computed(() => actor.value.length > 0 && actor.value === room.myId)

  const actorNickname = computed(() => {
    const player = room.playerList.find((item) => item.id === actor.value)
    return player?.nick || actor.value || '—'
  })

  const availableActions = computed<CandidateAction[]>(() => {
    const predictions = lastPrediction.value?.action
    const raw =
      predictions && predictions.length > 0 ? predictions : (room.room?.Predicts as DecodedMessage[] | undefined)
    if (!Array.isArray(raw)) return []
    return raw.map((action) => {
      const cmdId = toNumber(action.Id)
      return {
        cmdId,
        commandName: commandNameOf(cmdId),
        playerId: toStr(action.PlayerId),
        Sn: toStr(action.Sn),
        data: decodeCandidateData(action.Data),
      }
    })
  })

  const myActions = computed(() => availableActions.value.filter((item) => item.playerId === room.myId))

  function getTodo(commandName: string | string[]): CandidateAction | undefined {
    const names = Array.isArray(commandName) ? commandName : [commandName]
    return myActions.value.find((item) => names.includes(item.commandName))
  }

  const nodes = computed(() => {
    const table = room.room?.Lands
    if (!table || typeof table !== 'object') return []
    return Object.entries(table as Record<string, DecodedMessage>)
      .map(([node, value]) => ({ node: Number(node), type: toNumber(value.LandType) }))
      .sort((a, b) => a.node - b.node)
  })

  const battle = computed<DecodedMessage | null>(
    () => battleMirror.value ?? ((room.room?.Battle as DecodedMessage | undefined) ?? null),
  )

  const battleRunning = computed(() => {
    const battleStat = battle.value
    if (!battleStat) return false
    if (battleStat.IsEnd === true) return false
    const hasEdges = getBattleEdge('Attacker') !== null || getBattleEdge('Defender') !== null
    const Id = toStr(battleStat.BattleId)
    return hasEdges || (Id.length > 0 && Id !== '0')
  })

  function getBattleEdge(side: 'Attacker' | 'Defender'): DecodedMessage | null {
    const value = battle.value?.[side]
    return value && typeof value === 'object' ? (value as DecodedMessage) : null
  }

  const myBattleSide = computed(() => {
    if (battle.value === null) return ''
    if (toStr(getBattleEdge('Attacker')?.PlayerId) === room.myId) return '攻方'
    if (toStr(getBattleEdge('Defender')?.PlayerId) === room.myId) return '守方'
    return ''
  })

  const battlePendingResponse = computed(() => myActions.value.filter((item) => battleCommands.has(item.commandName)))

  const battleDetail = computed(() => {
    const battleStat = battle.value
    if (!battleStat) return null
    const prepareTable = (battleStat.CardUseState as Record<string, unknown> | undefined) ?? {}
    const draw = (edge: DecodedMessage | null) => {
      if (!edge) return null
      const id = toStr(edge.PlayerId)
      const player = room.playerList.find((item) => item.id === id)
      const monster = monsters.value.find((item) => item.id === id)
      const hero = player?.raw.Hero as DecodedMessage | undefined
      return {
        id,
        nickname: player?.nick || monster?.nickname || id,
        heroId: toNumber(edge.HeroId) || toNumber(hero?.HeroId),
        hp: player ? toNumber(hero?.Hp) : (monster?.hp ?? 0),
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
      attacker: draw(getBattleEdge('Attacker')),
      defender: draw(getBattleEdge('Defender')),
    }
  })

  const monsters = computed(() => {
    const received = new Map<string, DecodedMessage>()
    const put = (item: DecodedMessage): void => {
      const id = toStr(item.Id)
      if (id.length > 0 && id !== '0') received.set(id, item)
    }

    const table = room.room?.Monsters
    if (Array.isArray(table)) for (const item of table as DecodedMessage[]) put(item)
    for (const player of room.playerList) {
      const type = toNumber((player.raw.Hero as DecodedMessage | undefined)?.MonsterType)
      if (type !== 0) put(player.raw)
    }

    return [...received.values()].map((item) => {
      const hero = item.Hero as DecodedMessage | undefined
      const monsterId = toNumber(hero?.HeroId)
      return {
        id: toStr(item.Id),
        heroId: monsterId,
        nickname: (monsterName[monsterId] ?? toStr(item.Nick)) || `怪物 ${toStr(item.Id)}`,
        hp: toNumber(hero?.Hp),
        maxHp: toNumber(hero?.MaxHp),
        position: positionByPlayer.value[toStr(item.Id)] ?? toNumber(hero?.NodeId),
        type: toNumber(hero?.MonsterType),
      }
    })
  })

  function onRunFrame(value: DecodedMessage | null | undefined): void {
    room.onRoom(value)
    recordBornNode()
    syncMyPosition()
  }

  // 1113 ReplaySnapshotS2C：每次行动前的全量快照（PlayerId + Room）。
  // 参考项目拿它当「轮次 / 行动节点的唯一依据」，轮次数取快照里的 Room.Round。
  // 注意：客户端里没有任何地方订阅这条推送（只在录像里出现），所以它只是兜底，
  // 实时对局的轮次主要靠 1015 RoundStartS2C / 1117 GameRoundChangeS2C。
  function onSnapshot(value: DecodedMessage | null | undefined): void {
    if (!value) return
    room.onRoom(value.Room as DecodedMessage | undefined)
    const who = toStr(value.PlayerId)
    if (who.length > 0) actor.value = who
    recordBornNode()
    syncMyPosition()
  }

  // 全量房间帧（1003 RunningGameS2C / 1113 ReplaySnapshotS2C）里 Hero 的位置是权威的：
  // 只要它既给了位置又给了 FrontNodeIds，就说明这是「有效的落位」，直接以它为准。
  // （开局加载阶段那些帧 FrontNodeIds 是空的，不能信。）
  function syncMyPosition(): void {
    const hero = myHero.value
    if (!hero) return
    const frontNodeCount = Array.isArray(hero.FrontNodeIds) ? (hero.FrontNodeIds as unknown[]).length : 0
    if (frontNodeCount === 0) return
    const node = toNumber(hero.NodeId)
    if (node < 0 || node === landedNode.value) return
    landedNode.value = node
    positionByPlayer.value = { ...positionByPlayer.value, [room.myId]: node }
    // 位置变了，本地记的来路就跟着作废，改由 FrontNodeIds 反推（GetFromLandId）。
    fromNode.value = -1
  }

  function recordBornNode(): void {
    if (inferBornNode.value >= 0) return
    if (room.roomState !== 25 || room.round !== 0) return
    const position = mine.value?.position
    if (position === undefined) return
    const nodeTable = room.room?.Lands as Record<string, DecodedMessage> | undefined
    if (toNumber(nodeTable?.[String(position)]?.LandType) !== birthNodeType) return
    inferBornNode.value = position
  }

  function onPrediction(value: DecodedMessage | null | undefined): void {
    if (!value) return
    const action = Array.isArray(value.Actions) ? (value.Actions as DecodedMessage[]) : []
    if (action.length === 0) return
    lastPrediction.value = { roomRound: toNumber(value.RoomRound), action }
  }

  function onActionStart(value: DecodedMessage | null | undefined): void {
    if (!value) return
    actor.value = toStr(value.PlayerId)
    actorFlag.value = {
      dead: value.IsDie === true,
      hospitalized: value.IsHospital === true,
      skipThisTurn: value.IsStopRound === true,
    }
  }

  function onTurnStart(value: DecodedMessage | null | undefined): void {
    if (!value) return
    roundStart.value = value
    // 1015 带 Round，是普通对局同步「轮次」的主要来源
    //（客户端里 GameRoundChangeS2C 只在 Connect_PVE 订阅，RoundStartS2C 在 Connect_Player 订阅）
    room.onRoundChange(value)
    const who = toStr(value.PlayerId)
    const cooldownTable = value.SkillCds
    if (who.length > 0 && cooldownTable && typeof cooldownTable === 'object') {
      room.mergeHero(who, { SkillCds: cooldownTable })
    }
  }

  function onMove(value: DecodedMessage | null | undefined): void {
    if (!value) return
    const who = toStr(value.PlayerId)
    const visited = Array.isArray(value.NodeIds) ? (value.NodeIds as unknown[]).map(toNumber) : []
    if (visited.length === 0) return
    // 折叠逻辑全在 `@shared/game/move`（后端脚本引擎用的是同一份），这里只负责搬进 ref
    const state = applyMove(
      {
        landedNode: landedNode.value,
        fromNode: fromNode.value,
        walkedSteps: walkedSteps.value,
        knownEdges: knownEdges.value,
        positionByPlayer: positionByPlayer.value,
      },
      { who, myId: room.myId, myFallbackPosition: mine.value?.position ?? -1, visited },
    )
    knownEdges.value = state.knownEdges
    positionByPlayer.value = state.positionByPlayer
    landedNode.value = state.landedNode
    fromNode.value = state.fromNode
    walkedSteps.value = state.walkedSteps
  }

  // 追击 / 怪物突击（5034 PursuitS2C / 5214 MonsterPursuitS2C）。
  //
  // 发起者会**直接落到目标那一格**，而这一跳只有这一条帧通知：
  // `MoveS2C` 只管一步一步走（`NodeIds` 不含出发点、也不是瞬移），
  // `UpdateHeroAttrS2C` 的 `Place` 段实测恒为空（抓包里全是 `{}`）。
  // 不认这条帧，客户端就一直以为英雄还在突击之前那一格，
  // 于是从错的位置算 `可走候选`，发出去的 `MoveC2S.Direction` 被服务端判为非法（ERR=11023）。
  //
  // 帧里一次带齐了「落点 `NodeId` + 前路 `FrontIds` + 来路 `BackId`」，
  // 正好对上客户端 `RoomPlayer.UpdateHeroPlace(nodeId, frontNodeIds, backNodeId)`
  // 与 `CharacterMove.SendCharacter(nodeId, FrontIds)` 要的那三样，照抄即可。
  function onPursue(value: DecodedMessage | null | undefined): void {
    if (!value) return
    const who = toStr(value.PlayerId)
    if (who.length === 0 || who === '0') return
    // `FrontIds` 空的帧没有落位（真落位一定带可走方向，客户端 SendCharacter 会直接取 FrontIds[0]）。
    const prev = Array.isArray(value.FrontIds) ? (value.FrontIds as unknown[]).map(toNumber) : []
    if (prev.length === 0) return
    // 地块 0 合法，缺字段才是「没给」——不能拿 取数字 的缺省 0 当落点。
    if (value.NodeId === undefined || value.NodeId === null) return
    const node = toNumber(value.NodeId)
    const hasNext = value.BackId !== undefined && value.BackId !== null
    const after = toNumber(value.BackId)

    room.mergeHero(who, {
      NodeId: node,
      FrontNodeIds: prev,
      ...(hasNext ? { BackNodeId: after } : {}),
    })
    positionByPlayer.value = { ...positionByPlayer.value, [who]: node }

    if (who !== room.myId) return
    landedNode.value = node
    // 服务端把出发点也给了，不用本地拿 FrontNodeIds 反推（GetFromLandId 那套）。
    fromNode.value = hasNext ? after : -1
  }

  function onDiceRoll(value: DecodedMessage | null | undefined): void {
    if (!value) return
    const steps = toNumber(value.MovePoint)
    if (steps <= 0) return
    diceSteps.value = steps
    walkedSteps.value = 0
  }

  function onMoveAgain(value: DecodedMessage | null | undefined): void {
    if (!value) return
    const steps = toNumber(value.MovePoint)
    if (steps <= 0) return
    diceSteps.value += steps
  }

  const nodeBuff = computed(() => {
    const table = new Map<number, string[]>()
    for (const [node, packet] of Object.entries(nodeBuffPackets.value)) {
      const array = (packet?.BuffArr as DecodedMessage | undefined)?.Buffs
      if (!array || typeof array !== 'object') continue
      const name = new Set<string>()
      for (const item of Object.values(array as Record<string, DecodedMessage>)) {
        const namePick = nodeBuffName[toNumber(item?.BuffId)]
        if (namePick !== undefined) name.add(namePick)
      }
      if (name.size > 0) table.set(Number(node), [...name])
    }
    return table
  })

  function onNodeBar(value: DecodedMessage | null | undefined): void {
    const list = value?.Buffs
    if (!Array.isArray(list)) return
    const nextTable = { ...nodeBuffPackets.value }
    for (const item of list as DecodedMessage[]) {
      const node = toNumber(item.NodeId)
      nextTable[node] = item
    }
    nodeBuffPackets.value = nextTable
  }

  function onAttrChange(value: DecodedMessage | null | undefined): void {
    if (!value) return
    lastAttrChange.value = value
    const list = value.EffectDatas
    if (!Array.isArray(list)) return
    const outerId = toStr(value.PlayerId)
    for (const item of list as DecodedMessage[]) mergeAttrs(item, outerId)
  }

  function getHeroMap(playerId: string, fieldName: string): Record<string, unknown> {
    const player = room.playerList.find((item) => item.id === playerId)
    const table = (player?.raw.Hero as DecodedMessage | undefined)?.[fieldName]
    return table && typeof table === 'object' ? { ...(table as Record<string, unknown>) } : {}
  }

  function onSkillCooldown(value: DecodedMessage | null | undefined): void {
    if (!value) return
    const who = toStr(value.PlayerId) || room.myId
    const nextTable = value.SkillCds
    if (who.length === 0 || !nextTable || typeof nextTable !== 'object') return
    const table = getHeroMap(who, 'SkillCds')
    for (const [skillId, cooldown] of Object.entries(nextTable as Record<string, unknown>)) {
      table[skillId] = cooldown
    }
    room.mergeHero(who, { SkillCds: table })
  }

  function mergeAttrs(effect: DecodedMessage, outerId: string): void {
    const pick = (name: string): DecodedMessage | undefined => {
      const value = effect[name]
      return value && typeof value === 'object' ? (value as DecodedMessage) : undefined
    }

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
      const heroId = toNumber((room.playerList.find((item) => item.id === playerId)?.raw.Hero as DecodedMessage | undefined)?.HeroId)
      const skillId = activeSkillId(heroId)
      if (skillId > 0) {
        const table = getHeroMap(playerId, 'SkillCds')
        table[skillId] = toNumber(cd.Cd)
        field.SkillCds = table
      }
    }

    const buff = pick('Buff')
    if (buff) {
      const all = buff.Buffs
      const one = buff.Buff && typeof buff.Buff === 'object' ? (buff.Buff as DecodedMessage) : undefined
      if (all && typeof all === 'object' && Object.keys(all).length > 0) {
        field.Buffs = all
      } else if (one) {
        const uid = toStr(one.UniqueId)
        if (uid.length > 0) {
          const table = getHeroMap(playerId, 'Buffs')
          if (toNumber(buff.Op) === 2) delete table[uid]
          else table[uid] = one
          field.Buffs = table
        }
      }
    }

    if (Object.keys(field).length === 0) return
    room.mergeHero(playerId, field)
  }

  function onBattle(value: DecodedMessage | null | undefined): void {
    const battleStat = value?.Battle
    if (!battleStat || typeof battleStat !== 'object') return
    battleMirror.value = battleStat as DecodedMessage
  }

  function clear(): void {
    actor.value = ''
    actorFlag.value = { dead: false, hospitalized: false, skipThisTurn: false }
    lastPrediction.value = null
    roundStart.value = null
    nodeBuffPackets.value = {}
    lastAttrChange.value = null
    battleMirror.value = null
    landedNode.value = -1
    fromNode.value = -1
    diceSteps.value = 0
    walkedSteps.value = 0
    positionByPlayer.value = {}
    inferBornNode.value = -1
    knownEdges.value = {}
  }

  return reactive({
    actor,
    actorFlag,
    lastPrediction,
    roundStart,
    nodeBuffPackets,
    nodeBuff,
    lastAttrChange,
    battleMirror,
    landedNode,
    fromNode,
    diceSteps,
    walkedSteps,
    remainingSteps,
    myBornNode,
    currentFromNode,
    currentPosition,
    frontNodes,
    knownEdges,
    walkCandidates,
    forceDirection,
    inMatch,
    mine,
    playerDataList,
    myTurn,
    actorNickname,
    availableActions,
    myActions,
    getTodo,
    nodes,
    battle,
    battleRunning,
    myBattleSide,
    battlePendingResponse,
    battleDetail,
    monsters,
    onRunFrame,
    onSnapshot,
    onPrediction,
    onActionStart,
    onTurnStart,
    onNodeBar,
    onMove,
    onPursue,
    onDiceRoll,
    onMoveAgain,
    onAttrChange,
    onSkillCooldown,
    onBattle,
    clear,
  })
}

export type MatchState = ReturnType<typeof createMatchState>
