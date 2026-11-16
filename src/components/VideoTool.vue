<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';

import type {
  BilibiliResult,
  VideoHost,
  XhsResult,
  YoutubeResult
} from '../frontend/host';
import { extractDouyin } from '../frontend/douyinExtraction';
import {
  extractVideoLinks,
  platformName,
  type VideoLink,
  type VideoPlatform
} from '../frontend/videoLinks';

interface MediaInfo {
  title: string;
  cover?: string;
  videoUrl?: string;
  audioUrl?: string;
  imageUrls?: string[];
  subtitles?: YoutubeResult['subtitleUrls'];
  hasWatermark?: boolean;
  uploader?: string;
  notes?: string;
}

interface Entry {
  id: string;
  platform: VideoPlatform;
  sourceUrl: string;
  pageUrl: string;
  status: 'pending' | 'ok' | 'fail';
  info?: MediaInfo;
  error?: string;
}

const props = defineProps<{ host: VideoHost }>();
const raw = ref('');
const youtubeProxy = ref('');
const entries = ref<Entry[]>([]);
const truncatedCount = ref(0);
const feedback = ref<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let runGeneration = 0;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

watch(raw, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(extractNow, 300);
});

onBeforeUnmount(() => {
  runGeneration += 1;
  clearTimeout(debounceTimer);
  clearTimeout(feedbackTimer);
});

const hasInput = computed(() => raw.value.trim().length > 0);
const hasYoutube = computed(() => entries.value.some((entry) => entry.platform === 'youtube'));
const pendingCount = computed(() => entries.value.filter((entry) => entry.status === 'pending').length);
const successCount = computed(() => entries.value.filter((entry) => entry.status === 'ok').length);
const failureCount = computed(() => entries.value.filter((entry) => entry.status === 'fail').length);

function extractNow() {
  clearTimeout(debounceTimer);
  const extracted = extractVideoLinks(raw.value);
  truncatedCount.value = extracted.truncatedCount;
  const generation = ++runGeneration;
  entries.value = extracted.links.map((link) => ({
    id: `${link.platform}:${link.url}`,
    platform: link.platform,
    sourceUrl: link.url,
    pageUrl: link.url,
    status: 'pending'
  }));
  void resolveLinks(generation, extracted.links);
}

async function resolveLinks(generation: number, links: VideoLink[]) {
  let cursor = 0;
  const worker = async () => {
    while (generation === runGeneration) {
      const link = links[cursor++];
      if (!link) return;
      await resolveLink(generation, link);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, links.length) }, worker));
}

async function resolveLink(generation: number, link: VideoLink) {
  try {
    if (link.platform === 'douyin') {
      const { pageUrl, result } = await extractDouyin(props.host, link.url);
      if (generation !== runGeneration) return;
      updateEntry(link, { pageUrl });
      updateEntryForRun(generation, link, {
        status: 'ok',
        info: {
          title: result.title,
          videoUrl: result.mp4Url,
          hasWatermark: result.hasWatermark
        }
      });
      return;
    }
    if (link.platform === 'xhs') {
      const result = await props.host.request<XhsResult>('video.xhs.extract', { url: link.url });
      updateEntryForRun(generation, link, {
        status: 'ok',
        info: {
          title: result.title,
          cover: result.cover,
          videoUrl: result.videoUrl,
          imageUrls: result.imageUrls,
          notes: result.noteType === 'video' ? undefined : '图文帖：可批量发送全部图片'
        }
      });
      return;
    }
    if (link.platform === 'bilibili') {
      const result = await props.host.request<BilibiliResult>('video.bilibili.extract', { url: link.url });
      updateEntryForRun(generation, link, {
        pageUrl: `https://www.bilibili.com/video/${result.bvid}`,
        status: 'ok',
        info: {
          title: result.title,
          cover: result.cover,
          uploader: result.uploader,
          videoUrl: result.videoUrl,
          audioUrl: result.audioUrl,
          notes: result.qualityNote
        }
      });
      return;
    }
    const proxy = youtubeProxy.value.trim();
    const result = await props.host.request<YoutubeResult>('video.youtube.extract', {
      url: link.url,
      ...(proxy ? { proxy } : {})
    });
    updateEntryForRun(generation, link, {
      status: 'ok',
      info: {
        title: result.title,
        cover: result.cover,
        uploader: result.uploader,
        videoUrl: result.videoUrl,
        subtitles: result.subtitleUrls,
        notes: result.notes
      }
    });
  } catch (error) {
    updateEntryForRun(generation, link, {
      status: 'fail',
      error: readableError(error)
    });
  }
}

function updateEntry(link: VideoLink, patch: Partial<Entry>) {
  const index = entries.value.findIndex((entry) => entry.id === `${link.platform}:${link.url}`);
  if (index < 0) return;
  entries.value[index] = { ...entries.value[index], ...patch };
}

function updateEntryForRun(generation: number, link: VideoLink, patch: Partial<Entry>) {
  if (generation !== runGeneration) return;
  updateEntry(link, patch);
}

function clearAll() {
  runGeneration += 1;
  raw.value = '';
  entries.value = [];
  truncatedCount.value = 0;
  feedback.value = null;
}

async function copyText(text: string, successText = '已复制') {
  try {
    await props.host.copyText(text);
    showFeedback('success', successText);
  } catch (error) {
    showFeedback('error', `复制失败：${readableError(error)}`);
  }
}

async function openPage(entry: Entry) {
  try {
    await props.host.openExternal(entry.pageUrl);
    showFeedback('success', '已交给系统默认浏览器打开');
  } catch (error) {
    showFeedback('error', `打开失败：${readableError(error)}。可使用旁边的复制页面。`);
  }
}

async function sendDownloads(urls: string[]) {
  if (!props.host.canSendToAria2) {
    showFeedback('info', '仅在 AT Tool 中可发送到 Aria2');
    return;
  }
  try {
    await props.host.sendToAria2(urls);
    showFeedback('success', `已发送 ${urls.length} 个链接到 Aria2`);
  } catch (error) {
    showFeedback('error', `发送失败：${readableError(error)}`);
  }
}

function showFeedback(kind: 'success' | 'error' | 'info', text: string) {
  clearTimeout(feedbackTimer);
  feedback.value = { kind, text };
  feedbackTimer = setTimeout(() => {
    feedback.value = null;
  }, 4000);
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '未知错误');
}
</script>

<template>
  <main class="video-tool">
    <section class="input-section">
      <div class="section-heading">
        <div>
          <h1>视频链接抽取</h1>
          <p>抖音、小红书、B 站与 YouTube</p>
        </div>
        <div class="actions">
          <n-button secondary @click="clearAll">清空</n-button>
          <n-button type="primary" @click="extractNow">提取链接</n-button>
        </div>
      </div>

      <n-input
        v-model:value="raw"
        type="textarea"
        placeholder="粘贴分享文案或多个视频链接"
        :autosize="{ minRows: 5, maxRows: 10 }"
      />

      <div v-if="hasYoutube" class="proxy-row">
        <label for="youtube-proxy">YouTube 代理</label>
        <n-input
          id="youtube-proxy"
          v-model:value="youtubeProxy"
          size="small"
          placeholder="socks5://127.0.0.1:1080"
        />
      </div>
      <p v-if="truncatedCount" class="notice error-text">
        已处理前 100 条，另有 {{ truncatedCount }} 条未处理
      </p>
    </section>

    <section class="result-section">
      <div class="result-heading">
        <div>
          <h2>提取结果</h2>
          <p v-if="entries.length">
            成功 {{ successCount }} · 失败 {{ failureCount }} · 解析中 {{ pendingCount }}
          </p>
        </div>
        <n-button
          v-if="entries.length"
          size="small"
          secondary
          :disabled="pendingCount > 0"
          @click="copyText(entries.map((entry) => entry.pageUrl).join('\n'), '已复制全部页面')"
        >
          复制全部页面
        </n-button>
      </div>

      <div v-if="feedback" class="feedback" :class="feedback.kind" role="status">
        {{ feedback.text }}
      </div>

      <div v-if="entries.length" class="result-list">
        <article v-for="(entry, index) in entries" :key="entry.id" class="result-row">
          <span class="index">{{ index + 1 }}</span>
          <div class="result-content">
            <div class="page-line">
              <span class="platform">{{ platformName(entry.platform) }}</span>
              <span class="page-url">{{ entry.pageUrl }}</span>
              <div class="row-actions">
                <n-button size="tiny" secondary @click="copyText(entry.pageUrl, '已复制页面')">
                  复制页面
                </n-button>
                <n-button size="tiny" secondary @click="openPage(entry)">打开</n-button>
              </div>
            </div>

            <div v-if="entry.status === 'pending'" class="state-line">解析中</div>
            <div v-else-if="entry.status === 'fail'" class="state-line error-text">
              {{ entry.error }}
            </div>
            <div v-else-if="entry.info" class="media-block">
              <img v-if="entry.info.cover" :src="entry.info.cover" alt="" class="cover" />
              <div class="media-content">
                <div class="title-line">
                  <strong>{{ entry.info.title || '未命名内容' }}</strong>
                  <span v-if="entry.info.uploader">{{ entry.info.uploader }}</span>
                  <span v-if="entry.info.hasWatermark !== undefined" class="tag">
                    {{ entry.info.hasWatermark ? '含水印' : '无水印' }}
                  </span>
                </div>

                <div v-if="entry.info.videoUrl" class="asset-line">
                  <span class="asset-url">{{ entry.info.videoUrl }}</span>
                  <div class="row-actions">
                    <n-button size="tiny" secondary @click="copyText(entry.info.videoUrl, '已复制视频地址')">
                      复制视频
                    </n-button>
                    <n-button size="tiny" type="primary" @click="sendDownloads([entry.info.videoUrl])">
                      发送视频
                    </n-button>
                  </div>
                </div>

                <div v-if="entry.info.audioUrl" class="asset-line">
                  <span class="asset-url">{{ entry.info.audioUrl }}</span>
                  <n-button size="tiny" secondary @click="sendDownloads([entry.info.audioUrl])">
                    发送音频
                  </n-button>
                </div>

                <div v-if="entry.info.imageUrls?.length" class="asset-line">
                  <span>图片 {{ entry.info.imageUrls.length }} 张</span>
                  <n-button size="tiny" secondary @click="sendDownloads(entry.info.imageUrls)">
                    发送全部图片
                  </n-button>
                </div>

                <div v-if="entry.info.subtitles?.length" class="subtitle-line">
                  <span>字幕</span>
                  <n-button
                    v-for="subtitle in entry.info.subtitles"
                    :key="subtitle.url"
                    size="tiny"
                    secondary
                    @click="sendDownloads([subtitle.url])"
                  >
                    {{ subtitle.name }}
                  </n-button>
                </div>

                <p v-if="entry.info.notes" class="notes">{{ entry.info.notes }}</p>
              </div>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="empty-state">
        {{ hasInput ? '未识别到支持的平台链接' : '等待输入分享文案' }}
      </div>
    </section>
  </main>
</template>

<style scoped>
.video-tool {
  display: grid;
  min-height: 100%;
  grid-template-rows: auto minmax(0, 1fr);
}

.input-section,
.result-section {
  padding: 20px 24px;
}

.input-section {
  border-bottom: 1px solid var(--line);
}

.section-heading,
.result-heading,
.page-line,
.asset-line,
.subtitle-line,
.title-line,
.proxy-row,
.actions,
.row-actions {
  display: flex;
  align-items: center;
}

.section-heading,
.result-heading,
.page-line,
.asset-line {
  justify-content: space-between;
}

.section-heading,
.result-heading {
  gap: 16px;
  margin-bottom: 14px;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: var(--fs-xl);
  font-weight: 650;
}

h2 {
  font-size: var(--fs-lg);
  font-weight: 650;
}

.section-heading p,
.result-heading p,
.notes,
.state-line {
  color: var(--text-muted);
  font-size: var(--fs-xs);
}

.actions,
.row-actions,
.subtitle-line,
.title-line,
.proxy-row {
  gap: 8px;
}

.proxy-row {
  margin-top: 12px;
}

.proxy-row label {
  flex: none;
  color: var(--text-muted);
  font-size: var(--fs-xs);
}

.proxy-row :deep(.n-input) {
  max-width: 360px;
}

.notice {
  margin-top: 10px;
}

.result-section {
  display: grid;
  min-height: 0;
  grid-template-rows: auto auto minmax(0, 1fr);
}

.feedback {
  padding: 8px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  font-size: var(--fs-xs);
}

.feedback.success {
  border-color: var(--accent-line);
  color: var(--success);
}

.feedback.error,
.error-text {
  color: var(--error);
}

.feedback.info {
  color: var(--info);
}

.result-list {
  display: grid;
  min-height: 0;
  gap: 8px;
  overflow: auto;
  align-content: start;
}

.result-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.index {
  color: var(--text-faint);
  font-size: var(--fs-xs);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.result-content,
.media-content {
  display: grid;
  min-width: 0;
  gap: 8px;
}

.page-line {
  min-width: 0;
  gap: 8px;
}

.platform,
.tag {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--fs-xxs);
}

.page-url,
.asset-url {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}

.page-url,
.asset-url,
.title-line strong {
  flex: 1;
}

.media-block {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.cover {
  width: 72px;
  height: 54px;
  border-radius: var(--radius-sm);
  object-fit: cover;
  background: var(--bg-elev-2);
}

.title-line {
  min-width: 0;
  flex-wrap: wrap;
  color: var(--text-muted);
  font-size: var(--fs-xs);
}

.title-line strong {
  min-width: 160px;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-line,
.subtitle-line {
  min-width: 0;
  gap: 8px;
  color: var(--text-muted);
  font-size: var(--fs-xs);
}

.subtitle-line {
  flex-wrap: wrap;
}

.empty-state {
  display: grid;
  min-height: 180px;
  place-items: center;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-md);
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

@media (max-width: 640px) {
  .input-section,
  .result-section {
    padding: 16px;
  }

  .section-heading,
  .result-heading,
  .page-line,
  .asset-line {
    align-items: flex-start;
    flex-direction: column;
  }

  .actions,
  .row-actions {
    width: 100%;
  }

  .row-actions :deep(.n-button) {
    flex: 1;
  }

  .result-row {
    grid-template-columns: 20px minmax(0, 1fr);
    padding: 10px 8px;
  }

  .media-block {
    grid-template-columns: minmax(0, 1fr);
  }

  .cover {
    width: 100%;
    height: auto;
    max-height: 180px;
  }
}
</style>
