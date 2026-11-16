export interface DownloadActivationPayload {
  version: 1;
  kind: 'download.urls';
  urls: string[];
}

const MAX_URLS = 100;
const MAX_URL_LENGTH = 8192;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export function buildDownloadActivation(urls: string[]): DownloadActivationPayload {
  if (urls.length === 0 || urls.length > MAX_URLS) throw invalidActivation();

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (typeof raw !== 'string') throw invalidActivation();
    const value = raw.trim();
    if (!value || value.length > MAX_URL_LENGTH) throw invalidActivation();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw invalidActivation();
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username.length > 0
      || parsed.password.length > 0
    ) {
      throw invalidActivation();
    }
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
  }
  if (normalized.length === 0) throw invalidActivation();

  const payload: DownloadActivationPayload = {
    version: 1,
    kind: 'download.urls',
    urls: normalized
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_PAYLOAD_BYTES) {
    throw invalidActivation();
  }
  return payload;
}

function invalidActivation(): Error {
  return new Error('VIDEO_ACTIVATION_INVALID');
}
