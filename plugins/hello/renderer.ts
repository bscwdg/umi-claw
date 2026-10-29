// plugins/hello/renderer.ts —— Phase 0 契约演示插件（渲染端）
//
// 验证点：一条路由 + 一个导航组 + 一个插槽；停用后三者一起消失。
// 组件用 h() 内联，避免为了契约演示引入一个新 SFC。

import { defineComponent, h } from 'vue'
import type { PluginUiModule } from '../../src/renderer/pluginUi'

const HelloPage = defineComponent({
  name: 'PluginHelloPage',
  setup() {
    return () =>
      h('section', { class: 'page' }, [
        h('h1', { style: 'margin-bottom:12px' }, '👋 Hello 插件'),
        h(
          'p',
          { class: 'text-muted' },
          '这页由 plugins/hello/renderer.ts 注册。到设置里停用 hello，路由与导航会一起消失。'
        )
      ])
  }
})

const mod: PluginUiModule = {
  routes: [{ path: '/hello', name: 'plugin-hello', component: HelloPage }],
  nav: {
    id: 'plugins',
    label: '插件',
    order: 90,
    items: [{ to: '/hello', icon: '👋', label: 'Hello' }]
  },
  slot: {},
  setup() {
    return () => undefined
  }
}

export default mod
