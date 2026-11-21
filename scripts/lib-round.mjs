// Round bookkeeping shared by the CLI steps.
// Public round data and every invitation go to rounds/<id>/ (committed, so anyone can inspect them).
// The organiser's secret goes to state/secrets/ (git-ignored) until the draw reveals it on chain.
import fs from 'node:fs';
import path from 'node:path';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { serializeInvitation, deserializeInvitation } from '@xo-cash/utils';

export const EXPLORER = 'https://chipnet.imaginary.cash';
export const txLink = (transactionHash) => `${EXPLORER}/tx/${transactionHash}`;

const json = (value) => JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Uint8Array) return binToHex(item);
    return item;
}, 2);

export const roundDirectory = (roundId) => path.join('rounds', roundId);

export const readRound = (roundId) => JSON.parse(fs.readFileSync(path.join(roundDirectory(roundId), 'round.json'), 'utf8'));

export const writeRound = (round) => {
    fs.mkdirSync(path.join(roundDirectory(round.roundId), 'invitations'), { recursive: true });
    fs.writeFileSync(path.join(roundDirectory(round.roundId), 'round.json'), `${json(round)}\n`);
};

export const latestRoundId = () => {
    if (!fs.existsSync('rounds')) throw new Error('No rounds yet: run "open" first');
    const ids = fs.readdirSync('rounds').filter((name) => fs.existsSync(path.join('rounds', name, 'round.json'))).sort();
    if (ids.length === 0) throw new Error('No rounds yet: run "open" first');
    return ids.at(-1);
};

const secretFile = (roundId) => path.join('state', 'secrets', `${roundId}.json`);

export const writeSecret = (roundId, secret) => {
    fs.mkdirSync(path.dirname(secretFile(roundId)), { recursive: true });
    fs.writeFileSync(secretFile(roundId), `${json({ roundId, secret })}\n`, { mode: 0o600 });
};

export const readSecret = (roundId) => hexToBin(JSON.parse(fs.readFileSync(secretFile(roundId), 'utf8')).secret);

// Invitations are written exactly as XO serializes them, so they can be pasted into the XO debug tool.
export const saveInvitation = (roundId, name, invitation) => {
    const file = path.join(roundDirectory(roundId), 'invitations', `${name}.json`);
    fs.writeFileSync(file, serializeInvitation(invitation));
    return file;
};

export const loadInvitation = (roundId, name) =>
    deserializeInvitation(fs.readFileSync(path.join(roundDirectory(roundId), 'invitations', `${name}.json`), 'utf8'));

// One line per on-chain step: the proof table in the README is built from this.
export const logStep = (roundId, step) => {
    fs.appendFileSync(path.join(roundDirectory(roundId), 'steps.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...step })}\n`);
};

export const readSteps = (roundId) => {
    const file = path.join(roundDirectory(roundId), 'steps.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

export const stringify = json;
