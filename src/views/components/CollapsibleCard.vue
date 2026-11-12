<template>
  <section class="card collapsible-card" :class="cardClass">
    <header class="collapsible-head">
      <h3>{{ title }}</h3>
      <button
        type="button"
        class="btn btn-ghost btn-sm collapsible-toggle"
        :aria-expanded="!collapsed"
        :aria-controls="bodyId"
        @click="collapsed = !collapsed"
      >
        <svg
          class="collapsible-chevron"
          :class="{ open: !collapsed }"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M4 6 8 10 12 6" />
        </svg>
        {{ collapsed ? '展开' : '折叠' }}
      </button>
    </header>
    <div :id="bodyId" v-show="!collapsed" class="collapsible-body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import { getCurrentInstance, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    title: string
    defaultCollapsed?: boolean
    /** 额外卡片类，例如详细设置的 .settings */
    cardClass?: string
  }>(),
  {
    defaultCollapsed: false,
    cardClass: ''
  }
)

const collapsed = ref(props.defaultCollapsed)
const bodyId = `collapsible-card-body-${getCurrentInstance()?.uid ?? 0}`
</script>

<style scoped>
.collapsible-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--control-h-sm);
}

.collapsible-head h3 {
  margin: 0;
  min-width: 0;
}

.collapsible-toggle {
  flex: 0 0 auto;
  line-height: 1;
}

.collapsible-chevron {
  display: block;
  flex: 0 0 var(--text-sm);
  width: var(--text-sm);
  height: var(--text-sm);
  transform-origin: center;
  transition: transform var(--duration-fast) var(--ease-out);
  will-change: transform;
}

.collapsible-chevron.open {
  transform: rotate(180deg);
}

.collapsible-chevron path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.collapsible-body {
  margin-top: var(--space-3);
}

.collapsible-body :slotted(.hint:first-child) {
  margin-top: 0;
}
</style>
