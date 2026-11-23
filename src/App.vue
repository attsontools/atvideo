<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { darkTheme, NButton, NConfigProvider } from 'naive-ui';

import VideoTool from './components/VideoTool.vue';
import type { ThemeName, VideoHost } from './frontend/host';

const props = defineProps<{ host: VideoHost }>();
const theme = ref<ThemeName>('dark');
const state = ref<'loading' | 'ready' | 'error'>('loading');
const errorMessage = ref('');

watch(theme, (value) => {
  document.documentElement.dataset.theme = value;
}, { immediate: true });

onMounted(connect);
onBeforeUnmount(() => props.host.dispose());

async function connect() {
  state.value = 'loading';
  errorMessage.value = '';
  try {
    theme.value = await props.host.initialize((value) => {
      theme.value = value;
    });
    state.value = 'ready';
  } catch (error) {
    state.value = 'error';
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  localStorage.setItem('atvideo.standalone.theme', theme.value);
}
</script>

<template>
  <n-config-provider :theme="theme === 'dark' ? darkTheme : null">
    <div class="video-app" :class="{ 'video-app--plugin': host.mode === 'plugin' }">
      <header v-if="host.mode === 'standalone'" class="appbar">
        <strong>AT Video</strong>
        <button
          v-if="host.mode === 'standalone'"
          type="button"
          class="theme-toggle"
          :title="theme === 'dark' ? '切换到浅色' : '切换到深色'"
          @click="toggleTheme"
        >
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
          </svg>
        </button>
      </header>

      <div v-if="state === 'loading'" class="center-state">正在连接视频服务</div>
      <div v-else-if="state === 'error'" class="center-state error-state">
        <strong>视频服务不可用</strong>
        <span>{{ errorMessage }}</span>
        <n-button type="primary" @click="connect">重新连接</n-button>
      </div>
      <VideoTool v-else :host="host" />
    </div>
  </n-config-provider>
</template>

<style scoped>
.video-app {
  display: grid;
  min-height: 100vh;
  grid-template-rows: 48px minmax(0, 1fr);
  background: var(--bg-base);
  color: var(--text);
}

.video-app--plugin {
  grid-template-rows: minmax(0, 1fr);
}

.appbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-elevated);
}

.appbar strong {
  font-size: var(--fs-sm);
  font-weight: 650;
}

.theme-toggle {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: transparent;
  cursor: pointer;
}

.theme-toggle:hover {
  border-color: var(--accent-line);
  color: var(--accent);
}

.theme-toggle svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.7;
}

.center-state {
  display: grid;
  min-height: 280px;
  place-content: center;
  gap: 10px;
  color: var(--text-muted);
  text-align: center;
}

.error-state strong {
  color: var(--error);
}

.error-state span {
  max-width: 560px;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
</style>
