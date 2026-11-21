// Claims Chipnet coins from 2qx's on-chain faucet contracts (faucet.cash, the contract XO's faucet template encodes):
// each contract pays out 1000 sats (fee included) once its coin is a block old. Several contracts are funded, so one
// round of claims can hit each of them. Usage: node scripts/faucet-contract.mjs <bchtest:address> [rounds]
import { createRequire } from 'node:module';
import {
    bigIntToVmNumber, binToHex, cashAddressToLockingBytecode, createCompilerBch, encodeTransaction, hash160,
    sha256,
} from '@bitauth/libauth';
import { faucetCashTemplate } from '@xo-cash/templates';

const require = createRequire(import.meta.url);
const { ElectrumClient } = await import(require.resolve('@electrum-cash/network'));

const [ address, rounds = '1' ] = process.argv.slice(2);
const recipient = cashAddressToLockingBytecode(address);
if (typeof recipient === 'string') throw new Error(recipient);

const PERIOD = 1n;
const PAYOUT = 1000n;
const FEE = 300n; // ~1.4 sat/byte, so miners take it

const compiler = createCompilerBch({
    scripts: faucetCashTemplate.scripts,
    variables: { faucetIndex: { type: 'AddressData' }, payoutSatoshis: { type: 'AddressData' }, periodBlocks: { type: 'AddressData' } },
});

const redeemFor = (index) => {
    const result = compiler.generateBytecode({
        scriptId: 'faucetRedeemBytecode',
        data: { bytecode: { faucetIndex: bigIntToVmNumber(BigInt(index)), payoutSatoshis: bigIntToVmNumber(PAYOUT), periodBlocks: bigIntToVmNumber(PERIOD) } },
    });
    if (!result.success) throw new Error(JSON.stringify(result.errors));
    return result.bytecode;
};

const pushBytes = (bytes) => Uint8Array.from([ ...(bytes.length < 76 ? [ bytes.length ] : [ 0x4c, bytes.length ]), ...bytes ]);
const p2sh20 = (redeem) => Uint8Array.from([ 0xa9, 0x14, ...hash160(redeem), 0x87 ]);
const scriptHashOf = (lockingBytecode) => binToHex(sha256.hash(lockingBytecode).reverse());

const client = new ElectrumClient('lotry-faucet-claim', '1.5', 'chipnet.bch.ninja');
await client.connect();
let claimed = 0n;
for (let round = 0; round < Number(rounds); round += 1) {
    for (let index = 1; index <= 10; index += 1) {
        const redeem = redeemFor(index);
        const lockingBytecode = p2sh20(redeem);
        const unspent = await client.request('blockchain.scripthash.listunspent', scriptHashOf(lockingBytecode));
        const coin = Array.isArray(unspent) ? unspent.find((output) => output.height > 0 && output.value > Number(PAYOUT) * 2) : undefined;
        if (coin === undefined) continue;
        const transaction = {
            version: 2,
            locktime: 0,
            inputs: [ {
                outpointTransactionHash: Uint8Array.from(Buffer.from(coin.tx_hash, 'hex')),
                outpointIndex: coin.tx_pos,
                sequenceNumber: Number(PERIOD),
                unlockingBytecode: pushBytes(redeem),
            } ],
            outputs: [
                { lockingBytecode, valueSatoshis: BigInt(coin.value) - PAYOUT },
                { lockingBytecode: recipient.bytecode, valueSatoshis: PAYOUT - FEE },
            ],
        };
        const result = await client.request('blockchain.transaction.broadcast', binToHex(encodeTransaction(transaction)));
        if (typeof result === 'string' && result.length === 64) {
            claimed += PAYOUT - FEE;
            console.log(`faucet #${index}: ${PAYOUT - FEE} sats -> ${result}`);
        } else {
            console.log(`faucet #${index}: ${String(result).slice(0, 140)}`);
        }
    }
    if (round + 1 < Number(rounds)) await new Promise((resolve) => { setTimeout(resolve, 70_000); });
}
console.log(`claimed ${claimed} sats to ${address}`);
await client.disconnect();
process.exit(0);
