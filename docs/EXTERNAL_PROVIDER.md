# External provider agent

Anyone can sell readings in the marketplace with their own wallet. Nothing about an external provider is held by the backend: the
runner (`runner/provider-agent.ts`) is a separate Bun process with only its own two keys. It talks to the API for discovery and
evidence preparation, and to Arc Testnet for every transaction.

## What the runner does

1. **Identity.** Registers an ERC-8004 identity for your wallet (or reuses `AGENT_ID` if you own one) and binds it in the marketplace
   adapter (`bindAgent`). The directory only accepts wallets whose identity token is owned by the signing wallet AND is bound to the
   same id in the adapter.
2. **Reading signer.** Registers `DEVICE_KEY` in the EvidenceRegistry for your wallet (the device countersigns the binding).
3. **Directory.** Signs `POST /agents` (wallet-signed, single-use challenge) with your public profile.
4. **Bids.** Polls `GET /invites?wallet=...` (pull-based: the backend never calls out to you). For each open request that fits your
   price and ETA it signs an EIP-712 quote and posts it to `POST /missions/:id/quotes`. With `BID_ON_UNINVITED=1` it also bids on
   open requests it was not invited to; invitations are recommendations, not an allowlist.
5. **Assignment.** When the buyer agent selects you and escrows USDC, it calls `acceptAssignment` from your wallet.
6. **Observation.** Takes a value from your feed, signs an EIP-712 reading with the device key bound to the mission, asks the API to
   prepare the evidence bundle, checks that the bundle hashes to the returned hash and carries your device, wallet and nonce, then
   commits the evidence hash onchain from your wallet.
7. **Payout.** After the verifier's verdict and the challenge window the escrow credits your wallet; the runner calls `withdraw`.

If there is no feed value the runner **pauses at step 6** and tells you which tile it is waiting for. Add the value to the feed file
and it continues on the next poll.

## Run it

```bash
cp .env.provider.example .env.provider     # fill in PROVIDER_AGENT_KEY and DEVICE_KEY (two different testnet keys)
# send ~0.04 test USDC to the wallet address (Arc gas is paid in USDC)
echo '{"B3": {"valueMm": 418, "note": "entered by me"}}' > feed.json
bun run runner:provider
```

Helper for a throwaway testnet setup: `bun run scripts/fq-provider-keygen.ts <name> feed|simulated` writes `.env.provider-<name>`
(mode 600, git-ignored) and prints only the public addresses. Run it with
`bun --no-env-file --env-file=.env.provider-<name> run runner/provider-agent.ts`.

## Observation sources

* `FEED_FILE` (default): a JSON map of tile to `{ "valueMm": integer, "note": "..." }`. The reading is labelled
  `field-operator-upload`. It is a number you typed or exported, **not** a verified physical measurement.
* `SIMULATED=1`: a deterministic testnet-only value labelled `simulated-fixture` in the evidence, the receipt and the UI.
* A real device or serial feed: write its readings into the feed file (a small adapter can rewrite `feed.json` from a serial port
  or an HTTP source; see `docs/ADAPTERS.md`). The signature proves your device key signed the value, not that the value is true.

## Restart safety

The runner stores its progress in `runner-state-<wallet prefix>.json` (git-ignored). Every transaction hash is written *before*
the runner waits for its receipt. On restart it waits for a recorded hash instead of sending again, checks the onchain mission
status before accepting or submitting, re-sends the identical signed observation (deterministic evidence hash), and treats a
"quote already submitted" answer as success. A reverted or dropped transaction is re-checked against chain state before any retry.

## Trust and reputation

After a mission reaches a final state a keeper job calls the adapter's `recordOutcome(missionId)`. The adapter (not the buyer) posts
ERC-8004 feedback for your agent id, so the buyer scores you from `getSummary(agentId, [adapter], "fieldquest.delivery")` only.
Self-posted feedback is never counted. Reputation follows the identity token: if an identity changes hands in the directory, its
inherited onchain reputation is not counted. Reputation is a social signal, not proof that a reading is true.
If the reputation registry rejects one role, the keeper retries the missing role up to four times. Each confirmed attempt is
linked in the mission receipt; neither a retry nor a registry outage holds up escrow settlement or withdrawals.
