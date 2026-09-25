import { computed, reactive, ref } from 'vue'
import type { DecodedMessage } from '@shared/protocol/jsonSafe'
import { progressLimit as lookupProgressLimit } from '@/data/names'

export interface RoomPlayer {
  id: string
  nick: string
  level: number
  slot: number
  ready: boolean
  headIcon: number
  online: boolean
  progress: number
  raw: DecodedMessage
}

const toStr = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'bigint' ? value.toString() : ''
const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

export function createRoomState() {
  const mapMod = ref(1)
  const list = ref<DecodedMessage[]>([])
  const listLoading = ref(false)
  const hint = ref('')
  const room = ref<DecodedMessage | null>(null)
  const heroTable = ref<Record<string, DecodedMessage>>({})

  const myId = ref('')

  const inRoom = computed(() => room.value !== null)

  const playerList = computed<RoomPlayer[]>(() => {
    const raw = room.value?.Players
    if (!Array.isArray(raw)) return []
    return (raw as DecodedMessage[]).map((player) => ({
      id: toStr(player.Id),
      nick: toStr(player.Nick),
      level: toNumber(player.Level),
      slot: toNumber(player.Slot),
      ready: player.RoomReady === true,
      headIcon: toNumber(player.HeadIcon),
      online: toNumber(player.OnlineStatus) !== 0,
      progress: toNumber(player.Progress),
      raw: player,
    }))
  })

  const roomId = computed(() => toStr(room.value?.Id))
  const hostId = computed(() => toStr(room.value?.MasterId))
  const spectateCode = computed(() => toStr(room.value?.WatchCode))
  const roomPlayerCount = computed(() => playerList.value.length)
  const isHost = computed(() => myId.value.length > 0 && myId.value === hostId.value)
  const roomState = computed(() => toNumber(room.value?.State))
  // 轮次 = Room.Round（游戏自己的叫法，见 BuffRoundCountType_Round = 轮次）。
  // 所有对象各行动一次（= 一次「回合」，BuffRoundCountType_Action）算一个轮次，只增不减。
  // 进度是另一套：Room.GameProgress / GameMaxProgress，会被事件加减，到上限还没通关就失败。
  const round = computed(() => toNumber(room.value?.Round))

  const progress = computed(() => toNumber(room.value?.GameProgress))

  // 进度上限不能用服务端字段：
  //  - 1071 GameProgressChangeS2C 的 MaxProgress 恒等于 Progress（抓包实测 1/1 → 2/2 → 3/3），是镜像不是上限；
  //  - Room.GameMaxProgress(47) 实时对局的 Room 快照里从不下发（抓包里全是缺省 0）。
  // 客户端自己也是用本地难度的 ProgressLimit 当总步数（UIBattleInfo_Com_PVEProgress.InitPVEProgressEvent），
  // 所以这里同样用本地配置表（log.txt 的「难度配置表…进度上限」就是它的出处）。
  const progressLimit = computed(
    () => lookupProgressLimit(toNumber(room.value?.MapId), toNumber(room.value?.Difficulty)) ?? 0,
  )

  const roomSettings = computed(() => ({
    mode: toNumber(room.value?.MapType) || 1,
    mapId: toNumber(room.value?.MapId),
    condition: toNumber(room.value?.UpgradePlan),
    thinkTime: toNumber(room.value?.TimePlan),
    speed: toNumber(room.value?.SpeedType),
    difficulty: toNumber(room.value?.Difficulty),
    label: toNumber(room.value?.RoomLabel),
    skipStory: room.value?.SkipStory === true,
    password: toStr(room.value?.Pwd),
  }))

  const my = computed(() => playerList.value.find((player) => player.id === myId.value) ?? null)

  const myHero = computed(() => heroTable.value[myId.value] ?? null)

  const myHeroId = computed(() => toNumber(heroTable.value[myId.value]?.HeroId))

  const heroChoice = computed(() =>
    Object.entries(heroTable.value).map(([playerId, heroRow]) => {
      const player = playerList.value.find((item) => item.id === playerId)
      return {
        playerId,
        nickname: player?.nick || playerId,
        heroId: toNumber(heroRow.HeroId),
        confirmed: heroRow.Affirm === true,
        adorn: toNumber(heroRow.UseAdorn),
        skinConfirmed: heroRow.AffirmedSkin === true,
      }
    }),
  )

  function setList(entries: DecodedMessage[]): void {
    list.value = entries
  }

  function onRoom(value: DecodedMessage | null | undefined): void {
    if (!value) return
    const candidates = value.Players !== undefined ? value : (value.Room as DecodedMessage | undefined)
    if (!candidates || typeof candidates !== 'object') return
    room.value = candidates
  }

  function updatePlayerReady(playerId: string, ready: boolean): void {
    if (playerId === '0' || playerId.length === 0) return
    const raw = room.value?.Players
    if (!Array.isArray(raw)) return
    for (const player of raw as DecodedMessage[]) {
      if (toStr(player.Id) === playerId) player.RoomReady = ready
    }
  }

  function updateLoadProgress(playerId: string, progress: number): void {
    if (playerId === '0' || playerId.length === 0) return
    const raw = room.value?.Players
    if (!Array.isArray(raw)) return
    for (const player of raw as DecodedMessage[]) {
      if (toStr(player.Id) === playerId) player.Progress = progress
    }
  }

  function onProgressChange(value: DecodedMessage | null | undefined): void {
    if (!value || room.value === null) return
    // 只取 Progress（1 基的当前步数）。MaxProgress 别写进来：它恒等于 Progress，
    // 写进去就会被 进度上限 当成总步数用，显示成 1/1。
    room.value = { ...room.value, GameProgress: toNumber(value.Progress) }
  }

  function onRoundChange(value: DecodedMessage | null | undefined): void {
    if (!value || room.value === null) return
    const newRound = toNumber(value.Round)
    if (newRound > 0) room.value = { ...room.value, Round: newRound }
  }

  function removePlayer(playerId: string): void {
    const raw = room.value?.Players
    if (!Array.isArray(raw)) return
    const rest = (raw as DecodedMessage[]).filter((player) => toStr(player.Id) !== playerId)
    room.value = { ...room.value, Players: rest }
  }

  function onKickedFromRoom(): void {
    room.value = null
    heroTable.value = {}
    hint.value = '你被房主踢出房间了'
  }

  function onHeroBar(value: DecodedMessage | null | undefined): void {
    if (!value) return
    const inner = (value.Box as DecodedMessage | undefined)?.Box
    if (!inner || typeof inner !== 'object') return
    heroTable.value = { ...heroTable.value, ...(inner as Record<string, DecodedMessage>) }
  }

  function onSkin(value: DecodedMessage | null | undefined): void {
    if (!value) return
    const playerId = toStr(value.PlayerId)
    if (playerId.length === 0 || playerId === '0') return
    const prev = heroTable.value[playerId] ?? {}
    heroTable.value = {
      ...heroTable.value,
      [playerId]: {
        ...prev,
        HeroId: toNumber(value.HeroId) || toNumber(prev.HeroId),
        UseAdorn: toNumber(value.UseAdorn) || toNumber(prev.UseAdorn),
        AffirmedSkin: value.Affirmed === true ? true : prev.AffirmedSkin,
      },
    }
  }

  function onMonster(value: DecodedMessage | null | undefined): void {
    const raw = value?.Monster
    if (!raw || typeof raw !== 'object') return
    const monster = raw as DecodedMessage
    const id = toStr(monster.Id)
    if (id.length === 0 || id === '0') return
    if (room.value === null) return

    const old = Array.isArray(room.value.Monsters)
      ? (room.value.Monsters as DecodedMessage[])
      : []
    const position = old.findIndex((item) => toStr(item.Id) === id)
    const next = [...old]
    if (position >= 0) next[position] = monster
    else next.push(monster)
    room.value = { ...room.value, Monsters: next }
  }

  function onHandCards(value: DecodedMessage | null | undefined): void {
    const card = value?.Cards
    if (!Array.isArray(card)) return
    mergeHero(toStr(value?.PlayerId), { Cards: card })
  }

  function mergeHero(playerId: string, field: Record<string, unknown>): void {
    if (playerId.length === 0 || playerId === '0') return
    if (room.value === null) return
    const raw = room.value.Players
    if (!Array.isArray(raw)) return

    let changed = false
    const newPlayers = (raw as DecodedMessage[]).map((player) => {
      if (toStr(player.Id) !== playerId) return player
      const hero = player.Hero
      if (!hero || typeof hero !== 'object') return player
      changed = true
      return { ...player, Hero: { ...(hero as DecodedMessage), ...field } }
    })
    if (!changed) return
    room.value = { ...room.value, Players: newPlayers }
  }

  function clearRoom(): void {
    room.value = null
    heroTable.value = {}
  }

  function setHint(text: string): void {
    hint.value = text
  }

  return reactive({
    mapMod,
    list,
    listLoading,
    hint,
    room,
    heroTable,
    myId,
    inRoom,
    playerList,
    roomId,
    hostId,
    spectateCode,
    roomPlayerCount,
    isHost,
    roomState,
    round,
    progress,
    progressLimit,
    roomSettings,
    my,
    myHero,
    myHeroId,
    heroChoice,
    setList,
    onRoom,
    onHeroBar,
    onSkin,
    updatePlayerReady,
    updateLoadProgress,
    onProgressChange,
    onRoundChange,
    onMonster,
    onHandCards,
    mergeHero,
    removePlayer,
    onKickedFromRoom,
    clearRoom,
    setHint,
  })
}

export type roomState = ReturnType<typeof createRoomState>
