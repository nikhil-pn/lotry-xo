# Lotry on XO: glossary

**Round**: one lottery, from open to claim or refunds. It lives entirely in one coin, the Pot.

**Pot**: the coin that holds every ticket payment. It is locked to the pot covenant (`potLockingScript`, P2SH32) and carries
the round's minting NFT. No key can spend it.
_Avoid_: wallet, contract owner, treasury

**Covenant**: the pot's redeem script (`potRedeem`). It checks the transaction that spends the pot and only allows five
paths: buy, close, draw, claim, refund.

**Commitment**: the bytes stored in the pot's NFT, which are the round's state. Open: 4-byte little-endian ticket count.
Closed: count + `c1`. Drawn: winning number + `d0`. Refunding: 4 bytes + `ee`.

**Ticket**: an immutable CashTokens NFT of the round's category whose commitment is its 4-byte number. It is locked to a key
the player's wallet generates for that ticket (`ticketLockingScript`).
_Avoid_: token, entry, share

**Organiser**: the role that opens the round, adds the pot to each sale, and reveals the secret. It can never move the pot.

**Player**: the role that buys a ticket, and later claims or refunds with it.

**Secret / Secret Hash**: the organiser picks a secret and commits `sha256(secret)` when opening. The draw reveals it and
the covenant computes the winner: `sha256(secret) mod tickets + 1`.

**Draw Height / Refund Height / Claim Deadline**: lock heights (CLTV). After the draw height anyone can close sales and the
draw can happen. After the refund height an undrawn round refunds. After the claim deadline a drawn but unclaimed round
refunds. On chipnet a lock height counts 10-minute chunks since Faster Blocks.

**Invitation**: an XO object that several wallets fill in turn (commits), then one broadcasts. A ticket sale is a two-party
invitation: the organiser adds the pot, the player adds the ticket output, funding and signature, the organiser seals it.

**Follow-up Action**: an action a locking script offers to its holder. The pot offers buy, close and draw to the organiser;
the ticket offers claim and refund to its player.

**Genesis**: the open transaction that creates the round's token category with one minting NFT at zero tickets, locked to
the covenant. Buyers check it before paying (`scripts/lib-genesis.mjs`).

**Chipnet**: the Bitcoin Cash test network where every proof transaction lives.
