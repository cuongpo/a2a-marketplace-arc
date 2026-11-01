# Arc Mainnet pilot runbook (chain 5042)

Status: **deployed as a bounded hackathon pilot on 2026-11-01**. The four application contracts are live on Arc Mainnet, six role wallets were funded, two ERC-8004 provider identities were registered, and the operator deposited 0.80 USDC into the vault. This is unaudited research software. A quick Arc Studio review found no critical/high finding, but it is not an independent audit; do not treat this pilot as production-ready.

## 1. What is prepared locally

- `.env.mainnet` is a git-ignored, mode 0600 local wallet vault. It contains nine newly generated keys and public-address comments: deployer, operator, buyer agent, verifier, arbiter, two providers, and two device signers. It is **never uploaded to Arc Studio**. Keep a secure backup and do not paste keys into chat, Git, shell command arguments or a hosted app.
- `.env.mainnet.server` contains only the buyer and verifier keys. Its signing switch was enabled locally for this user-authorized bounded pilot. The backend refuses to sign as operator, provider, device or arbiter.
- `.env.mainnet.provider-a` and `.env.mainnet.provider-b` each contain only one provider and one device key. Their runner switches were enabled locally. A provider feed must name its real source and preserve its original observation time; simulated fixtures remain forbidden on mainnet.
- `bun run mainnet:preflight` is read-only. It checks the RPC chain, official contracts, local key separation, file permissions, public balances and whether our own deployment contracts have code. It prints no private keys.
- `bun run mainnet:plan` was used before deployment. It now refuses to plan a fresh deployment because the manifest has live addresses.

The exact Arc Mainnet facts are [RPC and chain ID](https://docs.arc.io/arc/references/rpc-endpoints), [contract addresses](https://docs.arc.io/arc/references/contract-addresses), and [gas rules](https://docs.arc.io/arc/references/gas-and-fees). USDC is the gas token. Its ERC-20 interface is `0x3600000000000000000000000000000000000000` with six decimals; native gas accounting uses 18 decimals. Mainnet ERC-8004 IdentityRegistry is `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`; ReputationRegistry is `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`.

## 2. Pilot USDC estimate

The deployer received **5 USDC** on Arc Mainnet. Four mainnet deployments cost approximately **0.145193 USDC** total; actual fees vary per receipt. The operator deposited only **0.80 USDC** into the vault and set matching `0.50 / 0.80 / 0.80` per-mission / total / daily caps, expiring after 72 hours.

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

The deployer distributed **3.10 USDC** to the six operating wallets. Device keys received 0 because they only sign offchain. The remaining operator and deployer balances stay outside the vault as gas and reserve. Do not transfer testnet USDC or ETH to these addresses. Current public balances are checked by `mainnet:preflight`.

## 3. Production gates still open

1. Obtain an **independent audit** of `EvidenceRegistry`, `MissionEscrow`, `AgentBudgetVault` and `Erc8004Adapter`. Resolve material findings before increasing vault deposits or user-facing production use. Internal tests and Arc Studio's quick review are not an independent audit.
2. Re-run `forge test --summary`, `forge build`, `bun run check`, `bun run test:backend` with testnet-only role keys, `bun run build`, and Arc Foundry's `arc-forge test --network arc` on any changed contract code. On 2026-11-01, Arc Studio's Arc Foundry run passed 161/161 Solidity tests and the backend suite passed 94/94 with isolated testnet-only keys.
3. Move operator and arbiter to hardware or multisig custody for sustained use. The generated hot keys are only a pilot convenience. Recheck role balances, source verification, host security, backup and monitoring before a public launch.

## 4. Deployment and bounded vault configuration

The local signer read the deployer key from the gitignored vault; no key appeared in a command-line argument. The transactions were sent in this order and each constructor getter was checked after receipt:

1. `EvidenceRegistry()`.
2. `MissionEscrow(USDC, EvidenceRegistry, arbiter)`.
3. `AgentBudgetVault(USDC, [MissionEscrow])`. The vault's trusted escrow set is immutable.
4. `Erc8004Adapter(IdentityRegistry, ReputationRegistry, MissionEscrow)`. The adapter is required for this application's open agent directory.

| Contract | Address | Deployment transaction |
|---|---|---|
| EvidenceRegistry | `0x12Ca5F0A45Bb1b3aa86A161F73f9330eFf4E7123` | `0x86386964ebec33c1fac9db6106de76a5f26acf8b73d3be07c1a32542d51db2b8` |
| MissionEscrow | `0x5556B234331f37d49A44A1086de0229569492212` | `0x493da623d54f3e7e8663e58447442051850045a5b6075a0342cdd8ee0b8d8c8c` |
| AgentBudgetVault | `0xA8FdB1BF1b3aA8bF5Fa2fA676138a255D0F36e58` | `0x290b9ef736180227422c648d9e0210d7dc68a2de9b9de7e6c492d1c2b2b0a838` |
| Erc8004Adapter | `0x300a16910D8A27Af2075255AA1B03e58D69a8720` | `0xf19e58d4b22664b676a61196276e58b70234a3c818a8391a93f438645a146824` |

The receipt hashes and addresses are also in `src/deployments/arc-mainnet.json`. All four contracts have [Sourcify](https://repo.sourcify.dev/) **exact creation and runtime bytecode matches** for their published source: [Registry](https://repo.sourcify.dev/5042/0x12Ca5F0A45Bb1b3aa86A161F73f9330eFf4E7123), [Escrow](https://repo.sourcify.dev/5042/0x5556B234331f37d49A44A1086de0229569492212), [Vault](https://repo.sourcify.dev/5042/0xA8FdB1BF1b3aA8bF5Fa2fA676138a255D0F36e58), [Adapter](https://repo.sourcify.dev/5042/0x300a16910D8A27Af2075255AA1B03e58D69a8720).

The operator approved and deposited **0.80 USDC**, set the buyer policy to **0.50 per mission / 0.80 total / 0.80 daily USDC** with 72-hour expiry, and allowlisted only the deployed escrow. Transactions: approve `0x33f5e61a85e06b05af8873e74f766a507341d1d8dc868d1d5745fd01e49d26bc`; deposit `0xe801dd39cf758eb58f39a639795f3ad2b84f0b22189d7286aec1e72e0d99ec66`; policy `0xbab30bb2a1e4dd5eb5a378f5d1092959295a79bb3a89b71c0e66412833f46b3a`; allowlist `0x68cbd121269fe3bb7dcce02d29641c155814c4f0bdc642e91ec97dc2ced8b135`. Operators can pause the policy, revoke the executor and reclaim uncommitted funds.

For this local pilot, `FQ_ALLOW_MAINNET_SERVER_KEYS=i-understand` is set **only in** `.env.mainnet.server`; run `bun --no-env-file --env-file=.env.mainnet.server run server/index.ts`. Each provider runner has its own isolated env. The app needs a real sourced feed; `SIMULATED=1` is rejected on mainnet. Do not load `.env.mainnet` into the backend process because it also contains human and provider keys.

## 5. Live pilot evidence and stopping

The first real mission is application ID `1717cca0`, escrow ID `1`, tile B3. Both independently operated provider runners signed quotes; the buyer selected Provider A at **0.20 USDC**, with a **0.05 USDC** verifier fee. The vault funded **0.25 USDC**. Provider A relayed the public NOAA CO-OPS San Francisco station 9414290 preliminary water level at 2026-11-01 15:18 UTC: **1.785 m MLLW = 1785 mm**, after the escrow was created. The registered device signer bound the observation to the mission and committed evidence hash `0xb3e3b7adc0f2ca48ba53ec4dde70ca0ce058f164ea0c580b3321f3b396b0bd53`. The signature proves relay key control, not ownership of a physical sensor or NOAA endorsement. The verifier accepted; after the challenge window, the escrow finalized **ProviderPaid**, the vault reconciled, the verifier withdrew 0.05 USDC, Provider A withdrew 0.20 USDC, and the ERC-8004 adapter posted successful delivery feedback. The escrow balance and Provider A credit returned to zero; the vault had 0.55 USDC available immediately afterward.

| Step | Arc Mainnet transaction |
|---|---|
| Fund escrow from bounded vault | [`0xe4118360…`](https://explorer.arc.io/tx/0xe41183603f924075cd28b01826bebceab6c782ddcbd056bda00b15d9647e1776) |
| Submit verifier verdict | [`0x9bf4c683…`](https://explorer.arc.io/tx/0x9bf4c683e68029fe2bc896cc3f61f3e384077482031517ed311e8614148eea11) |
| Finalize after challenge window | [`0x39062980…`](https://explorer.arc.io/tx/0x39062980a7d50815463a77601ecf8197459434a67e2d7260967cdb14c97824ae) |
| Reconcile vault | [`0x76bf4352…`](https://explorer.arc.io/tx/0x76bf4352ea802306127043901b97bbbe50e7fa358a1d414f4f856925b14c95a2) |
| Withdraw verifier fee | [`0x429bd06f…`](https://explorer.arc.io/tx/0x429bd06f03a0064d3d5b374d816623233c3068545d3b5b2ae7848cbaa9e262ca) |
| Record ERC-8004 feedback | [`0x3d0adc78…`](https://explorer.arc.io/tx/0x3d0adc78dfc7c40ccdadcf031cae88c3bb9bd6c4a92b7999340db9d217875293) |
| Withdraw Provider A payment | [`0x8ba69ed4…`](https://explorer.arc.io/tx/0x8ba69ed4b847a6eeee7dfcc8f6c568ffd73ecda9edb764cd8e5d84834805d7b5) |

The second real mission is application ID `2f3e3d08`, escrow ID `2`, tile C4. Two provider wallets bid again; the buyer selected Provider B at **0.10 USDC** plus the **0.05 USDC** verifier fee. Provider B relayed NOAA CO-OPS Nikiski station 9455760 preliminary water level at 2026-11-01 15:36 UTC: **3.303 m MLLW = 3303 mm**. The observation was newer than escrow creation. Its signed evidence hash was `0x52a86001f64f04281fa0f60b58bff01ce31a0bac0851179ce5fc713d0406efdb`. The verifier rejected the reading because **3303 mm exceeds this mission's explicit 2500 mm plausibility maximum**. The value is an authentic relay of a public NOAA API response; the rejection demonstrates the app's configured validation rule, not a claim that NOAA's measurement was false. After the challenge window, the escrow settled **BuyerRefunded**: **0.10 USDC** returned to the operator vault, while the verifier withdrew its **0.05 USDC** fee. Provider B received no price credit. The vault ended with **0.50 USDC available**, **0 committed**, **0.30 net spent**, and escrow liabilities/USDC balance both **0**.

| Step | Arc Mainnet transaction |
|---|---|
| Fund second escrow from bounded vault | [`0xb2df9e00…`](https://explorer.arc.io/tx/0xb2df9e004772a7a9cec506c191d4478e1fc10e2f36e00ef8f07dd2335482bd22) |
| Submit signed reject verdict | [`0x393ce247…`](https://explorer.arc.io/tx/0x393ce2476966417f818eb70ef31d020752b79e0bdf3553cd8bd830e986b0dda3) |
| Finalize BuyerRefunded | [`0x942fa12c…`](https://explorer.arc.io/tx/0x942fa12cf7c074870cbf08e711ea90935c877e9d99d62b421cdbeca18d3ac985) |
| Reconcile vault refund | [`0xf188603c…`](https://explorer.arc.io/tx/0xf188603cf6d1fd17045477aea3e3032aefcb97f3abbad5c615a85dd4cbf7d13c) |
| Withdraw verifier fee | [`0x554e2a83…`](https://explorer.arc.io/tx/0x554e2a83cbe1ce56e2a46b35eca0c7ccc39ecc1171efc45d0a58a23f9f33be11) |
| Record ERC-8004 outcome feedback | [`0x88cea678…`](https://explorer.arc.io/tx/0x88cea6788a8f23017e8a74483e870228e6e6fa33d27c5fb1c47960eb0d7960e6) |

The public read-only pilot viewer is [a2a-marketplace-arc.vercel.app](https://a2a-marketplace-arc.vercel.app). It preserves the two completed mission receipts and fetches current Arc block height, vault balances and escrow liabilities directly from the public Arc RPC, without keys or a local machine. Its API rejects writes with HTTP 405. The mission receipts are stored historical records; Explorer remains the source of truth. A separate local read-only backend can supply fresh mission data during a live pilot but is optional. The Arc Studio workspace is [FieldQuest Agent Commerce Platform](https://studio.arc.io/app/85cafd3b-414a-4a69-a0e7-a2dd13e31f16).

Run `node scripts/mainnet-verify-pilot.mjs` to re-fetch all 13 mission transaction receipts, both final onchain outcomes and evidence hashes, the four contract bytecodes, and final vault/escrow balances directly from the Arc Mainnet RPC. It needs no keys or local mission database.

The paid second-source integration is currently testnet-only and remains disabled in the mainnet pilot.

Stop new funding with `setPaused(true)` or `revokeExecutor()` from the operator wallet; reclaim only available vault funds. Open escrows continue under their settlement and timeout rules. The contracts have no owner, upgrade or emergency pause key.

## 6. DoraHacks submission handoff

**Project title:** A2A Marketplace — Open Agent Network on Arc

**Short description:** Independent agent wallets register ERC-8004 identities and bid on data requests with EIP-712 signatures. A buyer agent ranks bids using price, capability, delivery time and recorded trust, then spends only within a human-set USDC vault policy. The winning provider commits a signed, content-addressed observation; a verifier checks the evidence and the Arc Mainnet escrow releases payment or refunds the buyer after a challenge window. The pixel office visualizes each state. Two real mainnet missions demonstrate both outcomes using clearly attributed NOAA CO-OPS public water-level data. The signatures attest who relayed a reading; they do not establish physical sensor ownership.

| Form field | Value |
|---|---|
| Arc Studio project | https://studio.arc.io/app/85cafd3b-414a-4a69-a0e7-a2dd13e31f16 |
| Public app | https://a2a-marketplace-arc.vercel.app |
| Public repository | https://github.com/cuongpo/a2a-marketplace-arc |
| Builder profile | https://github.com/cuongpo |
| Mainnet escrow | https://explorer.arc.io/address/0x5556B234331f37d49A44A1086de0229569492212 |
| Real USDC transfer into escrow | https://explorer.arc.io/tx/0xe41183603f924075cd28b01826bebceab6c782ddcbd056bda00b15d9647e1776 |
| Real provider withdrawal | https://explorer.arc.io/tx/0x8ba69ed4b847a6eeee7dfcc8f6c568ffd73ecda9edb764cd8e5d84834805d7b5 |
| Refund example | https://explorer.arc.io/tx/0xf188603cf6d1fd17045477aea3e3032aefcb97f3abbad5c615a85dd4cbf7d13c |

**How Arc Studio was used:** The original four contracts and application were generated and iterated in the Arc Studio project above. Its Arc Testnet deployments and 161 passing Solidity tests are visible from the CLI/project history. After local security hardening and an Arc Studio quick review, the same application contracts were deployed from a locally held signer to Arc Mainnet; Arc Studio does not hold or use the mainnet key. Sourcify has exact bytecode matches for all four mainnet contracts. The public viewer and the 13 successful pilot transaction receipts show the mainnet app behavior. This is a bounded, unaudited pilot.

**Video walkthrough shot list (60–90 seconds):** In a browser signed into Arc Studio, show this project's workspace, contract files, test/review result and app preview (20 seconds). Open the public mainnet viewer, show B3 ProviderPaid and its receipt, then C4 BuyerRefunded and its receipt (30 seconds). Open the Arc Explorer funding and provider-withdrawal transactions, pointing to USDC movement and the escrow address (20 seconds). End on the public GitHub repo and the four verified contract links (10 seconds). Record and upload the video from the builder's logged-in browser; paste its public or unlisted URL into DoraHacks. Do not show any `.env` file, wallet key, Arc Studio token or Vercel credentials.
