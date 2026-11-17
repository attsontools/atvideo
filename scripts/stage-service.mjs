import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseCargoEnv } from './release-cargo-env.mjs';
import { downloadVerified } from './runtime-download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'runtime-manifest.json'), 'utf8'));
const release = process.argv.includes('--release');
const target = process.env.ATVIDEO_RELEASE_TARGET
  || process.env.TAURI_ENV_TARGET_TRIPLE
  || rustHostTarget();
const extension = target.includes('windows') ? '.exe' : '';
const profile = release ? 'release' : 'debug';
const cargoArgs = ['build', '--bin', 'atvideo-service', '--target', target];
if (release) cargoArgs.push('--release');
const cargoEnv = release ? releaseCargoEnv() : { ...process.env };
execFileSync('cargo', cargoArgs, { cwd: root, env: cargoEnv, stdio: 'inherit' });

const binaryDirectory = resolve(root, 'src-tauri', 'binaries');
mkdirSync(binaryDirectory, { recursive: true });
stageExecutable(
  resolve(root, 'target', target, profile, `atvideo-service${extension}`),
  resolve(binaryDirectory, `atvideo-service-${target}${extension}`)
);

const bridgeDestination = resolve(binaryDirectory, `youtube-bridge-${target}${extension}`);
if (process.env.ATVIDEO_YOUTUBE_BRIDGE_PATH) {
  stageExecutable(resolve(process.env.ATVIDEO_YOUTUBE_BRIDGE_PATH), bridgeDestination);
} else {
  buildYoutubeBridge(bridgeDestination);
}
assertBridgeVersions(bridgeDestination);

const quickjsDestination = resolve(binaryDirectory, `qjs-${target}${extension}`);
await stageQuickJs(quickjsDestination);
assertQuickJs(quickjsDestination);

function buildYoutubeBridge(destination) {
  const expectedArch = target.startsWith('aarch64-')
    ? 'arm64'
    : target.startsWith('x86_64-')
      ? 'x64'
      : null;
  if (!expectedArch || process.arch !== expectedArch) {
    throw new Error(`PyInstaller requires a native ${target} runner`);
  }
  const temporary = mkdtempSync(resolve(tmpdir(), 'atvideo-youtube-bridge-'));
  try {
    const python = process.env.ATVIDEO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    execFileSync(python, [
      '-m',
      'PyInstaller',
      '--noconfirm',
      '--clean',
      '--onefile',
      '--noupx',
      '--name',
      'youtube-bridge',
      '--collect-all',
      'yt_dlp',
      '--collect-all',
      'yt_dlp_ejs',
      '--distpath',
      resolve(temporary, 'dist'),
      '--workpath',
      resolve(temporary, 'work'),
      '--specpath',
      temporary,
      resolve(root, 'python', 'youtube_bridge.py')
    ], { cwd: root, stdio: 'inherit' });
    stageExecutable(
      resolve(temporary, 'dist', `youtube-bridge${extension}`),
      destination
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function assertBridgeVersions(program) {
  const result = spawnSync(program, ['--runtime-version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'YouTube bridge version smoke failed');
  }
  let versions;
  try {
    versions = JSON.parse(result.stdout);
  } catch {
    throw new Error('YouTube bridge returned invalid version JSON');
  }
  if (
    versions.ytDlp !== manifest.ytDlp.version
    || versions.ytDlpEjs !== manifest.ytDlpEjs.version
  ) {
    throw new Error(
      `YouTube runtime version mismatch: expected ${manifest.ytDlp.version}/${manifest.ytDlpEjs.version}`
    );
  }
}

async function stageQuickJs(destination) {
  const asset = manifest.quickJs.assets[target];
  if (!asset) throw new Error(`QuickJS does not support target ${target}`);
  if (process.env.ATVIDEO_QUICKJS_PATH) {
    stageExecutable(resolve(process.env.ATVIDEO_QUICKJS_PATH), destination);
    return;
  }
  const upstream = `https://github.com/quickjs-ng/quickjs/releases/download/v${manifest.quickJs.version}/${asset.name}`;
  const bytes = await downloadVerified(upstream, asset.sha256, { label: 'QuickJS' });
  writeFileSync(destination, bytes);
  if (!extension) chmodSync(destination, 0o755);
}

function assertQuickJs(program) {
  const version = spawnSync(program, ['--help'], { encoding: 'utf8' });
  const text = `${version.stdout || ''}\n${version.stderr || ''}`;
  if (version.status !== 0 || !text.includes(`QuickJS-ng version ${manifest.quickJs.version}`)) {
    throw new Error(`QuickJS-ng ${manifest.quickJs.version} is required`);
  }
  const smoke = spawnSync(program, ['-e', "console.log('ATVIDEO_QJS_OK')"], {
    encoding: 'utf8'
  });
  if (smoke.status !== 0 || !smoke.stdout.includes('ATVIDEO_QJS_OK')) {
    throw new Error(smoke.stderr || smoke.stdout || 'QuickJS execution smoke failed');
  }
}

function stageExecutable(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (!extension) chmodSync(destination, 0o755);
}

function rustHostTarget() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const match = output.match(/^host: (.+)$/m);
  if (!match) throw new Error('Unable to determine Rust host target');
  return match[1];
}
