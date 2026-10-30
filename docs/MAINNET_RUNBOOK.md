# Mainnet operator runbook (Arc, chain 5042)

Arc Studio prepared this configuration but did not deploy to, transact on, sign for or fund mainnet. Nothing here has been executed. You are responsible for every step, outside Arc Studio, with your own wallets.

Warning: transactions on mainnet involve real funds and, once submitted, are irreversible. Use testnet first, obtain an independent professional audit, and carefully review all wallet addresses, contract addresses, chain settings, permissions and other configuration before continuing.

Mainnet facts: chain id 5042, RPC https://rpc.mainnet.arc.io, explorer https://explorer.arc.io, USDC ERC-20 interface `0x3600000000000000000000000000000000000000` (6 decimals; native gas view is 18 decimals and shares the same balance).

## 0. Preconditions

1. Independent security audit of `MissionEscrow`, `AgentBudgetVault`, `EvidenceRegistry` (and `Erc8004Adapter` if used). Resolve every finding. Re-run `bun run contracts:test` and, with Arc Foundry, `arc-forge test`.
2. Decide the roles and use separate wallets you control: deployer, operator (treasury), buyer-agent executor, verifier, arbiter (human-controlled, ideally a multisig), and providers. Never reuse testnet keys.
3. Decide whether the sensor fixture is disabled (it must be: set `FQ_ENABLE_FIXTURE=0`).

## 1. Deploy from your own wallet

Use an encrypted keystore or hardware wallet, not a pasted key.

1. `EvidenceRegistry()`.
2. `MissionEscrow(usdc, registry, arbiter)` with the USDC address above.
3. `AgentBudgetVault(usdc, [escrow])`.
4. Optional: `Erc8004Adapter(identityRegistry, reputationRegistry, escrow)` using the mainnet registries listed at https://docs.arc.io/arc/references/contract-addresses.md.
5. Record addresses and deployment transaction hashes. Verify source on the explorer.
6. Put addresses in `src/deployments/arc-mainnet.json`.

## 2. Fund and configure

1. Fund the operator wallet with USDC for budget and gas, and the other role wallets with gas.
2. From the operator wallet: `approve` USDC to the vault, `deposit`, `setPolicy(executor, perMissionCap, totalCap, dailyCap, expiry)` with conservative caps, `setEscrowAllowed(escrow, true)`.
3. Providers register device keys: `registerSigner(deviceKey, metadataHash, deviceSignature)`.

## 3. Run the backend without server-held keys for human roles

Server-held keys are refused on mainnet by default. For a real deployment run buyer, provider and verifier agents with keys in a secrets manager or signer service you operate, and keep operator and arbiter signing human-controlled. This repository does not ship a mainnet signer integration; adding one is part of your review.

## 4. Acceptance tests (small amounts first)

1. One accepted mission: a real provider with a registered device key submits a real reading; verify the verdict, `finalize`, then the provider calls `withdraw(to)` and the USDC balance actually increases. Save all transaction hashes.
2. One refund: a rejected or expired mission; `claimRefund` / vault `reconcile`, and the operator's available budget is restored.
3. Pause the policy and confirm the agent cannot fund; reclaim unspent budget.

## 5. Host and collect

1. Host the frontend and backend publicly (the backend must not expose funded keys or be unauthenticated with spend authority).
2. Put the public app URL in the README.
3. Collect for submission: Arc Studio project URL, repository URL, app URL, the four contract addresses, transaction hashes for deployment, the accepted mission and its provider withdrawal, and the refund, plus a short demo video.

## Rollback

The contracts have no admin. To stop: `setPaused(true)` or `revokeExecutor()` in the vault, and `withdrawAvailable` to reclaim uncommitted funds. Funds in open missions settle by their normal rules or timeouts.
