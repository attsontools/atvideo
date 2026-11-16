import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { downloadVerified } from './runtime-download.mjs';

const DOWNLOAD_TIMEOUT_MS = 120_000;

const manifest = JSON.parse(readFileSync('runtime-manifest.json', 'utf8'));
const python = process.env.ATVIDEO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const directory = mkdtempSync(resolve(tmpdir(), 'atvideo-youtube-deps-'));

try {
  for (const dependency of [
    { name: 'yt-dlp', ...manifest.ytDlp },
    { name: 'yt-dlp-ejs', ...manifest.ytDlpEjs }
  ]) {
    const wheel = await verifiedWheel(dependency);
    const path = resolve(directory, wheel.fileName);
    writeFileSync(path, wheel.bytes);
    const targetArgs = process.env.ATVIDEO_PYTHON_TARGET
      ? ['--target', process.env.ATVIDEO_PYTHON_TARGET]
      : [];
    const result = spawnSync(python, [
      '-m',
      'pip',
      'install',
      '--no-deps',
      ...targetArgs,
      path
    ], {
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pip install ${dependency.name} failed`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

async function verifiedWheel(dependency) {
  const metadataUrl = `https://pypi.org/pypi/${dependency.name}/${dependency.version}/json`;
  const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`download ${metadataUrl}: HTTP ${response.status}`);
  const metadata = await response.json();
  const source = metadata.urls.find((file) => file.packagetype === 'sdist');
  if (!source || source.digests?.sha256 !== dependency.sourceSha256) {
    throw new Error(`PyPI source checksum differs for ${dependency.name}`);
  }
  await downloadVerified(source.url, dependency.sourceSha256, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    label: `${dependency.name} source`
  });
  const wheel = metadata.urls.find(
    (file) => file.packagetype === 'bdist_wheel' && file.filename.endsWith('-py3-none-any.whl')
  );
  if (!wheel || wheel.digests?.sha256 !== dependency.wheelSha256) {
    throw new Error(`PyPI wheel checksum differs for ${dependency.name}`);
  }
  return {
    fileName: wheel.filename,
    bytes: await downloadVerified(wheel.url, dependency.wheelSha256, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      label: `${dependency.name} wheel`
    })
  };
}
