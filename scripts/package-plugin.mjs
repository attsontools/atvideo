import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseManifest } from '@attson/plugin-sdk';
import { signManifest, verifyManifestSignature } from '@attson/plugin-sdk/node';

const TARGETS = {
  'aarch64-apple-darwin': ['macos', 'aarch64', 'atvideo-service', 'youtube-bridge', 'qjs'],
  'x86_64-apple-darwin': ['macos', 'x86_64', 'atvideo-service', 'youtube-bridge', 'qjs'],
  'aarch64-unknown-linux-gnu': ['linux', 'aarch64', 'atvideo-service', 'youtube-bridge', 'qjs'],
  'x86_64-unknown-linux-gnu': ['linux', 'x86_64', 'atvideo-service', 'youtube-bridge', 'qjs'],
  'x86_64-pc-windows-msvc': ['windows', 'x86_64', 'atvideo-service.exe', 'youtube-bridge.exe', 'qjs.exe']
};
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_NATIVE_FILE_BYTES = 128 * 1024 * 1024;

export function resolveReleaseTarget(targetTriple) {
  const value = TARGETS[targetTriple];
  if (!value) throw new Error(`Unsupported release target: ${targetTriple}`);
  return {
    targetTriple,
    targetOs: value[0],
    targetArch: value[1],
    serviceFileName: value[2],
    bridgeFileName: value[3],
    quickjsFileName: value[4]
  };
}

export function requiredPayloadPaths(target) {
  return [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'licenses/QuickJS-ng-MIT.txt',
    'licenses/yt-dlp-UNLICENSE.txt',
    'licenses/yt-dlp-ejs-LICENSE.txt',
    `native/${target.serviceFileName}`,
    `native/${target.bridgeFileName}`,
    `native/${target.quickjsFileName}`,
    'runtime-manifest.json',
    'ui/index.html'
  ].sort();
}

export function assertPayloadSize(relative, size) {
  const limit = relative.startsWith('native/') ? MAX_NATIVE_FILE_BYTES : MAX_FILE_BYTES;
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    throw new Error(`Plugin payload is too large: ${relative}`);
  }
}

export function createPluginManifest({ version, target, publisherKeyId, files }) {
  for (const relative of requiredPayloadPaths(target)) {
    if (!files[relative]) throw new Error(`Plugin payload is missing ${relative}`);
  }
  assertPayloadLayout(target, files);
  const serviceEntry = `native/${target.serviceFileName}`;
  return parseManifest({
    schemaVersion: 1,
    appId: 'com.attson.video',
    name: '视频链接抽取',
    version,
    publisher: { id: 'com.attson', name: 'Attson', keyId: publisherKeyId },
    target: { os: target.targetOs, arch: target.targetArch },
    hostApi: { min: '2.0.0', max: '2.x' },
    ui: { entry: 'ui/index.html' },
    permissions: [
      'host.theme.read',
      'host.video.extract',
      'host.clipboard.write',
      'host.external.open',
      'host.app.activate'
    ],
    nativeService: {
      entry: serviceEntry,
      version,
      sha256: files[serviceEntry],
      protocolVersion: 1
    },
    files
  });
}

function assertPayloadLayout(target, files) {
  const allowedNonUi = new Set([
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'licenses/QuickJS-ng-MIT.txt',
    'licenses/yt-dlp-UNLICENSE.txt',
    'licenses/yt-dlp-ejs-LICENSE.txt',
    `native/${target.serviceFileName}`,
    `native/${target.bridgeFileName}`,
    `native/${target.quickjsFileName}`,
    'runtime-manifest.json'
  ]);
  const unexpected = Object.keys(files)
    .filter((relative) => !relative.startsWith('ui/') && !allowedNonUi.has(relative))
    .sort();
  if (unexpected.length > 0) {
    throw new Error(`Plugin contains unexpected non-UI payload: ${unexpected.join(', ')}`);
  }
}

export async function buildPluginPackage({ root, version, targetTriple, signing }) {
  const target = resolveReleaseTarget(targetTriple);
  const stage = await mkdtemp(path.join(tmpdir(), 'atvideo-plugin-'));
  const artifacts = path.join(root, 'artifacts');
  const output = path.join(
    artifacts,
    `AT.Video_${version}_${target.targetOs}_${target.targetArch}.atpkg`
  );
  try {
    await mkdir(path.join(stage, 'ui'), { recursive: true });
    await mkdir(path.join(stage, 'native'), { recursive: true });
    await mkdir(artifacts, { recursive: true });
    await cp(path.join(root, 'dist-plugin'), path.join(stage, 'ui'), { recursive: true });
    await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
    await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(stage, 'THIRD_PARTY_NOTICES.md'));
    await cp(path.join(root, 'licenses'), path.join(stage, 'licenses'), { recursive: true });
    await cp(path.join(root, 'runtime-manifest.json'), path.join(stage, 'runtime-manifest.json'));
    await cp(
      stagedBinary(root, 'atvideo-service', target),
      path.join(stage, 'native', target.serviceFileName)
    );
    await cp(
      stagedBinary(root, 'youtube-bridge', target),
      path.join(stage, 'native', target.bridgeFileName)
    );
    await cp(
      stagedBinary(root, 'qjs', target),
      path.join(stage, 'native', target.quickjsFileName)
    );

    const files = {};
    for (const relative of await collect(stage)) {
      const content = await readFile(path.join(stage, relative));
      assertPayloadSize(relative, content.byteLength);
      files[relative] = sha256(content);
    }
    const manifest = createPluginManifest({
      version,
      target,
      publisherKeyId: signing.keyId,
      files
    });
    const signature = signManifest(manifest, signing.privateKey);
    if (!verifyManifestSignature(manifest, signature, signing.publicKey)) {
      throw new Error('Local test signature verification failed');
    }
    await writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(stage, 'manifest.sig'), `${signature}\n`);
    await rm(output, { force: true });
    await archive(stage, output);
    await verifyPluginPackage(output, signing.publicKey, {
      version,
      publisherKeyId: signing.keyId,
      target
    });
    return { output, manifest };
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function buildTestPackage({ root, version, targetTriple }) {
  return buildPluginPackage({
    root,
    version,
    targetTriple,
    signing: localTestSigningKey()
  });
}

export function loadPublisherSigningConfig(env) {
  const keyId = env.ATVIDEO_PUBLISHER_KEY_ID?.trim();
  if (!keyId) throw new Error('ATVIDEO_PUBLISHER_KEY_ID is required');
  const encodedKey = env.ATVIDEO_PUBLISHER_PRIVATE_KEY?.trim();
  if (!encodedKey) throw new Error('ATVIDEO_PUBLISHER_PRIVATE_KEY is required');
  const encodedPublicKey = env.ATVIDEO_PUBLISHER_PUBLIC_KEY?.trim();
  if (!encodedPublicKey) throw new Error('ATVIDEO_PUBLISHER_PUBLIC_KEY is required');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedPublicKey)) {
    throw new Error('ATVIDEO_PUBLISHER_PUBLIC_KEY must be a raw Ed25519 public key');
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(encodedKey);
  } catch {
    throw new Error('ATVIDEO_PUBLISHER_PRIVATE_KEY must be an Ed25519 private key');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('ATVIDEO_PUBLISHER_PRIVATE_KEY must be an Ed25519 private key');
  }
  const publicKey = createPublicKey(privateKey);
  const derived = publicKey.export({ format: 'jwk' });
  const derivedRaw = Buffer.from(derived.x, 'base64url').toString('base64');
  if (derivedRaw !== encodedPublicKey) {
    throw new Error('Publisher private key does not match configured public key');
  }
  return { keyId, privateKey, publicKey };
}

export async function verifyPluginPackage(packagePath, publicKey, expected) {
  const expectedName = `AT.Video_${expected.version}_${expected.target.targetOs}_${expected.target.targetArch}.atpkg`;
  if (path.basename(packagePath) !== expectedName) {
    throw new Error(`Package file name must be ${expectedName}`);
  }
  const extracted = await mkdtemp(path.join(tmpdir(), 'atvideo-verify-'));
  try {
    extract(packagePath, extracted);
    const manifest = parseManifest(
      JSON.parse(await readFile(path.join(extracted, 'manifest.json'), 'utf8'))
    );
    const signature = (await readFile(path.join(extracted, 'manifest.sig'), 'utf8')).trim();
    if (!verifyManifestSignature(manifest, signature, publicKey)) {
      throw new Error('Plugin manifest signature is invalid');
    }
    requireEqual(manifest.appId, 'com.attson.video', 'app ID');
    requireEqual(manifest.version, expected.version, 'version');
    requireEqual(manifest.publisher.keyId, expected.publisherKeyId, 'Publisher Key ID');
    requireEqual(manifest.target.os, expected.target.targetOs, 'target OS');
    requireEqual(manifest.target.arch, expected.target.targetArch, 'target architecture');
    requireEqual(manifest.hostApi.min, '2.0.0', 'minimum Host API');
    requireEqual(manifest.hostApi.max, '2.x', 'maximum Host API');
    requireEqual(manifest.ui.entry, 'ui/index.html', 'main UI entry');
    requireEqual(
      JSON.stringify(manifest.permissions),
      JSON.stringify([
        'host.theme.read',
        'host.video.extract',
        'host.clipboard.write',
        'host.external.open',
        'host.app.activate'
      ]),
      'permissions'
    );
    requireEqual(
      manifest.nativeService?.entry,
      `native/${expected.target.serviceFileName}`,
      'native service entry'
    );
    requireEqual(manifest.nativeService?.version, expected.version, 'native service version');
    requireEqual(manifest.nativeService?.protocolVersion, 1, 'native service protocol');
    assertPayloadLayout(expected.target, manifest.files);
    for (const relative of requiredPayloadPaths(expected.target)) {
      if (!manifest.files[relative]) throw new Error(`Plugin payload is missing ${relative}`);
    }
    const actualFiles = (await collect(extracted))
      .filter((relative) => relative !== 'manifest.json' && relative !== 'manifest.sig');
    const declaredFiles = Object.keys(manifest.files).sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
      throw new Error('Package files do not match the manifest');
    }
    for (const relative of declaredFiles) {
      const content = await readFile(path.join(extracted, relative));
      assertPayloadSize(relative, content.byteLength);
      const actualHash = sha256(content);
      if (actualHash !== manifest.files[relative]) {
        throw new Error(`Package hash mismatch for ${relative}`);
      }
    }
    return manifest;
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}

function stagedBinary(root, baseName, target) {
  const extension = target.targetOs === 'windows' ? '.exe' : '';
  return path.join(
    root,
    'src-tauri',
    'binaries',
    `${baseName}-${target.targetTriple}${extension}`
  );
}

async function collect(directory, prefix = '') {
  const output = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) output.push(...await collect(directory, relative));
    else output.push(relative);
  }
  return output.sort();
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function localTestSigningKey() {
  const seed = Buffer.from(
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex'
  );
  const publicBytes = Buffer.from(
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    'hex'
  );
  const privateKey = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: seed.toString('base64url'),
      x: publicBytes.toString('base64url')
    },
    format: 'jwk'
  });
  return {
    keyId: 'attool-p0-test',
    privateKey,
    publicKey: createPublicKey(privateKey)
  };
}

function rustHostTarget() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('rustc -vV failed');
  const target = result.stdout.match(/^host: (.+)$/m)?.[1];
  if (!target) throw new Error('Unable to determine Rust host target');
  return target;
}

function run(program, args, cwd = process.cwd()) {
  const result = spawnSync(program, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed`);
}

async function archive(stage, output) {
  const entries = await collect(stage);
  if (process.platform === 'win32') {
    run('7z', ['a', '-tzip', '-mx=9', output, ...entries], stage);
  } else {
    run('zip', ['-X', '-D', '-q', output, ...entries], stage);
  }
}

function extract(packagePath, destination) {
  if (process.platform === 'win32') {
    run('7z', ['x', '-y', `-o${destination}`, packagePath]);
  } else {
    run('unzip', ['-q', packagePath, '-d', destination]);
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Package ${label} mismatch: expected ${expected}, received ${actual}`);
  }
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const signing = process.argv.includes('--test-signing')
    ? localTestSigningKey()
    : loadPublisherSigningConfig(process.env);
  const result = await buildPluginPackage({
    root,
    version: packageJson.version,
    targetTriple: process.env.ATVIDEO_RELEASE_TARGET || rustHostTarget(),
    signing
  });
  console.log(result.output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
