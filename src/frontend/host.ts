export type ThemeName = 'dark' | 'light';

export type VideoServiceMethod =
  | 'video.douyin.resolve'
  | 'video.douyin.extract'
  | 'video.xhs.extract'
  | 'video.bilibili.extract'
  | 'video.youtube.extract';

export interface DouyinResult {
  mp4Url: string;
  title: string;
  hasWatermark: boolean;
}

export interface XhsResult {
  title: string;
  noteType: string;
  cover?: string;
  videoUrl?: string;
  imageUrls: string[];
}

export interface BilibiliResult {
  title: string;
  cover?: string;
  uploader?: string;
  bvid: string;
  duration?: number;
  videoUrl?: string;
  audioUrl?: string;
  qualityNote?: string;
}

export interface YoutubeSubtitle {
  language: string;
  name: string;
  url: string;
}

export interface YoutubeResult {
  title: string;
  uploader?: string;
  cover?: string;
  duration?: number;
  videoUrl?: string;
  subtitleUrls: YoutubeSubtitle[];
  notes?: string;
}

export interface ActivationResult {
  activationId: string;
}

export interface VideoHost {
  readonly mode: 'standalone' | 'plugin';
  readonly canSendToAria2: boolean;
  initialize(onTheme: (theme: ThemeName) => void): Promise<ThemeName>;
  request<T>(method: VideoServiceMethod, params: Record<string, unknown>): Promise<T>;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  sendToAria2(urls: string[]): Promise<ActivationResult>;
  dispose(): void;
}
