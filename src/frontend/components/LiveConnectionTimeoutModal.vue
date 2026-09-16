<template>
  <div
    v-if="show"
    class="modal-overlay active"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    :aria-describedby="messageId"
  >
    <div class="modal-dialog live-timeout-dialog">
      <div class="modal-header">
        <div :id="titleId" class="modal-title">$ websocket --timeout</div>
      </div>

      <div class="warning-box live-timeout-message">
        <span class="live-timeout-icon" aria-hidden="true">[!]</span>
        <div>
          <strong>{{ trans.liveConnectionTimeoutTitle }}</strong>
          <p :id="messageId">{{ trans.liveConnectionTimeoutMessage }}</p>
        </div>
      </div>

      <div class="modal-footer flex-justify-between">
        <button type="button" class="btn" @click="$emit('close')">
          {{ trans.close }}
        </button>
        <button type="button" class="btn btn-primary" autofocus @click="$emit('continue')">
          {{ trans.continueConnection }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
const titleId = 'live-connection-timeout-title'
const messageId = 'live-connection-timeout-message'

defineProps({
  show: { type: Boolean, default: false },
  trans: { type: Object, required: true }
})

defineEmits(['close', 'continue'])
</script>
