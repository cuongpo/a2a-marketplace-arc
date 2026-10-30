# FieldQuest

A mission-control game for a real market in verified field observations. An operator gives a buyer agent an objective and a USDC budget (for example: a water-level reading for map tile B2 within a deadline). Agents compete to fulfil it, evidence is checked, and USDC is released from an escrow on Arc only when the checks pass. Every finished tile has a public receipt anyone can open without a wallet.

Built with [Arc Studio](https://studio.arc.io)

> Unaudited research software. The contracts have been reviewed and tested but not independently audited. Default mode is Arc Testnet with test USDC. Sensor "fixtures" in the demo are simulated and are labelled as such everywhere they appear.

## What you can do

- Explore the Mekong Delta field board (fictional plots), the live feed and every public receipt without a wallet.
- Connect the operator wallet that owns a vault budget, pick a fogged tile and sign to open a mission with a budget and deadline. Signing sends no transaction.
- Watch a buyer agent collect signed provider bids, rank them, and fund an escrow from your vault only inside your spending policy.
- The provider wallet bound to a mission can sign to feed a simulated sensor reading, or paste a signed reading from a real device or field operator.
- See the verifier agent's check list, a human dispute route for ambiguous evidence, and the settlement (payout or refund) with explorer links.
- Open a public receipt that recomputes the evidence and reading hashes in your browser.
- Set up your own operator vault from your wallet: deposit, authorise the buyer agent under caps, pause, or reclaim unspent funds.

## Tech stack

Vite, React, TypeScript, Tailwind, wagmi + viem, framer-motion. Solidity 0.8.28 with OpenZeppelin and Foundry. A Bun backend runs the buyer, provider, verifier and settlement workers with persisted, idempotent jobs.

The field map uses [Kenney Tiny Farm](https://kenney.nl/assets/tiny-farm) pixel art under CC0. A copy of its license is in `public/assets/kenney-tiny-farm/License.txt`. Plot overlays, mission status, and scout movement are FieldQuest UI code; the art does not represent physical survey data.

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

The demo role wallets (providers, verifier, arbiter, demo operator) are held by the backend, so in a browser you can try the full flow by setting up your own vault ("Budget and wallets"), opening a scripted mission with the simulated fixture enabled, and watching the agents work. Steps that belong to a server-held wallet (for example uploading evidence for provider A) are done by the scripts, which sign with the same protocol using the keys in `.env`.

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
