<script setup lang="ts">
// 设备主页上那台像素小电视(固件 main/ui_pixel.c 的 ui_pixel_mascot_create),按同样的块坐标画成 SVG。
// 放进 .mascot-tile 小方块里使用:它的墨色轮廓在深色背景上会看不见。
withDefaults(defineProps<{ size?: number; blink?: boolean }>(), { size: 40, blink: true });
</script>

<template>
  <svg
    class="pixel-mascot" :class="{ blink }" :width="Math.round((size * 38) / 48)" :height="size"
    viewBox="0 0 38 48" shape-rendering="crispEdges" aria-hidden="true" focusable="false"
  >
    <rect x="18" y="0" width="3" height="6" fill="#17202a" />
    <rect x="16" y="0" width="7" height="3" fill="#ffb23e" />
    <rect x="3" y="6" width="32" height="24" fill="#17202a" />
    <rect x="0" y="12" width="5" height="10" fill="#7557d9" />
    <rect x="33" y="12" width="5" height="10" fill="#7557d9" />
    <rect x="7" y="10" width="24" height="16" fill="#b9f3ff" />
    <g class="eyes">
      <rect x="11" y="14" width="4" height="6" fill="#294b7a" />
      <rect x="23" y="14" width="4" height="6" fill="#294b7a" />
    </g>
    <rect x="16" y="22" width="7" height="2" fill="#7557d9" />
    <rect x="10" y="29" width="18" height="4" fill="#ffb23e" />
    <rect x="8" y="33" width="22" height="11" fill="#7557d9" />
    <rect x="3" y="35" width="5" height="7" fill="#b9f3ff" />
    <rect x="30" y="35" width="5" height="7" fill="#b9f3ff" />
    <rect x="8" y="44" width="9" height="4" fill="#17202a" />
    <rect x="21" y="44" width="9" height="4" fill="#17202a" />
  </svg>
</template>

<style scoped>
.pixel-mascot { display: block; }
.pixel-mascot.blink .eyes {
  transform-box: fill-box;
  transform-origin: center;
  animation: mascot-blink 3.8s steps(1) infinite;
}
@keyframes mascot-blink {
  0%, 93%, 100% { transform: scaleY(1); }
  95%, 97% { transform: scaleY(0.17); }
}
</style>
