// plugins/hello/renderer.ts —— Phase 0 契约演示插件（渲染端）
//
// 验证点：一条路由 + 一个导航组 + 一个插槽；页面能通过 window.api.plugins.invoke
// 调到自己的 main 侧能力（plugin:hello:ping）。停用后三者一起消失。

import { defineComponent, h, ref } from 'vue'
import type { PluginUiModule } from '../../src/renderer/pluginUi'

const HelloPage = defineComponent({
  name: 'PluginHelloPage',
  setup() {
    const result = ref('-')
    const busy = ref(false)

    const ping = async (): Promise<void> => {
      busy.value = true
      try {
        const res = await window.api.plugins.invoke<{ pong: boolean; echo: unknown }>('hello', 'ping', {
          from: 'renderer'
        })
        result.value = JSON.stringify(res)
      } catch (e) {
        result.value = `调用失败：${e instanceof Error ? e.message : String(e)}`
      } finally {
        busy.value = false
      }
    }

    return () =>
      h('section', { class: 'page' }, [
        h('h1', { style: 'margin-bottom:12px' }, '👋 Hello 插件'),
        h(
          'p',
          { class: 'text-muted' },
          '这页由 plugins/hello/renderer.ts 注册；停用 hello 后路由与导航会一起消失。'
        ),
        h(
          'div',
          { style: 'margin:16px 0; display:flex; gap:8px; align-items:center' },
          [
            h(
              'button',
              { class: 'btn btn-primary', disabled: busy.value, onClick: ping },
              busy.value ? '调用中…' : '调用 plugin:hello:ping'
            ),
            h('code', null, result.value)
          ]
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
