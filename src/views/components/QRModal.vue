<template>
  <div v-if="props.visible" class="modal-overlay">
    <div class="modal-card">
      <div class="modal-header">
        <div class="title-group">
          <span class="wechat-icon">💬</span>
          <h4>微信安全授权登录</h4>
        </div>
        <span class="close-btn" @click="emit('update:visible', false)">✕</span>
      </div>

      <div class="modal-body">
        <div class="status-bar" :class="{ 'status-success': isConnected }">
          <span class="status-dot"></span>
          <span class="status-text">
            {{ isConnected ? '✅ 微信已成功连接，系统常驻运行中' : '🔄 等待微信网关抛出登录二维码...' }}
          </span>
        </div>
        
        <div id="wechat-terminal" class="terminal-box"></div>
        
        <p class="guide-tip">提示：请使用手机微信扫描上方黑框内的二维码完成授权登录。</p>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" @click="emit('update:visible', false)">后台保持运行</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onUnmounted } from 'vue'
import { Terminal } from "@xterm/xterm";
import '@xterm/xterm/css/xterm.css'


// 接收外部控制的 visible 属性
const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:visible'])

const isConnected = ref(false)
let term = null
let destroyLogListener = null

// 监听弹窗显示状态：当外部将其设为 true 时，再挂载终端和绑定监听
watch(() => props.visible, async (newVal) => {
  if (newVal) {
    isConnected.value = false
    await nextTick()
    initTerminal()
  } else {
    // 弹窗关闭时随手断开监听，节约前端内存
    if (destroyLogListener) {
      destroyLogListener()
      destroyLogListener = null
    }
  }
})

// 初始化 xterm 渲染器
const initTerminal = () => {
  if (!term) {
    term = new Terminal({
      disableStdin: true,    // 纯展示模式
      cursorBlink: false,    // 关闭光标闪烁
      rows: 25,              // 设定固定行数，确保容纳完整的微信二维码
      cols: 65,              // 设定固定列数，防止二维码因太宽发生断行错位
      theme: {
        background: '#121417',
        foreground: '#ffffff'
      }
    })

    term.open(document.getElementById('wechat-terminal'))

    // 🌟 订阅来自 Electron 后端的普通日志流
    if (window.api && window.api.onLogStream) {
      destroyLogListener = window.api.onLogStream((line) => {
        // 过滤出二维码符号或包含终端方块 ANSI 编码的行
        if (line.includes('QR') || line.includes('扫码') || /[\u2580-\u259F]/.test(line)) {
          term.writeln(line)
        }

        // 捕捉登录成功的特征码
        if (line.includes('Login successfully') || line.includes('微信连接成功') || line.includes('连接成功')) {
          isConnected.value = true
        }
      })
    }
  } else {
    term.clear()
  }
}

// 组件销毁时彻底释放终端内存
onUnmounted(() => {
  if (destroyLogListener) destroyLogListener()
  if (term) {
    term.dispose()
    term = null
  }
})
</script>

<style scoped>
/* 磨砂玻璃质感的全屏半透明遮罩 */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(20, 22, 26, 0.5);
  backdrop-filter: blur(5px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 2000;
}

/* 弹窗卡片本体 */
.modal-card {
  background: #ffffff;
  border-radius: 12px;
  width: 500px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.15);
  overflow: hidden;
  border: 1px solid #eef0f2;
}

.modal-header {
  padding: 16px 20px;
  background: #f8f9fa;
  border-bottom: 1px solid #edeef0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-group h4 {
  margin: 0;
  font-size: 15px;
  color: #1f2329;
  font-weight: 600;
}

.close-btn {
  cursor: pointer;
  color: #8f959e;
  font-size: 16px;
}
.close-btn:hover {
  color: #1f2329;
}

.modal-body {
  padding: 20px;
}

/* 动态状态条 */
.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #f1f2f4;
  border-radius: 6px;
  margin-bottom: 16px;
}
.status-dot {
  width: 6px;
  height: 6px;
  background: #ff9900;
  border-radius: 50%;
}
.status-text {
  font-size: 13px;
  color: #5f6671;
}

/* 微信成功连接后的状态样式 */
.status-success {
  background: #edfbf3;
}
.status-success .status-dot {
  background: #07c160;
}
.status-success .status-text {
  color: #07c160;
}

/* 🌟 精致暗色终端显示容器 */
.terminal-box {
  background: #121417;
  padding: 16px;
  border-radius: 8px;
  min-height: 330px;
  display: flex;
  justify-content: center;
}

.guide-tip {
  font-size: 12px;
  color: #8f959e;
  margin-top: 12px;
  text-align: center;
  margin-bottom: 0;
}

.modal-footer {
  padding: 12px 20px;
  background: #f8f9fa;
  border-top: 1px solid #edeef0;
  text-align: right;
}

.btn-secondary {
  background: #f1f2f4;
  color: #1f2329;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  font-weight: 500;
}
.btn-secondary:hover {
  background: #e4e6eb;
}
</style>