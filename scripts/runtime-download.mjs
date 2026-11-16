import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 120_000;

export async function downloadVerified(
  origin,
  expectedSha256,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = 'runtime'
  } = {}
) {
  const candidates = [...proxyCandidates(origin), origin];
  let lastError;
  for (const url of candidates) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expectedSha256) throw new Error(`checksum mismatch: ${actual}`);
      return bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`unable to download verified ${label}: ${lastError}`);
}

function proxyCandidates(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || !['github.com', 'raw.githubusercontent.com'].includes(url.hostname)) {
    return [];
  }
  return [`https://gh-proxy.com/${origin}`];
}
