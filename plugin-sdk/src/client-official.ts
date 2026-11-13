// plugin-sdk/src/client-official.ts —— 官方插件 UI 的宿主共享能力（运行时）
//
// 为什么用「re-export 宿主模块」而不是把组件复制进插件：
// useToast / ConfirmDialog / agreementGate / wizardGate / contentPrefill 都是**模块级单例**
// 或共享组件。复制一份会让「设置页与弹窗使用两份 ref」的旧 bug 重现（见 TEST 记录）。
// 这里只做转发，模块身份不变；第三方 UI v1 不开放，因此此入口标 official。

export { useToast } from '../../src/composables/useToast'
export type { ToastState, ToastType } from '../../src/composables/useToast'

// ConfirmDialog 是 .vue 单文件组件：不能从 .ts SDK 入口 re-export，
// 否则纯 Node 的 UI 验收（esbuild 无 .vue loader）会把 SDK 链打断。
// 需要确认弹窗的页面继续直接 import `@/views/components/ConfirmDialog.vue`。

export {
  agreementVisible,
  agreementBlocking,
  consentGranted,
  consentAt,
  openAgreementBlocking,
  openAgreementReview,
  closeAgreement,
  syncConsent
} from '../../src/composables/useAgreementGate'

export { wizardVisible, openWizard, closeWizard } from '../../src/composables/useWizardGate'

export {
  setContentPrefill,
  consumeContentPrefill,
  peekContentPrefill,
  useContentPrefill
} from '../../src/composables/useContentPrefill'
export type { HotTopicPayload } from '../../src/composables/useContentPrefill'

export * from '../../src/constants/photographyPresets'
