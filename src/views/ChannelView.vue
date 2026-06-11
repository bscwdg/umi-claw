<template>
  <div class="channel-page">
    <div class="page-header">
      <div>
        <h1>渠道接入</h1>
        <p>管理 OpenClaw 聊天渠道</p>
      </div>

      <button class="refresh-btn" @click="loadChannels">刷新</button>
    </div>

    <div v-if="loading" class="loading">正在加载渠道...</div>

    <div v-else-if="channels.length === 0" class="empty">暂无可用渠道</div>

    <div v-else class="channel-grid">
      <div v-for="channel in channels" :key="channel.id" class="channel-card">
        <div class="card-header">
          <div class="channel-icon">{{ channel.icon }}</div>

          <div class="channel-info">
            <div class="channel-name">{{ channel.name }}</div>
            <div class="channel-desc">{{ channel.desc }}</div>
            <div
              class="status"
              :class="{
                enabled: channel.enabled,
                installed: channel.installed
              }"
            >
              {{
                channel.enabled
                  ? '已启用'
                  : channel.installed
                  ? '已安装'
                  : '未安装'
              }}
            </div>
          </div>
        </div>

        <div class="actions">
          <!-- 微信渠道特殊处理 -->
          <template v-if="channel.id === 'weixin'">
            <button
              v-if="!channel.installed"
              class="install-btn"
              @click="installChannel(channel)"
            >
              安装
            </button>

            <template v-else>
              <button class="login-btn" @click="loginChannel(channel)">
                扫码登录
              </button>
              <button class="remove-btn" @click="uninstallChannel(channel)">
                卸载
              </button>
            </template>
          </template>

          <!-- 普通渠道 -->
          <template v-else>
            <button class="config-btn" @click="openConfig(channel)">
              配置
            </button>

            <button
              v-if="!channel.enabled"
              class="enable-btn"
              @click="enableChannel(channel)"
            >
              启用
            </button>

            <button
              v-else
              class="disable-btn"
              @click="disableChannel(channel)"
            >
              禁用
            </button>
          </template>
        </div>
      </div>
    </div>

    <ChannelConfigDialog
      v-if="selectedChannel && selectedChannel.id !== 'weixin'"
      :visible="dialogVisible"
      :channel="selectedChannel"
      @close="dialogVisible = false"
      @save="saveConfig"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import ChannelConfigDialog from './components/ChannelConfigDialog.vue'

interface Channel {
  id: string
  name: string
  icon: string
  desc?: string
  installed?: boolean
  configured?: boolean
  enabled?: boolean
}

const channels = ref<Channel[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const selectedChannel = ref<Channel | null>(null)

/**
 * 加载渠道列表
 */
async function loadChannels() {
  loading.value = true
  try {
    channels.value = await window.api.channels.available()
    console.log('渠道列表', channels.value)
  } catch (err) {
    console.error('加载渠道失败', err)
    alert('加载渠道失败')
  }
  loading.value = false
}

/**
 * 普通渠道配置
 */
function openConfig(channel: Channel) {
  selectedChannel.value = channel
  dialogVisible.value = true
}

async function saveConfig(config: any) {
  if (!selectedChannel.value) return

  try {
    await window.api.channels.saveConfig(selectedChannel.value.id, config)
    alert('保存成功')
    dialogVisible.value = false
    await loadChannels()
  } catch (err) {
    console.error(err)
    alert('保存失败')
  }
}

/**
 * 启用/禁用普通渠道
 */
async function enableChannel(channel: Channel) {
  try {
    await window.api.channels.enable(channel.id)
    channel.enabled = true
  } catch (err) {
    console.error(err)
    alert('启用失败')
  }
}

async function disableChannel(channel: Channel) {
  try {
    await window.api.channels.disable(channel.id)
    channel.enabled = false
  } catch (err) {
    console.error(err)
    alert('禁用失败')
  }
}

/**
 * 微信渠道安装/登录/卸载
 */
async function installChannel(channel: Channel) {
  try {
    alert('开始安装微信渠道，请稍候...')
    await window.api.channels.install(channel.id)
    alert('安装成功')
    await loadChannels()
  } catch (err) {
    console.error(err)
    alert('安装失败')
  }
}

async function loginChannel(channel: Channel) {
  try {
    alert('二维码将在终端显示，请扫码登录...')
    await window.api.channels.login(channel.id)
  } catch (err) {
    console.error(err)
    alert('登录失败')
  }
}

async function uninstallChannel(channel: Channel) {
  if (!confirm('确认卸载微信渠道？')) return

  try {
    await window.api.channels.uninstall(channel.id)
    alert('卸载成功')
    await loadChannels()
  } catch (err) {
    console.error(err)
    alert('卸载失败')
  }
}

onMounted(() => {
  loadChannels()
})
</script>

<style scoped>
.channel-page { padding: 24px; }

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.page-header h1 { margin: 0; }
.page-header p { color: var(--text-muted); }

.refresh-btn {
  border: none;
  background: var(--accent);
  color: white;
  padding: 10px 18px;
  border-radius: 10px;
  cursor: pointer;
}

.loading, .empty {
  padding: 60px;
  text-align: center;
}

.channel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

.channel-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-muted);
  border-radius: 16px;
  padding: 20px;
}

.card-header {
  display: flex;
  margin-bottom: 20px;
}

.channel-icon {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  margin-right: 16px;
}

.channel-name { font-size: 18px; font-weight: 600; }
.channel-desc { color: var(--text-muted); font-size: 13px; margin-top: 4px; }

.status { margin-top: 8px; color: #ef4444; }
.status.installed { color: #f59e0b; }
.status.enabled { color: #22c55e; }

.actions { display: flex; gap: 10px; }
.actions button {
  flex: 1;
  border: none;
  border-radius: 10px;
  padding: 10px;
  cursor: pointer;
}

.install-btn { background: #22c55e; color: white; }
.login-btn { background: #3b82f6; color: white; }
.remove-btn { background: #ef4444; color: white; }
.config-btn { background: var(--bg-elevated); }
.enable-btn { background: #22c55e; color: white; }
.disable-btn { background: #ef4444; color: white; }
</style>