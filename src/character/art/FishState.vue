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

    <!-- 眼睛：sleepy 闭眼、happy 弯眼、caught 瞪大、其余正常 -->
    <template v-if="state === 'sleepy'">
      <path class="eye-line" d="M96 114 C102 120, 110 120, 116 114" />
      <path class="eye-line" d="M132 114 C138 120, 146 120, 152 114" />
    </template>
    <template v-else-if="state === 'happy'">
      <path class="eye-line" d="M96 116 C102 108, 110 108, 116 116" />
      <path class="eye-line" d="M132 116 C138 108, 146 108, 152 116" />
    </template>
    <template v-else-if="state === 'caught'">
      <circle class="eye" r="10" cx="106" cy="112" />
      <circle class="eye" r="10" cx="142" cy="112" />
      <circle class="pupil" r="4" cx="106" cy="112" />
      <circle class="pupil" r="4" cx="142" cy="112" />
      <text class="mark" x="168" y="70">!</text>
      <text class="mark small" x="180" y="92">!</text>
    </template>
    <template v-else>
      <circle class="eye" r="7" cx="106" cy="114" />
      <circle class="eye" r="7" cx="142" cy="114" />
      <circle class="pupil" r="3" cx="108" cy="116" />
      <circle class="pupil" r="3" cx="144" cy="116" />
    </template>

    <!-- 嘴 -->
    <path v-if="state === 'sulk'" class="mouth" d="M116 140 C122 134, 132 134, 138 140" />
    <ellipse v-else-if="state === 'eat' || state === 'caught'" class="mouth-open" cx="127" cy="138" rx="7" ry="9" />
    <path v-else class="mouth" d="M118 136 C124 144, 132 144, 138 136" />

    <!-- 饭碗（吃白饭态） -->
    <g v-if="state === 'eat'" class="bowl">
      <path d="M92 170 L164 170 C160 186, 148 196, 128 196 C108 196, 96 186, 92 170 Z" />
      <ellipse cx="128" cy="170" rx="36" ry="7" />
    </g>

    <!-- 腮红 -->
    <ellipse class="blush" cx="92" cy="132" rx="10" ry="5" />
    <ellipse class="blush" cx="156" cy="132" rx="10" ry="5" />

    <!-- 困了：Z -->
    <g v-if="state === 'sleepy'" class="zzz">
      <text x="164" y="66">z</text>
      <text x="176" y="50" class="small">z</text>
    </g>
  </svg>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'

type FishVisualState = 'idle' | 'happy' | 'sleepy' | 'sulk' | 'eat' | 'caught'

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
.mouth-open {
  fill: #17233d;
}
.blush {
  fill: #ff9fb5;
  opacity: 0.55;
}
.mark {
  fill: #ff6b6b;
  font-size: 26px;
  font-weight: 700;
}
.mark.small,
.zzz text {
  font-size: 18px;
}
.zzz text {
  fill: #cfe0ff;
  font-weight: 600;
}
.bowl path {
  fill: #dbe7ff;
  stroke: #24478f;
  stroke-width: 3;
}
.bowl ellipse {
  fill: #ffffff;
  stroke: #24478f;
  stroke-width: 3;
}
</style>
