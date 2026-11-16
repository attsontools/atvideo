import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createPluginHost } from '../src/frontend/pluginHost';
import type { BilibiliResult, YoutubeResult } from '../src/frontend/host';

const capabilities = [
  'host.theme.read',
  'host.video.extract',
  'host.clipboard.write',
  'host.external.open',
  'host.app.activate'
];

describe('plugin video host', () => {
  it('keeps service duration fields numeric', () => {
    expectTypeOf<BilibiliResult['duration']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<YoutubeResult['duration']>().toEqualTypeOf<number | undefined>();
  });

  it('maps video and desktop actions to the approved Host API methods', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'host.video.extract') return { title: 'Example', imageUrls: [] };
      if (method === 'host.app.activate') return { accepted: true, activationId: 'activation-1' };
      if (method === 'host.clipboard.writeText') return { copied: true };
      if (method === 'host.external.open') return { opened: true };
      throw new Error(`unexpected method: ${method}`);
    });
    const removeThemeListener = vi.fn();
    const close = vi.fn();
    const host = createPluginHost(async (appId) => {
      expect(appId).toBe('com.attson.video');
      return {
        handshake: async () => ({ theme: 'dark' as const, capabilities }),
        call,
        onThemeChange: () => removeThemeListener,
        close
      };
    });

    await expect(host.initialize(() => undefined)).resolves.toBe('dark');
    await expect(host.request('video.xhs.extract', { url: 'https://xhslink.com/a' }))
      .resolves.toEqual({ title: 'Example', imageUrls: [] });
    await expect(host.copyText('https://example.com/video.mp4')).resolves.toBeUndefined();
    await expect(host.openExternal('https://example.com/watch')).resolves.toBeUndefined();
    await expect(host.sendToAria2(['https://example.com/video.mp4']))
      .resolves.toEqual({ activationId: 'activation-1' });

    expect(call).toHaveBeenNthCalledWith(1, 'host.video.extract', {
      method: 'video.xhs.extract',
      params: { url: 'https://xhslink.com/a' }
    });
    expect(call).toHaveBeenNthCalledWith(2, 'host.clipboard.writeText', {
      text: 'https://example.com/video.mp4'
    });
    expect(call).toHaveBeenNthCalledWith(3, 'host.external.open', {
      url: 'https://example.com/watch'
    });
    expect(call).toHaveBeenNthCalledWith(4, 'host.app.activate', {
      appId: 'com.attson.aria2',
      payload: {
        version: 1,
        kind: 'download.urls',
        urls: ['https://example.com/video.mp4']
      }
    });

    host.dispose();
    expect(removeThemeListener).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects initialization when any required capability is missing', async () => {
    const close = vi.fn();
    const host = createPluginHost(async () => ({
      handshake: async () => ({
        theme: 'dark' as const,
        capabilities: capabilities.filter((value) => value !== 'host.app.activate')
      }),
      call: async () => ({}),
      onThemeChange: () => () => undefined,
      close
    }));

    await expect(host.initialize(() => undefined))
      .rejects.toThrow('HOST_PERMISSION_DENIED: host.app.activate');
    expect(close).toHaveBeenCalledOnce();
  });
});
