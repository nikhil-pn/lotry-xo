// Lock-time heights after CHIP-2025-03 "Faster Blocks".
//
// Chipnet moved to 1-minute blocks on 15 Nov 2026 (mainnet follows on 15 May 2027). Block-height lock times kept their
// old meaning: a lock-time "height" is now a 600-tick chunk, where blocks before activation count 600 ticks and blocks
// after it count 60. So after activation the lock-time height only advances by one every ten blocks.
//
// OP_CHECKLOCKTIMEVERIFY and nLockTime compare against that chunk height, so the round's drawHeight and refundHeight
// are chunk heights too. A transaction with nLockTime L is final in a block whose chunk height is greater than L.
//
// The chipnet activation height below was measured on 21 Nov 2026: at block 341561 the network accepted nLockTime
// 333361 and refused 333362, and 332451 + floor((341562 - 332451) / 10) = 333362.
export const FASTER_BLOCKS_ACTIVATION_HEIGHT = { chipnet: 332_451, mainnet: undefined };

/** The lock-time height that a block at this height satisfies (nLockTime must be lower than it). */
export const lockHeightOfBlock = (blockHeight, network = 'chipnet') => {
    const activation = FASTER_BLOCKS_ACTIVATION_HEIGHT[network];
    if (activation === undefined || blockHeight < activation) return blockHeight;
    return activation + Math.floor((blockHeight - activation) / 10);
};

/** The highest nLockTime a transaction can carry to be mined in the next block. */
export const currentLockHeight = (tipHeight, network = 'chipnet') => lockHeightOfBlock(tipHeight + 1, network) - 1;

/** Rough wait, in blocks, until a lock height is reachable. */
export const blocksUntilLockHeight = (lockHeight, tipHeight, network = 'chipnet') => {
    let height = tipHeight;
    while (lockHeightOfBlock(height + 1, network) <= lockHeight) height += 1;
    return height - tipHeight;
};
