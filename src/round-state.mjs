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
    },
    variables: { ticketCount: { type: 'AddressData' }, roundSecret: { type: 'AddressData' } },
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

/** Reads a pot or ticket commitment back into numbers. */
export const parseCommitment = (commitmentHex) => {
    const bytes = hexToBin(commitmentHex);
    const number = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    if (bytes.length === 4) return { phase: 'open', ticketCount: number, ticketNumber: number };
    if (bytes.length === 5 && bytes[4] === 0xd0) return { phase: 'drawn', winningTicket: number };
    throw new Error(`Not a Lotry commitment: ${commitmentHex}`);
};
