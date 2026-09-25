<script setup lang="ts">
import { computed } from 'vue'
import type { CandidateAction } from '@/stores/battle'
import type { session } from '@/stores/session'

const props = defineProps<{
  message: string
  action?: CandidateAction
  payload?: Record<string, unknown>
  extraReason?: string
  session: session
}>()

const session = props.session

const canOperate = computed(
  () => props.action !== undefined && props.extraReason === undefined && session.isLogined,
)

const disabledReason = computed(() => {
  if (props.action === undefined) {
    return '服务端没给这个动作（不是你的回合 / 当前阶段没有这个操作）'
  }
  return props.extraReason ?? '还没登录'
})

async function onClick(): Promise<void> {
  const action = props.action
  if (!action) return
  await session.executeMatchAction(action, props.payload ?? {})
}
</script>

<template>
  <button class="菜单按钮" :disabled="!canOperate" :title="canOperate ? '' : disabledReason" @click="onClick">
    {{ message }}
  </button>
</template>

<style scoped>
.菜单按钮 {
  padding: 5px 12px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #22608f;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}

.菜单按钮:hover:not(:disabled) {
  background: #2b74ab;
}

.菜单按钮:disabled {
  border-color: #2b3038;
  background: #1c2027;
  color: #5b6470;
  cursor: not-allowed;
}
</style>