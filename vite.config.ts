import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

/**
 * Vue DevTools 只在需要时注入。
 *
 * 它会给页面加一个悬浮小胶囊（左下角，V + 准星），而这个工具页是全屏铺满的，
 * 平时碍事；插件本身又没有"隐藏浮窗"的开关，所以这里用环境变量门控：
 *
 *   npm run dev                  不带浮窗（默认）
 *   XPA_DEVTOOLS=1 npm run dev   带浮窗（要调试组件 / 看 pinia 时）
 * （PowerShell：$env:XPA_DEVTOOLS=1; npm run dev）
 */
const devToolsEnabled = process.env.XPA_DEVTOOLS === '1'

export default defineConfig({
  plugins: [vue(), devToolsEnabled && vueDevTools()],
  resolve: {
    alias: {
      // 顺序要紧：Vite 按声明顺序做前缀匹配，`@shared` 必须排在 `@` 前面，
      // 否则 `@shared/...` 会先被 `@` 吃掉变成 `src/shared/...`。
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})