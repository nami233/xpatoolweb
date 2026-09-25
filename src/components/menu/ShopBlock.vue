<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CandidateAction } from '@/stores/battle'
import type { session } from '@/stores/session'
import MenuButton from '@/components/MenuButton.vue'
import { getOperationActions } from '@/components/menu/actions'
import { cardNameTable, displayName } from '@/data/names'

const props = defineProps<{
  session: session
}>()

const action = getOperationActions(props.session.match)

const cardShopAction = action.cardShop
const multiShopAction = action.multiShop
const vendorAction = action.vendor
const chipShopAction = action.chipShop

const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))

interface ShopItem {
  index: number
  cardId: number
  purchased: boolean
}

function listGoods(actionValue: CandidateAction | undefined, boughtField: string): ShopItem[] {
  const shelf = actionValue?.data.Cards
  if (!Array.isArray(shelf) || shelf.length === 0) return []
  const boughtTable = actionValue?.data[boughtField]
  const bought = Array.isArray(boughtTable) ? boughtTable : []
  return (shelf as unknown[]).map((card, index) => ({
    index,
    cardId: toNumber(card),
    purchased: bought[index] === true,
  }))
}

const cardShopShelf = computed(() => listGoods(cardShopAction.value, 'Alreadys'))
const multiShopShelf = computed(() => listGoods(multiShopAction.value, 'Alreadys'))
const vendorCardId = computed(() => toNumber(vendorAction.value?.data?.CardId))

const room = props.session.room

const transferablePlayers = computed(() =>
  room.playerList
    .filter((player) => player.id !== room.myId)
    .map((player) => ({
      id: player.id,
      name: player.nick || player.id,
      gold: toNumber((player.raw.Hero as Record<string, unknown> | undefined)?.Gold),
    })),
)

const assistGold = computed(() => toNumber(cardShopAction.value?.data?.AssistGold))

const transferTarget = ref('')
</script>

<template>
  <div class="op-subblock">
    <div class="op-sub">卡牌商店</div>
    <p v-if="!cardShopAction" class="op-muted">卡牌商店没开（服务端没给这个动作）</p>
    <template v-else>
      <span class="op-muted">卡牌商店 SN: {{ cardShopAction.Sn }}</span>
      <div class="op-row op-row--pair">
        <MenuButton
          v-for="goods in cardShopShelf"
          :key="goods.index"
          :session="session"
          :message="`买 [${goods.index}] ${displayName(cardNameTable, goods.cardId)}${goods.purchased ? '（已买过）' : ''}`"
          :action="cardShopAction"
          :payload="{ BuyCards: [goods.index] }"
        />
        <span v-if="cardShopShelf.length === 0" class="op-muted">（服务端没给货架）</span>
        <MenuButton
          :session="session"
          message="关闭商店"
          :action="cardShopAction"
          :payload="{ IsClose: true }"
        />
      </div>
      <p class="op-muted">按钮上的 [n] 是商品下标，发出去的 `BuyCards` 就是它（卡名只用来认）。</p>

      <div class="op-row">
        <label class="op-label">转账给</label>
        <select v-model="transferTarget" class="op-select">
          <option value="">（选一个玩家）</option>
          <option v-for="person in transferablePlayers" :key="person.id" :value="person.id">
            {{ person.name }}（金币 {{ person.gold }}）
          </option>
        </select>
        <MenuButton
          :session="session"
          :message="`转账（援助金 ${assistGold}）`"
          :action="cardShopAction"
          :payload="{ AssistPlayer: transferTarget }"
          :extraReason="
            transferTarget
              ? assistGold > 0
                ? undefined
                : '服务端没给援助金（AssistGold=0）'
              : '先选一个玩家'
          "
        />
        <span class="op-muted">只带 `AssistPlayer` 发 = 给援助金（双方金币 −/+ 援助金）</span>
      </div>
    </template>
  </div>

  <div class="op-subblock">
    <div class="op-sub">卡牌商店（多人 / 远程）</div>
    <p v-if="!multiShopAction" class="op-muted">多人商店没开（服务端没给这个动作）</p>
    <template v-else>
      <span class="op-muted">多人商店 SN: {{ multiShopAction.Sn }}</span>
      <div class="op-row op-row--pair">
        <MenuButton
          v-for="goods in multiShopShelf"
          :key="goods.index"
          :session="session"
          :message="`买 [${goods.index}] ${displayName(cardNameTable, goods.cardId)}${goods.purchased ? '（已买过）' : ''}`"
          :action="multiShopAction"
          :payload="{ BuyCards: [goods.index] }"
        />
        <span v-if="multiShopShelf.length === 0" class="op-muted">（服务端没给货架）</span>
      </div>
    </template>
  </div>

  <div class="op-subblock">
    <div class="op-sub">商贩处买卡</div>
    <p v-if="!vendorAction" class="op-muted">商贩没出现（服务端没给这个动作）</p>
    <template v-else>
      <span class="op-muted">商贩 SN: {{ vendorAction.Sn }}</span>
      <div class="op-row op-row--pair">
        <MenuButton
          :session="session"
          :message="`买卡 ${displayName(cardNameTable, vendorCardId)}`"
          :action="vendorAction"
          :payload="{ IsBuy: true }"
          :extraReason="vendorCardId > 0 ? undefined : '服务端没给要卖的卡（CardId=0）'"
        />
        <MenuButton
          :session="session"
          message="不买"
          :action="vendorAction"
          :payload="{ IsBuy: false }"
        />
      </div>
      <p class="op-muted">
        只发 `IsBuy`；`CardId` / `Gold` 是服务端在 `Data` 里预填的（它记录本次要交易哪张、花多少）。
      </p>
    </template>
  </div>

  <div class="op-subblock">
    <div class="op-sub">筹码商店</div>
    <p v-if="!chipShopAction" class="op-muted">
      筹码商店没开（服务端没给这个动作）。购买 = 花金币进店（第一次 10，之后 15/20/25）
    </p>
    <template v-else>
      <span class="op-muted">筹码商店 SN: {{ chipShopAction.Sn }}</span>
      <div class="op-row op-row--pair">
        <MenuButton :session="session" message="购买筹码" :action="chipShopAction" :payload="{ Select: 2, Exit: 1 }" />
        <MenuButton :session="session" message="离开" :action="chipShopAction" :payload="{ Exit: 1 }" />
      </div>
    </template>
  </div>
</template>
