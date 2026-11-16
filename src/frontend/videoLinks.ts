export type VideoPlatform = 'douyin' | 'xhs' | 'bilibili' | 'youtube';

export interface VideoLink {
  platform: VideoPlatform;
  url: string;
}

export interface ExtractVideoLinksResult {
  links: VideoLink[];
  truncatedCount: number;
}

interface PlatformSpec {
  platform: VideoPlatform;
  pattern: RegExp;
}

const PLATFORM_SPECS: PlatformSpec[] = [
  {
    platform: 'douyin',
    pattern: /https?:\/\/(?:v\.douyin\.com|www\.douyin\.com|www\.iesdouyin\.com)\/[A-Za-z0-9/_?=&%.-]+/gi
  },
  {
    platform: 'xhs',
    pattern: /https?:\/\/(?:www\.xiaohongshu\.com|xhslink\.com)\/[A-Za-z0-9/_?=&%.-]+/gi
  },
  {
    platform: 'bilibili',
    pattern: /https?:\/\/(?:www\.bilibili\.com|b23\.tv|m\.bilibili\.com)\/[A-Za-z0-9/_?=&%.-]+/gi
  },
  {
    platform: 'youtube',
    pattern: /https?:\/\/(?:www\.youtube\.com|youtube\.com|youtu\.be|m\.youtube\.com)\/[A-Za-z0-9/_?=&%.-]+/gi
  }
];

const PLATFORM_NAMES: Record<VideoPlatform, string> = {
  douyin: '抖音',
  xhs: '小红书',
  bilibili: 'B 站',
  youtube: 'YouTube'
};

export function platformName(platform: VideoPlatform): string {
  return PLATFORM_NAMES[platform];
}

export function extractVideoLinks(text: string): ExtractVideoLinksResult {
  const links: VideoLink[] = [];
  const seen = new Set<string>();

  for (const spec of PLATFORM_SPECS) {
    for (const rawUrl of text.match(spec.pattern) ?? []) {
      const url = normalizeVideoUrl(rawUrl, spec.platform);
      const key = `${spec.platform}:${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ platform: spec.platform, url });
    }
  }

  const truncatedCount = Math.max(0, links.length - 100);
  return {
    links: truncatedCount === 0 ? links : links.slice(0, 100),
    truncatedCount
  };
}

function normalizeVideoUrl(url: string, platform: VideoPlatform): string {
  const normalizedScheme = url.replace(/^http:\/\//i, 'https://');
  if (platform === 'douyin' && /^https:\/\/v\.douyin\.com\//i.test(normalizedScheme)) {
    return `${normalizedScheme.replace(/\/+$/, '')}/`;
  }
  return normalizedScheme.replace(/\/+$/, '');
}
