<template>
  <div class="terminal-container-page">
    <div class="page-header">
      <h2>OpenClaw 控制台终端</h2>
      <p class="page-sub">
        原生的系统黑屏调试环境，可在这里完成微信扫码、系统体检和高级管理
      </p>
    </div>

    <div class="quick-bar">
      <button
        v-for="cmd in QUICK_CMDS"
        :key="cmd.label"
        class="q-btn"
        :disabled="isRunning || isInteractive"
        @click="runCmd(cmd.args)"
      >
        {{ cmd.label }}
      </button>
      <button
        class="q-btn q-btn-weixin"
        :disabled="isRunning || isInteractive"
        @click="wechatLogin"
      >
        💚 微信登录 (扫码)
      </button>
      <button
        class="q-btn q-btn-stop"
        :disabled="!isInteractive"
        @click="stopInteractive"
      >
        🛑 停止交互
      </button>
    </div>

    <div ref="termEl" class="xterm-box" />

    <div class="input-line">
      <span class="prefix">openclaw</span>
      <input
        ref="inputEl"
        v-model="input"
        type="text"
        placeholder="在这里输入进阶子指令（例如: status）按回车发送..."
        :disabled="isRunning || isInteractive"
        @keydown.enter="handleEnter"
      />
      <button
        class="send-btn"
        :disabled="isRunning || isInteractive || !input.trim()"
        @click="handleEnter"
      >
        {{ isRunning ? "正在响应..." : "发射 🚀" }}
      </button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const QUICK_CMDS = [
  { label: "状态 📊", args: ["status"] },
  { label: "版本 ℹ️", args: ["--version"] },
  { label: "健康检查 🩺", args: ["health"] },
  { label: "修复 🩺", args: ["doctor", "--yes"] },
  { label: "查看日志 📝", args: ["logs", "--lines", "30"] },
  { label: "已启技能 🧩", args: ["skills", "list"] },
  { label: "当前渠道 🔌", args: ["channels", "list"] },
  { label: "Gateway网关状态 🔋", args: ["gateway", "status"] },
  { label: "停止Gateway网关服务❄", args: ["gateway", "stop"] },
  { label: "帮助 ❓", args: ["--help"] },
];

const termEl = ref<HTMLElement | null>(null);
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;

const input = ref("");
const isRunning = ref(false);
const isInteractive = ref(false);
const sessionId = ref<string | null>(null);
const cmdHistory = ref<string[]>([]);
const historyIdx = ref(-1);
const inputEl = ref<HTMLInputElement | null>(null);

function initTerm() {
  if (!termEl.value || term) return;
  term = new Terminal({
    theme: {
      background: "#0a0d14",
      foreground: "#e2e8f0",
      cursor: "#60a5fa",
      selectionBackground: "#3b82f640",
      black: "#1e293b",
      red: "#f87171",
      green: "#10b981",
      yellow: "#f59e0b",
      blue: "#60a5fa",
      magenta: "#a78bfa",
      cyan: "#22d3ee",
      white: "#e2e8f0",
    },
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.5,
    cursorBlink: true,
    convertEol: true, // 核心修复：自动处理换行不回车的问题
    scrollback: 5000,
    enableClipboard: true, // 启用复制粘贴
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(termEl.value);
  // 自定义键盘快捷键：复制与粘贴
  term.attachCustomKeyEventHandler((event) => {
    const ctrl = event.ctrlKey || event.metaKey; // 支持 Windows 和 Mac

    // ---------- 复制：Ctrl+Shift+C / Cmd+Shift+C ----------
    if (ctrl && event.shiftKey && (event.key === "c" || event.key === "C")) {
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard?.writeText(selection).catch((err) => {
          console.warn("复制失败:", err);
        });
      }
      return false; // 阻止 xterm 默认行为
    }

    // ---------- 粘贴：Ctrl+Shift+V / Cmd+Shift+V ----------
    if (ctrl && event.shiftKey && (event.key === "v" || event.key === "V")) {
      navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) {
            term.paste(text);
          }
        })
        .catch((err) => {
          console.warn("粘贴失败:", err);
        });
      return false;
    }

    // 其他按键继续由 xterm 正常处理（包括 Ctrl+C 中断信号）
    return true;
  });

  nextTick(() => fitAddon?.fit());

  // 监听键盘按键，如果处于交互模式下，直接转输送给后台 OpenClaw 的 stdin
  term.onData((data) => {
    if (isInteractive.value && sessionId.value) {
      window.api.terminal.inputPty(sessionId.value, data);
    }
  });

  resizeObserver = new ResizeObserver(() => fitAddon?.fit());
  resizeObserver.observe(termEl.value);

  term.writeln(
    "\x1b[90m⚙️ OpenClaw 独立终端就绪 — 点击快捷按钮或输入自定义子命令\x1b[0m"
  );
}

// ── 执行一键查询快照 ──
async function runCmd(args: string[]) {
  if (isRunning.value || isInteractive.value) return;
  isRunning.value = true;
  term?.writeln(`\r\n\x1b[94m$ openclaw ${args.join(" ")}\x1b[0m`);

  try {
    const result = await window.api.terminal.runCommand(args);
    if (result.stdout) term?.write(result.stdout);
    if (result.stderr) term?.write(result.stderr);
  } catch (e) {
    term?.writeln(`\x1b[91m执行异常: ${e}\x1b[0m`);
  } finally {
    isRunning.value = false;
    nextTick(() => inputEl.value?.focus());
  }
}

async function wechatLogin() {
  if (isRunning.value || isInteractive.value) return;
  await runCmd(['config', 'set', 'plugins.entries.openclaw-weixin.enabled', 'true']);
  await startInteractive(['channels', 'login', '--channel', 'openclaw-weixin']);
}
// ── 激活全双工交互（如微信扫码） ──
async function startInteractive(args: string[]) {
  if (isRunning.value || isInteractive.value) return;
  isRunning.value = true;
  isInteractive.value = true;

  term?.writeln(`\r\n\x1b[94m$ openclaw ${args.join(" ")}\x1b[0m`);
  term?.writeln(
    "\x1b[93m[进入交互模式] 正在拉起进程流，如需退出请点击'停止交互'...\x1b[0m\r\n"
  );
  term?.focus();

  try {
    const sid = await window.api.terminal.startPty(args);
    if (sid) {
      sessionId.value = sid;
    } else {
      term?.writeln("\x1b[91m进程管道对接失败\x1b[0m");
      isInteractive.value = false;
    }
  } catch (e) {
    term?.writeln(`\x1b[91m启动失败: ${e}\x1b[0m`);
    isInteractive.value = false;
  } finally {
    isRunning.value = false;
  }
}

function stopInteractive() {
  if (sessionId.value) {
    window.api.terminal.stopPty(sessionId.value);
  }
  sessionId.value = null;
  isInteractive.value = false;
  isRunning.value = false;
  term?.writeln("\r\n\x1b[90m[交互模式已被前端手动断开]\x1b[0m\r\n");
}

function handleEnter() {
  const cmd = input.value.trim();
  if (!cmd || isRunning.value || isInteractive.value) return;
  cmdHistory.value.unshift(cmd);
  input.value = "";
  const parts = cmd
    .replace(/^openclaw\s+/, "")
    .split(/\s+/)
    .filter(Boolean);
  // 如果输入的是 onboard / setup / login 或者是微信专有命令，走交互式 PTY
  const isInteractiveCmd = ["onboard", "setup", "login", "init", "doctor"].some(
    (c) => parts[0] === c
  );
  if (isInteractiveCmd) {
    startInteractive(parts);
  } else {
    runCmd(parts);
  }
}

onMounted(() => {
  initTerm();

  // 🔔 核心：在页面挂载时绑定来自 IPC 的流事件监听
  window.api.terminal.onPtyChunk((chunk: any) => {
    if (term && chunk.sessionId === sessionId.value) {
      term.write(chunk.data);
    }
  });

  window.api.terminal.onPtyExit((exited: any) => {
    if (exited.sessionId === sessionId.value) {
      term?.writeln(
        `\r\n\x1b[90m[后台进程已关闭，退出码: ${exited.exitCode}]\x1b[0m\r\n`
      );
      sessionId.value = null;
      isInteractive.value = false;
      isRunning.value = false;
    }
  });
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  if (sessionId.value) window.api.terminal.stopPty(sessionId.value);
  // 释放解绑，确保切走路由后彻底卸载，不留内存遗毒
  window.api.terminal.removeListeners();
  term?.dispose();
});
</script>



<style scoped>
:deep(.xterm-screen div) {
  user-select: auto !important;
  -webkit-user-select: auto !important;
  -ms-user-select: auto !important;
}
:deep(.xterm) {
  user-select: auto !important;
  -webkit-user-select: auto !important;
  -ms-user-select: auto !important;
}
.terminal-container-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 20px;
  box-sizing: border-box;
  background: var(--bg);
}
.page-header {
  margin-bottom: 15px;
}
.page-header h2 {
  font-size: 1.2rem;
  margin: 0 0 4px;
  color: var(--text);
}
.page-sub {
  font-size: 0.8rem;
  margin: 0;
  color: var(--text2);
}

.quick-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.q-btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg2);
  color: var(--text);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s;
}
.q-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--bg3);
}
.q-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.q-btn-weixin {
  border-color: #10b981;
  color: #10b981;
  font-weight: 600;
}
.q-btn-weixin:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.1);
}
.q-btn-stop {
  border-color: var(--danger);
  color: var(--danger);
}
.q-btn-stop:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.1);
}

.xterm-box {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 8px 8px 0 0;
  background: #0a0d14;
  padding: 10px;
  user-select: auto !important;
}
:deep(.xterm) {
  height: 100%;
}

.input-line {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #0a0d14;
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 8px 8px;
  padding: 12px 16px;
}
.prefix {
  font-family: monospace;
  color: #10b981;
  font-weight: bold;
  font-size: 0.9rem;
}
.input-line input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: #fff;
  font-family: monospace;
  font-size: 0.9rem;
}
.input-line input:disabled {
  opacity: 0.5;
}
.send-btn {
  background: var(--accent);
  color: white;
  border: none;
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 0.8rem;
  cursor: pointer;
}
.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>