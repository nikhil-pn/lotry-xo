// Lotry on XO, step by step on Chipnet. Each step runs as one wallet (one XO account per process).
//
//   node scripts/lotry.mjs open [--price 20000] [--draw-in 1] [--refund-in 144] [--seed 2000]   organiser
//        (--draw-in / --refund-in count lock heights: ten 1-minute blocks each since Faster Blocks)
//   node scripts/lotry.mjs offer [round]                    organiser starts a ticket sale invitation
//   node scripts/lotry.mjs take  <BUYER_A|BUYER_B> [round]  the player joins it, adds a ticket, pays, signs
//   node scripts/lotry.mjs seal  [round]                    organiser signs the pot input and broadcasts
//   node scripts/lotry.mjs draw  [round]                    organiser reveals the secret after the draw height
//   node scripts/lotry.mjs claim <BUYER_A|BUYER_B> [round]  the winner takes the pot
//   node scripts/lotry.mjs refund <BUYER_A|BUYER_B> [round] a player gets a ticket price back from an undrawn round
//   node scripts/lotry.mjs status [round]                   pot state as the organiser sees it
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { DUST_LIMIT_SATOSHIS } from '@xo-cash/engine';
import { lotryTemplate } from '../src/lotry-template.mjs';
import { blocksUntilLockHeight, currentLockHeight } from '../src/chain-time.mjs';
import { drawnCommitment, nextOpenCommitment, openCommitment, parseCommitment } from '../src/round-state.mjs';
import { closeWallet, openWallet, persist } from './lib-engine.mjs';
import {
    latestRoundId, loadInvitation, logStep, readRound, readSecret, readSteps, saveInvitation, stringify, txLink, writeRound, writeSecret,
} from './lib-round.mjs';

const [ command, ...rest ] = process.argv.slice(2);

const flag = (name, fallback) => {
    const position = rest.indexOf(`--${name}`);
    return position === -1 ? fallback : rest[position + 1];
};
const positional = rest.filter((item, position) => !item.startsWith('--') && !rest[position - 1]?.startsWith('--'));

const variable = (variableIdentifier, roleIdentifier, value) => ({ variableIdentifier, roleIdentifier, value });

const roundVariables = (round, roleIdentifier) => [
    variable('ticketPrice', roleIdentifier, BigInt(round.ticketPrice)),
    variable('drawHeight', roleIdentifier, BigInt(round.drawHeight)),
    variable('refundHeight', roleIdentifier, BigInt(round.refundHeight)),
    variable('secretHash', roleIdentifier, round.secretHash),
    variable('roundCategory', roleIdentifier, round.roundCategory),
];

const importLotry = async (engine) => (await engine.importTemplate(lotryTemplate)).templateIdentifier;

const findIntent = (actionIdentifier, intents) => {
    const intent = intents.find((candidate) => candidate.action === actionIdentifier);
    if (intent === undefined) throw new Error(`No ${actionIdentifier} intent available`);
    return intent;
};

// Adds change if there is any worth keeping, signs every input this wallet owns, and optionally broadcasts.
// The engine's fee estimate does not see the size of the pot's unlocking script (the whole covenant is pushed),
// so transactions that spend the pot pass an explicit fee and get their change output built here.
const finish = async (engine, invitationIdentifier, { broadcast, feeSatoshis }) => {
    if (feeSatoshis === undefined) {
        const availability = await engine.calculateChangeAvailability(invitationIdentifier);
        if (availability.canAddChange) await engine.addChangeToInvitation(invitationIdentifier);
    } else {
        const leftover = BigInt((await engine.calculateChange(invitationIdentifier)).valueSatoshis);
        const change = leftover - BigInt(feeSatoshis);
        if (change >= BigInt(DUST_LIMIT_SATOSHIS)) {
            const invitation = (await engine.getInvitation(invitationIdentifier)).invitation;
            await engine.appendInvitation(invitationIdentifier, {
                templateIdentifier: invitation.templateIdentifier,
                actionIdentifier: invitation.actionIdentifier,
                outputs: [ { lockingBytecode: hexToBin(await engine.generateLockingBytecodeFromDefaultPolicy('receive')), valueSatoshis: change } ],
            });
        }
    }
    for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }
    if (!broadcast) return { storedInvitation: await engine.getInvitation(invitationIdentifier) };
    if (process.env.LOTRY_DRY_RUN) {
        const preview = await engine.buildInvitationTransactionFromMergedCommit(invitationIdentifier);
        const decoded = decodeTransaction(hexToBin(preview.serializedTransaction));
        if (process.env.LOTRY_DRY_RUN === "hex") console.log(preview.serializedTransaction);
        console.log(stringify({ dryRun: true, locktime: decoded.locktime, sequenceNumbers: decoded.inputs.map((input) => input.sequenceNumber), outputs: decoded.outputs.length, chain: await engine.getChainStatus() }));
        process.exit(0);
    }
    const missing = await engine.listMissingRequirements(invitationIdentifier);
    const { builtTransaction, storedInvitation } = await engine.executeAction(invitationIdentifier, { broadcastTransaction: true });
    return { builtTransaction, storedInvitation, missing };
};

// The pot coin of a round, as tracked by this wallet, with its state read from the minting NFT.
const findPot = async (engine, round, { wait = 0 } = {}) => {
    for (let waited = 0; ; waited += 2000) {
        const pot = (await engine.listUnspentOutputs()).find((output) => output.tokenNftCapability === 'minting'
            && output.tokenCategory === round.roundCategory && output.reservedBy === undefined);
        if (pot !== undefined) return { ...pot, state: parseCommitment(pot.tokenNftCommitment) };
        if (waited >= wait) return undefined;
        await pause(2000);
    }
};

// A ticket of this round held by this wallet; with a number, that exact ticket.
const findTicket = async (engine, round, ticketNumber) => (await engine.listUnspentOutputs()).find((output) =>
    output.tokenCategory === round.roundCategory && output.tokenNftCapability === 'none'
    && (ticketNumber === undefined || parseCommitment(output.tokenNftCommitment).ticketNumber === Number(ticketNumber)));

const outpointOf = (output, inputIdentifier) => ({
    outpointTransactionHash: hexToBin(output.outpointTransactionHash), outpointIndex: output.outpointIndex, inputIdentifier,
});

// XO participants share the final copy of an invitation after broadcast. Updating with it lets a buyer's wallet
// learn the pot covenant (and so track the pot) from the sales it took part in.
const syncSales = async (engine, round, wallet) => {
    const directory = `rounds/${round.roundId}/invitations`;
    const own = fs.readdirSync(directory).filter((name) => name.endsWith(`-2-${wallet.toLowerCase()}.json`));
    for (const name of own) {
        const sealed = name.replace(/-2-[a-z_]+\.json$/, '-3-sealed');
        if (fs.existsSync(`${directory}/${sealed}.json`)) await engine.updateInvitation(loadInvitation(round.roundId, sealed));
    }
    return own.length;
};

const nextSaleNumber = (roundId) => readSteps(roundId).filter((step) => step.step === 'buy').length + 1;

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const steps = {
    // Opens a round: the funding coin must be output 0 of its transaction, since its hash becomes the round's token category.
    async open() {
        const engine = await openWallet('ORGANISER');
        const templateIdentifier = await importLotry(engine);
        const { currentHeight } = await engine.getChainStatus();

        let genesisCoin = (await engine.listSpendableUnspentOutputs())
            .find((output) => output.outpointIndex === 0 && output.token === undefined && BigInt(output.valueSatoshis) >= 20_000n);
        if (genesisCoin === undefined) {
            genesisCoin = await steps.makeGenesisCoin(engine);
        }

        const secret = randomBytes(32);
        const round = {
            roundId: `round-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`,
            network: 'chipnet',
            templateIdentifier,
            ticketPrice: flag('price', '20000'),
            seedSatoshis: flag('seed', '2000'),
            // Lock heights, not block heights: since Faster Blocks one lock height is ten 1-minute blocks.
            drawHeight: String(currentLockHeight(currentHeight) + Number(flag('draw-in', '1'))),
            refundHeight: String(currentLockHeight(currentHeight) + Number(flag('refund-in', '144'))),
            secretHash: createHash('sha256').update(secret).digest('hex'),
            roundCategory: genesisCoin.outpointTransactionHash,
            openedAtHeight: currentHeight,
        };
        writeSecret(round.roundId, binToHex(secret));

        const template = await engine.getTemplate(templateIdentifier);
        const created = await engine.createInvitation({
            templateIdentifier,
            actionIdentifier: 'openRound',
            intent: findIntent('openRound', template.start),
            variables: [
                ...roundVariables(round, 'organiser'),
                variable('seedSatoshis', 'organiser', BigInt(round.seedSatoshis)),
                variable('potCommitment', 'organiser', openCommitment(0)),
            ],
            inputs: [ { outpointTransactionHash: hexToBin(genesisCoin.outpointTransactionHash), outpointIndex: 0 } ],
        });
        const { invitationIdentifier } = created.invitation;
        await engine.appendInvitation(invitationIdentifier, {
            templateIdentifier, actionIdentifier: 'openRound', outputs: [ { outputIdentifier: 'potOpenedOutput' } ],
        });
        const { builtTransaction, storedInvitation } = await finish(engine, invitationIdentifier, { broadcast: true });

        round.openTransactionHash = builtTransaction.transactionHash;
        writeRound(round);
        saveInvitation(round.roundId, '1-open', storedInvitation.invitation);
        logStep(round.roundId, { step: 'open', transactionHash: builtTransaction.transactionHash, tickets: 0, potSatoshis: round.seedSatoshis });
        console.log(`Opened ${round.roundId}\n  category ${round.roundCategory}\n  draw from lock height ${round.drawHeight}, refunds from ${round.refundHeight}\n  ${txLink(builtTransaction.transactionHash)}`);
        await closeWallet(engine);
    },

    // Sends coins to ourselves so that a coin sits at output 0, ready to be a token genesis input.
    async makeGenesisCoin(engine) {
        const [ walletTemplate ] = await engine.listTemplatesForDefaultPolicy('receive');
        const walletTemplateIdentifier = walletTemplate.templateIdentifier;
        const template = await engine.getTemplate(walletTemplateIdentifier);
        const funding = (await engine.listSpendableUnspentOutputs()).find((output) => output.token === undefined && BigInt(output.valueSatoshis) >= 60_000n);
        if (funding === undefined) throw new Error('The organiser needs at least 60000 sats: fund it with scripts/faucet.mjs');
        const receivingScript = template.lockingScripts.receivingLockingScript;
        const sendIntent = findIntent('sendSatoshis', receivingScript.roles.receiver.actions);
        const recipient = await engine.generateLockingBytecodeFromDefaultPolicy('receive');
        const created = await engine.createInvitation({
            templateIdentifier: walletTemplateIdentifier,
            actionIdentifier: 'sendSatoshis',
            intent: sendIntent,
            variables: [
                variable('transferredSatoshis', 'sender', 50_000n),
                variable('recipientLockingscript', 'sender', recipient),
            ],
            inputs: [ { outpointTransactionHash: hexToBin(funding.outpointTransactionHash), outpointIndex: funding.outpointIndex } ],
        });
        const { invitationIdentifier } = created.invitation;
        await engine.appendInvitation(invitationIdentifier, {
            templateIdentifier: walletTemplateIdentifier, actionIdentifier: 'sendSatoshis', outputs: [ { outputIdentifier: 'transferSatoshisOutput' } ],
        });
        const { builtTransaction } = await finish(engine, invitationIdentifier, { broadcast: true });
        console.log(`Made a genesis coin: ${txLink(builtTransaction.transactionHash)}`);
        await persist();
        for (let attempt = 0; attempt < 30; attempt += 1) {
            const coin = (await engine.listSpendableUnspentOutputs())
                .find((output) => output.outpointTransactionHash === builtTransaction.transactionHash && output.outpointIndex === 0);
            if (coin !== undefined) return coin;
            await pause(2000);
        }
        throw new Error('The genesis coin did not show up');
    },

    // Organiser: starts a ticket sale. The invitation holds the pot and the new pot; a player fills in the rest.
    async offer() {
        const round = readRound(positional[0] ?? latestRoundId());
        const engine = await openWallet('ORGANISER');
        await importLotry(engine);
        const pot = await findPot(engine, round, { wait: 20_000 });
        if (pot === undefined || pot.state.phase !== 'open') throw new Error('No open pot for this round');
        const template = await engine.getTemplate(round.templateIdentifier);
        const intent = findIntent('buyTicket', template.lockingScripts.potLockingScript.roles.organiser.actions);
        const created = await engine.createInvitation({
            templateIdentifier: round.templateIdentifier,
            actionIdentifier: 'buyTicket',
            intent,
            variables: [
                ...roundVariables(round, 'organiser'),
                variable('potSatoshis', 'organiser', BigInt(pot.valueSatoshis)),
                variable('ticketCount', 'organiser', BigInt(pot.state.ticketCount)),
                variable('nextPotCommitment', 'organiser', nextOpenCommitment(pot.state.ticketCount)),
                variable('ticketCommitment', 'organiser', nextOpenCommitment(pot.state.ticketCount)),
            ],
            inputs: [ outpointOf(pot, 'potBuyInput') ],
        });
        const { invitationIdentifier } = created.invitation;
        const stored = await engine.appendInvitation(invitationIdentifier, {
            templateIdentifier: round.templateIdentifier, actionIdentifier: 'buyTicket', outputs: [ { outputIdentifier: 'potBoughtOutput' } ],
        });
        const name = `buy-${nextSaleNumber(round.roundId)}-1-offer`;
        const file = saveInvitation(round.roundId, name, stored.invitation);
        console.log(`Ticket #${pot.state.ticketCount + 1} offered: ${file}`);
        await closeWallet(engine);
    },

    // Player: joins the sale, takes the ticket output with a fresh key, pays from their own coins and signs their part.
    async take() {
        const wallet = positional[0];
        const round = readRound(positional[1] ?? latestRoundId());
        const sale = nextSaleNumber(round.roundId);
        const engine = await openWallet(wallet);
        await importLotry(engine);
        const offered = loadInvitation(round.roundId, `buy-${sale}-1-offer`);
        const accepted = await engine.acceptInvitation(offered, { roleIdentifier: 'player' });
        const { invitationIdentifier } = accepted.invitation;
        const funding = (await engine.listSpendableUnspentOutputs())
            .filter((output) => output.tokenCategory === undefined)
            .sort((a, b) => Number(BigInt(b.valueSatoshis) - BigInt(a.valueSatoshis)))[0];
        if (funding === undefined) throw new Error(`${wallet} has no coins: fund it with scripts/faucet.mjs`);
        await engine.appendInvitation(invitationIdentifier, {
            templateIdentifier: round.templateIdentifier,
            actionIdentifier: 'buyTicket',
            outputs: [ { outputIdentifier: 'ticketOutput', roleIdentifier: 'player' } ],
            inputs: [ outpointOf(funding) ],
        });
        const { storedInvitation } = await finish(engine, invitationIdentifier, { broadcast: false });
        const file = saveInvitation(round.roundId, `buy-${sale}-2-${wallet.toLowerCase()}`, storedInvitation.invitation);
        console.log(`${wallet} took the ticket and signed: ${file}`);
        await closeWallet(engine);
    },

    // Organiser: merges the player's commits, adds the pot's unlocking script and broadcasts.
    async seal() {
        const round = readRound(positional[0] ?? latestRoundId());
        const sale = nextSaleNumber(round.roundId);
        const engine = await openWallet('ORGANISER');
        await importLotry(engine);
        const files = fs.readdirSync(`rounds/${round.roundId}/invitations`).filter((name) => name.startsWith(`buy-${sale}-2-`));
        if (files.length !== 1) throw new Error(`Expected one taken invitation for sale ${sale}, found ${files.length}`);
        const taken = loadInvitation(round.roundId, files[0].replace(/\.json$/, ''));
        const updated = await engine.updateInvitation(taken);
        const { invitationIdentifier } = updated.invitation;
        const { builtTransaction, storedInvitation, missing } = await finish(engine, invitationIdentifier, { broadcast: true });
        saveInvitation(round.roundId, `buy-${sale}-3-sealed`, storedInvitation.invitation);
        const ticketNumber = sale;
        logStep(round.roundId, { step: 'buy', ticketNumber, buyer: files[0].split('-').at(-1).replace('.json', ''), transactionHash: builtTransaction.transactionHash });
        console.log(`Ticket #${ticketNumber} sold: ${txLink(builtTransaction.transactionHash)}`);
        if (missing && Object.keys(missing).length) console.log(stringify(missing));
        await closeWallet(engine);
    },

    // Organiser: after the draw height, reveals the secret. The covenant itself checks which ticket won.
    async draw() {
        const round = readRound(positional[0] ?? latestRoundId());
        const engine = await openWallet('ORGANISER');
        await importLotry(engine);
        const { currentHeight } = await engine.getChainStatus();
        if (currentLockHeight(currentHeight) < Number(round.drawHeight)) {
            throw new Error(`The draw opens at lock height ${round.drawHeight}, in about ${blocksUntilLockHeight(Number(round.drawHeight), currentHeight)} blocks`);
        }
        const pot = await findPot(engine, round, { wait: 20_000 });
        if (pot === undefined || pot.state.phase !== 'open') throw new Error('No open pot for this round');
        const secretHex = binToHex(readSecret(round.roundId));
        const nextPotCommitment = drawnCommitment(secretHex, pot.state.ticketCount);
        const { winningTicket } = parseCommitment(nextPotCommitment);
        const template = await engine.getTemplate(round.templateIdentifier);
        const created = await engine.createInvitation({
            templateIdentifier: round.templateIdentifier,
            actionIdentifier: 'drawRound',
            intent: findIntent('drawRound', template.lockingScripts.potLockingScript.roles.organiser.actions),
            variables: [
                ...roundVariables(round, 'organiser'),
                variable('potSatoshis', 'organiser', BigInt(pot.valueSatoshis)),
                variable('ticketCount', 'organiser', BigInt(pot.state.ticketCount)),
                variable('roundSecret', 'organiser', secretHex),
                variable('nextPotCommitment', 'organiser', nextPotCommitment),
            ],
            inputs: [ outpointOf(pot, 'potDrawInput') ],
        });
        const { invitationIdentifier } = created.invitation;
        // The organiser pays the draw fee from its own coins; the pot keeps every satoshi.
        const feeCoin = (await engine.listSpendableUnspentOutputs()).find((output) => output.tokenCategory === undefined && BigInt(output.valueSatoshis) >= 5_000n);
        await engine.appendInvitation(invitationIdentifier, {
            templateIdentifier: round.templateIdentifier,
            actionIdentifier: 'drawRound',
            outputs: [ { outputIdentifier: 'potDrawnOutput' } ],
            inputs: [ outpointOf(feeCoin) ],
        });
        const { builtTransaction, storedInvitation } = await finish(engine, invitationIdentifier, { broadcast: true, feeSatoshis: 1_500 });
        saveInvitation(round.roundId, 'draw', storedInvitation.invitation);
        logStep(round.roundId, { step: 'draw', winningTicket, tickets: pot.state.ticketCount, potSatoshis: pot.valueSatoshis, transactionHash: builtTransaction.transactionHash });
        console.log(`Ticket #${winningTicket} of ${pot.state.ticketCount} won ${pot.valueSatoshis} sats: ${txLink(builtTransaction.transactionHash)}`);
        await closeWallet(engine);
    },

    // Player: spends the drawn pot together with the winning ticket, a follow-up action of the ticket itself.
    async claim() {
        const wallet = positional[0];
        const round = readRound(positional[1] ?? latestRoundId());
        const engine = await openWallet(wallet);
        await importLotry(engine);
        await syncSales(engine, round, wallet);
        const pot = await findPot(engine, round, { wait: 30_000 });
        if (pot === undefined || pot.state.phase !== 'drawn') throw new Error('No drawn pot visible to this wallet yet');
        const ticket = await findTicket(engine, round, pot.state.winningTicket);
        if (ticket === undefined) throw new Error(`${wallet} does not hold the winning ticket #${pot.state.winningTicket}`);
        const template = await engine.getTemplate(round.templateIdentifier);
        const payoutLockingScript = await engine.generateLockingBytecodeFromDefaultPolicy('receive');
        const created = await engine.createInvitation({
            templateIdentifier: round.templateIdentifier,
            actionIdentifier: 'claimPot',
            intent: findIntent('claimPot', template.lockingScripts.ticketLockingScript.roles.player.actions),
            variables: [
                ...roundVariables(round, 'player'),
                variable('potSatoshis', 'player', BigInt(pot.valueSatoshis)),
                variable('winningTicket', 'player', BigInt(pot.state.winningTicket)),
                variable('payoutLockingScript', 'player', payoutLockingScript),
            ],
            inputs: [ outpointOf(pot, 'potClaimInput'), outpointOf(ticket, 'ticketClaimInput') ],
        });
        const { invitationIdentifier } = created.invitation;
        await engine.appendInvitation(invitationIdentifier, {
            templateIdentifier: round.templateIdentifier, actionIdentifier: 'claimPot', outputs: [ { outputIdentifier: 'claimPayoutOutput' } ],
        });
        const { builtTransaction, storedInvitation } = await finish(engine, invitationIdentifier, { broadcast: true });
        saveInvitation(round.roundId, 'claim', storedInvitation.invitation);
        logStep(round.roundId, { step: 'claim', winner: wallet.toLowerCase(), ticketNumber: pot.state.winningTicket, transactionHash: builtTransaction.transactionHash });
        console.log(`${wallet} claimed the pot with ticket #${pot.state.winningTicket}: ${txLink(builtTransaction.transactionHash)}`);
        await closeWallet(engine);
    },

    // Player: after the refund height, burns a ticket of an undrawn round for its price back.
    async refund() {
        const wallet = positional[0];
        const round = readRound(positional[1] ?? latestRoundId());
        const engine = await openWallet(wallet);
        await importLotry(engine);
        const { currentHeight } = await engine.getChainStatus();
        if (currentLockHeight(currentHeight) < Number(round.refundHeight)) {
            throw new Error(`Refunds open at lock height ${round.refundHeight}, in about ${blocksUntilLockHeight(Number(round.refundHeight), currentHeight)} blocks`);
        }
        await syncSales(engine, round, wallet);
        const pot = await findPot(engine, round, { wait: 30_000 });
        if (pot === undefined || pot.state.phase !== 'open') throw new Error('No undrawn pot visible to this wallet');
        const ticket = await findTicket(engine, round);
        if (ticket === undefined) throw new Error(`${wallet} holds no ticket of this round`);
        const ticketNumber = parseCommitment(ticket.tokenNftCommitment).ticketNumber;
        const template = await engine.getTemplate(round.templateIdentifier);
        const payoutLockingScript = await engine.generateLockingBytecodeFromDefaultPolicy('receive');
        const created = await engine.createInvitation({
            templateIdentifier: round.templateIdentifier,
            actionIdentifier: 'refundTicket',
            intent: findIntent('refundTicket', template.lockingScripts.ticketLockingScript.roles.player.actions),
            variables: [
                ...roundVariables(round, 'player'),
                variable('potSatoshis', 'player', BigInt(pot.valueSatoshis)),
                variable('potCommitment', 'player', pot.tokenNftCommitment),
                variable('ticketNumber', 'player', BigInt(ticketNumber)),
                variable('payoutLockingScript', 'player', payoutLockingScript),
            ],
            inputs: [ outpointOf(pot, 'potRefundInput'), outpointOf(ticket, 'ticketRefundInput') ],
        });
        const { invitationIdentifier } = created.invitation;
        await engine.appendInvitation(invitationIdentifier, {
            templateIdentifier: round.templateIdentifier,
            actionIdentifier: 'refundTicket',
            outputs: [ { outputIdentifier: 'potRefundedOutput' }, { outputIdentifier: 'refundPayoutOutput' } ],
        });
        const { builtTransaction, storedInvitation } = await finish(engine, invitationIdentifier, { broadcast: true });
        saveInvitation(round.roundId, `refund-${ticketNumber}`, storedInvitation.invitation);
        logStep(round.roundId, { step: 'refund', ticketNumber, holder: wallet.toLowerCase(), transactionHash: builtTransaction.transactionHash });
        console.log(`${wallet} refunded ticket #${ticketNumber}: ${txLink(builtTransaction.transactionHash)}`);
        await closeWallet(engine);
    },

    async status() {
        const round = readRound(positional[0] ?? latestRoundId());
        const wallet = positional[1] ?? 'ORGANISER';
        const engine = await openWallet(wallet);
        await importLotry(engine);
        if (wallet !== 'ORGANISER') await syncSales(engine, round, wallet);
        const pot = await findPot(engine, round, { wait: 6000 });
        if (pot === undefined) console.log('No unspent pot (claimed, or not seen yet)');
        else console.log(`${round.roundId}: ${pot.valueSatoshis} sats, ${stringify(pot.state)}\n  pot coin ${pot.outpointTransactionHash}:${pot.outpointIndex}`);
        await closeWallet(engine);
    },
};

if (steps[command] === undefined || command === 'makeGenesisCoin') {
    console.log('Commands: open, offer, take, seal, draw, claim, refund, status');
    process.exit(1);
}
await steps[command]();
process.exit(0);
