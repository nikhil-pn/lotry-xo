// Runs every path of the Lotry pot covenant in libauth's BCH 2026 virtual machine, using the template's own scripts.
// Each happy path is followed by the attacks it must refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    bigIntToVmNumber,
    createCompilerBch,
    decodeAuthenticationInstructions,
    createVirtualMachineBch2026,
    hexToBin,
    utf8ToBin,
} from '@bitauth/libauth';
import { lotryTemplate } from '../src/lotry-template.mjs';

const vm = createVirtualMachineBch2026(true);

const ROUND = {
    ticketPrice: 20_000n,
    drawHeight: 300_000n,
    refundHeight: 300_500n,
    secret: hexToBin('6c6f7472792d6f6e2d786f2d726f756e642d736563726574212121212121212121'),
};
ROUND.secretHash = new Uint8Array(createHash('sha256').update(ROUND.secret).digest());

const compiler = createCompilerBch({
    scripts: {
        ...lotryTemplate.scripts,
        // Test-only wrappers that push the result of the template's off-chain expressions.
        evaluateDrawnCommitment: '<$(drawnCommitment)>',
        evaluateNextOpenCommitment: '<$(nextOpenCommitment)>',
    },
    variables: Object.fromEntries([ 'ticketPrice', 'drawHeight', 'refundHeight', 'secretHash', 'roundSecret', 'ticketCount' ]
        .map((name) => [ name, { type: 'AddressData' } ])),
    lockingScriptTypes: { potRedeem: 'p2sh32' },
    unlockingScripts: {
        potBuyUnlock: 'potRedeem',
        potDrawUnlock: 'potRedeem',
        potClaimUnlock: 'potRedeem',
        potRefundUnlock: 'potRedeem',
    },
    vm,
});

const bytecodeData = (extra = {}) => ({
    bytecode: {
        ticketPrice: bigIntToVmNumber(ROUND.ticketPrice),
        drawHeight: bigIntToVmNumber(ROUND.drawHeight),
        refundHeight: bigIntToVmNumber(ROUND.refundHeight),
        secretHash: ROUND.secretHash,
        ...extra,
    },
});

const compile = (scriptId, extra) => {
    const result = compiler.generateBytecode({ scriptId, data: bytecodeData(extra) });
    if (!result.success) throw new Error(`${scriptId}: ${JSON.stringify(result.errors)}`);
    return result.bytecode;
};

const POT_LOCK = compile('potRedeem');
const UNLOCK = {
    buy: compile('potBuyUnlock'),
    draw: compile('potDrawUnlock', { roundSecret: ROUND.secret }),
    drawWrongSecret: compile('potDrawUnlock', { roundSecret: utf8ToBin('not the secret') }),
    claim: compile('potClaimUnlock'),
    refund: compile('potRefundUnlock'),
};

// Anyone-can-spend stand-ins for player coins: the covenant only looks at their tokens, never at who signs.
const PLAYER_LOCK = Uint8Array.of(0x51);
const PAYOUT_LOCK = hexToBin('76a914' + '11'.repeat(20) + '88ac');
const OTHER_LOCK = hexToBin('76a914' + '22'.repeat(20) + '88ac');

const CATEGORY = hexToBin('ab'.repeat(32));
const OTHER_CATEGORY = hexToBin('cd'.repeat(32));

const le4 = (number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, Number(number), true);
    return bytes;
};
const openCommitment = (count) => le4(count);
const drawnCommitment = (winner) => Uint8Array.from([ ...le4(winner), 0xd0 ]);

const winnerFor = (secret, count) => {
    const digest = createHash('sha256').update(secret).digest();
    return BigInt(digest.readUInt32LE(0)) % BigInt(count) + 1n;
};

const potToken = (commitment, category = CATEGORY) => ({ amount: 0n, category, nft: { capability: 'minting', commitment } });
const ticketToken = (number, category = CATEGORY) => ({ amount: 0n, category, nft: { capability: 'none', commitment: le4(number) } });

const outpoint = (byte, index = 0) => ({ outpointTransactionHash: hexToBin(byte.repeat(32)), outpointIndex: index });

// Builds and verifies one transaction. Returns true or the VM's error message.
const run = ({ inputs, outputs, locktime = 0 }) => {
    const transaction = {
        version: 2,
        locktime,
        inputs: inputs.map(({ unlockingBytecode, spends, sequenceNumber = 0 }, index) => ({
            ...outpoint(String(index + 1).padStart(2, '0'), 0),
            sequenceNumber,
            unlockingBytecode,
            ...(spends.outpoint ?? {}),
        })),
        outputs,
    };
    const sourceOutputs = inputs.map(({ spends }) => ({ lockingBytecode: spends.lockingBytecode, valueSatoshis: spends.valueSatoshis, token: spends.token }));
    const result = vm.verify({ transaction, sourceOutputs });
    return result === true ? true : String(result);
};

const accepts = (spec) => assert.equal(run(spec), true);
const rejects = (spec) => {
    const result = run(spec);
    if (process.env.SHOW_REJECTIONS) console.log(`    -> ${result}`);
    assert.notEqual(result, true);
};

const pot = (valueSatoshis, commitment) => ({ lockingBytecode: POT_LOCK, valueSatoshis, token: potToken(commitment) });
const funding = (valueSatoshis) => ({ lockingBytecode: PLAYER_LOCK, valueSatoshis });

// ---------- buy ----------
const buySpec = ({ count = 0n, potValue = 50_000n, overrides = {} } = {}) => ({
    inputs: [
        { unlockingBytecode: UNLOCK.buy, spends: pot(potValue, openCommitment(count)) },
        { unlockingBytecode: new Uint8Array(), spends: funding(100_000n) },
    ],
    outputs: overrides.outputs ?? [
        { lockingBytecode: POT_LOCK, valueSatoshis: potValue + ROUND.ticketPrice, token: potToken(openCommitment(count + 1n)) },
        { lockingBytecode: PLAYER_LOCK, valueSatoshis: 1_000n, token: ticketToken(count + 1n) },
        { lockingBytecode: PLAYER_LOCK, valueSatoshis: 78_000n },
    ],
});

test('buy: first ticket is #1 and the pot grows by the price', () => accepts(buySpec()));
test('buy: the 42nd ticket is #42', () => accepts(buySpec({ count: 41n })));
test('buy: works without a change output', () => {
    const spec = buySpec();
    spec.outputs = spec.outputs.slice(0, 2);
    accepts(spec);
});

test('buy refuses: paying less than the ticket price', () => {
    const spec = buySpec();
    spec.outputs[0] = { ...spec.outputs[0], valueSatoshis: 50_000n + ROUND.ticketPrice - 1n };
    rejects(spec);
});
test('buy refuses: skipping a ticket number', () => {
    const spec = buySpec();
    spec.outputs[1] = { ...spec.outputs[1], token: ticketToken(2n) };
    rejects(spec);
});
test('buy refuses: pot count and ticket number disagree', () => {
    const spec = buySpec();
    spec.outputs[0] = { ...spec.outputs[0], token: potToken(openCommitment(5n)) };
    rejects(spec);
});
test('buy refuses: minting a second ticket in the change output', () => {
    const spec = buySpec();
    spec.outputs[2] = { ...spec.outputs[2], token: ticketToken(1n) };
    rejects(spec);
});
test('buy refuses: a ticket with minting power', () => {
    const spec = buySpec();
    spec.outputs[1] = { ...spec.outputs[1], token: { ...ticketToken(1n), nft: { capability: 'minting', commitment: le4(1n) } } };
    rejects(spec);
});
test('buy refuses: moving the pot to another script', () => {
    const spec = buySpec();
    spec.outputs[0] = { ...spec.outputs[0], lockingBytecode: OTHER_LOCK };
    rejects(spec);
});
test('buy refuses: a fourth output', () => {
    const spec = buySpec();
    spec.outputs.push({ lockingBytecode: PLAYER_LOCK, valueSatoshis: 1_000n });
    spec.outputs[2] = { ...spec.outputs[2], valueSatoshis: 77_000n };
    rejects(spec);
});
test('buy refuses: buying into a drawn pot', () => {
    const spec = buySpec();
    spec.inputs[0] = { ...spec.inputs[0], spends: pot(50_000n, drawnCommitment(1n)) };
    rejects(spec);
});
test('buy refuses: the pot at input 1', () => {
    const spec = buySpec();
    spec.inputs.reverse();
    rejects(spec);
});

// ---------- draw ----------
const drawSpec = ({ count = 3n, potValue = 61_000n, locktime = Number(ROUND.drawHeight), unlock = UNLOCK.draw, winner } = {}) => ({
    locktime,
    inputs: [
        { unlockingBytecode: unlock, spends: pot(potValue, openCommitment(count)) },
        { unlockingBytecode: new Uint8Array(), spends: funding(10_000n) },
    ],
    outputs: [
        { lockingBytecode: POT_LOCK, valueSatoshis: potValue, token: potToken(drawnCommitment(winner ?? winnerFor(ROUND.secret, count))) },
        { lockingBytecode: PLAYER_LOCK, valueSatoshis: 9_000n },
    ],
});

test('draw: the secret picks sha256(secret) mod tickets + 1', () => accepts(drawSpec()));
test('draw: one ticket always wins', () => accepts(drawSpec({ count: 1n })));
test('draw: works on a big round', () => accepts(drawSpec({ count: 997n })));

test('draw refuses: before the draw height', () => rejects(drawSpec({ locktime: Number(ROUND.drawHeight) - 1 })));
test('draw refuses: the wrong secret', () => rejects(drawSpec({ unlock: UNLOCK.drawWrongSecret })));
test('draw refuses: writing a different winner', () => {
    const real = winnerFor(ROUND.secret, 3n);
    rejects(drawSpec({ winner: real === 3n ? 1n : real + 1n }));
});
test('draw refuses: a round with no tickets', () => rejects(drawSpec({ count: 0n, winner: 1n })));
test('draw refuses: taking satoshis out of the pot', () => {
    const spec = drawSpec();
    spec.outputs[0] = { ...spec.outputs[0], valueSatoshis: 60_000n };
    rejects(spec);
});
test('draw refuses: minting a ticket during the draw', () => {
    const spec = drawSpec();
    spec.outputs[1] = { ...spec.outputs[1], token: ticketToken(1n) };
    rejects(spec);
});

// ---------- claim ----------
const claimSpec = ({ winner = 2n, ticketNumber = 2n, ticketCategory = CATEGORY, potCommitment } = {}) => ({
    inputs: [
        { unlockingBytecode: UNLOCK.claim, spends: pot(61_000n, potCommitment ?? drawnCommitment(winner)) },
        { unlockingBytecode: new Uint8Array(), spends: { lockingBytecode: PLAYER_LOCK, valueSatoshis: 1_000n, token: ticketToken(ticketNumber, ticketCategory) } },
    ],
    outputs: [ { lockingBytecode: PAYOUT_LOCK, valueSatoshis: 61_000n } ],
});

test('claim: the winning ticket takes the whole pot', () => accepts(claimSpec()));

test('claim refuses: a losing ticket', () => rejects(claimSpec({ ticketNumber: 3n })));
test('claim refuses: a winning number from another round', () => rejects(claimSpec({ ticketCategory: OTHER_CATEGORY })));
test('claim refuses: claiming before the draw', () => rejects(claimSpec({ potCommitment: openCommitment(3n) })));
test('claim refuses: keeping the minting NFT', () => {
    const spec = claimSpec();
    spec.outputs[0] = { ...spec.outputs[0], valueSatoshis: 60_000n, token: potToken(drawnCommitment(2n)) };
    rejects(spec);
});
test('claim refuses: keeping the ticket', () => {
    const spec = claimSpec();
    spec.outputs = [ { lockingBytecode: PAYOUT_LOCK, valueSatoshis: 59_000n }, { lockingBytecode: PLAYER_LOCK, valueSatoshis: 1_000n, token: ticketToken(2n) } ];
    rejects(spec);
});

// ---------- refund ----------
const refundSpec = ({ locktime = Number(ROUND.refundHeight), potCommitment = openCommitment(3n), ticketCategory = CATEGORY, potAfter = 41_000n } = {}) => ({
    locktime,
    inputs: [
        { unlockingBytecode: UNLOCK.refund, spends: pot(61_000n, potCommitment) },
        { unlockingBytecode: new Uint8Array(), spends: { lockingBytecode: PLAYER_LOCK, valueSatoshis: 1_000n, token: ticketToken(2n, ticketCategory) } },
    ],
    outputs: [
        { lockingBytecode: POT_LOCK, valueSatoshis: potAfter, token: potToken(potCommitment) },
        { lockingBytecode: PAYOUT_LOCK, valueSatoshis: 20_500n },
    ],
});

test('refund: an undrawn round pays a ticket back after the refund height', () => accepts(refundSpec()));

test('refund refuses: before the refund height', () => rejects(refundSpec({ locktime: Number(ROUND.refundHeight) - 1 })));
test('refund refuses: once the round is drawn', () => rejects(refundSpec({ potCommitment: drawnCommitment(2n) })));
test('refund refuses: a ticket of another round', () => rejects(refundSpec({ ticketCategory: OTHER_CATEGORY })));
test('refund refuses: paying back more than the price', () => rejects(refundSpec({ potAfter: 40_999n })));
test('refund refuses: keeping the ticket after the refund', () => {
    const spec = refundSpec();
    spec.outputs[1] = { ...spec.outputs[1], token: ticketToken(2n) };
    rejects(spec);
});
test('refund refuses: changing the ticket count', () => {
    const spec = refundSpec();
    spec.outputs[0] = { ...spec.outputs[0], token: potToken(openCommitment(2n)) };
    rejects(spec);
});

// ---------- the template's off-chain expressions agree with the covenant ----------
const pushedData = (scriptId, bytecode) => {
    const result = compiler.generateBytecode({ scriptId, data: { bytecode } });
    if (!result.success) throw new Error(JSON.stringify(result.errors));
    const [ instruction ] = decodeAuthenticationInstructions(result.bytecode);
    return instruction.data ?? new Uint8Array();
};

test('template: the drawn commitment it builds is the one the covenant demands', () => {
    for (const count of [ 1n, 2n, 3n, 10n, 997n ]) {
        const built = pushedData('evaluateDrawnCommitment', { roundSecret: ROUND.secret, ticketCount: bigIntToVmNumber(count) });
        assert.deepEqual(built, drawnCommitment(winnerFor(ROUND.secret, count)));
        accepts(drawSpec({ count, winner: winnerFor(ROUND.secret, count) }));
    }
});

test('template: the next ticket number it builds is count + 1', () => {
    for (const count of [ 0n, 1n, 41n, 255n, 256n ]) {
        assert.deepEqual(pushedData('evaluateNextOpenCommitment', { ticketCount: bigIntToVmNumber(count) }), openCommitment(count + 1n));
    }
});
