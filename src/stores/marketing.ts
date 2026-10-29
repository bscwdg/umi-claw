// 兼容垫片（Phase 3）：营销 store 已随插件搬到 plugins/marketing/ui/store.ts。
//
// 宿主页 Dashboard 仍在读它（控制台展示营销摘要）。为了不把「store 跟插件走」拆成两份真相，
// 这里只做**单点再导出**，不复制任何实现。Phase 4 把 Dashboard 的营销摘要改成插件插槽后删除本文件。

export * from '../../plugins/marketing/ui/store'
