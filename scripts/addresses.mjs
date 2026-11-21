// Prints one demo wallet's funding address and balance: node scripts/addresses.mjs ORGANISER|BUYER_A|BUYER_B
// The first receive address is remembered, so the same address is shown on every run.
import fs from 'node:fs';
import { closeWallet, openWallet, toCashAddress } from './lib-engine.mjs';

const name = process.argv[2] ?? 'ORGANISER';
const ADDRESS_FILE = 'state/funding-addresses.json';
const known = fs.existsSync(ADDRESS_FILE) ? JSON.parse(fs.readFileSync(ADDRESS_FILE, 'utf8')) : {};

const engine = await openWallet(name);
known[name] ??= toCashAddress(await engine.generateLockingBytecodeFromDefaultPolicy('receive'));
const outputs = await engine.listUnspentOutputs();
const satoshis = outputs.reduce((sum, output) => sum + BigInt(output.valueSatoshis ?? 0), 0n);
console.log(`${name.padEnd(10)} ${known[name]}  ${satoshis} sats in ${outputs.length} outputs`);
await closeWallet(engine);
fs.writeFileSync(ADDRESS_FILE, JSON.stringify(known, null, 2));
process.exit(0);
