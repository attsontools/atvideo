import { homedir } from 'node:os';

const FLAG_SEPARATOR = '\x1f';

export function releaseCargoEnv(environment = process.env, homeDirectory = homedir()) {
  const cargoEnv = { ...environment };
  const remapPathFlag = `--remap-path-prefix=${homeDirectory}=/build`;
  const flags = cargoEnv.CARGO_ENCODED_RUSTFLAGS
    ? cargoEnv.CARGO_ENCODED_RUSTFLAGS.split(FLAG_SEPARATOR).filter(Boolean)
    : (cargoEnv.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
  if (!flags.includes(remapPathFlag)) flags.push(remapPathFlag);
  cargoEnv.CARGO_ENCODED_RUSTFLAGS = flags.join(FLAG_SEPARATOR);
  delete cargoEnv.RUSTFLAGS;
  return cargoEnv;
}
