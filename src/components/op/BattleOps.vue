<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { session } from '@/stores/session'
import ActionCard from '@/components/ActionCard.vue'
import ActionMenu from '@/components/ActionMenu.vue'
import MapView from '@/components/op/MapView.vue'
import {
  heroNameTable,
  mapNameTable,
  heroCandidateList,
  cardNameTable,
  nodeDetail,
  chipNameTable,
  roomStateNameTable,
  displayName,
  difficultyNameTable,
  mapDifficultyList,
} from '@/data/names'

const props = defineProps<{
  session: session
}>()

const session = props.session
const battle = session.match
const room = session.room

const toNum = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))
const toText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'bigint' ? value.toString() : ''

const menuOverrides = new Set([
  'ThrowDiceC2S',
  'MoveAgainC2S',
  'ThrowDiceResultC2S',
  'UseEffectCardC2S',
  'BattleUseCardC2S',
  'BattleThrowDiceC2S',
  'BattleChoiceC2S',
  'AskBattleC2S',
  'StopOrContinueC2S',
  'SelectRelicC2S',
  'MoveC2S',
  'ChoiceDirectionC2S',
  'PVEShopBuyC2S',
  'BuyRelicC2S',
  'MonsterPursuitC2S',
])

const otherActions = computed(() => operableActions.value.filter((item) => !menuOverrides.has(item.commandName)))

const operableActions = computed(() => battle.myActions)

const otherPlayerActions = computed(() => battle.availableActions.filter((item) => item.playerId !== room.myId))

const roundInfo = computed(() => {
  const value = battle.roundStart
  if (!value) return null
  return {
    turn: toNum(value.Round),
    startingPlayer: toText(value.PlayerId),
    gold: toNum(value.Gold),
    handCardCount: toNum(value.CardNum),
    cardPlayLimit: toNum(value.UseCardMaxNum),
  }
})

const battleSides = computed(() => {
  const battleStat = battle.battleDetail
  if (!battleStat) return []
  return [
    { name: '攻方', value: battleStat.attacker },
    { name: '守方', value: battleStat.defender },
  ].filter((edge) => edge.value !== null)
})

const responseCommands = computed(() => [...new Set(battle.battlePendingResponse.map((item) => item.commandName))])

const myNodeDetail = computed(() => {
  const position = battle.mine?.position
  if (position === undefined || position < 0) return ''
  const type = battle.nodes.find((chunk) => chunk.node === position)?.type ?? 0
  return nodeDetail(type)
})


const canOperate = computed(() => session.isLogined)

const roomDifficultyName = computed(() => {
  const settings = room.roomSettings
  if (mapDifficultyList(settings.mapId).length === 0) return ''
  return `${settings.difficulty} ${difficultyNameTable[settings.difficulty] ?? ''}`.trim()
})

const heroCandidates = heroCandidateList
const desiredHero = ref(heroCandidates[0] ?? 101)

function defaultAdorn(heroId: number): number {
  return 100000000 + heroId * 1000 + 1
}

const desiredSkin = ref(0)

watch(
  () => room.myHero,
  (heroRow) => {
    if (!heroRow) return
    const heroId = toNum(heroRow.HeroId)
    if (heroId > 0) desiredSkin.value = toNum(heroRow.UseAdorn) || defaultAdorn(heroId)
  },
  { immediate: true },
)

const canPickSkin = computed(
  () => room.roomState === 15 || (room.myHero?.Affirm === true && room.roomState < 20),
)

const isLoading = computed(() => room.roomState === 20)

const isPicking = computed(
  () => room.roomState === 10 || room.roomState === 15 || room.heroChoice.length > 0,
)

async function toggleReady(value: boolean): Promise<void> {
  await session.setReady(value)
}
</script>

<template>
  <div class="页">
    <section class="块">
      <div class="块头">
        <h3>对局</h3>
        <div class="计数">
          <span v-if="room.inRoom">房间：{{ room.roomId }}</span>
          <span>状态：{{ roomStateNameTable[room.roomState] ?? room.roomState }}</span>
          <span v-if="room.round > 0">轮次 {{ room.round }}</span>
          <span>地图：{{ displayName(mapNameTable, toNum(room.room?.MapId)) }}</span>
          <span>行动者：{{ battle.actorNickname }}</span>
        </div>
      </div>

      <p v-if="!battle.inMatch" class="提示">
        还没进对局。建房/进房在主页面「批量操作」里；进房后在下面的「准备区」准备 + 选英雄/皮肤开局。
      </p>
      <p v-if="battle.myTurn" class="提示 警告">轮到你行动了 —— 看下面的「操作」</p>
      <p v-if="room.hint" class="提示 警告">{{ room.hint }}</p>

      <div v-if="roundInfo" class="计数 留白">
        <span>本回合起始玩家：{{ roundInfo.startingPlayer }}</span>
        <span>起始金币：{{ roundInfo.gold }}</span>
        <span>手牌：{{ roundInfo.handCardCount }}</span>
        <span>出牌上限：{{ roundInfo.cardPlayLimit }}</span>
      </div>
    </section>

    <section v-if="room.inRoom" class="块">
      <div class="块头">
        <h3>准备区</h3>
        <div class="计数">
          <span>房间 {{ room.roomId }}</span>
          <span>状态 {{ roomStateNameTable[room.roomState] ?? room.roomState }}</span>
          <span v-if="room.round > 0">轮次 {{ room.round }}</span>
          <span>地图 {{ displayName(mapNameTable, toNum(room.room?.MapId)) }}</span>
          <span v-if="roomDifficultyName">难度 {{ roomDifficultyName }}</span>
          <span>{{ room.isHost ? '我是房主' : '我是成员' }}</span>
        </div>
      </div>

      <p v-if="!canOperate" class="提示">这个账号还没登录（主页面勾上它点「登录账号」）。</p>

      <div class="行">
        <button class="主" :disabled="!canOperate" @click="toggleReady(!(room.my?.ready ?? false))">
          {{ room.my?.ready ? '取消准备' : '准备' }}
        </button>
        <button v-if="room.isHost" class="主" :disabled="!canOperate" @click="session.startGame(true)">
          开始游戏（补 Bot）
        </button>
        <button :disabled="!canOperate" @click="session.autoChooseHero()">自动选英雄</button>
        <button class="危险" :disabled="!canOperate" @click="session.exitRoom()">退出房间</button>
      </div>

      <div class="表">
        <div class="表头">
          <span class="c-slot">座位</span>
          <span class="c-nick">昵称</span>
          <span class="c-level">等级</span>
          <span class="c-ready">准备</span>
          <span class="c-master">房主</span>
        </div>
        <div v-for="player in room.playerList" :key="player.id" class="表行">
          <span class="c-slot">{{ player.slot }}</span>
          <span class="c-nick">{{ player.nick || player.id }}</span>
          <span class="c-level">{{ player.level }}</span>
          <span class="c-ready" :class="{ ok: player.ready }">{{
            player.ready ? '已准备' : '未准备'
          }}</span>
          <span class="c-master">{{ player.id === room.hostId ? '★' : '' }}</span>
        </div>
        <p v-if="room.playerList.length === 0" class="空">房间里还没有玩家数据</p>
      </div>

      <div v-if="isPicking" class="子区">
        <div class="块头">
          <h4>选英雄 / 选皮肤</h4>
          <div class="计数">
            <span v-if="room.myHero">
              英雄 {{ displayName(heroNameTable, toNum(room.myHero.HeroId)) }} ·
              {{ room.myHero.Affirm === true ? '已确认' : '待确认' }}
              ／ 装饰 {{ room.myHero.UseAdorn || '—' }} ·
              {{ room.myHero.AffirmedSkin === true ? '已确认' : '待确认' }}
            </span>
            <span v-else class="灰">还没选</span>
          </div>
        </div>

        <div class="行">
          <span class="步骤">1 · 选英雄</span>
          <label class="内联">
            <span>英雄</span>
            <select v-model.number="desiredHero">
              <option v-for="hero in heroCandidates" :key="hero" :value="hero">
                {{ displayName(heroNameTable, hero) }}
              </option>
            </select>
          </label>
          <button class="主 小" :disabled="!canOperate" @click="session.selectAndConfirmHero(desiredHero)">
            选择并确认
          </button>
          <button class="小" :disabled="!canOperate" @click="session.chooseHero(desiredHero)">仅选择</button>
          <button class="小" :disabled="!canOperate" @click="session.confirmHero()">仅确认</button>
          <button class="小" :disabled="!canOperate" @click="session.autoChooseHero()">随机选一个</button>
        </div>

        <div class="行">
          <span class="步骤">2 · 选皮肤</span>
          <label class="内联">
            <span>装饰</span>
            <input v-model.number="desiredSkin" type="number" class="装饰" />
          </label>
          <button
            class="主 小"
            :disabled="!canOperate || !canPickSkin"
            @click="session.selectAndConfirmSkin(desiredSkin)"
          >
            选并确认皮肤
          </button>
          <button class="小" :disabled="!canOperate || !canPickSkin" @click="session.chooseSkin(desiredSkin)">
            仅选皮肤
          </button>
          <button class="小" :disabled="!canOperate || !canPickSkin" @click="session.confirmSkin()">
            仅确认皮肤
          </button>
          <span v-if="!canPickSkin" class="提示">先把英雄确认了，才轮到选皮肤</span>
        </div>

        <div class="表">
          <div class="表头">
            <span class="c-nick">玩家</span>
            <span class="c-map">英雄</span>
            <span class="c-ready">英雄确认</span>
            <span class="c-srv">装饰</span>
            <span class="c-ready">皮肤确认</span>
          </div>
          <div v-for="item in room.heroChoice" :key="item.playerId" class="表行">
            <span class="c-nick">{{ item.nickname }}{{ item.playerId === room.myId ? '（我）' : '' }}</span>
            <span class="c-map">{{ item.heroId > 0 ? displayName(heroNameTable, item.heroId) : '—' }}</span>
            <span class="c-ready" :class="{ ok: item.confirmed }">{{
              item.confirmed ? '已确认' : '未确认'
            }}</span>
            <span class="c-srv">{{ item.adorn || '—' }}</span>
            <span class="c-ready" :class="{ ok: item.skinConfirmed }">
              {{ item.skinConfirmed ? '已确认' : '未确认' }}
            </span>
          </div>
        </div>
      </div>

      <div v-if="isLoading" class="子区">
        <div class="块头">
          <h4>加载中</h4>
          <div class="计数">
            <span>等所有人都报到 100% 才开始对局</span>
            <span>本账号一进加载页就自动报 100%，不用手点</span>
          </div>
        </div>

        <div class="表">
          <div class="表头">
            <span class="c-nick">玩家</span>
            <span class="c-level">进度</span>
          </div>
          <div v-for="player in room.playerList" :key="player.id" class="表行">
            <span class="c-nick"
              >{{ player.nick || player.id }}{{ player.id === room.myId ? '（我）' : '' }}</span
            >
            <span class="c-level" :class="{ ok: player.progress >= 100 }">{{ player.progress }}%</span>
          </div>
        </div>
      </div>
    </section>

    <section v-if="battle.playerDataList.length > 0" class="块">
      <div class="块头">
        <h3>玩家信息</h3>
        <div class="计数">
          <span>共 {{ battle.playerDataList.length }} 人</span>
          <span>手牌认 1109、属性认 1040，都实时刷新</span>
        </div>
      </div>

      <div
        v-for="player in battle.playerDataList"
        :key="player.playerId"
        class="玩家卡"
        :class="{ my: player.playerId === room.myId }"
      >
        <div class="玩家头">
          <span class="昵称"
            >{{ player.nickname }}{{ player.playerId === room.myId ? '（我）' : '' }}</span
          >
          <span>英雄 {{ displayName(heroNameTable, player.heroId) }}</span>
          <span>位置 {{ player.position }}</span>
          <span>金币 {{ player.gold }}</span>
          <span>血量 {{ player.hp }}/{{ player.maxHp }}</span>
          <span>攻 {{ player.attack }}</span>
          <span>防 {{ player.defense }}</span>
          <span>移动点 {{ player.moveNode }}</span>
          <span>等级 {{ player.level }}</span>
          <span
            v-for="skill in player.skillCooldown"
            :key="skill.name"
            :class="{ ok: skill.cooldown <= 0, 警告: skill.cooldown > 0 }"
          >
            {{ skill.name }} {{ skill.cooldown > 0 ? `剩 ${skill.cooldown} 回合` : '可用' }}
          </span>
        </div>

        <div class="串">
          <span class="串标">手牌</span>
          <span v-for="card in player.handCards" :key="card.uniqueId" class="串项">
            {{ displayName(cardNameTable, card.cardId) }} <em>#{{ card.uniqueId }}</em>
          </span>
          <span v-if="player.handCards.length === 0" class="灰">（没有手牌）</span>
        </div>

        <div class="串">
          <span class="串标">Buff</span>
          <span v-for="(buff, index) in player.buffs" :key="`${buff.name}-${index}`" class="串项">
            {{ buff.name }}
            <em v-if="buff.depth > 0"> ×{{ buff.depth }}</em>
            <em v-if="buff.remainingTurns > 0"> · 剩 {{ buff.remainingTurns }}</em>
          </span>
          <span v-if="player.buffs.length === 0" class="灰">（没有 buff）</span>
        </div>

        <div class="串">
          <span class="串标">筹码</span>
          <span v-for="chipId in player.chip" :key="chipId" class="串项">
            {{ displayName(chipNameTable, chipId) }}
          </span>
          <span v-if="player.chip.length === 0" class="灰">（没有筹码）</span>
        </div>

        <div v-if="player.playerId === room.myId" class="串">
          <span class="串标">相邻节点</span>
          <span v-for="node in battle.mine?.walkableNodes ?? []" :key="node" class="串项">{{ node }}</span>
          <span v-if="(battle.mine?.walkableNodes ?? []).length === 0" class="灰">
            （服务端没给相邻节点）
          </span>
        </div>
      </div>

      <div v-if="battle.monsters.length > 0" class="串">
        <span class="串标">怪物</span>
        <span v-for="monster in battle.monsters" :key="monster.id" class="串项">
          {{ monster.nickname }}
          <em v-if="monster.maxHp > 0">{{ monster.hp }}/{{ monster.maxHp }}</em>
          <em v-if="monster.position > 0">位置 {{ monster.position }}</em>
          <em>id {{ monster.id }}</em>
        </span>
      </div>
    </section>

    <section v-if="battleSides.length > 0" class="块">
      <div class="块头">
        <h3>战斗</h3>
        <div class="计数">
          <span>编号 {{ battle.battleDetail?.Id }}</span>
          <span>状态：{{ battle.battleDetail?.end ? '已结算' : '进行中' }}</span>
          <span v-if="battle.battleDetail?.pursue">追击战</span>
          <span v-if="battle.myBattleSide">我是{{ battle.myBattleSide }}</span>
          <span v-if="responseCommands.length > 0" class="警告">
            待我响应：{{ responseCommands.join(' / ') }}
          </span>
        </div>
      </div>

      <div class="表">
        <div class="表头">
          <span class="c-slot">边</span>
          <span class="c-nick">玩家</span>
          <span class="c-srv">英雄</span>
          <span class="c-level">血量</span>
          <span class="c-srv">费用</span>
          <span class="c-ready">攻 / 防 / 骰点</span>
        </div>
        <div v-for="edge in battleSides" :key="edge.name" class="表行">
          <span class="c-slot">{{ edge.name }}</span>
          <span class="c-nick">
            {{ edge.value?.nickname ?? '—' }}{{ edge.value?.ready ? ' · 已准备' : '' }}
          </span>
          <span class="c-srv">{{ edge.value ? displayName(heroNameTable, edge.value.heroId) : '—' }}</span>
          <span class="c-level">{{ edge.value?.hp ?? '—' }}</span>
          <span class="c-srv" :class="{ ok: (edge.value?.cost ?? 0) > 0 }">
            {{ edge.value?.cost ?? 0 }}/{{ edge.value?.costLimit ?? 0 }}
          </span>
          <span class="c-ready">
            {{ edge.value?.attack ?? 0 }} / {{ edge.value?.defense ?? 0 }} / {{ edge.value?.diceValue ?? 0 }}
            <template v-if="edge.value?.dodge"> · 闪避</template>
            <template v-if="edge.value && edge.value.useCard.length > 0">
              · 用牌 {{ edge.value.useCard.map((card) => displayName(cardNameTable, card)).join('、') }}
            </template>
          </span>
        </div>
      </div>
    </section>

    <section class="块">
      <div class="块头">
        <h3>操作</h3>
        <div class="计数">
          <span v-if="battle.myTurn">轮到你行动</span>
          <span v-else>当前行动者：{{ battle.actorNickname }}</span>
          <span v-if="operableActions.length > 0">待你操作 {{ operableActions.length }} 个</span>
        </div>
      </div>

      <p v-if="!battle.inMatch" class="提示">还没进对局。</p>

      <ActionMenu v-else :session="session">
        <details v-if="otherActions.length > 0" class="折叠">
          <summary>其它 / 原始报文（{{ otherActions.length }} 个）</summary>
          <ActionCard
            v-for="action in otherActions"
            :key="`${action.cmdId}-${action.Sn}`"
            :action="action"
            :session="session"
          />
        </details>
      </ActionMenu>

      <details v-if="otherPlayerActions.length > 0" class="折叠 淡">
        <summary>其他人的候选动作（{{ otherPlayerActions.length }} 个，只读）</summary>
        <ul class="列表">
          <li v-for="action in otherPlayerActions" :key="`${action.cmdId}-${action.Sn}`">
            {{ action.commandName }} · Id={{ action.cmdId }} · Sn={{ action.Sn }} · 玩家 {{ action.playerId }}
          </li>
        </ul>
      </details>
    </section>

    <section class="块">
      <div class="块头">
        <h3>地图</h3>
        <div class="计数">
          <span>共 {{ battle.nodes.length }} 块</span>
          <span v-if="battle.mine">我在 {{ battle.mine.position }}</span>
        </div>
      </div>
      <MapView :session="session" />

      <p v-if="myNodeDetail" class="提示">我脚下这块地：{{ myNodeDetail }}</p>
    </section>
  </div>
</template>

<style scoped>
.页 {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.块 {
  padding: 12px 14px;
  border: 1px solid #23262f;
  border-radius: 6px;
  background: #13161c;
}

.块头 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.块头 h3 {
  margin: 0;
  font-size: 14px;
}

.计数 {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
}

.计数.留白 {
  margin-top: 6px;
}

.提示 {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.提示.警告,
.警告 {
  color: #e0a33e;
}

.灰 {
  color: var(--muted);
}

.串 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}

.串标 {
  color: var(--muted);
  font-size: 12px;
}

.串项 {
  padding: 2px 8px;
  border: 1px solid #2b3038;
  border-radius: 10px;
  font-size: 12px;
}

.串项 em {
  color: var(--muted);
  font-style: normal;
}


.玩家卡 {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid #2b3038;
  border-radius: 4px;
}

.玩家卡.我 {
  border-color: #3d7ebe;
}

.玩家头 {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
}

.玩家头 .昵称 {
  color: #e6ebf2;
  font-size: 13px;
}

.玩家头 .好 {
  color: #4caf7d;
}

.折叠 {
  margin-top: 12px;
}

.折叠 > summary {
  padding: 5px 0;
  border-bottom: 1px solid #2b3038;
  color: #e6ebf2;
  font-size: 13px;
  cursor: pointer;
}

.折叠.淡 > summary {
  color: var(--muted);
  font-size: 12px;
}

.列表 {
  margin: 6px 0 0;
  padding-left: 20px;
  color: var(--muted);
  font-size: 12px;
}

.表 {
  margin-top: 10px;
  border: 1px solid #2b3038;
  border-radius: 4px;
  overflow: hidden;
  font-size: 13px;
}

.表头,
.表行 {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
}

.表头 {
  background: #171b21;
  color: var(--muted);
  font-size: 12px;
}

.表行 + .表行 {
  border-top: 1px solid #22262e;
}

.c-slot {
  flex: 0 0 50px;
}

.c-nick {
  flex: 1 1 160px;
}

.c-srv {
  flex: 0 0 70px;
}

.c-level {
  flex: 0 0 70px;
}

.c-ready {
  flex: 0 0 100px;
}

.空 {
  padding: 14px 10px;
  color: var(--muted);
  font-size: 12px;
}


.行 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

button {
  padding: 4px 12px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

button.主 {
  border-color: #3d7ebe;
  background: #22608f;
  color: #fff;
}

button.小 {
  padding: 2px 8px;
}

button.危险 {
  border-color: #6b3030;
  color: #e07b7b;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

label.内联 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

select,
input {
  padding: 4px 6px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
}

.子区 {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid #22262e;
}

.子区 h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.步骤 {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

input.装饰 {
  width: 130px;
}

.c-map {
  flex: 1 1 120px;
}

.c-master {
  flex: 0 0 50px;
}

.c-ready.好,
.c-srv.好,
.c-level.好 {
  color: #4caf7d;
}
</style>