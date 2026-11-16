import { describe, expect, it, vi } from 'vitest';

import { createStandaloneHost } from '../src/frontend/standaloneHost';

describe('standalone video host', () => {
  it('uses the local service and native desktop actions', async () => {
    const invoke = vi.fn(async (command: string, args?: unknown) => {
      if (command === 'connect_video_service') return null;
      expect(command).toBe('video_service_request');
      expect(args).toEqual({
        method: 'video.youtube.extract',
        params: { url: 'https://youtu.be/example', proxy: 'socks5://127.0.0.1:1080' }
      });
      return { title: 'Example', subtitleUrls: [] };
    });
    const copyText = vi.fn(async () => undefined);
    const openExternal = vi.fn(async () => undefined);
    const host = createStandaloneHost({
      invoke,
      storage: { getItem: () => 'light' },
      copyText,
      openExternal
    });
    const themes: string[] = [];

    await expect(host.initialize((theme) => themes.push(theme))).resolves.toBe('light');
    await expect(host.request('video.youtube.extract', {
      url: 'https://youtu.be/example',
      proxy: 'socks5://127.0.0.1:1080'
    })).resolves.toEqual({ title: 'Example', subtitleUrls: [] });
    await host.copyText('copied');
    await host.openExternal('https://example.com/watch');

    expect(host.canSendToAria2).toBe(false);
    expect(themes).toEqual(['light']);
    expect(copyText).toHaveBeenCalledWith('copied');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/watch');
  });

  it('rejects Aria2 handoff without invoking a private standalone protocol', async () => {
    const invoke = vi.fn(async () => null);
    const host = createStandaloneHost({
      invoke,
      storage: { getItem: () => null },
      copyText: async () => undefined,
      openExternal: async () => undefined
    });

    await expect(host.sendToAria2(['https://example.com/video.mp4']))
      .rejects.toThrow('VIDEO_ARIA2_HOST_REQUIRED');
    expect(invoke).not.toHaveBeenCalled();
  });
});
