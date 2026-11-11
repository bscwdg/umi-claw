<template>
  <transition name="fade">
    <div v-if="visible" class="modal-overlay" @click.self="onCancel">
      <div class="modal-card modal-sm">
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

<!-- 样式全部吃全局：.modal-overlay/.modal-card.modal-sm/.modal-header/-body/-footer/-message、
     .btn-danger/.btn-primary、fade 过渡，本组件无 scoped 样式 -->
