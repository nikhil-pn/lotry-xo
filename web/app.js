// Lotry on XO site: copy-to-clipboard for the banner, and the live rounds rendered from data/rounds.json.
'use strict';

// ---------- Copy (EMBER2026 vote address) ----------

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers without the async clipboard (or non-secure contexts).
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
};

document.querySelectorAll('[data-copy]').forEach((button) => {
  const source = document.getElementById(button.dataset.copy);
  // The EMBER button shows its state in a small hint; other copy buttons change their own label.
  const hint = button.querySelector('.ember__hint') ?? button;
  const idle = hint.textContent;
  let timer;
  button.addEventListener('click', async () => {
    const ok = await copyText(source.textContent.trim());
    hint.textContent = ok ? 'copied' : 'select it';
    button.classList.toggle('is-copied', ok);
    if (!ok) {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      hint.textContent = idle;
      button.classList.remove('is-copied');
    }, 1800);
  });
});

// ---------- Live rounds (data/rounds.json) ----------

const REPO = 'https://github.com/nikhil-pn/lotry-xo';

// Rounds are named by letter in the order they opened (Round A, Round B, ...), as in the README and docs/PROOF.md.
// Only `rounds` is shown: every one of its transactions is confirmed on Chipnet.
const roundName = (index) => `Round ${String.fromCharCode(65 + index)}`;

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
};

const svgArrow = () => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M5 11 11 5M6 5h5v5');
  svg.append(path);
  return svg;
};

const sats = (value) => Number(value).toLocaleString('en-US');
const shortHash = (hash) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;
const prettyText = (text) => text.replace(/(\d{4,}) sats/g, (_, n) => `${sats(n)} sats`);

const MONTHS = [ 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec' ];
const utcTime = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
};

// What kind of ending a round had, read from its steps.
const describeRound = (round) => {
  const steps = round.steps ?? [];
  const draw = steps.find((step) => step.step === 'draw');
  const claim = steps.find((step) => step.step === 'claim');
  const refunds = steps.filter((step) => step.step === 'refund');
  const tickets = round.ticketsSold ?? steps.filter((step) => step.step === 'buy').length;
  const price = BigInt(round.ticketPrice);
  const pot = BigInt(round.seedSatoshis ?? 0) + price * BigInt(tickets);

  if (claim && draw) {
    const won = draw.potSatoshis ?? pot;
    return {
      kind: 'claimed',
      pill: 'Claimed',
      title: 'Drawn, then claimed',
      summary: `${tickets} tickets sold. After the draw height sales closed, the organiser revealed the secret, the covenant picked ticket #${draw.winningTicket}, and its holder took the ${sats(won)}-sat pot.`,
      money: [ 'Pot claimed', `${sats(won)} sats` ],
      winner: draw.winningTicket,
      pot: won,
      tickets,
      claimLink: claim.link,
    };
  }
  if (refunds.length > 0 && draw) {
    return {
      kind: 'refunded',
      pill: 'Refunded',
      title: 'Drawn, never claimed, refunded',
      summary: `${tickets === 1 ? '1 ticket' : `${tickets} tickets`} sold and drawn, but nobody claimed by the claim deadline, so the pot turned to refunds: ${refunds.length === 1 ? 'the ticket was' : 'each ticket was'} burned for its ${sats(price)}-sat price back. The ${sats(round.seedSatoshis ?? 0)}-sat seed and the pot NFT stay in the covenant.`,
      money: [ 'Paid back', `${sats(price * BigInt(refunds.length))} sats` ],
      tickets,
    };
  }
  if (refunds.length > 0) {
    return {
      kind: 'refunded',
      pill: 'Refunded',
      title: 'Never drawn, refunded',
      summary: `${tickets} ticket${tickets === 1 ? '' : 's'} sold and no draw. After the refund height each ticket was burned for its ${sats(price)}-sat price back, with no one’s permission needed.`,
      money: [ 'Paid back', `${sats(price * BigInt(refunds.length))} sats` ],
      tickets,
    };
  }
  return {
    kind: 'open',
    pill: 'Open',
    title: `Open, ${tickets} ticket${tickets === 1 ? '' : 's'} sold`,
    summary: `${tickets} ticket${tickets === 1 ? '' : 's'} sold. The pot waits for its draw height, and every ticket stays refundable if the round is never drawn.`,
    money: [ 'In the pot', `${sats(pot)} sats` ],
    tickets,
  };
};

const renderStep = (step) => h('li', { class: `tl tl--${step.step}` },
  h('span', { class: 'tl__dot', 'aria-hidden': 'true' }),
  h('div', { class: 'tl__body' },
    h('p', { class: 'tl__title' }, step.title, ' ', h('span', { class: 'tl__time', text: utcTime(step.at) })),
    h('p', { class: 'tl__desc', text: prettyText(step.description ?? '') }),
    step.note ? h('p', { class: 'tl__note', text: step.note }) : null,
  ),
  step.link
    ? h('a', { class: 'tl__tx', href: step.link, title: `${step.transactionHash} on the Chipnet explorer` }, shortHash(step.transactionHash), ' ', svgArrow())
    : null,
);

const renderInvitations = (round) => {
  const files = round.invitations ?? [];
  if (files.length === 0) return null;
  return h('details', { class: 'invites' },
    h('summary', {}, `Invitation files (${files.length})`),
    h('p', { class: 'invites__legend' },
      'A sale is three files: ', h('code', { text: 'offer' }), ' (organiser starts it with the pot), ',
      h('code', { text: 'buyer_x' }), ' (the player adds coins, takes the ticket, signs), ',
      h('code', { text: 'sealed' }), ' (organiser adds the pot’s unlocking script and broadcasts; the pot has no key, so nothing signs for it).'),
    h('ul', { class: 'invites__list' }, files.map((file) => h('li', {},
      h('a', { href: file.url }, `${file.name}.json`),
      file.raw ? h('a', { class: 'invites__raw', href: file.raw, 'aria-label': `${file.name}.json, raw` }, 'raw') : null,
    ))),
  );
};

const renderRound = ({ round, name, slug, info }, featured) => {
  const facts = [
    [ 'Ticket price', `${sats(round.ticketPrice)} sats` ],
    [ 'Tickets sold', String(info.tickets) ],
    info.money,
    round.claimHeight
      ? [ 'Draw / refund / claim deadline (lock height)', `${sats(round.drawHeight)} / ${sats(round.refundHeight)} / ${sats(round.claimHeight)}` ]
      : [ 'Draw / refund from lock height', `${sats(round.drawHeight)} / ${sats(round.refundHeight)}` ],
  ];

  const head = h('div', { class: 'round__head' },
    h('div', {},
      h('p', { class: 'round__kicker' }, name, h('span', { class: 'round__id', text: round.roundId })),
      h('h3', { class: 'round__title', text: info.title }),
    ),
    h('span', { class: `pill pill--${info.kind}`, text: info.pill }),
  );

  const intro = h('div', { class: 'round__intro' },
    head,
    h('p', { class: 'round__summary', text: info.summary }),
    h('dl', { class: 'round__facts' }, facts.map(([ label, value ]) => h('div', {}, h('dt', { text: label }), h('dd', { text: value })))),
  );

  const timeline = h('ol', { class: 'timeline', 'aria-label': `${name} transactions` }, (round.steps ?? []).map(renderStep));

  const foot = h('p', { class: 'round__foot' },
    'Token category ', h('code', { title: round.roundCategory, text: shortHash(round.roundCategory) }),
    ' · secret hash ', h('code', { title: round.secretHash, text: shortHash(round.secretHash) }),
    ' · ', h('a', { href: `${REPO}/tree/main/rounds/${round.roundId}` }, 'round files ', svgArrow()),
  );

  return h('article', { class: `round round--${info.kind}${featured ? ' round--featured' : ''}`, id: slug },
    featured ? h('p', { class: 'round__flag', text: 'The whole story' }) : null,
    h('div', { class: 'round__grid' }, intro, timeline),
    renderInvitations(round),
    foot,
  );
};

const fillHero = (entry) => {
  const { info } = entry ?? {};
  if (!info || info.kind !== 'claimed') return;
  document.querySelectorAll('[data-hero="label"]').forEach((el) => { el.textContent = `${entry.name} · Chipnet`; });
  document.querySelectorAll('[data-hero="pot"]').forEach((el) => { el.textContent = sats(info.pot); });
  document.querySelectorAll('[data-hero="winner"]').forEach((el) => { el.textContent = String(info.winner); });
  document.querySelectorAll('[data-hero="tickets"]').forEach((el) => { el.textContent = String(info.tickets); });
  document.querySelectorAll('[data-hero="claim"]').forEach((el) => { el.href = info.claimLink; });
};

const renderRounds = async () => {
  const list = document.getElementById('rounds-list');
  if (!list) return;
  try {
    const response = await fetch('data/rounds.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const all = (data.rounds ?? [])
      .slice()
      .sort((a, b) => a.openedAtHeight - b.openedAtHeight)
      .map((round, index) => ({
        round,
        name: roundName(index),
        slug: `round-${String.fromCharCode(97 + index)}`,
        info: describeRound(round),
      }));
    if (all.length === 0) throw new Error('no rounds in the file yet');

    // The newest drawn-and-claimed round leads; the rest follow, oldest first (Round A, Round B, ...).
    const featured = [ ...all ].reverse().find((entry) => entry.info.kind === 'claimed') ?? all[0];
    const rest = all.filter((entry) => entry !== featured);

    const blocks = [ renderRound(featured, true) ];
    if (rest.length > 0) blocks.push(h('div', { class: 'rounds__rest' }, rest.map((entry) => renderRound(entry, false))));
    list.replaceChildren(...blocks);

    fillHero(featured);
    const txs = all.reduce((total, entry) => total + (entry.round.steps ?? []).filter((step) => step.transactionHash).length, 0);
    document.querySelectorAll('[data-stat="rounds"]').forEach((el) => { el.textContent = String(all.length); });
    document.querySelectorAll('[data-stat="txs"]').forEach((el) => { el.textContent = String(txs); });
  } catch (error) {
    list.replaceChildren(h('p', { class: 'rounds__status' },
      `Could not load the rounds (${error.message}). The same proof is in `,
      h('a', { href: `${REPO}/blob/main/docs/PROOF.md` }, 'docs/PROOF.md'), '.'));
  }
};

renderRounds();
