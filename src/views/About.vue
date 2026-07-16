<template>
  <div class="about-page">
    <div class="hero card">
      <div class="hero-icon">🦞</div>
      <h1>Umi Claw</h1>
      <p class="text-muted">OpenClaw 便携管理工具 · 基于 Electron + Vue3 + Vite</p>
      <div class="version-badges">
        <span class="badge badge-blue">v1.0.0</span>
        <span class="badge badge-green">Electron 30</span>
        <span class="badge badge-purple">Vue 3</span>
      </div>
    </div>

    <div class="info-grid">
      <div class="card info-card">
        <h3>🚀 核心特性</h3>
        <ul class="feature-list">
          <li>零配置启动，开箱即用</li>
          <li>图形化 OpenClaw 进程管理</li>
          <li>支持 10+ 国内外 AI 服务商</li>
          <li>实时日志监控</li>
          <li>系统托盘后台运行</li>
          <li>便携模式（U 盘）支持</li>
          <li>国内镜像加速下载</li>
        </ul>
      </div>

      <div class="card info-card">
        <h3>🛠 技术栈</h3>
        <div class="tech-list">
          <div v-for="t in techStack" :key="t.name" class="tech-row">
            <span class="tech-name">{{ t.name }}</span>
            <span class="text-muted text-sm">{{ t.desc }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card links-card">
      <h3 style="margin-bottom:14px">🔗 相关链接</h3>
      <div class="links-grid">
        <button class="link-btn" @click="open('https://github.com/openclaw/openclaw')">
          <span>📦</span> OpenClaw 项目
        </button>
        <button class="link-btn" @click="open('https://github.com/uxiaohan/vh-claw')">
          <span>🦞</span> VH-Claw 原项目
        </button>
        <button class="link-btn" @click="open('https://github.com/dongsheng123132/u-claw')">
          <span>💾</span> U-Claw 原项目
        </button>
        <button class="link-btn" @click="open('https://electronjs.org')">
          <span>⚡</span> Electron
        </button>
        <button class="link-btn" @click="open('https://vuejs.org')">
          <span>💚</span> Vue 3
        </button>
        <button class="link-btn" @click="open('https://vitejs.dev')">
          <span>⚡</span> Vite
        </button>
      </div>
    </div>

    <div class="card" style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px">
      MIT License · 基于 OpenClaw 开源项目重构 · Made with 🦞
    </div>
  </div>
</template>

<script setup lang="ts">
const techStack = [
  { name: 'Electron 30', desc: '跨平台桌面应用框架' },
  { name: 'Vue 3.4', desc: '渐进式前端框架' },
  { name: 'Vite 5', desc: '极速构建工具' },
  { name: 'TypeScript', desc: '类型安全的 JavaScript' },
  { name: 'Pinia', desc: '状态管理' },
  { name: 'Vue Router 4', desc: '前端路由' },
  { name: 'electron-vite', desc: 'Electron + Vite 集成' }
]

function open(url: string) {
  window.api.shell.openExternal(url)
}
</script>

<style scoped>
.about-page { display: flex; flex-direction: column; gap: 20px; width: 100%; }

.hero {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px; text-align: center; padding: 40px;
}
.hero-icon { font-size: 52px; }
.version-badges { display: flex; gap: 8px; margin-top: 4px; }
.badge-purple { background: rgba(188,140,255,0.15); color: var(--purple); }

.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.info-card h3 { margin-bottom: 14px; }

.feature-list {
  list-style: none;
  display: flex; flex-direction: column; gap: 8px;
}
.feature-list li {
  font-size: 13px; color: var(--text-secondary);
  padding-left: 16px; position: relative;
}
.feature-list li::before {
  content: '›'; position: absolute; left: 0;
  color: var(--accent); font-weight: 700;
}

.tech-list { display: flex; flex-direction: column; gap: 10px; }
.tech-row { display: flex; justify-content: space-between; align-items: center; }
.tech-name { font-size: 13px; font-weight: 500; }

.links-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
}
.link-btn {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 13px; cursor: pointer;
  transition: all 0.15s;
  text-align: left;
}
.link-btn:hover {
  border-color: var(--accent);
  color: var(--text-primary);
  background: var(--accent-muted);
}
</style>
