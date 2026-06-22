<template>
  <div v-if="visible" class="term-dialog-overlay">
    <div class="term-dialog-box">
      <div class="term-dialog-header">
        <div class="title-area">
          <span class="terminal-icon">💻</span>
          <h3>{{ title }}</h3>
        </div>
        <button class="close-btn" :disabled="isRunning" @click="close">
          {{ isRunning ? '执行中...' : '关闭' }}
        </button>
      </div>

      <div ref="termEl" class="dialog-xterm-box" />

      <div class="term-dialog-footer" :class="{ 'is-running': isRunning }">
        <div v-if="isRunning" class="status-tip animated-blink">
          ⏳ 正在与 OpenClaw 建立实时安全交互，请勿关闭窗口...
        </div>
        <div v-else class="status-tip success-tip">
          ✅ 进程执行完毕，可以安全关闭当前窗口。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  visible: boolean
  title: string
  args: string[] // 接收传递过来的子命令参数，如 ['channels', 'login', 'weixin']
}>()

const emit = defineEmits(['close', 'refresh'])

const termEl = ref<HTMLElement | null>(null)
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
const sessionId = ref<string | null>(null)
const isRunning = ref(false)

function initTerminal() {
  if (!termEl.value || term) return

  term = new Terminal({
    theme: {
      background: '#0a0d14',
      foreground: '#e2e8f0',
      cursor: '#60a5fa',
      black: '#1e293b',
      red: '#f87171',
      green: '#10b981',
      yellow: '#f59e0b',
      blue: '#60a5fa',
      white: '#e2e8f0',
    },
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.4,
    cursorBlink: true,
    convertEol: true, // 确保换行符正常解析
    scrollback: 1000,
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(termEl.value)

  // 铺满容器
  nextTick(() => fitAddon?.fit())

  // 处理终端输入（扫码后有时需要按回车或进行交互确认）
  term.onData((data) => {
    if (sessionId.value) {
      window.api.terminal.inputPty(sessionId.value, data)
    }
  })

  // 监听容器大小变化自动 fit
  resizeObserver = new ResizeObserver(() => fitAddon?.fit())
  resizeObserver.observe(termEl.value)
}

async function startInteractiveTask() {
  if (!term) return
  isRunning.value = true
  term.clear()
  term.writeln(`\x1b[94m$ openclaw ${props.args.join(' ')}\x1b[0m`)
  term.writeln(`\x1b[90m正在拉起底层安全管道...\x1b[0m\r\n`)

  try {
    // 调用我们在主进程优化过、支持指定 cwd 的 PTY 启动器
    // 传入 { cwd: '.' } 确保它在当前根目录执行
    const sid = await window.api.terminal.startPty(props.args, { cwd: '.' })
    if (sid) {
      sessionId.value = sid
      term.focus()
    } else {
      term.writeln('\x1b[91m❌ 进程管道对接失败，请检查主进程日志\x1b[0m')
      isRunning.value = false
    }
  } catch (e) {
    term.writeln(`\x1b[91m❌ 启动异常: ${e}\x1b[0m`)
    isRunning.value = false
  }
}

function close() {
  if (sessionId.value) {
    window.api.terminal.stopPty(sessionId.value)
  }
  emit('close')
  emit('refresh') // 顺便让外层刷新列表，捕获最新状态
}

onMounted(() => {
  initTerminal()

  // 接收来自 PTY 的实时输出流（包括微信生成的字符二维码和进度条）
  window.api.terminal.onPtyChunk((chunk: any) => {
    if (term && chunk.sessionId === sessionId.value) {
      term.write(chunk.data)
    }
  })

  // 监听子进程退出事件
  window.api.terminal.onPtyExit((exited: any) => {
    if (exited.sessionId === sessionId.value) {
      term?.writeln(`\r\n\x1b[90m[后台任务执行完毕，退出码: ${exited.exitCode}]\x1b[0m`)
      isRunning.value = false
      sessionId.value = null
    }
  })

  // 激活任务
  if (props.visible) {
    startInteractiveTask()
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  if (sessionId.value) {
    window.api.terminal.stopPty(sessionId.value)
  }
  term?.dispose()
})
</script>

<style scoped>
.term-dialog-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(4, 6, 10, 0.8);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.term-dialog-box {
  width: 700px;
  height: 480px;
  background: #0f1117;
  border: 1px solid var(--border-muted, #2d3748);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
}

.term-dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  background: #161922;
  border-bottom: 1px solid #232834;
}

.title-area {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-area h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #f1f5f9;
}

.close-btn {
  background: #313846;
  border: none;
  color: #e2e8f0;
  padding: 6px 16px;
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.close-btn:hover:not(:disabled) {
  background: #ef4444;
  color: white;
}

.close-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dialog-xterm-box {
  flex: 1;
  background: #0a0d14;
  padding: 16px;
  min-height: 0;
}

/* 兼容处理 xterm 内部样式确保高亮 */
:deep(.xterm-viewport) {
  background-color: #0a0d14 !important;
}

.term-dialog-footer {
  padding: 12px 20px;
  background: #161922;
  border-top: 1px solid #232834;
  font-size: 12px;
}

.status-tip {
  color: #94a3b8;
}

.animated-blink {
  color: #f59e0b;
  animation: blink 2s infinite ease-in-out;
}

.success-tip {
  color: #10b981;
  font-weight: bold;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
</style>