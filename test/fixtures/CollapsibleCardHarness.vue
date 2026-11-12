<template>
  <CollapsibleCard title="默认展开卡片">
    <span data-slot="expanded">expanded-body</span>
  </CollapsibleCard>
  <CollapsibleCard title="默认折叠卡片" default-collapsed>
    <span data-slot="collapsed">collapsed-body</span>
  </CollapsibleCard>
</template>

<script setup lang="ts">
import CollapsibleCard from '@/views/components/CollapsibleCard.vue'
</script>
