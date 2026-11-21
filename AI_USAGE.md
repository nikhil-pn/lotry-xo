# How AI was used

Lotry on XO was built during BCH BLAZE 2026 by Nikhil PN with an AI coding assistant (Claude, via Claude Code).

- **Design and code**: the covenant, the XO template, the CLI and the tests were written with the assistant, from the
  rules of the original Lotry.fun round. Every covenant path and attack case is checked by the test suite in libauth's
  BCH 2026 VM, and every step was run for real on Chipnet (see `docs/PROOF.md`).
- **Debugging on the live network**: the assistant ran the Chipnet steps and investigated the failures, including the
  Faster Blocks lock-time behaviour described in the README.
- **Docs and site**: the README, the proof table generator and the website were drafted with the assistant and reviewed
  by the team.
- **Not AI**: the feedback on XO submitted for the XO bounties is written by Nikhil himself, as the bounty requires.
