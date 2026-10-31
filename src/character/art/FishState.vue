<template>
  <svg class="fish" viewBox="0 0 200 220" role="img" :aria-label="`大肥鱼-${state}`">
    <!-- 尾巴 -->
    <path
      class="tail"
      :class="state"
      d="M52 128 C28 112, 20 92, 24 78 C40 88, 52 98, 58 110 C64 98, 76 88, 92 80 C88 96, 80 116, 60 132 Z"
    />
    <!-- 身体 -->
    <ellipse class="body" cx="116" cy="120" rx="62" ry="72" />
    <!-- 肚子 -->
    <ellipse class="belly" cx="120" cy="140" rx="38" ry="44" />
    <!-- 呆毛 -->
    <path class="hair" d="M116 48 C112 34, 122 26, 132 28 C126 34, 124 40, 126 48 Z" />
    <!-- 鳍 -->
    <path class="fin" d="M64 118 C52 122, 48 134, 54 146 C64 138, 70 130, 70 124 Z" />
    <!-- 眼睛 -->
    <template v-if="state === 'sleepy'">
      <path class="eye-line" d="M96 112 C102 118, 110 118, 116 112" />
      <path class="eye-line" d="M132 112 C138 118, 146 118, 152 112" />
    </template>
    <template v-else-if="state === 'happy'">
      <path class="eye-line" d="M96 116 C102 108, 110 108, 116 116" />
      <path class="eye-line" d="M132 116 C138 108, 146 108, 152 116" />
    </template>
    <template v-else>
      <circle class="eye" :r="state === 'surprised' ? 9 : 7" cx="106" cy="114" />
      <circle class="eye" :r="state === 'surprised' ? 9 : 7" cx="142" cy="114" />
      <circle class="pupil" :r="state === 'surprised' ? 4 : 3" cx="108" cy="116" />
      <circle class="pupil" :r="state === 'surprised' ? 4 : 3" cx="144" cy="116" />
    </template>
    <!-- 嘴 -->
    <path v-if="state === 'sad'" class="mouth" d="M116 138 C122 132, 132 132, 138 138" />
    <path v-else-if="state === 'surprised'" class="mouth" d="M124 138 a6 8 0 1 0 0.1 0" />
    <path v-else class="mouth" d="M118 136 C124 144, 132 144, 138 136" />
    <!-- 腮红 -->
    <ellipse class="blush" cx="92" cy="132" rx="10" ry="5" />
    <ellipse class="blush" cx="156" cy="132" rx="10" ry="5" />
    <!-- 思考泡泡 -->
    <g v-if="state === 'thinking'" class="think">
      <circle cx="168" cy="70" r="4" />
      <circle cx="176" cy="58" r="6" />
      <circle cx="186" cy="42" r="9" />
    </g>
  </svg>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'

type FishVisualState = 'idle' | 'happy' | 'sad' | 'sleepy' | 'thinking' | 'surprised'

defineProps({
  state: { type: String as PropType<FishVisualState>, default: 'idle' }
})
</script>

<style scoped>
.fish {
  width: 100%;
  height: 100%;
  display: block;
  filter: drop-shadow(0 8px 14px rgba(0, 0, 0, 0.35));
}
.body {
  fill: #3b6fd4;
  stroke: #24478f;
  stroke-width: 3;
}
.belly {
  fill: #dbe7ff;
  opacity: 0.9;
}
.tail {
  fill: #2f5bb0;
  stroke: #24478f;
  stroke-width: 3;
}
.tail.sleepy {
  transform: rotate(-6deg);
  transform-origin: 60px 120px;
}
.hair {
  fill: #6f9cf0;
}
.fin {
  fill: #2f5bb0;
  stroke: #24478f;
  stroke-width: 3;
}
.eye {
  fill: #ffffff;
}
.pupil {
  fill: #17233d;
}
.eye-line {
  fill: none;
  stroke: #17233d;
  stroke-width: 5;
  stroke-linecap: round;
}
.mouth {
  fill: none;
  stroke: #17233d;
  stroke-width: 4;
  stroke-linecap: round;
}
.blush {
  fill: #ff9fb5;
  opacity: 0.55;
}
.think circle {
  fill: #cfe0ff;
  stroke: #24478f;
  stroke-width: 2;
}
</style>
