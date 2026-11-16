import { describe, expect, it, vi } from 'vitest';

import { extractDouyin } from '../src/frontend/douyinExtraction';
import type { VideoHost } from '../src/frontend/host';

function hostWithRequest(request: VideoHost['request']): Pick<VideoHost, 'request'> {
  return { request };
}

describe('extractDouyin', () => {
  it('extracts a canonical Douyin page without sending it through short-link resolution', async () => {
    const request = vi.fn(async () => ({
      mp4Url: 'https://cdn.example/video.mp4',
      title: 'Direct page',
      hasWatermark: false
    })) as VideoHost['request'];

    const result = await extractDouyin(
      hostWithRequest(request),
      'https://www.douyin.com/video/7650383172730932515'
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('video.douyin.extract', {
      url: 'https://www.douyin.com/video/7650383172730932515'
    });
    expect(result.pageUrl).toBe('https://www.douyin.com/video/7650383172730932515');
  });

  it('resolves a Douyin short link before extracting its canonical page', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'video.douyin.resolve') {
        return 'https://www.douyin.com/video/7650383172730932515';
      }
      return {
        mp4Url: 'https://cdn.example/video.mp4',
        title: 'Short link',
        hasWatermark: false
      };
    }) as VideoHost['request'];

    const result = await extractDouyin(hostWithRequest(request), 'https://v.douyin.com/abc/');

    expect(request).toHaveBeenNthCalledWith(1, 'video.douyin.resolve', {
      url: 'https://v.douyin.com/abc/'
    });
    expect(request).toHaveBeenNthCalledWith(2, 'video.douyin.extract', {
      url: 'https://www.douyin.com/video/7650383172730932515'
    });
    expect(result.pageUrl).toBe('https://www.douyin.com/video/7650383172730932515');
  });
});
