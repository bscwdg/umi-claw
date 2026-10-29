// src/composables/useAgreementGate.ts —— 用户协议弹窗的**共享状态**（模块级单例）
//
// 为什么需要它（北 2026-09-24）：
//   1. 弹窗只有**一个实例**（渲染在 App.vue），但触发点有两处 —— App 首启自检、
//      设置页「用户协议」入口。两处必须看到同一份状态，否则设置页勾选框与弹窗脱钩
//      （此前勾选框是写死的 `disabled`，纯装饰，北指出「这个要和那个弹窗关联」）。
//   2. 同意状态也要共享：设置页勾选框、弹窗反显、启动闸门读的是同一个值。
//
// 不用 pinia：组件级验收（test/_ui.mjs）挂单页时没有 pinia 实例，
// 引 store 会让页面挂不起来（v0.12 已踩过一次）。

import { ref } from 'vue'

/** 弹窗是否可见（App.vue 渲染唯一实例） */
export const agreementVisible = ref(false)

/** 是否阻断模式（首启：无 ✕、点遮罩不关，必须同意；设置页打开时为复核模式） */
export const agreementBlocking = ref(false)

/** 已同意（UI 单一真相源；落库仍以 `wizard.status()` 为准，这里只做展示同步） */
export const consentGranted = ref(false)

/** 同意时间（毫秒；未同意为 null） */
export const consentAt = ref<number | null>(null)

/** 首启阻断式打开：必须同意才能继续用应用 */
export function openAgreementBlocking(): void {
  agreementBlocking.value = true
  agreementVisible.value = true
}

/** 复核式打开（设置页入口）：可关闭，已同意则默认打勾并反显时间 */
export function openAgreementReview(): void {
  agreementBlocking.value = false
  agreementVisible.value = true
}

/** 关闭弹窗（阻断模式下 UserAgreementModal 自身会拒绝，这里是兜底出口） */
export function closeAgreement(): void {
  agreementVisible.value = false
}

/** 用 `wizard.status()` 的结果刷新共享状态（挂载时 / 撤销后调用） */
export function syncConsent(consent: boolean, at: number | null): void {
  consentGranted.value = consent
  consentAt.value = at
}
