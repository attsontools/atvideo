import { describe, expect, it } from 'vitest';

import { buildDownloadActivation } from '../src/frontend/downloadActivation';

describe('buildDownloadActivation', () => {
  it('normalizes a valid batch while preserving first occurrence order', () => {
    expect(buildDownloadActivation([
      ' https://example.com/video.mp4 ',
      'https://example.com/audio.m4a',
      'https://example.com/video.mp4'
    ])).toEqual({
      version: 1,
      kind: 'download.urls',
      urls: [
        'https://example.com/video.mp4',
        'https://example.com/audio.m4a'
      ]
    });
  });

  it.each([
    [[]],
    [['ftp://example.com/video.mp4']],
    [['https://user:secret@example.com/video.mp4']],
    [[...Array.from({ length: 101 }, (_, index) => `https://example.com/${index}`)]]
  ])('rejects an invalid batch atomically', (urls) => {
    expect(() => buildDownloadActivation(urls)).toThrow('VIDEO_ACTIVATION_INVALID');
  });
});
