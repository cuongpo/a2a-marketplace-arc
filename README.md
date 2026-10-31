# A2A Marketplace

A wallet-to-wallet marketplace for verified agent work on Arc. An operator opens a data request with a USDC budget. Independent provider wallets submit EIP-712 signed bids during a public auction. The buyer agent ranks eligible bids, spends only within the operator vault policy, and funds an escrow for the winner. The winner accepts the assignment, commits signed evidence, and receives USDC only after verification and the challenge window. Every trade has a public receipt.

Built with [Arc Studio](https://studio.arc.io)

> Unaudited research software. Default mode is Arc Testnet with test USDC. This release offers one service category: signed water-level data. Manual wallet signing proves account control, not the truth of a physical measurement. Demo fixtures are simulated and labelled.

## What you can do

- Explore the animated trading floor, request board, live feed and public receipts without a wallet. The floor highlights the actual request, bid, escrow, evidence, verdict and settlement state; character positions are illustrative.
- Connect an operator wallet with a vault budget, choose an available request slot and open a public A2A auction. Signing the request sends no transaction.
- Connect any external provider wallet to submit one independently signed bid. The buyer agent checks its signature, price, ETA, evidence capability and historical reliability when bidding closes.
- The winner uses its own wallet to accept the onchain assignment, register a signer, prepare evidence and commit its hash to escrow. Managed demo providers remain available only in scripted testnet journeys.
- See the verifier agent's check list, a human dispute route for ambiguous evidence, and the settlement (payout or refund) with explorer links.
- Withdraw credited USDC to the winning provider wallet and open a public receipt that recomputes evidence and reading hashes in your browser.
- Set up your own operator vault from your wallet: deposit, authorise the buyer agent under caps, pause, or reclaim unspent funds.

## Tech stack

Vite, React, TypeScript, Tailwind, wagmi + viem, framer-motion. Solidity 0.8.28 with OpenZeppelin and Foundry. A Bun backend runs the buyer, provider, verifier and settlement workers with persisted, idempotent jobs.

The public product name is **A2A Marketplace**. Existing testnet contracts retain the `FieldQuest` EIP-712 names and `fieldquest.*` evidence schemas: those cryptographic identifiers are immutable for this deployment and must stay unchanged to verify existing signatures and receipts. The new marketplace UI does not use farm art.

The trading floor uses character and interior sprites from **Modern tiles Free**. Its original license is preserved at `public/assets/modern-tiles/LICENSE.txt` and permits non-commercial use only. Replace or separately license these sprites before any commercial use; the marketplace code does not depend on the sprite files for transaction correctness.

## Development

Prerequisites: Bun, Foundry (`forge`). Optional: Arc Foundry (`arc-forge`) for Arc-specific testing.

```bash
bun install
bun run fq:keygen          # writes TESTNET-ONLY role keys into .env (never printed)
bun run server             # backend on :3001 (agents + API)
bun run dev                # frontend on :5173 (proxies /api to the backend)
```

To run real testnet missions you need test USDC on Arc Testnet in the operator wallet. Get it from the Arc Studio sidebar ("Get test USDC") or https://faucet.circle.com, send it to the operator address printed by `bun run fq:keygen`, then:

```bash
bun run fq:setup --with-8004   # fund role wallets, deposit into the vault, set policy, bind sensors
bun run fq:journey accept      # provider A wins, payout, provider withdrawal
bun run fq:journey reject      # provider B wins, implausible reading, rejection + refund
bun run fq:journey dispute     # ambiguous reading, escalation, human arbiter
```

## Who can do what

Reading is open to everyone. Every action that changes something needs a wallet signature, and the app tells you which wallet is required if you connect the wrong one:

- Open a mission or challenge a verdict: the operator wallet that authorised the buyer agent in its vault.
- Supply evidence or use the simulated fixture: the provider wallet bound to that mission.
- Rule on a dispute: the arbiter wallet.

The demo role wallets (providers, verifier, arbiter, demo operator) are held by the backend for scripted testnet journeys. Open A2A auctions accept externally controlled provider wallets; the server cannot accept or submit evidence for them. The winning external wallet must take those actions itself. Only a single provider can win and be paid per request under the current escrow contract.

**Deployment status:** deployed on Arc Testnet only. `src/deployments/arc-mainnet.json` has no contract addresses. Mainnet deployment and real USDC movement have not been performed; see `docs/MAINNET_RUNBOOK.md` before any mainnet use.

Environment variables (names only, see `.env.example`):

- `FQ_NETWORK` (testnet or mainnet), `FQ_SERVER_PORT`, `FQ_DATA_DIR`, `FQ_ENABLE_FIXTURE`, `FQ_VAULT_DEPOSIT`
- `FQ_OPERATOR_KEY`, `FQ_BUYER_AGENT_KEY`, `FQ_PROVIDER_KEY`, `FQ_SENSOR_KEY`, `FQ_PROVIDER2_KEY`, `FQ_SENSOR2_KEY`, `FQ_VERIFIER_KEY`, `FQ_ARBITER_KEY` (testnet-only role keys, backend only)
- `FQ_LLM_API_KEY` (optional, currently unused)
- `PROVIDER_KEY` and `DEVICE_KEY` (only for `scripts/ingest-sample.ts`: the bound provider wallet that authorises an upload, and the registered device key that signs the reading)
- `FQ_RPC_URL_OVERRIDE` (optional, local fork rehearsal only)
- `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` (optional outside Arc Studio)

Build and test:

```bash
bun run check              # lint + typecheck
bun run build              # production frontend build
bun run test:backend       # backend tests (auth, agents, UI render smoke)
bun run contracts:test     # Foundry tests (161)
```

Deeper docs (including the API authentication design in the threat model): `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/TESTING.md`, `docs/TESTNET_WALKTHROUGH.md`, `docs/MAINNET_RUNBOOK.md`, `docs/ADAPTERS.md`.
