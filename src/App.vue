<script setup>
import { ElConfigProvider } from 'element-plus'
import zhTw from 'element-plus/dist/locale/zh-tw.mjs'
</script>

<template>
  <el-config-provider :locale="zhTw">
    <router-view />
  </el-config-provider>
</template>
