// Computes a round's NFT commitments with the template's own CashAssembly formulas, so clients and the
// covenant can never disagree about the encoding. Values are hex strings, as XO token_commitment variables expect.
import {
    bigIntToVmNumber, binToHex, createCompilerBch, createVirtualMachineBch2026, decodeAuthenticationInstructions, hexToBin,
} from '@bitauth/libauth';
import { lotryTemplate } from './lotry-template.mjs';

const compiler = createCompilerBch({
    scripts: {
        ...lotryTemplate.scripts,
        pushOpenCommitment: '<$(openCommitment)>',
        pushNextOpenCommitment: '<$(nextOpenCommitment)>',
        pushDrawnCommitment: '<$(drawnCommitment)>',
        pushRefundingCommitment: '<$(refundingCommitment)>',
        pushClosedCommitment: '<$(closedCommitment)>',
    },
    variables: {
        ticketCount: { type: 'AddressData' },
        roundSecret: { type: 'AddressData' },
        ticketPrice: { type: 'AddressData' },
        drawHeight: { type: 'AddressData' },
        refundHeight: { type: 'AddressData' },
        claimHeight: { type: 'AddressData' },
        secretHash: { type: 'AddressData' },
    },
    lockingScriptTypes: { potRedeem: 'p2sh32' },
    vm: createVirtualMachineBch2026(),
});

const evaluate = (scriptId, bytecode) => {
    const result = compiler.generateBytecode({ scriptId, data: { bytecode } });
    if (!result.success) throw new Error(`${scriptId}: ${JSON.stringify(result.errors)}`);
    const [ instruction ] = decodeAuthenticationInstructions(result.bytecode);
    return binToHex(instruction.data ?? new Uint8Array());
};

const count = (ticketCount) => bigIntToVmNumber(BigInt(ticketCount));

/** Pot commitment of an open round with this many tickets sold. */
export const openCommitment = (ticketCount) => evaluate('pushOpenCommitment', { ticketCount: count(ticketCount) });

/** Pot commitment after one more ticket; also the new ticket's own commitment (its number). */
export const nextOpenCommitment = (ticketCount) => evaluate('pushNextOpenCommitment', { ticketCount: count(ticketCount) });

/** Pot commitment after the draw: the winning number, then the 0xd0 marker. */
export const drawnCommitment = (roundSecretHex, ticketCount) =>
    evaluate('pushDrawnCommitment', { roundSecret: hexToBin(roundSecretHex), ticketCount: count(ticketCount) });

/** Pot commitment once sales close: the count, then the 0xc1 marker. */
export const closedCommitment = (ticketCount) => evaluate('pushClosedCommitment', { ticketCount: count(ticketCount) });

/** Pot commitment after the first refund of an open round: the count, then the 0xee marker (only refunds from then on). */
export const refundingCommitment = (ticketCount) => evaluate('pushRefundingCommitment', { ticketCount: count(ticketCount) });

/** Pot commitment after any refund: the covenant keeps the first 4 bytes and sets the 0xee marker. */
export const afterRefundCommitment = (commitmentHex) => `${commitmentHex.slice(0, 8)}ee`;

/** The pot's P2SH32 locking bytecode for a round, compiled from the template (used to check a round's genesis). */
export const potLockingBytecode = (round) => {
    const result = compiler.generateBytecode({
        scriptId: 'potRedeem',
        data: {
            bytecode: {
                ticketPrice: bigIntToVmNumber(BigInt(round.ticketPrice)),
                drawHeight: bigIntToVmNumber(BigInt(round.drawHeight)),
                refundHeight: bigIntToVmNumber(BigInt(round.refundHeight)),
                claimHeight: bigIntToVmNumber(BigInt(round.claimHeight)),
                secretHash: hexToBin(round.secretHash),
            },
        },
    });
    if (!result.success) throw new Error(`potRedeem: ${JSON.stringify(result.errors)}`);
    return binToHex(result.bytecode);
};

/** Reads a pot or ticket commitment back into numbers. */
export const parseCommitment = (commitmentHex) => {
    const bytes = hexToBin(commitmentHex);
    const number = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    if (bytes.length === 4) return { phase: 'open', ticketCount: number, ticketNumber: number };
    if (bytes.length === 5 && bytes[4] === 0xd0) return { phase: 'drawn', winningTicket: number };
    if (bytes.length === 5 && bytes[4] === 0xc1) return { phase: 'closed', ticketCount: number };
    if (bytes.length === 5 && bytes[4] === 0xee) return { phase: 'refunding', number };
    throw new Error(`Not a Lotry commitment: ${commitmentHex}`);
};
