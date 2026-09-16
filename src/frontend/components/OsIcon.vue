<template>
  <img
    v-if="iconSrc && !loadFailed"
    class="os-icon-img"
    :src="iconSrc"
    :alt="osName"
    :aria-label="osName"
    loading="lazy"
    @error="loadFailed = true"
  >
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { getOSImage, getOSName } from '../utils/osIcon'
import { getPublicAssetUrl } from '../utils/config'

const props = defineProps({
  os: { type: String, default: '' }
})

const loadFailed = ref(false)
const osImage = computed(() => getOSImage(props.os))
const osName = computed(() => getOSName(props.os))
const iconSrc = computed(() => osImage.value ? getPublicAssetUrl(osImage.value) : '')

watch(() => props.os, () => {
  loadFailed.value = false
})
</script>
