import { ref } from 'vue'

/**
 * Project 切换器的开关状态（Commit 03）
 *
 * 切换器本体挂在侧边栏（`src/views/components/ProjectSwitcher.vue`），但工作台的
 * 「当前商家」卡片也需要能唤起它 —— 这里用模块级单例状态把两边接起来，避免再往
 * marketing store 的契约里塞纯 UI 字段。
 */
const open = ref(false)

export function useProjectSwitcher() {
  return {
    open,
    toggle: () => {
      open.value = !open.value
    },
    show: () => {
      open.value = true
    },
    close: () => {
      open.value = false
    }
  }
}
