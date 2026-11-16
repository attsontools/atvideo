import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import type { ThemeName, VideoHost, VideoServiceMethod } from './host';

const STORAGE_KEY = 'atvideo.standalone.theme';

export interface StandaloneDependencies {
  invoke(command: string, args?: unknown): Promise<unknown>;
  storage: Pick<Storage, 'getItem'>;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export function createStandaloneHost(
  dependencies: StandaloneDependencies = browserDependencies()
): VideoHost {
  return {
    mode: 'standalone',
    canSendToAria2: false,
    async initialize(onTheme) {
      await dependencies.invoke('connect_video_service');
      const theme: ThemeName = dependencies.storage.getItem(STORAGE_KEY) === 'light'
        ? 'light'
        : 'dark';
      onTheme(theme);
      return theme;
    },
    async request<T>(method: VideoServiceMethod, params: Record<string, unknown>): Promise<T> {
      return await dependencies.invoke('video_service_request', { method, params }) as T;
    },
    async copyText(text) {
      await dependencies.copyText(text);
    },
    async openExternal(url) {
      await dependencies.openExternal(url);
    },
    async sendToAria2() {
      throw new Error('VIDEO_ARIA2_HOST_REQUIRED');
    },
    dispose() {}
  };
}

function browserDependencies(): StandaloneDependencies {
  return {
    invoke,
    storage: localStorage,
    async copyText(text) {
      await writeText(text);
    },
    async openExternal(url) {
      await invoke('open_external_url', { url });
    }
  };
}
