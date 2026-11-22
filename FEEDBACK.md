# Feedback on building with XO

_Written by Nikhil PN for the Migrate to XO and Build with XO bounties._

I’m Nikhil Pn and my Co Partner Hina Hanan. At Exprmnts, I make fun web3 projects for the internet. 
We made Lotry.fun as a runner up in Base Batch India 2025, and it is built on base first, then migrated onto Solana . With BLAZE, I was interested in seeing whether we could port the same round to BCH without an owner. This was made possible via XO. Here is my experience.

Getting started
I read through the docs and template package. The format of templates makes sense and in one file, you can define roles, actions and scripts. I made the pot with 5 paths (buy, close, draw, claim, refund) and no signing path. Each player holds their ticket as an NFT in their own wallets. This was simple.

Issues
When running in Node, I ran into issues. The SQLite storage provided in @xo-cash/state (version 0.0.5) doesn’t work (calling Engine.create throws the error. Then I switched to fake-indexeddb, and manually saved to disk. However, only one account can be run per process. Trying to run a second engine throws ‘Cannot configure storage for cache after it has been initialized’. To combat this, I had to run each role (organiser, buyer A, buyer B) as separate processes. While this works, a simple example in Node from the docs would have saved me 1/2 a day.

Commitments
I wanted to calculate the NFT commitments in the template, for example based off the number of tickets + 1. However, when trying to pass in tokens to calculate the commitment, they were parsed as strings, then hex, throwing an error. Eventually I calculated these externally, using the scripts defined in the template, and passed them into the template as variables.

Best part
Selling tickets via 2 party transactions was very smooth. The organiser creates the pot, players join. They receive a new key, pay and sign. The organiser signs (seals) and sends. Passing JSON files between the parties worked perfectly. The follow-up actions are clever too. The ticket itself allows the holder to claim or refund.

Delays
The draw transaction was slow to implement. The input in the draw is a P2SH32, with a large redeemer script. The fee estimation does not include this, meaning on submission, the node throws the error "min relay fee not met”. During sealing, addChangeToInvitation took the change from the buyers’ fee. I manually set the fees. However, during drawing, I continued to get errors “bad-txns-nonfinal”.  The errors that I have noted: my AI agent has noted all the errors and I have saved it. I am adding it here. These are the errors that I found.(That's why I have added the error names, okay?)

After a lot of testing, I found that Faster Blocks has altered the calculation of locktime heights on chipnet. They are now in 10 minute intervals. This meant that in the first round we used normal block heights, and so it is impossible to draw for weeks. This is not an issue with XO specifically, but as all XO apps on chipnet will face this issue, a note on this would be helpful.
Other issues

In the buyer wallet, I only saw the pot update once the final version of the invitation had been sent in the broadcast. I found this by looking at the engine source code. Basically this function name - (generateTemplateIdentifier) did not match with the engine ID or debug tool ID. 
After a re-org on chipnet, I was unable to see any new coins in my wallet until clearing my Electrum cache.

Debug tool
blaze.xo.cash was very useful. As the template ID was the same, and I could view all the signed commits, I was able to step through each operation in the draw transaction.

Suggestions
It would be great to be able to monitor covenants which I did not create. It would be helpful for token fields to allow for calculated byte values. getChainStatus should return lock time height. A functioning SQLite backend for Node would be great, and a two party invite example in the browser.  Also if you could provide MCP support, a Claude skill, or an agent.md file, it would be very useful for the AI to debug and install the package and work on it. I would really hope to bring agent support.

Will I use XO in the future? Yes!

 The idea of the template being the app is solid. The issues I had were largely due to using early versions.
