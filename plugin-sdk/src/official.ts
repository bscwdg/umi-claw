// plugin-sdk/src/official.ts —— 官方插件 internal：kernel 契约与 definePlugin
//
// 为什么拆成多个 official-* 子路径而不是一个 barrel：barrel 的 `export *` 会把
// knowledge（mammoth/exceljs）、hostUi（electron）一并链进每个 domain bundle，
// 纯 Node 验收/打包都会炸。按宿主模块拆开后，插件只拉自己用的那条链。

export * from '../../electron/main/kernel'
