// src/composables/useWizardGate.ts —— 冷启动向导的**开关闸门**（模块级单例）
//
// 为什么需要它：向导已从「路由页面」改为「弹窗」（北 2026-09-24），
// 而弹窗渲染在 App.vue，触发点却有三处（App 首启自检 / Setup 完成后接续 /
// 设置页「开始向导」按钮）。
// 用一个模块级 ref 做共享开关，避免上 pinia——组件级验收（test/_ui.mjs）
// 挂单页时没有 pinia 实例，引 store 会让页面挂不起来。
//
// 只存「开/关」这一件事；向导自身状态一律以 `wizard.status()` 为准（不在此缓存）。

import { ref } from 'vue'

/** 向导弹窗是否可见（模块级单例，跨组件共享） */
export const wizardVisible = ref(false)

/** 打开向导弹窗（幂等） */
export function openWizard(): void {
  wizardVisible.value = true
}

/** 关闭向导弹窗（幂等） */
export function closeWizard(): void {
  wizardVisible.value = false
}
