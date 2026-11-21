// Creates the three Chipnet demo wallets (organiser + two buyers) once, and stores their mnemonics outside the repo.
import fs from 'node:fs';
import path from 'node:path';
import { generateBip39Mnemonic } from '@bitauth/libauth';
import { ENV_FILE, readEnv } from './lib-env.mjs';

const env = readEnv();
const names = [ 'ORGANISER_MNEMONIC', 'BUYER_A_MNEMONIC', 'BUYER_B_MNEMONIC' ];
const missing = names.filter((name) => env[name] === undefined);
if (missing.length === 0) {
    console.log(`All wallets already exist in ${ENV_FILE}`);
    process.exit(0);
}
fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
const lines = missing.map((name) => `${name}=${generateBip39Mnemonic()}`);
fs.appendFileSync(ENV_FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
fs.chmodSync(ENV_FILE, 0o600);
console.log(`Created ${missing.join(', ')} in ${ENV_FILE}`);
