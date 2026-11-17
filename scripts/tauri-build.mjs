import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { releaseCargoEnv } from './release-cargo-env.mjs';

const require = createRequire(import.meta.url);
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js');
const tauriArguments = process.argv.slice(2);
if (tauriArguments[0] === '--') tauriArguments.shift();
const result = spawnSync(process.execPath, [tauriCli, 'build', ...tauriArguments], {
  env: releaseCargoEnv(),
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
