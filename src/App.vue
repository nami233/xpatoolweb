<script setup lang="ts">
import { watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { goHome, routeError } from '@/router'
import { currentUser, logout } from '@/stores/user'

const route = useRoute()
const router = useRouter()

/**
 * 兜住「已经登录了却还停在登录页」：掉线重连后自动补绑定只会把 `当前用户` 填上，没人负责切页面；
 * 而且那时 `当前用户` 本来就是旧值，光 watch 变化是等不到第二次的 —— 所以 `immediate` 也要跑一次。
 */
watch(
  [currentUser, () => route.name],
  () => {
    if (currentUser.value.length > 0 && route.name === 'login') void goHome()
  },
  { immediate: true },
)

async function onQuitClick(): Promise<void> {
  await logout()
  await router.push('/login')
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <h1>xpatoolweb</h1>
      <nav>
        <RouterLink to="/">账号</RouterLink>
        <RouterLink to="/capture">抓包</RouterLink>
      </nav>
      <div v-if="currentUser" class="用户区">
        <span class="用户名">{{ currentUser }}</span>
        <button class="退出" @click="onQuitClick">退出</button>
      </div>
    </header>

    <div v-if="routeError" class="路由错误">{{ routeError }}</div>

    <main>
      <RouterView />
    </main>
  </div>
</template>

<style>
:root {
  --muted: #8b93a3;
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

html,
body,
#app {
  height: 100%;
}

body {
  margin: 0;
  background: #0e1015;
  color: #d7dbe3;
  font-family:
    'Microsoft YaHei',
    -apple-system,
    'Segoe UI',
    sans-serif;
  font-size: 14px;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 10px 18px;
  border-bottom: 1px solid #23262f;
  background: #13161c;
}

.topbar h1 {
  margin: 0;
  font-size: 16px;
  letter-spacing: 1px;
}

.topbar nav {
  display: flex;
  gap: 6px;
}

.topbar nav a {
  padding: 4px 12px;
  border-radius: 4px;
  color: var(--muted);
  text-decoration: none;
  font-size: 13px;
}

.topbar nav a.router-link-active {
  background: #22608f;
  color: #fff;
}

main {
  flex: 1;
  min-height: 0;
  padding: 14px 18px 18px;
  overflow-y: auto;
}

.路由错误 {
  padding: 8px 18px;
  border-bottom: 1px solid #6b3030;
  background: #2a1616;
  color: #e07b7b;
  font-size: 13px;
  word-break: break-all;
}

.用户区 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.用户名 {
  color: #cfd6e2;
  font-size: 13px;
}

button.退出 {
  padding: 3px 10px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #1b1f27;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

button.退出:hover {
  border-color: #5a6172;
}

.op-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.op-row--pair {
  gap: 6px;
}

.op-row--top {
  align-items: flex-start;
}

.op-label {
  min-width: 84px;
  color: var(--muted);
  font-size: 12px;
}

.op-muted {
  color: var(--muted);
  font-size: 12px;
}

.op-warn {
  color: #e6a23c;
  font-size: 12px;
}

.op-sub {
  margin-top: 8px;
  color: #cfd6e2;
  font-size: 12px;
}

.op-subblock {
  margin-left: 10px;
  padding-left: 10px;
  border-left: 2px solid #22262e;
}

.op-select {
  min-width: 240px;
  padding: 4px 6px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
}

.op-num {
  width: 88px;
  padding: 3px 6px;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  background: #14171c;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
}

.op-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.op-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
</style>