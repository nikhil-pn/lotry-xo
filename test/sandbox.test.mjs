// The browser sandbox must behave like the chain: honest rounds go through, every cheat is refused by the covenant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/sandbox-core.mjs';

const accepted = (entry) => assert.equal(entry.accepted, true, `${entry.label}: ${entry.error}`);
const refusedByCovenant = (entry) => {
    assert.equal(entry.accepted, false, `${entry.label} should be refused`);
    assert.notEqual(entry.skipped, true, `${entry.label} should reach the VM, not be skipped: ${entry.error}`);
};

test('sandbox: a full honest round, from tickets to the winner claiming', () => {
    const sandbox = createSandbox();
    accepted(sandbox.actions.buy('You'));
    accepted(sandbox.actions.buy('Alice'));
    accepted(sandbox.actions.buy('Bob'));
    refusedByCovenant(sandbox.actions.close()); // before the draw height
    sandbox.actions.advance(10);
    accepted(sandbox.actions.close());
    assert.equal(sandbox.potPhase().phase, 'closed');
    accepted(sandbox.actions.draw());
    const { phase, number } = sandbox.potPhase();
    assert.equal(phase, 'drawn');
    const winner = sandbox.state.tickets.find((ticket) => ticket.number === number).owner;
    const before = sandbox.state.balances[winner];
    accepted(sandbox.actions.claim(winner));
    assert.equal(sandbox.state.balances[winner] - before, 2_000n + 3n * 20_000n);
});

test('sandbox: an undrawn round refunds every ticket', () => {
    const sandbox = createSandbox();
    accepted(sandbox.actions.buy('You'));
    accepted(sandbox.actions.buy('Alice'));
    refusedByCovenant(sandbox.actions.refund('You')); // before the refund height
    sandbox.actions.advance(25);
    accepted(sandbox.actions.refund('You'));
    accepted(sandbox.actions.refund('Alice'));
    assert.equal(sandbox.potPhase().phase, 'refunding');
    assert.equal(sandbox.state.pot.valueSatoshis, 2_000n);
});

test('sandbox: every cheat is refused by the covenant', () => {
    const sandbox = createSandbox();
    accepted(sandbox.actions.buy('Alice'));
    accepted(sandbox.actions.buy('Bob'));
    for (const name of [ 'stealPot', 'freeTicket', 'underpay', 'mintingTicket', 'earlyDraw', 'fakeTicket' ]) refusedByCovenant(sandbox.attacks[name].run());
    sandbox.actions.advance(10);
    accepted(sandbox.actions.close());
    refusedByCovenant(sandbox.attacks.stealPot.run());
    refusedByCovenant(sandbox.attacks.wrongWinner.run());
    refusedByCovenant(sandbox.actions.buy('You', { kind: 'attack' })); // buying after the close
    accepted(sandbox.actions.draw());
    refusedByCovenant(sandbox.attacks.stealPot.run());
    refusedByCovenant(sandbox.attacks.losingClaim.run());
    // The failure report names the opcode that stopped it.
    assert.ok(sandbox.state.log.find((entry) => entry.kind === 'attack' && entry.failure?.opcode));
});
