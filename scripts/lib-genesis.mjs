// A buyer's check that a round was opened honestly. The covenant cannot see the genesis transaction, so before
// paying for a ticket the buyer fetches it and checks: exactly one token of the round's category was created,
// it is the pot's minting NFT with no fungible amount and a zero ticket count, and it is locked to the pot covenant
// built from the round's public variables. A pre-minted ticket, a second minting NFT, fungible tokens of the
// category or a head-start count would all fail here.
import { createRequire } from 'node:module';
import { binToHex, decodeTransaction, hexToBin, sha256 } from '@bitauth/libauth';

const require = createRequire(import.meta.url);

const fetchTransactionHex = async (transactionHash) => {
    const { ElectrumClient } = await import(require.resolve('@electrum-cash/network'));
    for (const host of [ 'chipnet.imaginary.cash', 'chipnet.bch.ninja' ]) {
        const client = new ElectrumClient('lotry-genesis-check', '1.5', host);
        try {
            await client.connect();
            const hex = await client.request('blockchain.transaction.get', transactionHash);
            if (typeof hex === 'string') return hex;
        } catch {
            // try the next server
        } finally {
            await client.disconnect().catch(() => {});
        }
    }
    throw new Error(`Could not fetch the genesis transaction ${transactionHash}`);
};

/**
 * Whether a transaction paying a locking script is mined, from the script's Electrum history (height > 0 = in a block).
 * Uses only the standard scripthash API, which every Chipnet Electrum server supports.
 */
export const isMined = async (lockingBytecodeHex, transactionHash) => {
    const { ElectrumClient } = await import(require.resolve('@electrum-cash/network'));
    const scriptHash = binToHex(sha256.hash(hexToBin(lockingBytecodeHex)).reverse());
    for (const host of [ 'chipnet.imaginary.cash', 'chipnet.bch.ninja' ]) {
        const client = new ElectrumClient('lotry-confirmations', '1.5', host);
        try {
            await client.connect();
            const history = await client.request('blockchain.scripthash.get_history', scriptHash);
            if (Array.isArray(history)) return history.some((entry) => entry.tx_hash === transactionHash && entry.height > 0);
        } catch {
            // try the next server
        } finally {
            await client.disconnect().catch(() => {});
        }
    }
    throw new Error(`Could not read the history of script ${scriptHash}`);
};

const hexOrReversed = (bytes) => [ binToHex(bytes), binToHex(Uint8Array.from(bytes).reverse()) ];

/** Throws unless the round's open transaction created exactly the honest pot. Returns a one-line summary. */
export const verifyGenesis = async (round, expectedPotLockingBytecodeHex) => {
    const transaction = decodeTransaction(hexToBin(await fetchTransactionHex(round.openTransactionHash)));
    if (typeof transaction === 'string') throw new Error(`Genesis transaction does not decode: ${transaction}`);

    const [ firstInput ] = transaction.inputs;
    if (!hexOrReversed(firstInput.outpointTransactionHash).includes(round.roundCategory) || firstInput.outpointIndex !== 0) {
        throw new Error('Genesis: input 0 does not create this round\'s category');
    }
    const roundTokens = transaction.outputs
        .map((output, index) => ({ output, index }))
        .filter(({ output }) => output.token !== undefined && hexOrReversed(output.token.category).includes(round.roundCategory));
    if (roundTokens.length !== 1) throw new Error(`Genesis: ${roundTokens.length} outputs carry this round's tokens, expected exactly 1`);

    const [ { output, index } ] = roundTokens;
    if (index !== 0) throw new Error('Genesis: the pot is not output 0');
    if (output.token.amount !== 0n) throw new Error('Genesis: the pot carries fungible tokens');
    if (output.token.nft?.capability !== 'minting') throw new Error('Genesis: the pot NFT is not the minting NFT');
    if (binToHex(output.token.nft.commitment) !== '00000000') throw new Error('Genesis: the round did not start at zero tickets');
    if (binToHex(output.lockingBytecode) !== expectedPotLockingBytecodeHex) {
        throw new Error('Genesis: the pot is not locked to the covenant built from this round\'s variables');
    }
    return `one minting NFT, 0 tickets, locked to the pot covenant (${round.openTransactionHash.slice(0, 10)}…)`;
};
