# Arc Mainnet pilot runbook (chain 5042)

Status: **prepared, not deployed**. No mainnet transaction has been signed or broadcast. The four application contract addresses in `src/deployments/arc-mainnet.json` are empty. This repository is unaudited research software. An independent audit and resolution of its findings are required before using real USDC.

## 1. What is prepared locally

- `.env.mainnet` is a git-ignored, mode 0600 local wallet vault. It contains nine newly generated keys and public-address comments: deployer, operator, buyer agent, verifier, arbiter, two providers, and two device signers. It is **never uploaded to Arc Studio**. Keep a secure backup and do not paste keys into chat, Git, shell command arguments or a hosted app.
- `.env.mainnet.server` contains only the buyer and verifier keys. Its `FQ_ALLOW_MAINNET_SERVER_KEYS` switch is empty. On mainnet, the backend refuses to sign as operator, provider, device or arbiter.
- `.env.mainnet.provider-a` and `.env.mainnet.provider-b` each contain only one provider and one device key. Their `RUNNER_MAINNET_ACK` switches are empty. Both feed files are empty; no fabricated observation will be submitted.
- `bun run mainnet:preflight` is read-only. It checks the RPC chain, official contracts, local key separation, file permissions, public balances and whether our own deployment contracts have code. It prints no private keys.
- `bun run mainnet:plan` is read-only. After `forge build`, it prints the four constructor arguments, artifact hashes and predicted addresses for the deployer's current nonce. Sending any deployer transaction changes the predictions.

The exact Arc Mainnet facts are [RPC and chain ID](https://docs.arc.io/arc/references/rpc-endpoints), [contract addresses](https://docs.arc.io/arc/references/contract-addresses), and [gas rules](https://docs.arc.io/arc/references/gas-and-fees). USDC is the gas token. Its ERC-20 interface is `0x3600000000000000000000000000000000000000` with six decimals; native gas accounting uses 18 decimals. Mainnet ERC-8004 IdentityRegistry is `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`; ReputationRegistry is `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`.

## 2. Pilot USDC estimate

At the read-only check on 2026-11-01, Arc Mainnet reported **25 Gwei**. The four deployments used **7,448,098 gas** on testnet, giving a *spot comparison* of approximately **0.186 USDC** for those four transactions. This is not a mainnet quote; recheck gas just before sending.

| Wallet | Pilot allocation | Purpose |
|---|---:|---|
| Deployer | 1.00 USDC | Four deployments and gas buffer |
| Operator | 2.00 USDC | Small vault budget, setup, gas |
| Buyer agent | 0.25 USDC | Escrow funding transactions and gas |
| Verifier | 0.25 USDC | Verdict, keeper, feedback and gas |
| Provider A | 0.25 USDC | Identity, binding, signer, delivery, withdrawal and gas |
| Provider B | 0.25 USDC | Identity, binding, bidding and gas |
| Arbiter | 0.10 USDC | Dispute action if exercised |
| Device A/B | 0 USDC | Offchain signatures only |

Total planned distribution: **4.10 USDC**. Prepare **5 USDC** on Arc Mainnet to leave 0.90 USDC outside these wallets as reserve. This is a small pilot budget, not a production operating balance. Only the operator's deposit becomes marketplace spending capacity; the rest is gas money. Do not transfer testnet USDC or ETH to these addresses. The current public balances are checked by `mainnet:preflight`.

## 3. Gates before any deployment

1. Obtain an **independent audit** of `EvidenceRegistry`, `MissionEscrow`, `AgentBudgetVault` and `Erc8004Adapter`. Resolve and re-audit material findings. Freeze the audited commit and compiler settings. Internal tests are not an audit.
2. Run `forge test --summary`, `forge build`, `bun run check`, `bun run test:backend` with testnet-only role keys, `bun run build`, and Arc Foundry's `arc-forge test --network arc`. Arc Foundry models Arc runtime differences. On 2026-11-01, Arc Studio's Arc Foundry run passed 161/161 Solidity tests; the backend suite passed 94/94 with isolated testnet-only keys. Repeat both on the final audited commit.
3. Run `bun run mainnet:preflight` and `bun run mainnet:plan` again after the final build. Review every address, constructor argument, code hash and proposed policy cap. Move the operator and arbiter to hardware or multisig custody for sustained production use; the generated hot keys are a pilot convenience.

## 4. Deploy and configure (requires a human review of real-money transactions)

Use Arc Foundry with a keystore (`--account`) or hardware signer. Do not put a private key in a command-line argument. Deploy in this order:

1. `EvidenceRegistry()`.
2. `MissionEscrow(USDC, EvidenceRegistry, arbiter)`.
3. `AgentBudgetVault(USDC, [MissionEscrow])`. The vault's trusted escrow set is immutable.
4. `Erc8004Adapter(IdentityRegistry, ReputationRegistry, MissionEscrow)`. The adapter is required for this application's open agent directory.

After each receipt, verify the chain ID and constructor immutables onchain, save the transaction hash, and check the actual address against the plan. Populate `src/deployments/arc-mainnet.json` with the four actual addresses and transaction hashes. Verify the exact audited source on the Arc explorer. If the nonce or an address differs, stop and recompute the rest of the plan; never reuse an outdated predicted address.

From the operator wallet: approve the intended USDC amount to the vault, deposit only the pilot amount, set policy for the buyer agent with **0.50 per mission / 2.00 total / 1.00 daily USDC** caps and a short expiry, then allowlist the escrow. The UI sends each operation from the operator's own wallet. Operators can pause the policy, revoke the executor and reclaim uncommitted funds.

After audit, deployment and host hardening, set `FQ_ALLOW_MAINNET_SERVER_KEYS=i-understand` **only in** `.env.mainnet.server`, then run `bun --no-env-file --env-file=.env.mainnet.server run server/index.ts`. Set `RUNNER_MAINNET_ACK=audited-and-funded` in each isolated provider env after funding it, and run each runner separately. The app needs an actual operator-provided feed; `SIMULATED=1` is rejected on mainnet. Do not load `.env.mainnet` into the backend process because it also contains human and provider keys.

## 5. Acceptance and stopping

Open one small custom auction with two independent signed bids. Confirm the selected provider's assignment, signed evidence, verifier verdict, challenge window, escrow credit, provider withdrawal and ERC-8004 feedback on mainnet receipts. Then test a rejected or expired request and confirm the operator budget is restored. The paid second-source integration is currently testnet-only and must remain disabled in the mainnet pilot.

Stop new funding with `setPaused(true)` or `revokeExecutor()` from the operator wallet; reclaim only available vault funds. Open escrows continue under their settlement and timeout rules. The contracts have no owner, upgrade or emergency pause key.
