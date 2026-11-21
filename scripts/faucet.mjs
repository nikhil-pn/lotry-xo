// Requests Chipnet test coins from chipnet.bch.ninja, doing the same proof of work its web page does.
// Usage: node scripts/faucet.mjs <bchtest:address> [satoshis]
import { createHash } from 'node:crypto';

const [ address, sats = '200000' ] = process.argv.slice(2);
if (address === undefined) throw new Error('Usage: node scripts/faucet.mjs <bchtest:address> [satoshis]');

const api = async (path, body) => {
    const response = await fetch(`https://chipnet.bch.ninja/api/${path}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
};

const challenge = await api('challenge', { address, sats });
const target = BigInt(`0x${challenge.target}`);
let nonce = 0n;
while (BigInt(`0x${createHash('sha256').update(`${challenge.payload}:${nonce}`).digest('hex')}`) > target) nonce += 1n;
const result = await api('claim', { payload: challenge.payload, signature: challenge.signature, nonce: nonce.toString() });
console.log(`${sats} sats -> ${address}: https://chipnet.imaginary.cash/tx/${result.txid} (fee ${result.fee})`);
