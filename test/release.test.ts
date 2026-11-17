// @ts-nocheck
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assertVersionAlignment,
  expectedReleaseAssets
} from '../scripts/verify-release.mjs';

describe('Video release contract', () => {
  it('requires the tag and all four project versions to match', () => {
    expect(assertVersionAlignment({
      tagName: 'v0.1.0-alpha.1',
      packageVersion: '0.1.0-alpha.1',
      tauriVersion: '0.1.0-alpha.1',
      serviceCargoVersion: '0.1.0-alpha.1',
      tauriCargoVersion: '0.1.0-alpha.1'
    })).toBe('0.1.0-alpha.1');

    expect(() => assertVersionAlignment({
      tagName: 'v0.1.0-alpha.1',
      packageVersion: '0.1.0-alpha.0',
      tauriVersion: '0.1.0-alpha.1',
      serviceCargoVersion: '0.1.0-alpha.1',
      tauriCargoVersion: '0.1.0-alpha.1'
    })).toThrow(/must all match/);
  });

  it('requires exactly five installers and five plugin packages', () => {
    const assets = expectedReleaseAssets('0.1.0-alpha.1');

    expect(assets).toHaveLength(10);
    expect(assets).toContain('AT.Video_0.1.0-alpha.1_windows_x86_64.exe');
    expect(assets).toContain('AT.Video_0.1.0-alpha.1_linux_aarch64.atpkg');
    expect(assets).toContain('AT.Video_0.1.0-alpha.1_macos_x86_64.dmg');
  });

  it('declares the five-target production build and tag-only release', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    for (const target of [
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'aarch64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
      'x86_64-pc-windows-msvc'
    ]) expect(workflow).toContain(target);
    expect(workflow).toContain('environment: prod');
    expect(workflow).toContain('ATVIDEO_PUBLISHER_PRIVATE_KEY');
    expect(workflow.match(/Install Linux dependencies/g)).toHaveLength(2);
    expect(workflow).toContain('pnpm install:youtube-deps');
    expect(workflow).toContain('pnpm smoke:runtime');
    expect(workflow).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    expect(workflow).toContain('scripts/verify-release.mjs assets');
    expect(workflow).toContain('find "src-tauri/target" -type f -path \'*/release/bundle/*\'');
    expect(workflow).not.toContain('target/${{ matrix.target }}/release/bundle');
  });

  it('installs the shipped Python runtime only through the checksum verifier', () => {
    const requirements = readFileSync('python/requirements-build.txt', 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);

    expect(requirements).toEqual(['PyInstaller==6.16.0']);
  });

  it('bundles runtime notices and the pinned manifest with the standalone application', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));

    expect(config.bundle.resources).toEqual({
      '../LICENSE': 'licenses/LICENSE',
      '../THIRD_PARTY_NOTICES.md': 'licenses/THIRD_PARTY_NOTICES.md',
      '../licenses/QuickJS-ng-MIT.txt': 'licenses/QuickJS-ng-MIT.txt',
      '../licenses/yt-dlp-UNLICENSE.txt': 'licenses/yt-dlp-UNLICENSE.txt',
      '../licenses/yt-dlp-ejs-LICENSE.txt': 'licenses/yt-dlp-ejs-LICENSE.txt',
      '../runtime-manifest.json': 'runtime-manifest.json'
    });
  });

  it('pins the plugin SDK with Video permissions to an immutable proxy URL', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const lockfile = readFileSync('pnpm-lock.yaml', 'utf8');
    const dependency = packageJson.dependencies['@attson/plugin-sdk'];
    const expected = 'https://gh-proxy.com/https://github.com/attsontools/attool-plugin-sdk/archive/7300706aa5b492cd3ef6e8e5a88153cb81ac61e0.tar.gz';

    expect(dependency).toBe(expected);
    expect(lockfile).toContain(expected);
  });
});
