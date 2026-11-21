# Bounty checklist

Each qualifying requirement of the two General Protocols XO bounties, with where it is met.

## Migrate to XO (1 BCH × 5)

| Requirement | Where |
|---|---|
| Migrate existing functionality to a novel, well-designed, functional XO template that correctly implements its intended contract | Lotry.fun's round (tickets, pot, draw, payout) → [`src/lotry-template.mjs`](../src/lotry-template.mjs); 38 tests in the BCH 2026 VM ([`test/covenant.test.mjs`](../test/covenant.test.mjs)); full rounds on Chipnet ([`PROOF.md`](PROOF.md)) |
| The XO implementation does not need to replicate the original UX | The original is a Farcaster mini app on Base; this is a CLI with two-party invitations, a website showing the live rounds, and the XO debug tool |
| Execute a transaction on Chipnet or Mainnet using an invitation that can be inspected with the debug tool; submit the invitation | 15 Chipnet transactions from invitations; the files are in [`rounds/`](../rounds), e.g. the sale [`buy-2-3-sealed.json`](../rounds/round-20261121T1949/invitations/buy-2-3-sealed.json), the draw [`draw.json`](../rounds/round-20261121T1949/invitations/draw.json) and the claim [`claim.json`](../rounds/round-20261121T1949/invitations/claim.json); debug tool screenshots in [`debug-tool/`](debug-tool) |
| Showcase follow-up actions | The pot offers `buyTicket` and `drawRound` to the organiser; the ticket offers `claimPot` and `refundTicket` to its player. All four were executed on Chipnet |
| Submit the template and invitation, with instructions to reproduce the invitation | [`templates/lotry.json`](../templates/lotry.json) + README "Try it" (CLI steps) and "To inspect without running anything" |
| Links to both the original working project and the XO implementation | Original: https://www.lotry.fun · https://github.com/exprmnts/Lotry_contract. XO: this repository |
| Detailed, personally written feedback on developing with XO | [`../FEEDBACK.md`](../FEEDBACK.md), written by Nikhil |

## Build with XO (0.3 BCH × 10)

| Requirement | Where |
|---|---|
| A novel, well-designed, functional XO template that correctly implements its intended contract | As above: a keyless lottery pot with ticket NFTs, commit-reveal draw, claim and refunds |
| Execute a transaction on Chipnet or Mainnet using an invitation the debug tool can inspect; submit the invitation | As above |
| Showcase follow-up actions | As above |
| Submit the template, the invitation and instructions to reproduce it | As above |
| Detailed, personally written feedback | [`../FEEDBACK.md`](../FEEDBACK.md) |
