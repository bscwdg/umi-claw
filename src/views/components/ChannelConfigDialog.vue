<template>
  <div v-if="visible" class="overlay">
    <div class="dialog">
      <div class="header">配置 {{ channel.name }}</div>

      <div class="body">
        <div v-for="field in schema" :key="field.key" class="field">
          <label>
            {{ field.label }}
          </label>

          <input
            v-model="form[field.key]"
            :type="field.type"
            :placeholder="field.placeholder"
          />
        </div>
      </div>

      <div class="footer">
        <button @click="$emit('close')">取消</button>

        <button class="save" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";

import { CHANNEL_SCHEMAS } from "../../shared/channelSchemas";

const props = defineProps({
  visible: Boolean,

  channel: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["close", "save"]);

const form = reactive<Record<string, any>>({});

const schema = computed(() => CHANNEL_SCHEMAS[props.channel.id] || []);

function save() {
  emit("save", form);
}
</script>

<style scoped>
.overlay {
  position: fixed;

  inset: 0;

  background: rgba(0, 0, 0, 0.5);

  display: flex;

  justify-content: center;

  align-items: center;
}

.dialog {
  width: 450px;

  background: white;

  border-radius: 16px;

  overflow: hidden;
}

.header {
  padding: 20px;

  font-size: 20px;

  font-weight: 700;
}

.body {
  padding: 20px;
}

.field {
  margin-bottom: 20px;
}

.field label {
  display: block;

  margin-bottom: 8px;
}

.field input {
  width: 100%;

  padding: 10px;

  border: 1px solid #ddd;

  border-radius: 10px;
}

.footer {
  display: flex;

  justify-content: flex-end;

  gap: 12px;

  padding: 20px;
}

.save {
  background: #3b82f6;

  color: white;
}
</style>