import type { DouyinResult, VideoHost } from './host';

type RequestHost = Pick<VideoHost, 'request'>;

export async function extractDouyin(host: RequestHost, sourceUrl: string) {
  const pageUrl = new URL(sourceUrl).hostname === 'v.douyin.com'
    ? await host.request<string>('video.douyin.resolve', { url: sourceUrl })
    : sourceUrl;
  const result = await host.request<DouyinResult>('video.douyin.extract', { url: pageUrl });
  return { pageUrl, result };
}
