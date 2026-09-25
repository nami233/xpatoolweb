import { ref } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { currentUser } from '@/stores/user'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
    { path: '/capture', name: 'capture', component: () => import('@/views/CaptureView.vue') },
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue') },
  ],
})

/**
 * 最近一次「切页面没切成」的原因（懒加载的组件拿不到、守卫里抛了错……）。
 * 页面顶上的红条读它：这类失败默认只进控制台，看着就像「点了没反应」。
 */
export const routeError = ref('')

router.onError((error) => {
  routeError.value = `页面切换失败：${error instanceof Error ? error.message : String(error)}`
})

/**
 * 切到主页，返回失败原因（null = 成功）。
 *
 * 触发点有两个：登录页点「登录」、以及掉线重连后自动补绑定（那时用户停在登录页）。
 * 两边可能同时来，所以共用同一个「在飞行」的跳转 —— 各自 `push` 一次会互相取消掉。
 */
let navigating: Promise<string | null> | null = null

export function goHome(): Promise<string | null> {
  if (navigating !== null) return navigating
  navigating = (async (): Promise<string | null> => {
    try {
      const fail = await router.push('/')
      if (fail !== undefined) return `没能进主页（${String(fail.type)}）`
      return null
    } catch (error) {
      return `进主页出错：${error instanceof Error ? error.message : String(error)}`
    }
  })().then((reason) => {
    // 没人盯着控制台：失败原因挂到页面顶上的红条，别让它悄悄消失
    if (reason !== null) routeError.value = `已登录，但${reason}`
    navigating = null
    return reason
  })
  return navigating
}

/**
 * 门禁：没绑定用户前不进主页。**不自动恢复会话** —— 刷新页面就得重新登录，
 * 想省事在登录页勾「记住密码」（只帮你把用户名/密码填好，仍然要自己点登录）。
 */
router.beforeEach((to) => {
  const loggedIn = (currentUser.value ?? '').length > 0
  if (!loggedIn && to.name !== 'login') return { name: 'login' }
  if (loggedIn && to.name === 'login') return { name: 'home' }
  return true
})

export default router