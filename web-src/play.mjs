// UI for web/play.html. Bundled with esbuild into web/play.js (npm run build:play).
import { createSandbox } from '../src/sandbox-core.mjs';

const $ = (selector) => document.querySelector(selector);
const formatSats = (value) => Number(value).toLocaleString('en-US');
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const PHASE_TEXT = {
    open: 'Tickets on sale. No key can spend this coin.',
    closed: 'Sales are closed: the ticket count is frozen. Waiting for the secret.',
    drawn: 'The chain wrote the winner into the pot. Only that ticket can claim it.',
    refunding: 'Refunds only: each ticket burns for its price back.',
    claimed: 'The winner took the pot. This round is over.',
};

let sandbox;

const render = () => {
    const { state, info } = sandbox;
    const claimed = state.pot.claimed === true;
    const { phase, number } = sandbox.potPhase();
    const shownPhase = claimed ? 'claimed' : phase;

    const badge = $('#pot-phase');
    badge.textContent = shownPhase.toUpperCase();
    badge.dataset.phase = shownPhase;
    $('#pot-value').textContent = formatSats(claimed ? 0n : state.pot.valueSatoshis);
    $('#pot-line').textContent = PHASE_TEXT[shownPhase];
    $('#pot-commitment').textContent = claimed ? 'burned' : hex(state.pot.token.nft.commitment);
    $('#ticket-price').textContent = `${formatSats(info.ticketPrice)} sats`;
    $('#secret-hash').textContent = `${info.secretHash.slice(0, 12)}…`;
    $('#secret-hash').title = info.secretHash;
    const secret = sandbox.revealSecret();
    $('#secret-value').textContent = secret === undefined ? 'hidden until the draw' : `${secret.slice(0, 12)}…`;

    $('#lock-height').textContent = state.height;
    $('#clock-fill').style.width = `${Math.min(100, (state.height / 31) * 100)}%`;

    const winning = phase === 'drawn' && !claimed ? number : undefined;
    const tickets = $('#tickets');
    tickets.innerHTML = '';
    if (state.tickets.length === 0) {
        tickets.innerHTML = `<li class="tickets__empty">${claimed ? 'Winning ticket burned' : 'None held'}</li>`;
    } else {
        for (const ticket of state.tickets.slice().sort((a, b) => a.number - b.number)) {
            const item = document.createElement('li');
            item.innerHTML = `<b>#${ticket.number}</b> ${ticket.owner}${ticket.number === winning ? ' · winner' : ''}`;
            if (ticket.number === winning) item.classList.add('is-winner');
            tickets.append(item);
        }
    }

    const log = $('#log');
    log.innerHTML = '';
    if (state.log.length === 0) log.innerHTML = '<li class="log__empty">Your transactions appear here.</li>';
    for (const entry of state.log) log.append(renderEntry(entry));
};

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);

const renderEntry = (entry) => {
    const item = document.createElement('li');
    if (entry.kind === 'attack') item.classList.add('is-attack');
    if (entry.kind === 'time') item.classList.add('is-time');
    let mark = '<span class="log__mark ok">✓</span>';
    let detail = '';
    if (entry.kind === 'time') {
        mark = '<span class="log__mark">⏱</span>';
        detail = 'Blocks pass. The lock height is what OP_CHECKLOCKTIMEVERIFY compares against.';
    } else if (entry.skipped) {
        mark = '<span class="log__mark">·</span>';
        detail = escapeHtml(entry.error);
    } else if (entry.accepted) {
        detail = 'The BCH 2026 virtual machine ran the pot covenant on this transaction and accepted it.';
    } else {
        mark = '<span class="log__mark no">✗</span>';
        const where = entry.failure ? `stopped at <code>${escapeHtml(entry.failure.opcode)}</code>: ` : '';
        detail = `Refused by the covenant, ${where}<code>${escapeHtml(entry.error)}</code>`;
        if (entry.stoppedBy) detail += `<div class="log__why">Why: ${escapeHtml(entry.stoppedBy)}</div>`;
    }
    item.innerHTML = `${mark}<div><div class="log__label">${escapeHtml(entry.label)}</div><div class="log__detail">${detail}</div></div>`
        + `<span class="log__meta">${escapeHtml(entry.actor ?? '')} · h${entry.height}</span>`;
    return item;
};

const renderCheats = () => {
    const container = $('#cheats');
    container.innerHTML = '';
    for (const [ name, attack ] of Object.entries(sandbox.attacks)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cheat';
        button.innerHTML = `<div class="cheat__title">${escapeHtml(attack.title)}<span>Try it</span></div><div class="cheat__what">${escapeHtml(attack.what)}</div>`;
        button.addEventListener('click', () => {
            const entry = attack.run();
            if (!entry.accepted && !entry.skipped) {
                entry.stoppedBy ??= attack.stoppedBy;
                button.classList.add('is-refused');
                button.querySelector('.cheat__title span').textContent = 'Refused';
            }
            render();
            $('#log').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        container.append(button);
    }
};

const bump = () => {
    const value = $('#pot-value').parentElement;
    value.classList.add('is-bump');
    setTimeout(() => value.classList.remove('is-bump'), 350);
};

const wire = () => {
    document.querySelectorAll('[data-buy]').forEach((button) => button.addEventListener('click', () => {
        const entry = sandbox.actions.buy(button.dataset.buy);
        if (entry.accepted) bump();
        render();
    }));
    document.querySelectorAll('[data-refund]').forEach((button) => button.addEventListener('click', () => {
        sandbox.actions.refund(button.dataset.refund);
        render();
    }));
    document.querySelectorAll('[data-advance]').forEach((button) => button.addEventListener('click', () => {
        const entry = sandbox.actions.advance(Number(button.dataset.advance));
        sandbox.state.log.unshift(entry);
        render();
    }));
    $('[data-action="close"]').addEventListener('click', () => { sandbox.actions.close(); render(); });
    $('[data-action="draw"]').addEventListener('click', () => { sandbox.actions.draw(); render(); });
    $('[data-action="claim"]').addEventListener('click', () => {
        const { phase, number } = sandbox.potPhase();
        const holder = sandbox.state.tickets.find((ticket) => ticket.number === number)?.owner ?? 'You';
        sandbox.actions.claim(phase === 'drawn' ? holder : 'You');
        render();
    });
    $('#reset').addEventListener('click', start);
};

const showCovenant = () => {
    const scripts = sandbox.info.covenantSource;
    const order = [ 'potRedeem', 'potBuy', 'potClose', 'potDraw', 'potClaim', 'potRefund', 'potCarriesOn', 'potIsOpen', 'potIsDrawn', 'input1IsTicket', 'roundCategoryOnly', 'output1HasNoToken', 'output2HasNoToken' ];
    $('#covenant-source').textContent = order
        .filter((name) => scripts[name] !== undefined)
        .map((name) => `${name}:\n${scripts[name].replace(/^\n/, '').replace(/\s+$/, '').split('\n').map((line) => `    ${line.trim()}`).join('\n')}`)
        .join('\n\n');
};

function start() {
    sandbox = createSandbox();
    renderCheats();
    render();
}

try {
    start();
    wire();
    showCovenant();
    const status = $('#engine-status');
    status.textContent = `BCH 2026 virtual machine ready · pot covenant compiled from the template (${sandbox.info.potLockingBytecode.length / 2}-byte P2SH32 lock)`;
    status.classList.add('is-ready');
} catch (error) {
    const status = $('#engine-status');
    status.textContent = `Could not start the sandbox: ${error.message}`;
    status.classList.add('is-error');
    console.error(error);
}
