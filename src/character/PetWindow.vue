<template>
  <div class="pet-root" :class="{ clickThrough }">
    <div class="pet-drag drag-region">
      <FishState :state="visualState" class="fish-wrap" />
      <transition name="bubble">
        <div v-if="bubble" class="bubble no-drag" @click="dismissBubble">{{ bubble }}</div>
      </transition>
      <div class="pet-actions no-drag">
        <button class="mini" title="摸摸头" @click.stop="onPat">摸</button>
        <button class="mini" title="收起" @click.stop="onHide">收</button>
      </div>
      <div v-if="clickThrough" class="through-hint">穿透中 · Ctrl+Alt+F 恢复</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import FishState from './art/FishState.vue'

type FishVisualState = 'idle' | 'happy' | 'sleepy' | 'sulk' | 'eat' | 'caught'

const state = ref({ mood: '', familiarity: 0, intimacy: 0 })
const emotionState = ref<FishVisualState | ''>('')
const size = ref<'small' | 'medium' | 'large'>('medium')
const clickThrough = ref(false)
const bubble = ref('')
let bubbleTimer: ReturnType<typeof setTimeout> | null = null
let emotionTimer: ReturnType<typeof setTimeout> | null = null
let offEvent: (() => void) | null = null
let offEmotion: (() => void) | null = null

const visualState = computed<FishVisualState>(() => {
  if (emotionState.value) return emotionState.value
  const mood = state.value.mood || ''
  if (/饭|吃|饱|投喂/.test(mood)) return 'eat'
  if (/头|开心|喜欢|得意/.test(mood)) return 'happy'
  if (/困|睡|疲惫/.test(mood)) return 'sleepy'
  if (/难|委屈|生气|拒绝/.test(mood)) return 'sulk'
  if (/惊|抓|搞怪/.test(mood)) return 'caught'
  return 'idle'
})

const QUIPS = {
  pat: ['别摸头…会长不高的。', '（甩了甩尾巴）', '哼，勉强让你摸一下。', '本鱼的头只能摸三下。'],
  feed: ['……再来一碗。', '白饭！本鱼的白饭！', '这顿算你懂事。'],
  idle: ['本鱼在摸鱼。', '有事说事，没事陪我发呆。', '（探出头）']
}

onMounted(async () => {
  offEvent = window.api.character.onEvent(async () => {
    await refresh()
  })
  offEmotion = window.api.character.onEmotion((payload) => {
    emotionState.value = (payload.visualState as FishVisualState) || ''
    if (emotionTimer) clearTimeout(emotionTimer)
    emotionTimer = setTimeout(() => {
      emotionState.value = ''
      emotionTimer = null
    }, 8000)
  })
  await refresh()
})

onBeforeUnmount(() => {
  offEvent?.()
  offEvent = null
  offEmotion?.()
  offEmotion = null
  if (bubbleTimer) clearTimeout(bubbleTimer)
  if (emotionTimer) clearTimeout(emotionTimer)
})

async function refresh(): Promise<void> {
  try {
    const settings = await window.api.character.settings.get()
    size.value = settings.pet?.size ?? 'medium'
    clickThrough.value = Boolean(settings.pet?.clickThrough)
    state.value = await window.api.character.state()
  } catch {
    /* 窗口不因读取失败而消失 */
  }
}

async function onPat(): Promise<void> {
  try {
    state.value = await window.api.character.interact({ kind: 'pat' })
    showBubble(pick(QUIPS.pat))
  } catch {
    showBubble(pick(QUIPS.idle))
  }
}

async function onHide(): Promise<void> {
  try {
    // 与右键菜单「收起」一致：持久化可见性，避免任意设置变更后弹回来
    await window.api.character.settings.set({ pet: { visible: false } } as never)
  } catch {
    /* 忽略：窗口可能已销毁 */
  }
  try {
    await window.api.character.pet.hide()
  } catch {
    /* 忽略 */
  }
}

function dismissBubble(): void {
  bubble.value = ''
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = null
}

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)]
}

function showBubble(text: string): void {
  bubble.value = text
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    bubble.value = ''
    bubbleTimer = null
  }, 6000)
}
</script>

<style scoped>
.pet-root {
  width: 100vw;
  height: 100vh;
  background: transparent;
  overflow: hidden;
  user-select: none;
}
.pet-drag {
  width: 100%;
  height: 100%;
  position: relative;
}
.fish-wrap {
  width: 100%;
  height: 100%;
}
.bubble {
  position: absolute;
  left: 8%;
  right: 8%;
  top: 4%;
  padding: 8px 12px;
  border-radius: 12px;
  background: rgba(20, 26, 38, 0.94);
  border: 1px solid #3b6fd4;
  color: #e8ecf4;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  word-break: break-word;
}
.through-hint {
  position: absolute;
  left: 50%;
  bottom: 6px;
  transform: translateX(-50%);
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(13, 18, 28, 0.8);
  color: #ffcf6b;
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
}
.pet-actions {
  position: absolute;
  right: 4px;
  bottom: 4px;
  display: flex;
  gap: 4px;
  opacity: 0.35;
  transition: opacity 0.15s ease;
}
.pet-root:hover .pet-actions {
  opacity: 1;
}
.mini {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid #3b6fd4;
  background: rgba(20, 26, 38, 0.9);
  color: #cfe0ff;
  font-size: 11px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
}
.mini:hover {
  background: #3b6fd4;
  color: #fff;
}
.bubble-enter-active,
.bubble-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.bubble-enter-from,
.bubble-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
