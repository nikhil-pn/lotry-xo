// Loads the demo wallets' mnemonics from a file kept outside the repo (never committed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENV_FILE = process.env.LOTRY_ENV ?? path.join(os.homedir(), '.config/pi/lotry-xo.env');

export const readEnv = () => {
    if (!fs.existsSync(ENV_FILE)) return {};
    return Object.fromEntries(
        fs.readFileSync(ENV_FILE, 'utf8').split('\n')
            .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
            .map((line) => [ line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim() ]),
    );
};
