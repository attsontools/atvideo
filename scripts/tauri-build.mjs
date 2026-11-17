import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { releaseCargoEnv } from './release-cargo-env.mjs';

const require = createRequire(import.meta.url);
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js');
const result = spawnSync(process.execPath, [tauriCli, 'build', ...process.argv.slice(2)], {
  env: releaseCargoEnv(),
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
