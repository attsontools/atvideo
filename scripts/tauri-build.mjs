import { spawnSync } from 'node:child_process';

import { releaseCargoEnv } from './release-cargo-env.mjs';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(pnpm, ['exec', 'tauri', 'build', ...process.argv.slice(2)], {
  env: releaseCargoEnv(),
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
