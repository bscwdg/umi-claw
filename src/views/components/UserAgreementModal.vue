<template>
  <transition name="fade">
    <div v-if="visible" class="modal-overlay agreement-overlay" @click.self="onOverlayClick">
      <div class="modal-card modal-md agreement-card">
        <div class="agreement-head">
          <h2>{{ reviewMode ? '用户协议' : '开始前，先说清楚资料怎么用' }}</h2>
          <button v-if="!blocking" class="btn btn-icon btn-sm" title="关闭" @click="close">✕</button>
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
/* 遮罩骨架吃全局 .modal-overlay；本修饰类只补两个特例：
   ① 从标题栏下方开始，保证窗口最小化/关闭按钮始终可用（用户必须能退出）；
   ② 层级取 --z-banner(1900)，低于 ModelPicker(--z-modal 2000) 与 ConfirmDialog(--z-toast 2100) */
.agreement-overlay {
  top: var(--titlebar-h, 0);
  z-index: var(--z-banner);
}

/* 卡片骨架吃全局 .modal-card.modal-md（宽度 560px / max-width 92vw 与原值一致）；
   协议正文可能超高，保留卡片内部滚动并补内边距（全局 modal-card 默认 overflow:hidden、无 padding） */
.agreement-card {
  overflow-y: auto;
  padding: var(--space-6);
}
.agreement-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.agreement-head h2 {
  margin: 0 0 var(--space-4);
  font-size: var(--text-xl);
}
/* 关闭钮吃全局 .btn.btn-icon.btn-sm，不再自定义 */
.notice {
  background: var(--bg-base);
  border-radius: var(--radius-sm);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
}
.notice p {
  margin: 0 0 var(--space-2);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}
.notice-list {
  margin: 0;
  padding-left: var(--space-4);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  color: var(--text-muted);
}
.agreed-note {
  font-size: var(--text-sm);
  color: var(--success);
  margin: 0 0 var(--space-3);
}
.agree {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  margin-bottom: var(--space-4);
  cursor: pointer;
}
.agree-error {
  color: var(--danger);
  font-size: var(--text-sm);
  margin: 0 0 var(--space-3);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
.blocked-note {
  margin: var(--space-3) 0 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-align: right;
}
</style>
