<template>
  <transition name="fade">
    <div v-if="visible" class="modal-overlay" @click.self="onCancel">
      <div class="modal-card">
        <div class="modal-header">
          <span class="modal-icon">{{ icon }}</span>
          <h4>{{ title }}</h4>
        </div>
        <div class="modal-body">
          <slot>
            <p class="modal-message">{{ message }}</p>
          </slot>
        </div>
        <div class="modal-footer">
          <button class="btn btn-sm" @click="onCancel">{{ cancelText }}</button>
          <button
            class="btn btn-sm"
            :class="danger ? 'btn-danger' : 'btn-primary'"
            @click="onConfirm"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    visible: boolean;
    title?: string;
    message?: string;
    icon?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }>(),
  {
    title: "请确认",
    message: "",
    icon: "❓",
    confirmText: "确定",
    cancelText: "取消",
    danger: false,
  }
);

const emit = defineEmits<{
  (e: "update:visible", value: boolean): void;
  (e: "confirm"): void;
  (e: "cancel"): void;
}>();

function onConfirm() {
  emit("update:visible", false);
  emit("confirm");
}

function onCancel() {
  emit("update:visible", false);
  emit("cancel");
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 22, 26, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2100;
}
.modal-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  width: 400px;
  max-width: 90vw;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.modal-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
}
.modal-header h4 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.modal-icon {
  font-size: 18px;
}
.modal-body {
  padding: 18px;
  font-size: 14px;
}
.modal-message {
  margin: 0;
  line-height: 1.6;
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}
.btn-danger {
  background: var(--red);
  color: #fff;
  border-color: var(--red);
}
.btn-danger:hover {
  filter: brightness(1.1);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
