# Testing

## Contracts

```bash
forge test                                   # 161 tests, 10 suites
~/.local/bin/arc-forge test                  # same suite on Arc Foundry (v0.8.0-2)
```

Install Arc Foundry from https://github.com/circlefin/arc-foundry/releases (see https://docs.arc.io/arc/tutorials/install-arc-foundry.md). Result when last run: 161 passed, 0 failed on both stock Foundry and Arc Foundry. The suites use a mock 6-decimal USDC (with blocklist and fee-on-transfer variants) and mock ERC-8004 registries, so real USDC and the real ERC-8004 registries are not exercised by unit tests.

Coverage: creation and funding, vault caps (per mission, total, daily with day rollover), pause, expiry, non-executor and non-trusted-escrow rejection, accepted payout with an actual `withdraw`, rejection and refund through the vault, expiry, dispute and every timeout branch, bad signer, replay across missions, chains and contracts, reused sensor nonce, wrong tile, stale reading, reentrancy, duplicate calls, blocklisted recipients, fee-on-transfer tokens, adapter isolation, and invariants (escrow balance covers liabilities, exact conservation of price plus fee, vault accounting).

## Backend

```bash
bun run test:backend
```

`server/tests/auth.test.ts` drives the real HTTP handler with real EIP-712 signatures from throwaway keys: unauthenticated POST on every mutating route, independent provider quote submission, duplicate and wrong-wallet bids, valid operator and provider signatures, replay (failed and successful), tampered body, path swap, forged challenge, expired challenge, wrong chain id, wrong role for operator, provider, mission operator and arbiter, paused and expired vault policy, and public reads. Chain reads are replaced by fakes, no transaction can be sent.

The rest covers canonical hashing, input guards, buyer ranking and exclusion, fixture signatures, evidence redaction and hash stability, upload validation and idempotent jobs (a finished job never re-runs, failed jobs back off, a running job is not started twice).

## Static checks

```bash
bun run check        # oxlint + tsc
bun run build        # vite production build
```

## Local fork rehearsal (no real USDC needed)

This runs the real deployed contract code and the full agent pipeline against a local fork of Arc Testnet with balances set by `anvil_setBalance`. Transactions exist only on the fork; they are NOT public-testnet transactions and have no explorer pages.

```bash
arc-anvil --network arc --fork-url <testnet rpc> --port 8546 --block-time 1 --chain-id 5042002
# fund the operator on the fork, then run a second backend against it with its own data dir:
FQ_RPC_URL_OVERRIDE=http://127.0.0.1:8546 FQ_DATA_DIR=/tmp/fqfork FQ_SERVER_PORT=3002 bun run server
FQ_RPC_URL_OVERRIDE=http://127.0.0.1:8546 bun run fq:setup --with-8004
FQ_RPC_URL_OVERRIDE=http://127.0.0.1:8546 FQ_API=http://127.0.0.1:3002 bun run fq:journey accept
```

Last fork rehearsal results (labelled fork, not public testnet): accept journey ended Settled / ProviderPaid with provider and verifier withdrawals; reject journey ended BuyerRefunded with the vault budget restored; dispute journey escalated and the arbiter ruled for the buyer. Vault accounting afterwards: available 2.45, committed 0, net spent 0.55 USDC, escrow liabilities 0.

## Open agent network tests

`server/tests/network.test.ts`: registration authorization (unsigned, spoofed identity, wrong binding, duplicate/moved identity, immutable id, self-only deactivation, profile and URL validation), invitation matching and persistence, uninvited bids, trust (cold start, adapter-filtered query arguments, spoof/transfer exclusion, registry-down fallback, blend), buyer ranking with trust components, and the feedback job (log-driven claims, idempotent re-runs, registry failure, partial success, independence from reconcile and withdrawals, no automatic back-fill). `runner/core.test.ts`: the external runner critical path with fake chain and API (onboarding, correctly signed quote, one accept, pause without a feed, evidence verification, one submit, one withdraw, restart safety with pending hashes). `server/tests/ui-smoke.test.tsx` renders the agent cards and checks that bubbles only repeat recorded facts.
