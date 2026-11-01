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
- Optionally require a paid second source. After primary evidence arrives, a separate buyer wallet pays a reference service through Circle Gateway/x402 on Arc Testnet. The verifier checks the source signature, mission binding and value difference; a disagreement escalates to human review.
- Withdraw credited USDC to the winning provider wallet and open a public receipt that recomputes evidence and reading hashes in your browser.
- Set up your own operator vault from your wallet: deposit, authorise the buyer agent under caps, pause, or reclaim unspent funds.

## Tech stack

Vite, React, TypeScript, Tailwind, wagmi + viem, framer-motion. Solidity 0.8.28 with OpenZeppelin and Foundry. A Bun backend runs the buyer, provider, verifier and settlement workers with persisted, idempotent jobs.

The public product name is **A2A Marketplace**. Existing testnet contracts retain the `FieldQuest` EIP-712 names and `fieldquest.*` evidence schemas: those cryptographic identifiers are immutable for this deployment and must stay unchanged to verify existing signatures and receipts. The new marketplace UI does not use farm art.

The full-width trading floor draws a continuous pixel office from **Modern tiles Free** room-builder, interior, and character sprites, with code-drawn desk pods and status nameplates. Its original license is preserved at `public/assets/modern-tiles/LICENSE.txt` and permits non-commercial use only. Replace or separately license these sprites before any commercial use; the marketplace code does not depend on the sprite files for transaction correctness.

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
FQ_REQUIRE_PAID_REFERENCE=1 bun run fq:journey accept  # accepted journey including a paid reference
```

### Paid reference source

The second-source path is opt-in and testnet-only. Configure `FQ_REFERENCE_SERVICE_URL`, `FQ_REFERENCE_BUYER_KEY`, `FQ_REFERENCE_SIGNER_ADDRESS`, and `FQ_REFERENCE_SELLER_ADDRESS` on the buyer backend. The buyer wallet needs at least 0.001 USDC in its **Circle Gateway balance** before it can purchase a reading. This is separate from the operator's mission vault. No paid source is configured by default, and the verifier never silently substitutes the old in-process reference fixture.

An independently operated seller can run `bun run reference:seller` with `FQ_REFERENCE_SIGNER_KEY`, `FQ_REFERENCE_SELLER_ADDRESS`, and `FQ_REFERENCE_FEED_FILE` in its own environment. The JSON feed maps a slot such as `B2` to `{ "valueMm": 420, "observedAt": 1793450000, "sourceId": "gauge-42", "provenance": "device-adapter" }`. `observedAt` must be a real recent Unix timestamp from the source operator. For a clearly labelled protocol demo, use `"provenance": "simulated-fixture"` and `"observedAt": "now"`; the seller then timestamps the simulated value when it serves the request. A signature authenticates the operator, not the physical reading. The sample seller charges 0.001 USDC per call and signs a mission-bound payload. Keep its signing key out of the buyer backend and out of Git.

For an example of funding a Gateway wallet and how the HTTP 402 payment flow works, see [Circle's Arc Testnet seller walkthrough](https://www.circle.com/blog/turn-your-api-into-a-storefront-for-agents). A Gateway payment authorization can be settled in a later batch, so the app records a payment reference and does not present it as an individual Arc transaction hash. A failed or interrupted purchase requires an explicit signed operator retry to avoid automatic duplicate charges. The `fq:journey dispute` script now requires this reference service to be configured and funded.

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
- `FQ_REFERENCE_*` (optional, paid independent reference source; see `.env.example`)
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

## Open agent network

Any wallet can join as a data provider. The Agent Network panel (below the trading floor) lists registered agents with their ERC-8004 identity number, verified status, a trust score with every component and sample count, and what each one has actually done on the selected request (invited, bid, selected, paid, feedback). Registration is wallet-signed; the wallet must own the identity and have bound it in the marketplace adapter. Buyers rank bids by price, evidence type, deadline and trust. Trust blends local escrow history with ERC-8004 feedback posted by this marketplace's own adapter, so self-posted feedback never counts. If the registry is unreachable, ranking falls back to local history and payouts are unaffected.

To join, run your own provider agent with your own keys: see [docs/EXTERNAL_PROVIDER.md](docs/EXTERNAL_PROVIDER.md) and `.env.provider.example`.

```bash
cp .env.provider.example .env.provider   # your own testnet wallet key + a separate device key
bun run runner:provider
```

Runner environment variables (names only): `PROVIDER_AGENT_KEY`, `DEVICE_KEY`, `A2A_API`, `PROVIDER_NAME`, `CAPABILITY`, `MIN_PRICE_USDC`, `MAX_PRICE_USDC`, `QUOTE_PRICE_USDC`, `ETA_SEC`, `MAX_ETA_SEC`, `CARD_URL`, `AGENT_ID`, `BID_ON_UNINVITED`, `POLL_SEC`, `FEED_FILE`, `SIMULATED`, `RUNNER_STATE_FILE`.

Deeper docs (including the API authentication design in the threat model): `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/TESTING.md`, `docs/TESTNET_WALKTHROUGH.md`, `docs/MAINNET_RUNBOOK.md`, `docs/ADAPTERS.md`.

## Paid reference demo (testnet, simulated feed)

`bun run scripts/fq-reference-setup.ts keys A1` creates separate seller and buyer keys (the seller key goes only into the ignored `.env.seller`), `fund` moves at most 0.02 test USDC to the buyer and deposits 0.005 into Circle Gateway, and `bun run reference:seller` starts the seller on port 3002 using only `.env.seller`. Then `FQ_TILE_ACCEPT=A1 FQ_REQUIRE_PAID_REFERENCE=1 bun run fq:journey accept` buys one 0.001 USDC reference. The reference feed is a SIMULATED fixture and is labelled that way everywhere.
