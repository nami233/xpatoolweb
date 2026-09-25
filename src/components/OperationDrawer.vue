<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AccountSlot } from '@/stores/accounts'
import BattleOps from '@/components/op/BattleOps.vue'
import ScriptOps from '@/components/op/ScriptOps.vue'
import DebugOps from '@/components/op/DebugOps.vue'

const props = defineProps<{
  accountList: AccountSlot[]
}>()

const emit = defineEmits<{ close: [] }>()

const groupList = ['对局', '脚本', '调试'] as const
const currentGroup = ref<(typeof groupList)[number]>('对局')
const currentIndex = ref(0)

watch(
  () => props.accountList,
  (list) => {
    if (currentIndex.value >= list.length) currentIndex.value = 0
  },
  { immediate: true },
)

const accountSlot = computed<AccountSlot | null>(() => props.accountList[currentIndex.value] ?? null)
</script>

<template>
  <div class="抽屉层">
    <div class="遮罩" @click="emit('close')" />

    <aside class="抽屉">
      <header class="抽屉头">
        <h2>操作</h2>
        <div class="账号页签">
          <button
            v-for="(item, index) in accountList"
            :key="item.slot"
            class="账号页签项"
            :class="{ 选中: index === currentIndex }"
            :title="item.account"
            @click="currentIndex = index"
          >
            <span class="页签名">{{ item.session.displayName }}</span>
            <span class="页签态" :class="`态-${item.session.loginState}`">{{ item.session.loginLabel }}</span>
          </button>
        </div>
        <button class="关" @click="emit('close')">×</button>
      </header>

      <nav class="分组">
        <button
          v-for="group in groupList"
          :key="group"
          class="分组项"
          :class="{ 选中: group === currentGroup }"
          @click="currentGroup = group"
        >
          {{ group }}
        </button>
      </nav>

      <div class="抽屉身">
        <p v-if="!accountSlot" class="空">
          没有选中的账号：在下面账号列表里勾一个（或点一行把它设为当前），再点「操作」。
        </p>
        <template v-else>
          <BattleOps v-if="currentGroup === '对局'" :key="`对局-${accountSlot.slot}`" :session="accountSlot.session" />
          <ScriptOps v-else-if="currentGroup === '脚本'" :key="`脚本-${accountSlot.slot}`" :session="accountSlot.session" />
          <DebugOps v-else :key="`调试-${accountSlot.slot}`" :session="accountSlot.session" />
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.抽屉层 {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.遮罩 {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
}

.抽屉 {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: min(720px, 92vw);
  border-left: 1px solid #23262f;
  background: #0f1218;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.45);
}

.抽屉头 {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid #23262f;
  background: #13161c;
}

.抽屉头 h2 {
  margin: 0;
  font-size: 15px;
}

.账号页签 {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 6px;
}

.账号页签项 {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 210px;
  padding: 4px 10px;
  border: 1px solid #3a3f4b;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.账号页签项.选中 {
  border-color: #3d7ebe;
  background: #1b2a3a;
}

.页签名 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.页签态 {
  color: var(--muted);
  font-size: 11px;
}

.页签态.态-logined {
  color: #67c23a;
}

.页签态.态-failed {
  color: #f56c6c;
}

.关 {
  padding: 2px 10px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 16px;
  line-height: 1.2;
  cursor: pointer;
}

.分组 {
  display: flex;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid #23262f;
}

.分组项 {
  padding: 4px 14px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

.分组项.选中 {
  border-color: #3d7ebe;
  background: #22608f;
  color: #fff;
}

.抽屉身 {
  flex: 1;
  padding: 14px;
  overflow-y: auto;
}

.空 {
  color: var(--muted);
  font-size: 13px;
}
</style>