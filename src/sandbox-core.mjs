// A Lotry round you can play in a browser: every action builds a real transaction against the real pot covenant
// (compiled from the template) and runs it through libauth's BCH 2026 VM. Coins are simulated (no network) and the
// players' own coins are unlocked so anyone can try anything; the pot's rules are exactly the ones on chain.
import {
    bigIntToVmNumber, binToHex, createCompilerBch, createVirtualMachineBch2026, decodeAuthenticationInstructions, hexToBin, sha256,
} from '@bitauth/libauth';
import { lotryTemplate } from './lotry-template.mjs';

const PLAYERS = [ 'You', 'Alice', 'Bob' ];
const ANYONE = Uint8Array.of(0x51); // OP_1: the sandbox skips player signatures, never the covenant
const ORGANISER_LOCK = hexToBin(`76a914${'0a'.repeat(20)}88ac`);
const OPCODE_NAMES = { 0x88: 'OP_EQUALVERIFY', 0x69: 'OP_VERIFY', 0x9d: 'OP_NUMEQUALVERIFY', 0xb1: 'OP_CHECKLOCKTIMEVERIFY' };

const le4 = (number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, Number(number), true);
    return bytes;
};
const readLe4 = (bytes) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
const withMarker = (number, marker) => Uint8Array.from([ ...le4(number), marker ]);
const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

export const PHASE_MARKERS = { closed: 0xc1, drawn: 0xd0, refunding: 0xee };

export const readPhase = (commitment) => {
    if (commitment.length === 4) return { phase: 'open', number: readLe4(commitment) };
    const marker = commitment[4];
    const phase = Object.keys(PHASE_MARKERS).find((name) => PHASE_MARKERS[name] === marker);
    return { phase, number: readLe4(commitment) };
};

export const createSandbox = ({ ticketPrice = 20_000n, drawHeight = 10, refundHeight = 20, claimHeight = 30, seed = 2_000n } = {}) => {
    const vm = createVirtualMachineBch2026(true);
    const secret = randomBytes(32);
    const secretHash = sha256.hash(secret);
    const compiler = createCompilerBch({
        scripts: lotryTemplate.scripts,
        variables: Object.fromEntries([ 'ticketPrice', 'drawHeight', 'refundHeight', 'claimHeight', 'secretHash', 'roundSecret' ]
            .map((name) => [ name, { type: 'AddressData' } ])),
        lockingScriptTypes: { potRedeem: 'p2sh32' },
        unlockingScripts: { potBuyUnlock: 'potRedeem', potDrawUnlock: 'potRedeem', potClaimUnlock: 'potRedeem', potRefundUnlock: 'potRedeem', potCloseUnlock: 'potRedeem' },
        vm,
    });
    const data = (extra = {}) => ({
        bytecode: {
            ticketPrice: bigIntToVmNumber(ticketPrice),
            drawHeight: bigIntToVmNumber(BigInt(drawHeight)),
            refundHeight: bigIntToVmNumber(BigInt(refundHeight)),
            claimHeight: bigIntToVmNumber(BigInt(claimHeight)),
            secretHash,
            ...extra,
        },
    });
    const compile = (scriptId, extra) => {
        const result = compiler.generateBytecode({ scriptId, data: data(extra) });
        if (!result.success) throw new Error(`${scriptId}: ${JSON.stringify(result.errors)}`);
        return result.bytecode;
    };
    const potLock = compile('potRedeem');
    const unlock = {
        buy: compile('potBuyUnlock'),
        close: compile('potCloseUnlock'),
        draw: compile('potDrawUnlock', { roundSecret: secret }),
        drawWrongSecret: compile('potDrawUnlock', { roundSecret: randomBytes(32) }),
        claim: compile('potClaimUnlock'),
        refund: compile('potRefundUnlock'),
    };

    const category = randomBytes(32);
    const otherCategory = randomBytes(32);
    const newCoin = (lockingBytecode, valueSatoshis, token) => ({ outpointTransactionHash: randomBytes(32), outpointIndex: 0, lockingBytecode, valueSatoshis, token });

    const state = {
        height: 1,
        pot: newCoin(potLock, seed, { amount: 0n, category, nft: { capability: 'minting', commitment: le4(0) } }),
        tickets: [],
        balances: Object.fromEntries(PLAYERS.map((player) => [ player, 200_000n ])),
        organiserBalance: 50_000n,
        log: [],
        secretRevealed: false,
    };

    const potToken = (commitment) => ({ amount: 0n, category, nft: { capability: 'minting', commitment } });
    const ticketToken = (number, ticketCategory = category) => ({ amount: 0n, category: ticketCategory, nft: { capability: 'none', commitment: le4(number) } });
    const potPhase = () => readPhase(state.pot.token.nft.commitment);
    const winnerFor = (count) => BigInt(readLe4(sha256.hash(secret).slice(0, 4))) % BigInt(count) + 1n;

    // Explains where the covenant stopped: the failing opcode and how far into the pot's redeem script it was.
    const explainFailure = (transaction, sourceOutputs) => {
        try {
            const trace = vm.debug({ inputIndex: 0, sourceOutputs, transaction });
            const last = trace.at(-1);
            if (last?.error === undefined) return undefined;
            const instruction = last.instructions?.[last.ip - 1] ?? last.instructions?.[last.ip];
            const opcode = instruction ? (OPCODE_NAMES[instruction.opcode] ?? `opcode 0x${instruction.opcode.toString(16)}`) : 'a check';
            return { opcode, error: String(last.error) };
        } catch {
            return undefined;
        }
    };

    // Runs a transaction through the VM. Accepted transactions change the sandbox state through `apply`.
    const run = ({ label, actor, kind = 'honest', locktime = 0, inputs, outputs, apply, stoppedBy }) => {
        const transaction = {
            version: 2,
            locktime,
            inputs: inputs.map(({ coin, unlockingBytecode }) => ({
                outpointTransactionHash: coin.outpointTransactionHash, outpointIndex: coin.outpointIndex, sequenceNumber: 0, unlockingBytecode,
            })),
            outputs,
        };
        const sourceOutputs = inputs.map(({ coin }) => ({ lockingBytecode: coin.lockingBytecode, valueSatoshis: coin.valueSatoshis, token: coin.token }));
        const verdict = vm.verify({ transaction, sourceOutputs });
        const accepted = verdict === true;
        const entry = {
            label, actor, kind, accepted, height: state.height,
            transactionBytes: inputs.reduce((sum, { unlockingBytecode }) => sum + unlockingBytecode.length, 0) + 60 * inputs.length + 45 * outputs.length,
            error: accepted ? undefined : String(verdict).replace(/^Unable to verify transaction: error in evaluating input index \d+: /, ''),
            failure: accepted ? undefined : explainFailure(transaction, sourceOutputs),
            stoppedBy: accepted ? undefined : stoppedBy,
        };
        if (accepted) apply?.();
        state.log.unshift(entry);
        return entry;
    };

    const cannot = (label, actor, reason, kind = 'honest') => {
        const entry = { label, actor, kind, accepted: false, height: state.height, skipped: true, error: reason };
        state.log.unshift(entry);
        return entry;
    };

    const funding = (value) => newCoin(ANYONE, value, undefined);
    const potGone = () => state.pot.claimed === true;

    const actions = {
        // ---------- honest moves ----------
        buy(player, { pay = ticketPrice, extraTicket = false, ticketCapability = 'none', kind = 'honest', label } = {}) {
            const { phase, number: count } = potPhase();
            if (phase !== 'open' && kind === 'honest') return cannot('Buy a ticket', player, `Sales are ${phase === 'closed' ? 'closed' : 'over'}: the pot no longer sells tickets.`);
            if (potGone()) return cannot('Buy a ticket', player, 'The round is over: the pot was claimed.', kind);
            const coin = funding(100_000n);
            const next = count + 1;
            const outputs = [
                { lockingBytecode: potLock, valueSatoshis: state.pot.valueSatoshis + pay, token: potToken(le4(next)) },
                { lockingBytecode: ANYONE, valueSatoshis: 1_000n, token: { ...ticketToken(next), nft: { capability: ticketCapability, commitment: le4(next) } } },
                { lockingBytecode: ANYONE, valueSatoshis: 100_000n - pay - 1_000n - 2_000n, token: extraTicket ? ticketToken(next + 1) : undefined },
            ];
            return run({
                label: label ?? `${player} ${player === 'You' ? 'buy' : 'buys'} ticket #${next}`, actor: player, kind,
                inputs: [ { coin: state.pot, unlockingBytecode: unlock.buy }, { coin, unlockingBytecode: new Uint8Array() } ],
                outputs,
                apply: () => {
                    state.pot = { ...newCoin(potLock, outputs[0].valueSatoshis, outputs[0].token) };
                    state.tickets.push({ number: next, owner: player, coin: newCoin(ANYONE, 1_000n, ticketToken(next)) });
                    state.balances[player] -= pay + 1_000n + 2_000n;
                },
            });
        },

        advance(blocks) {
            state.height += blocks;
            return { label: `${blocks} lock heights pass`, actor: 'Time', kind: 'time', accepted: true, height: state.height };
        },

        close() {
            if (potGone()) return cannot('Close sales', 'Anyone', 'The round is over: the pot was claimed.');
            const { phase, number: count } = potPhase();
            if (phase !== 'open') return cannot('Close sales', 'Anyone', `The pot is already ${phase}.`);
            const fee = newCoin(ANYONE, 10_000n);
            const outputs = [ { lockingBytecode: potLock, valueSatoshis: state.pot.valueSatoshis, token: potToken(withMarker(count, PHASE_MARKERS.closed)) } ];
            return run({
                label: `Sales close at ${count} ticket${count === 1 ? '' : 's'}`, actor: 'Anyone', locktime: state.height,
                inputs: [ { coin: state.pot, unlockingBytecode: unlock.close }, { coin: fee, unlockingBytecode: new Uint8Array() } ],
                outputs,
                stoppedBy: state.height < drawHeight ? `Sales can only close from lock height ${drawHeight} (OP_CHECKLOCKTIMEVERIFY).` : undefined,
                apply: () => { state.pot = newCoin(potLock, outputs[0].valueSatoshis, outputs[0].token); },
            });
        },

        draw({ wrongSecret = false, claimedWinner, kind = 'honest', label } = {}) {
            if (potGone()) return cannot('Draw', 'Organiser', 'The round is over: the pot was claimed.', kind);
            const { phase, number: count } = potPhase();
            const winner = claimedWinner ?? (count > 0 ? winnerFor(count) : 1n);
            const fee = newCoin(ANYONE, 10_000n);
            const outputs = [ { lockingBytecode: potLock, valueSatoshis: state.pot.valueSatoshis, token: potToken(withMarker(winner, PHASE_MARKERS.drawn)) } ];
            return run({
                label: label ?? (phase === 'closed' ? `Organiser reveals the secret: ticket #${winner} wins` : 'Organiser tries to draw'), actor: 'Organiser', kind,
                inputs: [ { coin: state.pot, unlockingBytecode: wrongSecret ? unlock.drawWrongSecret : unlock.draw }, { coin: fee, unlockingBytecode: new Uint8Array() } ],
                outputs,
                stoppedBy: phase !== 'closed' ? 'The draw only runs on a closed pot, so the count is frozen before the secret is seen.' : undefined,
                apply: () => { state.pot = newCoin(potLock, outputs[0].valueSatoshis, outputs[0].token); state.secretRevealed = true; },
            });
        },

        claim(player, { ticketNumber, kind = 'honest', label } = {}) {
            if (potGone()) return cannot('Claim the pot', player, 'The pot was already claimed.', kind);
            const { phase, number } = potPhase();
            const ticket = state.tickets.find((candidate) => candidate.owner === player && (ticketNumber === undefined
                ? (phase === 'drawn' ? candidate.number === number : true) : candidate.number === ticketNumber));
            if (ticket === undefined) return cannot('Claim the pot', player, phase === 'drawn' ? `${player} doesn't hold ticket #${number}.` : `${player} holds no ticket.`, kind);
            const outputs = [ { lockingBytecode: ANYONE, valueSatoshis: state.pot.valueSatoshis + 1_000n - 1_000n } ];
            return run({
                label: label ?? `${player} ${player === 'You' ? 'claim' : 'claims'} the pot with ticket #${ticket.number}`, actor: player, kind,
                inputs: [ { coin: state.pot, unlockingBytecode: unlock.claim }, { coin: ticket.coin, unlockingBytecode: new Uint8Array() } ],
                outputs,
                apply: () => {
                    state.balances[player] += outputs[0].valueSatoshis;
                    state.tickets = state.tickets.filter((candidate) => candidate !== ticket);
                    state.pot = { ...state.pot, valueSatoshis: 0n, claimed: true };
                },
            });
        },

        refund(player, { fake = false, kind = 'honest', label } = {}) {
            if (potGone()) return cannot('Refund a ticket', player, 'The pot was already claimed.', kind);
            const { phase, number } = potPhase();
            const ticket = fake
                ? { number: 0, owner: player, coin: newCoin(ANYONE, 1_000n, { amount: 1n, category }) }
                : state.tickets.find((candidate) => candidate.owner === player);
            if (ticket === undefined) return cannot('Refund a ticket', player, `${player} holds no ticket.`, kind);
            const locktime = state.height;
            const outputs = [
                { lockingBytecode: potLock, valueSatoshis: state.pot.valueSatoshis - ticketPrice, token: potToken(withMarker(number, PHASE_MARKERS.refunding)) },
                { lockingBytecode: ANYONE, valueSatoshis: ticketPrice },
            ];
            return run({
                label: label ?? `${player} ${player === 'You' ? 'refund' : 'refunds'} ticket #${ticket.number}`, actor: player, kind, locktime,
                inputs: [ { coin: state.pot, unlockingBytecode: unlock.refund }, { coin: ticket.coin, unlockingBytecode: new Uint8Array() } ],
                outputs,
                stoppedBy: phase === 'drawn' && state.height < claimHeight ? `A drawn pot only refunds after the claim deadline (lock height ${claimHeight}).`
                    : state.height < refundHeight ? `Refunds open at lock height ${refundHeight}.` : undefined,
                apply: () => {
                    state.pot = newCoin(potLock, outputs[0].valueSatoshis, outputs[0].token);
                    state.tickets = state.tickets.filter((candidate) => candidate !== ticket);
                    state.balances[player] += ticketPrice;
                },
            });
        },
    };

    // ---------- ways to cheat: each is a real transaction the covenant must refuse ----------
    const attacks = {
        stealPot: {
            title: 'Organiser takes the pot',
            what: 'The organiser spends the pot and pays everything to himself.',
            stoppedBy: 'Every path re-creates the pot with the same value (or pays only the winner / a refund). There is no key path at all.',
            run: () => {
                if (potGone()) return cannot('Organiser takes the pot', 'Organiser', 'The pot was already claimed.', 'attack');
                const { phase } = potPhase();
                const fee = newCoin(ANYONE, 10_000n);
                // He picks whichever path the pot is in right now; none of them lets value leave to an arbitrary script.
                const path = { open: unlock.buy, closed: unlock.draw, drawn: unlock.claim, refunding: unlock.refund }[phase];
                return run({
                    label: 'Organiser sends the pot to himself', actor: 'Organiser', kind: 'attack', locktime: state.height,
                    inputs: [ { coin: state.pot, unlockingBytecode: path }, { coin: fee, unlockingBytecode: new Uint8Array() } ],
                    outputs: [ { lockingBytecode: ORGANISER_LOCK, valueSatoshis: state.pot.valueSatoshis } ],
                    stoppedBy: attacks.stealPot.stoppedBy,
                });
            },
        },
        freeTicket: {
            title: 'Mint a free extra ticket',
            what: 'A buyer pays for one ticket and slips a second ticket NFT into the change output.',
            stoppedBy: 'Buying mints exactly one ticket: any other output carrying a token is refused.',
            run: () => actions.buy('You', { extraTicket: true, kind: 'attack', label: 'You buy one ticket and mint a second for free' }),
        },
        underpay: {
            title: 'Pay less than the price',
            what: 'A buyer takes a ticket but adds only half the price to the pot.',
            stoppedBy: 'The pot must grow by exactly the ticket price.',
            run: () => actions.buy('You', { pay: ticketPrice / 2n, kind: 'attack', label: 'You pay half price for a ticket' }),
        },
        mintingTicket: {
            title: 'Buy a ticket that can mint',
            what: 'A buyer takes ticket #n with minting power, to print more tickets later.',
            stoppedBy: 'A ticket must be an immutable NFT: its category carries no capability byte.',
            run: () => actions.buy('You', { ticketCapability: 'minting', kind: 'attack', label: 'You buy a ticket that can mint more tickets' }),
        },
        earlyDraw: {
            title: 'Draw before sales close',
            what: 'The organiser reveals the secret while tickets are still on sale, so he could buy the winning one after.',
            stoppedBy: 'The draw only runs on a closed pot.',
            run: () => actions.draw({ kind: 'attack', label: 'Organiser draws while sales are open' }),
        },
        wrongWinner: {
            title: 'Write a different winner',
            what: 'The organiser reveals the secret but writes his friend\'s ticket number as the winner.',
            stoppedBy: 'The covenant computes sha256(secret) mod tickets + 1 itself and compares.',
            run: () => {
                const { phase, number } = potPhase();
                if (phase !== 'closed' || number < 2) return cannot('Write a different winner', 'Organiser', 'Needs a closed pot with at least two tickets: buy two tickets, pass the draw height and close sales first.', 'attack');
                const real = winnerFor(number);
                return actions.draw({ claimedWinner: real === BigInt(number) ? 1n : real + 1n, kind: 'attack', label: 'Organiser writes the wrong winner' });
            },
        },
        losingClaim: {
            title: 'Claim with a losing ticket',
            what: 'A player who didn\'t win spends the drawn pot with their own ticket.',
            stoppedBy: 'Input 1 must be the ticket whose number is written in the pot.',
            run: () => {
                const { phase, number } = potPhase();
                if (phase !== 'drawn') return cannot('Claim with a losing ticket', 'You', 'Needs a drawn pot: close sales and draw first.', 'attack');
                const loser = state.tickets.find((ticket) => ticket.number !== number);
                if (loser === undefined) return cannot('Claim with a losing ticket', 'You', 'Every remaining ticket is the winner.', 'attack');
                return actions.claim(loser.owner, { ticketNumber: loser.number, kind: 'attack', label: `${loser.owner} ${loser.owner === 'You' ? 'try' : 'tries'} to claim with losing ticket #${loser.number}` });
            },
        },
        fakeTicket: {
            title: 'Refund a fake ticket',
            what: 'Someone holding a fungible token of the round\'s category tries to pass it off as a ticket for a refund.',
            stoppedBy: 'A ticket must be an immutable NFT with a 4-byte number and no fungible amount.',
            run: () => actions.refund('You', { fake: true, kind: 'attack', label: 'You refund a fungible token posing as a ticket' }),
        },
    };

    return {
        state,
        actions,
        attacks,
        info: {
            ticketPrice, drawHeight, refundHeight, claimHeight, seed,
            category: binToHex(category),
            secretHash: binToHex(secretHash),
            potLockingBytecode: binToHex(potLock),
            covenantSource: lotryTemplate.scripts,
        },
        potPhase,
        revealSecret: () => (state.secretRevealed ? binToHex(secret) : undefined),
        decode: (bytes) => decodeAuthenticationInstructions(bytes),
        otherCategory,
    };
};
