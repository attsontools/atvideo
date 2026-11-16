import { describe, expect, it } from 'vitest';

import { extractVideoLinks } from '../src/frontend/videoLinks';

describe('extractVideoLinks', () => {
  it('groups recognized links by platform while preserving first normalized occurrence', () => {
    const result = extractVideoLinks(`
      YouTube https://youtu.be/yt-first/
      Bilibili http://b23.tv/bv-first/
      Douyin http://v.douyin.com/dy-first
      Xiaohongshu https://xhslink.com/xhs-first/
      Douyin duplicate https://v.douyin.com/dy-first/
      Douyin second https://www.douyin.com/video/123/
      YouTube duplicate http://youtu.be/yt-first
    `);

    expect(result).toEqual({
      links: [
        { platform: 'douyin', url: 'https://v.douyin.com/dy-first/' },
        { platform: 'douyin', url: 'https://www.douyin.com/video/123' },
        { platform: 'xhs', url: 'https://xhslink.com/xhs-first' },
        { platform: 'bilibili', url: 'https://b23.tv/bv-first' },
        { platform: 'youtube', url: 'https://youtu.be/yt-first' }
      ],
      truncatedCount: 0
    });
  });

  it('limits extraction to 100 links and reports the omitted count', () => {
    const text = Array.from(
      { length: 101 },
      (_, index) => `https://www.youtube.com/watch?v=video-${index}`
    ).join('\n');

    const result = extractVideoLinks(text);

    expect(result.links).toHaveLength(100);
    expect(result.links[99]).toEqual({
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=video-99'
    });
    expect(result.truncatedCount).toBe(1);
  });
});
