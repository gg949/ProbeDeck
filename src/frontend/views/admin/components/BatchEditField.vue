<template>
  <div class="batch-edit-field">
    <label class="batch-edit-field-toggle">
      <input type="checkbox" :checked="enabled" @change="$emit('toggle', $event.target.checked)">
      <span>{{ label }}</span>
    </label>
    <div class="batch-edit-field-control">
      <slot />
    </div>
  </div>
</template>

<script setup>
defineProps({
  enabled: { type: Boolean, default: false },
  label: { type: String, required: true }
})

defineEmits(['toggle'])
</script>
