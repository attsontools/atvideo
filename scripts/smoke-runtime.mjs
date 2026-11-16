import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertBridgeRuntime(result, manifest) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'YouTube bridge version smoke failed');
  }
  let versions;
  try {
    versions = JSON.parse(result.stdout);
  } catch {
    throw new Error('YouTube bridge returned invalid version JSON');
  }
  if (versions.ytDlp !== manifest.ytDlp.version || versions.ytDlpEjs !== manifest.ytDlpEjs.version) {
    throw new Error('YouTube bridge runtime versions do not match runtime-manifest.json');
  }
}

export function assertQuickJsRuntime(versionResult, executionResult, expectedVersion) {
  if (versionResult.error) throw versionResult.error;
  const versionOutput = `${versionResult.stdout || ''}\n${versionResult.stderr || ''}`;
  if (versionResult.status !== 0 || !versionOutput.includes(`QuickJS-ng version ${expectedVersion}`)) {
    throw new Error(`QuickJS-ng ${expectedVersion} is required`);
  }
  if (executionResult.error) throw executionResult.error;
  if (executionResult.status !== 0 || !executionResult.stdout.includes('ATVIDEO_QJS_OK')) {
    throw new Error(executionResult.stderr || executionResult.stdout || 'QuickJS execution smoke failed');
  }
}

export function assertServiceRuntime(result) {
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 1 || !output.includes('VIDEO_SERVICE_ARGUMENT_INVALID')) {
    throw new Error('Video service did not expose its stable argument boundary');
  }
}

function rustHostTarget() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('rustc -vV failed');
  const target = result.stdout.match(/^host: (.+)$/m)?.[1];
  if (!target) throw new Error('Unable to determine Rust host target');
  return target;
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(readFileSync(path.join(root, 'runtime-manifest.json'), 'utf8'));
  const target = process.env.ATVIDEO_RELEASE_TARGET || rustHostTarget();
  const extension = target.includes('windows') ? '.exe' : '';
  const binaryDirectory = path.join(root, 'src-tauri', 'binaries');
  const service = path.join(binaryDirectory, `atvideo-service-${target}${extension}`);
  const bridge = path.join(binaryDirectory, `youtube-bridge-${target}${extension}`);
  const quickjs = path.join(binaryDirectory, `qjs-${target}${extension}`);

  assertServiceRuntime(spawnSync(service, [], { encoding: 'utf8' }));
  assertBridgeRuntime(spawnSync(bridge, ['--runtime-version'], { encoding: 'utf8' }), manifest);
  assertQuickJsRuntime(
    spawnSync(quickjs, ['--help'], { encoding: 'utf8' }),
    spawnSync(quickjs, ['-e', "console.log('ATVIDEO_QJS_OK')"], { encoding: 'utf8' }),
    manifest.quickJs.version
  );
  console.log(`Video runtime smoke passed for ${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
