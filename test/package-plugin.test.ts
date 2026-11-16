// @ts-nocheck
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  assertPayloadSize,
  createPluginManifest,
  loadPublisherSigningConfig,
  requiredPayloadPaths,
  resolveReleaseTarget
} from '../scripts/package-plugin.mjs';

const permissions = [
  'host.theme.read',
  'host.video.extract',
  'host.clipboard.write',
  'host.external.open',
  'host.app.activate'
];

function payload(target) {
  return Object.fromEntries(
    requiredPayloadPaths(target).map((path, index) => [path, String(index).padStart(64, 'a')])
  );
}

describe('video plugin package contract', () => {
  it('declares Host API 2 video permissions and all independent runtime files', () => {
    const target = resolveReleaseTarget('x86_64-unknown-linux-gnu');
    const manifest = createPluginManifest({
      version: '0.1.0-alpha.0',
      target,
      publisherKeyId: 'attool-p0-test',
      files: payload(target)
    });

    expect(manifest.appId).toBe('com.attson.video');
    expect(manifest.name).toBe('视频链接抽取');
    expect(manifest.hostApi).toEqual({ min: '2.0.0', max: '2.x' });
    expect(manifest.permissions).toEqual(permissions);
    expect(manifest.nativeService).toEqual({
      entry: 'native/atvideo-service',
      version: '0.1.0-alpha.0',
      sha256: payload(target)['native/atvideo-service'],
      protocolVersion: 1
    });
    expect(manifest.files).toHaveProperty('native/youtube-bridge');
    expect(manifest.files).toHaveProperty('native/qjs');
  });

  it('maps the five targets to service, bridge, and QuickJS filenames', () => {
    expect(resolveReleaseTarget('aarch64-apple-darwin')).toMatchObject({
      targetOs: 'macos',
      targetArch: 'aarch64',
      serviceFileName: 'atvideo-service',
      bridgeFileName: 'youtube-bridge',
      quickjsFileName: 'qjs'
    });
    expect(resolveReleaseTarget('x86_64-pc-windows-msvc')).toMatchObject({
      targetOs: 'windows',
      targetArch: 'x86_64',
      serviceFileName: 'atvideo-service.exe',
      bridgeFileName: 'youtube-bridge.exe',
      quickjsFileName: 'qjs.exe'
    });
    expect(() => resolveReleaseTarget('wasm32-unknown-unknown')).toThrow(/Unsupported/);
  });

  it('requires UI, native runtime, and complete third-party license payloads', () => {
    expect(requiredPayloadPaths(resolveReleaseTarget('x86_64-unknown-linux-gnu'))).toEqual([
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'licenses/QuickJS-ng-MIT.txt',
      'licenses/yt-dlp-UNLICENSE.txt',
      'licenses/yt-dlp-ejs-LICENSE.txt',
      'native/atvideo-service',
      'native/qjs',
      'native/youtube-bridge',
      'runtime-manifest.json',
      'ui/index.html'
    ]);
  });

  it('rejects undeclared native payloads while allowing signed UI assets', () => {
    const target = resolveReleaseTarget('x86_64-unknown-linux-gnu');
    const files = {
      ...payload(target),
      'ui/assets/app.js': 'f'.repeat(64)
    };
    expect(() => createPluginManifest({
      version: '0.1.0-alpha.0',
      target,
      publisherKeyId: 'attool-p0-test',
      files
    })).not.toThrow();
    expect(() => createPluginManifest({
      version: '0.1.0-alpha.0',
      target,
      publisherKeyId: 'attool-p0-test',
      files: { ...files, 'native/psd-bridge': 'f'.repeat(64) }
    })).toThrow(/unexpected non-UI payload/);
  });

  it('rejects payloads above the Host package limits', () => {
    expect(() => assertPayloadSize('native/atvideo-service', 128 * 1024 * 1024))
      .not.toThrow();
    expect(() => assertPayloadSize('native/atvideo-service', 128 * 1024 * 1024 + 1))
      .toThrow(/too large/);
  });

  it('accepts only a matching Ed25519 production Publisher key pair', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicRaw = Buffer.from(
      publicKey.export({ format: 'jwk' }).x,
      'base64url'
    ).toString('base64');

    const signing = loadPublisherSigningConfig({
      ATVIDEO_PUBLISHER_KEY_ID: 'attson-video-2026-01',
      ATVIDEO_PUBLISHER_PRIVATE_KEY: privatePem,
      ATVIDEO_PUBLISHER_PUBLIC_KEY: publicRaw
    });

    expect(signing.keyId).toBe('attson-video-2026-01');
    expect(signing.privateKey.asymmetricKeyType).toBe('ed25519');
  });

  it('rejects missing and mismatched production Publisher keys', () => {
    const pair = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const wrongPublicRaw = Buffer.from(
      other.publicKey.export({ format: 'jwk' }).x,
      'base64url'
    ).toString('base64');

    expect(() => loadPublisherSigningConfig({})).toThrow(/KEY_ID is required/);
    expect(() => loadPublisherSigningConfig({
      ATVIDEO_PUBLISHER_KEY_ID: 'attson-video-2026-01',
      ATVIDEO_PUBLISHER_PRIVATE_KEY: privatePem,
      ATVIDEO_PUBLISHER_PUBLIC_KEY: wrongPublicRaw
    })).toThrow(/does not match/);
  });
});
