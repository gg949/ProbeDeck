<template>
  <footer class="footer status-bar">
    <span class="footer-version">
      <span>V{{ VERSION }}</span>
    </span>
    <span>Powered by <a href="https://github.com/gg949/ProbeDeck" target="_blank">ProbeDeck</a></span>
  </footer>
</template>

<script setup>
import { VERSION } from '../utils/api'
</script>
