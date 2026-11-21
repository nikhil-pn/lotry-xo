// Lotry on XO: one lottery round on Bitcoin Cash, written as an XO template.
//
// The round lives in a single coin, "the pot", locked to a covenant with no keys at all.
// The pot carries the round's minting NFT; its commitment is the round's state.
//
//   open round   organiser   genesis of a new token category, pot holds a minting NFT, commitment = 0 tickets
//   buy ticket   anyone      pot grows by the ticket price and mints ticket #n (an immutable NFT) to the buyer
//   draw         anyone who  after the draw height, reveals the organiser's secret; the winning number
//                knows the   sha256(secret) mod tickets + 1 is written into the pot's commitment
//                secret
//   claim pot    winner      spends the pot together with the winning ticket; both NFTs are burned
//   refund       any ticket  after the refund height, if the round was never drawn, a ticket is burned
//                holder      and its price is paid back from the pot
//
// Nobody, the organiser included, can take the pot any other way: there is no signature path in the covenant.
//
// Pot commitment while open:  4-byte little-endian ticket count
// Pot commitment once drawn:   4-byte little-endian winning ticket number, then the marker byte 0xd0

const ROUND_VARIABLES = [ 'ticketPrice', 'drawHeight', 'refundHeight', 'secretHash' ];

const NO_BALANCE = { satoshis: 0n, fungibleTokens: 0n, nonfungibleTokens: 0 };

export const lotryTemplate = {
    $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',

    name: 'Lotry',
    description: 'An on-chain lottery round. Tickets are NFTs, the pot is a covenant nobody can take, and the winner is drawn from a committed secret.',
    icon: 'lotry',

    version: '1',
    supported: [ 'BCH_2025_05', 'BCH_2026_05' ],

    resources: [
        {
            name: 'Lotry.fun',
            description: 'The original Lotry, a tokenized lottery on Base (Base Batch India 2025 runner-up). This template migrates its core round to Bitcoin Cash.',
            url: 'https://www.lotry.fun',
        },
        {
            name: 'Original contracts',
            description: 'The Solidity contracts this round is migrated from.',
            url: 'https://github.com/exprmnts/Lotry_contract',
        },
    ],

    roles: {
        organiser: {
            name: 'Organiser',
            description: 'Opens a round, keeps the secret that decides the winner, and reveals it at the draw. Can never spend the pot.',
            icon: 'organiser',
        },
        player: {
            name: 'Player',
            description: 'Buys tickets, and claims the pot with the winning ticket or gets the ticket price back if the round is never drawn.',
            icon: 'player',
        },
    },

    // Only the organiser can start: every other action continues from a pot or ticket output.
    start: [
        {
            action: 'openRound',
            role: 'organiser',
        },
    ],

    actions: {
        openRound: {
            name: 'Open a round',
            description: 'Create the pot of a new lottery round with its own ticket category.',
            icon: 'open',

            roles: {
                organiser: {
                    requirements: {
                        variables: [ ...ROUND_VARIABLES, 'roundCategory', 'seedSatoshis', 'potCommitment' ],
                    },
                },
            },

            requirements: {
                participants: [ { role: 'organiser', slots: { min: 1, max: 1 } } ],
            },

            transaction: 'openRoundTransaction',
        },

        buyTicket: {
            name: 'Buy a ticket',
            description: 'Pay the ticket price into the pot and receive the next numbered ticket NFT.',
            icon: 'ticket',

            roles: {
                // The organiser runs the round's service: it tracks the pot and adds it to the transaction.
                organiser: {
                    requirements: {
                        variables: [ ...ROUND_VARIABLES, 'roundCategory', 'potSatoshis', 'ticketCount', 'nextPotCommitment', 'ticketCommitment' ],
                    },
                },
                player: {
                    generate: [ 'playerKey' ],
                    requirements: {
                        secrets: [ 'playerKey' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'organiser', slots: { min: 1, max: 1 } },
                    { role: 'player', slots: { min: 1, max: 1 } },
                ],
            },

            transaction: 'buyTicketTransaction',
        },

        drawRound: {
            name: 'Draw the winner',
            description: 'Reveal the round secret after the draw height and write the winning ticket number into the pot.',
            icon: 'draw',

            roles: {
                organiser: {
                    requirements: {
                        variables: [ ...ROUND_VARIABLES, 'roundCategory', 'potSatoshis', 'ticketCount', 'roundSecret', 'nextPotCommitment' ],
                    },
                },
            },

            requirements: {
                participants: [ { role: 'organiser', slots: { min: 1, max: 1 } } ],
            },

            conditions: [ '$(<roundSecret> OP_SHA256 <secretHash> OP_EQUAL)' ],
            transaction: 'drawRoundTransaction',
        },

        claimPot: {
            name: 'Claim the pot',
            description: 'Spend the drawn pot with the winning ticket. Both NFTs are burned and the whole pot is paid out.',
            icon: 'claim',

            roles: {
                player: {
                    requirements: {
                        variables: [ ...ROUND_VARIABLES, 'roundCategory', 'potSatoshis', 'winningTicket', 'payoutLockingScript' ],
                        secrets: [ 'playerKey' ],
                    },
                },
            },

            requirements: {
                participants: [ { role: 'player', slots: { min: 1, max: 1 } } ],
            },

            transaction: 'claimPotTransaction',
        },

        refundTicket: {
            name: 'Refund a ticket',
            description: 'After the refund height, if the round was never drawn, burn a ticket and get its price back from the pot.',
            icon: 'refund',

            roles: {
                player: {
                    requirements: {
                        variables: [ ...ROUND_VARIABLES, 'roundCategory', 'potSatoshis', 'potCommitment', 'ticketNumber', 'payoutLockingScript' ],
                        secrets: [ 'playerKey' ],
                    },
                },
            },

            requirements: {
                participants: [ { role: 'player', slots: { min: 1, max: 1 } } ],
            },

            transaction: 'refundTicketTransaction',
        },
    },

    transactions: {
        openRoundTransaction: {
            name: 'Round opened',
            description: 'A Lotry round opened: tickets cost $(<ticketPrice>) satoshis, the draw is from block $(<drawHeight>).',
            icon: 'open',

            // The organiser adds one funding input. It must spend output 0 of its transaction:
            // that transaction hash becomes the round's token category (CashTokens genesis).
            inputs: [],
            outputs: [ { output: 'potOpenedOutput', outputIndex: 0 } ],

            version: 2,
            locktime: 0,
            composable: true,
        },

        buyTicketTransaction: {
            name: 'Ticket bought',
            description: 'Ticket #$(<ticketCount> OP_1ADD) bought for $(<ticketPrice>) satoshis.',
            icon: 'ticket',

            inputs: [ { input: 'potBuyInput', inputIndex: 0 } ],
            outputs: [
                { output: 'potBoughtOutput', outputIndex: 0 },
                { output: 'ticketOutput', outputIndex: 1 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },

        drawRoundTransaction: {
            name: 'Winner drawn',
            description: 'Ticket #$(winningTicketNumber) won the pot of $(<potSatoshis>) satoshis.',
            icon: 'draw',

            inputs: [ { input: 'potDrawInput', inputIndex: 0 } ],
            outputs: [ { output: 'potDrawnOutput', outputIndex: 0 } ],

            version: 2,
            // The covenant checks the lock time, so the transaction must carry it.
            locktime: '$(<drawHeight>)',
            composable: true,
        },

        claimPotTransaction: {
            name: 'Pot claimed',
            description: 'The winning ticket #$(<winningTicket>) claimed the pot.',
            icon: 'claim',

            inputs: [
                { input: 'potClaimInput', inputIndex: 0 },
                { input: 'ticketClaimInput', inputIndex: 1 },
            ],
            outputs: [ { output: 'claimPayoutOutput', outputIndex: 0 } ],

            version: 2,
            locktime: 0,
            composable: false,
        },

        refundTicketTransaction: {
            name: 'Ticket refunded',
            description: 'Ticket #$(<ticketNumber>) was refunded $(<ticketPrice>) satoshis.',
            icon: 'refund',

            inputs: [
                { input: 'potRefundInput', inputIndex: 0 },
                { input: 'ticketRefundInput', inputIndex: 1 },
            ],
            outputs: [
                { output: 'potRefundedOutput', outputIndex: 0 },
                { output: 'refundPayoutOutput', outputIndex: 1 },
            ],

            version: 2,
            locktime: '$(<refundHeight>)',
            composable: false,
        },
    },

    inputs: {
        potBuyInput: {
            name: 'Round pot',
            description: 'The pot before this ticket.',
            icon: 'pot',
            unlockingScript: 'potBuyUnlock',
        },
        potDrawInput: {
            name: 'Round pot',
            description: 'The pot when the winner is drawn.',
            icon: 'pot',
            unlockingScript: 'potDrawUnlock',
        },
        potClaimInput: {
            name: 'Drawn pot',
            description: 'The pot after the draw.',
            icon: 'pot',
            unlockingScript: 'potClaimUnlock',
        },
        potRefundInput: {
            name: 'Round pot',
            description: 'The undrawn pot after the refund height.',
            icon: 'pot',
            unlockingScript: 'potRefundUnlock',
        },
        ticketClaimInput: {
            name: 'Winning ticket',
            description: 'Ticket #$(<winningTicket>), burned to claim the pot.',
            icon: 'ticket',
            unlockingScript: 'ticketUnlock',
        },
        ticketRefundInput: {
            name: 'Ticket',
            description: 'Ticket #$(<ticketNumber>), burned for a refund.',
            icon: 'ticket',
            unlockingScript: 'ticketUnlock',
        },
    },

    outputs: {
        potOpenedOutput: {
            name: 'Round pot',
            description: 'A new round with no tickets sold yet.',
            icon: 'pot',
            lockingScript: 'potLockingScript',
            valueSatoshis: '$(<seedSatoshis>)',
            token: {
                category: '$(<roundCategory>)',
                amount: 0n,
                nft: { capability: 'minting', commitment: '$(<potCommitment>)' },
            },
        },
        potBoughtOutput: {
            name: 'Round pot',
            description: 'The pot after ticket #$(<ticketCount> OP_1ADD).',
            icon: 'pot',
            lockingScript: 'potLockingScript',
            valueSatoshis: '$(<potSatoshis> <ticketPrice> OP_ADD)',
            token: {
                category: '$(<roundCategory>)',
                amount: 0n,
                nft: { capability: 'minting', commitment: '$(<nextPotCommitment>)' },
            },
        },
        ticketOutput: {
            name: 'Lotry ticket',
            description: 'Ticket #$(<ticketCount> OP_1ADD) of this round.',
            icon: 'ticket',
            lockingScript: 'ticketLockingScript',
            valueSatoshis: '$(<ticketSatoshis>)',
            token: {
                category: '$(<roundCategory>)',
                amount: 0n,
                nft: { capability: 'none', commitment: '$(<ticketCommitment>)' },
            },
        },
        potDrawnOutput: {
            name: 'Drawn pot',
            description: 'The pot waiting for ticket #$(winningTicketNumber) to claim it.',
            icon: 'pot',
            lockingScript: 'potLockingScript',
            valueSatoshis: '$(<potSatoshis>)',
            token: {
                category: '$(<roundCategory>)',
                amount: 0n,
                nft: { capability: 'minting', commitment: '$(<nextPotCommitment>)' },
            },
        },
        potRefundedOutput: {
            name: 'Round pot',
            description: 'The pot after refunding ticket #$(<ticketNumber>).',
            icon: 'pot',
            lockingScript: 'potLockingScript',
            valueSatoshis: '$(<potSatoshis> <ticketPrice> OP_SUB)',
            token: {
                category: '$(<roundCategory>)',
                amount: 0n,
                nft: { capability: 'minting', commitment: '$(<potCommitment>)' },
            },
        },
        claimPayoutOutput: {
            name: 'Lotry winnings',
            description: 'The whole pot, paid to the winner.',
            icon: 'claim',
            lockingScript: '$(<payoutLockingScript>)',
            valueSatoshis: '$(<potSatoshis> <ticketSatoshis> OP_ADD <minerFeeSatoshis> OP_SUB)',
            token: null,
        },
        refundPayoutOutput: {
            name: 'Ticket refund',
            description: 'The ticket price, paid back.',
            icon: 'refund',
            lockingScript: '$(<payoutLockingScript>)',
            valueSatoshis: '$(<ticketPrice> <ticketSatoshis> OP_ADD <minerFeeSatoshis> OP_SUB)',
            token: null,
        },
    },

    lockingScripts: {
        potLockingScript: {
            name: 'Lotry pot',
            description: 'A lottery pot that only pays the drawn winner, or refunds tickets if the round is never drawn.',
            icon: 'pot',

            lockingType: 'p2sh',
            lockingBytecode: 'potRedeem',

            // Everything needed to rebuild the covenant is public round data.
            state: { variables: ROUND_VARIABLES, secrets: [] },

            // The pot belongs to nobody and must never be used to fund other transactions.
            selectable: false,
            balance: NO_BALANCE,

            roles: {
                organiser: {
                    state: { variables: [ 'roundCategory' ] },
                    actions: [
                        { action: 'buyTicket', role: 'organiser' },
                        { action: 'drawRound', role: 'organiser' },
                    ],
                    selectable: false,
                    balance: NO_BALANCE,
                },
                player: {
                    state: { variables: [ 'roundCategory' ] },
                    actions: [],
                    selectable: false,
                    balance: NO_BALANCE,
                },
            },
        },

        ticketLockingScript: {
            name: 'Lotry ticket',
            description: 'A numbered ticket NFT held by its player.',
            icon: 'ticket',

            lockingType: 'p2pkh',
            lockingBytecode: 'ticketLock',
            unlockingBytecode: 'ticketUnlock',

            roles: {
                player: {
                    state: { variables: [ ...ROUND_VARIABLES, 'roundCategory' ], secrets: [ 'playerKey' ] },
                    actions: [
                        { action: 'claimPot', role: 'player', secrets: [ { playerKey: null } ] },
                        { action: 'refundTicket', role: 'player', secrets: [ { playerKey: null } ] },
                    ],
                    // A ticket is a claim on the pot, not spending money: keep it out of coin selection.
                    balance: { satoshis: 0n, fungibleTokens: 0n, nonfungibleTokens: true },
                    selectable: false,
                },
            },
        },
    },

    scripts: {
        // ---- Round state encodings. The covenant enforces them on chain; clients compile these formulas
        //      to fill potCommitment, nextPotCommitment and ticketCommitment (test/covenant.test.mjs proves they agree).
        openCommitment: '<ticketCount> <4> OP_NUM2BIN',
        nextOpenCommitment: '<ticketCount> OP_1ADD <4> OP_NUM2BIN',
        winningTicketNumber: '<roundSecret> OP_SHA256 <4> OP_SPLIT OP_DROP <0x00> OP_CAT OP_BIN2NUM <ticketCount> OP_MOD OP_1ADD',
        drawnCommitment: 'winningTicketNumber <4> OP_NUM2BIN <0xd0> OP_CAT',
        drawnCommitmentFromWinner: '<winningTicket> <4> OP_NUM2BIN <0xd0> OP_CAT',

        // ---- Covenant building blocks. The pot is always input 0 and output 0.
        // The 32-byte round category: the pot's category without its minting capability byte.
        roundCategoryOnly: 'OP_0 OP_UTXOTOKENCATEGORY <32> OP_SPLIT OP_DROP',
        // The pot carries on: same covenant, same category, still the minting NFT.
        potCarriesOn: 'OP_0 OP_OUTPUTBYTECODE OP_0 OP_UTXOBYTECODE OP_EQUALVERIFY OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_UTXOTOKENCATEGORY OP_EQUALVERIFY',
        // The pot's commitment has the open (4 bytes) or drawn (5 bytes) shape; leaves the commitment on the stack.
        potIsOpen: 'OP_0 OP_UTXOTOKENCOMMITMENT OP_SIZE OP_4 OP_NUMEQUALVERIFY',
        potIsDrawn: 'OP_0 OP_UTXOTOKENCOMMITMENT OP_SIZE OP_5 OP_NUMEQUALVERIFY',
        // Input 1 is a ticket of this round: an immutable NFT, so its category has no capability byte.
        input1IsTicket: 'OP_1 OP_UTXOTOKENCATEGORY roundCategoryOnly OP_EQUALVERIFY',
        // Output N (when it exists) carries no token, so no NFT of the round can be copied or kept.
        output1HasNoToken: 'OP_TXOUTPUTCOUNT OP_1 OP_GREATERTHAN OP_IF OP_1 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY OP_ENDIF',
        output2HasNoToken: 'OP_TXOUTPUTCOUNT OP_2 OP_GREATERTHAN OP_IF OP_2 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY OP_ENDIF',

        // 1. Buy: the pot grows by exactly one ticket price and mints exactly one ticket, numbered count + 1.
        potBuy: `
            potIsOpen
            OP_BIN2NUM OP_1ADD OP_4 OP_NUM2BIN
            OP_DUP OP_0 OP_OUTPUTTOKENCOMMITMENT OP_EQUALVERIFY
            OP_1 OP_OUTPUTTOKENCOMMITMENT OP_EQUALVERIFY
            potCarriesOn
            OP_0 OP_OUTPUTVALUE OP_0 OP_UTXOVALUE <ticketPrice> OP_ADD OP_NUMEQUALVERIFY
            OP_1 OP_OUTPUTTOKENCATEGORY roundCategoryOnly OP_EQUALVERIFY
            OP_TXOUTPUTCOUNT OP_3 OP_LESSTHANOREQUAL OP_VERIFY
            output2HasNoToken
        `,

        // 2. Draw: after the draw height, anyone holding the secret fixes the winner: sha256(secret) mod tickets + 1.
        potDraw: `
            <drawHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP
            OP_DUP OP_SHA256 <secretHash> OP_EQUALVERIFY
            potIsOpen
            OP_BIN2NUM OP_DUP OP_0 OP_GREATERTHAN OP_VERIFY
            OP_SWAP OP_SHA256 <4> OP_SPLIT OP_DROP <0x00> OP_CAT OP_BIN2NUM
            OP_SWAP OP_MOD OP_1ADD
            OP_4 OP_NUM2BIN <0xd0> OP_CAT
            OP_0 OP_OUTPUTTOKENCOMMITMENT OP_EQUALVERIFY
            potCarriesOn
            OP_0 OP_OUTPUTVALUE OP_0 OP_UTXOVALUE OP_NUMEQUALVERIFY
            OP_TXOUTPUTCOUNT OP_2 OP_LESSTHANOREQUAL OP_VERIFY
            output1HasNoToken
        `,

        // 3. Claim: the drawn pot is spent with the winning ticket at input 1. Every token is burned.
        potClaim: `
            potIsDrawn
            OP_4 OP_SPLIT <0xd0> OP_EQUALVERIFY
            OP_1 OP_UTXOTOKENCOMMITMENT OP_EQUALVERIFY
            input1IsTicket
            OP_TXOUTPUTCOUNT OP_2 OP_LESSTHANOREQUAL OP_VERIFY
            OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
            output1HasNoToken
        `,

        // 4. Refund: after the refund height, an undrawn pot pays back one ticket price for one burned ticket.
        potRefund: `
            <refundHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP
            potIsOpen OP_DROP
            input1IsTicket
            potCarriesOn
            OP_0 OP_OUTPUTTOKENCOMMITMENT OP_0 OP_UTXOTOKENCOMMITMENT OP_EQUALVERIFY
            OP_0 OP_OUTPUTVALUE OP_0 OP_UTXOVALUE <ticketPrice> OP_SUB OP_NUMEQUALVERIFY
            OP_TXOUTPUTCOUNT OP_3 OP_LESSTHANOREQUAL OP_VERIFY
            output1HasNoToken
            output2HasNoToken
        `,

        // The pot covenant. The unlocking script picks a path with 1 to 4 (the secret goes under the 2).
        potRedeem: `
            OP_INPUTINDEX OP_0 OP_NUMEQUALVERIFY
            OP_DUP OP_1 OP_NUMEQUAL OP_IF OP_DROP potBuy OP_ELSE
            OP_DUP OP_2 OP_NUMEQUAL OP_IF OP_DROP potDraw OP_ELSE
            OP_DUP OP_3 OP_NUMEQUAL OP_IF OP_DROP potClaim OP_ELSE
            OP_4 OP_NUMEQUALVERIFY potRefund
            OP_ENDIF OP_ENDIF OP_ENDIF
            OP_1
        `,
        potBuyUnlock: 'OP_1',
        potDrawUnlock: '<roundSecret> OP_2',
        potClaimUnlock: 'OP_3',
        potRefundUnlock: 'OP_4',

        ticketLock: 'OP_DUP OP_HASH160 <$(<playerKey.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG',
        ticketUnlock: '<playerKey.schnorr_signature.all_outputs> <playerKey.public_key>',
    },

    constants: {
        ticketSatoshis: {
            name: 'Ticket dust',
            description: 'Satoshis carried by each ticket NFT output.',
            type: 'satoshis',
            value: 1000n,
        },
        minerFeeSatoshis: {
            name: 'Payout fee',
            description: 'Fee taken from the payout when a pot is claimed or a ticket refunded.',
            type: 'satoshis',
            value: 1000n,
        },
    },

    variables: {
        ticketPrice: { name: 'Ticket price', description: 'Satoshis paid into the pot for one ticket.', type: 'satoshis' },
        drawHeight: { name: 'Draw height', description: 'Block height from which the winner can be drawn.', type: 'integer' },
        refundHeight: { name: 'Refund height', description: 'Block height from which tickets of an undrawn round can be refunded.', type: 'integer' },
        secretHash: { name: 'Secret hash', description: 'SHA-256 of the organiser secret that decides the winner.', type: 'bytes' },
        roundSecret: { name: 'Round secret', description: 'The organiser secret, revealed at the draw.', type: 'bytes' },
        roundCategory: { name: 'Round category', description: 'Token category of this round: the pot NFT and every ticket.', type: 'token_category' },
        seedSatoshis: { name: 'Seed', description: 'Satoshis the organiser puts in the pot when opening it.', type: 'satoshis' },
        potSatoshis: { name: 'Pot', description: 'Satoshis in the pot right now.', type: 'satoshis' },
        potCommitment: { name: 'Pot state', description: 'The pot NFT commitment: the ticket count (openCommitment), or the winner (drawnCommitment).', type: 'token_commitment' },
        nextPotCommitment: { name: 'Next pot state', description: 'The pot NFT commitment after this action: nextOpenCommitment for a ticket, drawnCommitment for a draw.', type: 'token_commitment' },
        ticketCommitment: { name: 'Ticket number', description: 'The new ticket NFT commitment: the 4-byte ticket number (nextOpenCommitment).', type: 'token_commitment' },
        ticketCount: { name: 'Tickets sold', description: 'Tickets sold so far in this round.', type: 'integer' },
        winningTicket: { name: 'Winning ticket', description: 'The ticket number written into the pot at the draw.', type: 'integer' },
        ticketNumber: { name: 'Ticket number', description: 'The number of the ticket being refunded.', type: 'integer' },
        payoutLockingScript: { name: 'Pay to', description: 'Where the winnings or the refund go.', type: 'locking_script' },
        playerKey: { name: 'Player key', description: 'The key that holds a player\'s tickets.', type: 'private_key' },
    },

    icons: [
        { name: 'lotry', hash: '0000000000000000000000' },
        { name: 'organiser', hash: '0000000000000000000000' },
        { name: 'player', hash: '0000000000000000000000' },
        { name: 'open', hash: '0000000000000000000000' },
        { name: 'ticket', hash: '0000000000000000000000' },
        { name: 'draw', hash: '0000000000000000000000' },
        { name: 'claim', hash: '0000000000000000000000' },
        { name: 'refund', hash: '0000000000000000000000' },
        { name: 'pot', hash: '0000000000000000000000' },
    ],
};
