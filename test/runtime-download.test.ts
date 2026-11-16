// @ts-nocheck
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { downloadVerified } from '../scripts/runtime-download.mjs';

describe('pinned video runtime downloads', () => {
  it('uses the proxy first for GitHub and falls back to the origin with the same hash check', async () => {
    const bytes = Buffer.from('verified quickjs runtime');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const requests: Array<{ url: string; signal: AbortSignal }> = [];
    const fetchImpl = vi.fn(async (url, options) => {
      requests.push({ url, signal: options.signal });
      if (requests.length === 1) throw new Error('proxy unavailable');
      return new Response(bytes, { status: 200 });
    });

    await expect(downloadVerified(
      'https://github.com/quickjs-ng/quickjs/releases/download/v0.17.0/qjs-linux-x86_64',
      sha256,
      { fetchImpl, timeoutMs: 5000, label: 'QuickJS' }
    )).resolves.toEqual(bytes);
    expect(requests.map((request) => request.url)).toEqual([
      'https://gh-proxy.com/https://github.com/quickjs-ng/quickjs/releases/download/v0.17.0/qjs-linux-x86_64',
      'https://github.com/quickjs-ng/quickjs/releases/download/v0.17.0/qjs-linux-x86_64'
    ]);
    expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true);
  });

  it('uses one bounded request for non-GitHub sources', async () => {
    const bytes = Buffer.from('verified wheel');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }));

    await downloadVerified('https://files.pythonhosted.org/package.whl', sha256, {
      fetchImpl,
      timeoutMs: 5000,
      label: 'yt-dlp wheel'
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects bytes that do not match the fixed hash from every candidate', async () => {
    const fetchImpl = vi.fn(async () => new Response('tampered', { status: 200 }));

    await expect(downloadVerified('https://github.com/example/archive', 'a'.repeat(64), {
      fetchImpl,
      timeoutMs: 5000,
      label: 'runtime'
    })).rejects.toThrow(/checksum mismatch/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
