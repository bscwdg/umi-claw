<template>
  <transition name="fade">
    <div v-if="visible" class="agreement-overlay" @click.self="onOverlayClick">
      <div class="agreement-card card">
        <div class="agreement-head">
          <h2>{{ reviewMode ? '用户协议' : '开始前，先说清楚资料怎么用' }}</h2>
          <button v-if="!blocking" class="head-close" title="关闭" @click="close">✕</button>
        </div>

        <div class="notice">
          <p>
            资料默认仅保存在本地；当你主动执行需要 AI 处理的操作时，被选中的上下文内容
            可能随请求发送至你所选的模型服务商。
          </p>
          <ul class="notice-list">
            <li>不点 AI 动作，就不会有任何内容外发</li>
            <li>外发范围只有你本次操作选中的上下文，不是整库</li>
            <li>模型服务商在「模型配置」里选，随时可改</li>
          </ul>
        </div>

        <!-- 反显：之前同意过就展示当时的记录 -->
        <p v-if="reviewMode && agreedAtLabel" class="agreed-note">
          ✅ 你已于 <strong>{{ agreedAtLabel }}</strong> 同意本协议。
        </p>

        <label class="agree">
          <input type="checkbox" :checked="checked" @change="onToggle(($event.target as HTMLInputElement).checked)" />
          <span>我已阅读并同意上述说明</span>
        </label>

        <p v-if="error" class="agree-error">{{ error }}</p>

        <div class="actions">
          <button
            v-if="!blocking"
            class="btn btn-sm"
            @click="close"
          >关闭</button>
          <button
            class="btn btn-primary"
            :disabled="!checked || saving"
            @click="submit"
          >{{ saving ? '保存中…' : reviewMode ? '保存' : '同意并继续' }}</button>
        </div>

        <p v-if="blocking" class="blocked-note">
          同意后才能使用本应用。
        </p>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    visible: boolean
    /** 阻断模式：不可关闭，必须同意 */
    blocking?: boolean
    /** 已同意过（用于反显打勾） */
    agreed?: boolean
    /** 已同意时间（毫秒） */
    agreedAt?: number | null
  }>(),
  { blocking: false, agreed: false, agreedAt: null }
)

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'agreed'): void
}>()

const checked = ref(false)
const saving = ref(false)
const error = ref('')

/** 复核模式：从设置页打开（可关闭、有历史记录可反显） */
const reviewMode = computed(() => !props.blocking)

const agreedAtLabel = computed(() => {
  const t = props.agreedAt
  if (!t) return ''
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

// 打开时同步「反显」：已同意过就默认打勾
watch(
  () => [props.visible, props.agreed] as const,
  ([vis, agreed]) => {
    if (vis) {
      checked.value = agreed
      error.value = ''
    }
  },
  { immediate: true }
)

function onToggle(v: boolean): void {
  checked.value = v
  error.value = ''
}

function onOverlayClick(): void {
  // 阻断模式点遮罩不关；复核模式允许关闭
  if (!props.blocking) close()
}

function close(): void {
  if (props.blocking) return
  emit('update:visible', false)
}

async function submit(): Promise<void> {
  if (!checked.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    emit('agreed')
  } catch (e: any) {
    error.value = e?.message ?? '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
/* 遮罩从标题栏下方开始：保证窗口最小化/关闭按钮始终可用（用户必须能退出） */
.agreement-overlay {
  position: fixed;
  top: var(--titlebar-h, 0);
  left: 0;
  right: 0;
  bottom: 0;
  /* 层级：低于关闭提示弹窗 ConfirmDialog(2100)，否则用户无法退出应用 */
  z-index: 1950;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(2px);
}
.agreement-card {
  width: min(560px, 92vw);
  max-height: 86vh;
  overflow-y: auto;
  padding: 22px 24px;
  /* 居中且内容超高时不裁切顶部 */
  margin: auto;
}
.agreement-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.agreement-head h2 {
  margin: 0 0 14px;
  font-size: 17px;
}
.head-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 15px;
  cursor: pointer;
  padding: 2px 6px;
}
.notice {
  background: var(--bg-elevated, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.notice p {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.7;
}
.notice-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-muted);
}
.agreed-note {
  font-size: 13px;
  color: var(--green);
  margin: 0 0 10px;
}
.agree {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 14px;
  cursor: pointer;
}
.agree-error {
  color: var(--red);
  font-size: 13px;
  margin: 0 0 10px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.blocked-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  text-align: right;
}
</style>
