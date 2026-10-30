# Testnet walkthrough (Arc Testnet, chain 5042002)

Everything below ran on the PUBLIC Arc Testnet (not a fork). Every transaction link is a transaction whose receipt was re-fetched and confirmed `success` by `bun run scripts/fq-verify.ts` (raw output: `docs/testnet-verification.txt`, `docs/testnet-verification.json`). Funds are test USDC with no real value. No mainnet transaction was made and none is claimed.

> Note: missions #1 to #4 were executed before the API was hardened. They used scripts that called the then-unauthenticated write endpoints. **Mission #5 occurred after the hardening and every write for it was EIP-712 wallet-signed.** The live API rejects unsigned writes.

**What is real and what is simulated**

- Real: wallets, USDC movement, escrow, vault, verdict signatures, withdrawals, refunds, ERC-8004 identities.
- Simulated: the sensor. Every reading was produced by the testnet-only SIMULATED fixture (keys `FQ_SENSOR_KEY` / `FQ_SENSOR2_KEY`). No physical instrument was involved, and the evidence bundles are labelled that way.
- Simulated: the two provider agents and the pricing scenario knobs (scripted demo scenarios). They are real wallets running real agent code, but they are not independent businesses.
- All demo role keys are held by one backend process. This demonstrates the protocol, not decentralised operation.

## Contracts

| Contract | Address | Deploy tx |
|---|---|---|
| EvidenceRegistry | [`0x6fc13addb07161575841d9f8732dffbf271b9d29`](https://explorer.testnet.arc.io/address/0x6fc13addb07161575841d9f8732dffbf271b9d29) | [`0x9848207e47...`](https://explorer.testnet.arc.io/tx/0x9848207e47368fd81aa543a3a4da0d7720ceb36302708eacbf02d485deda5034) |
| MissionEscrow | [`0xdf6f312e10e6d57eb9b7fafc599c92e87288d16e`](https://explorer.testnet.arc.io/address/0xdf6f312e10e6d57eb9b7fafc599c92e87288d16e) | [`0xdf28054da0...`](https://explorer.testnet.arc.io/tx/0xdf28054da03c77053927ccadfa4fb1a73d28ea4faea5a80c5bf3fcabeab487a2) |
| AgentBudgetVault | [`0x8c29ac73ee2fef44542192c4a217620473bcfe76`](https://explorer.testnet.arc.io/address/0x8c29ac73ee2fef44542192c4a217620473bcfe76) | [`0x51db5eeb87...`](https://explorer.testnet.arc.io/tx/0x51db5eeb875875b9039458ab6be62f9f8d267a8ca262d5bb693967178a05b3cb) |
| Erc8004Adapter | [`0x5f083614fc370621ea640ca29701cfd65be787da`](https://explorer.testnet.arc.io/address/0x5f083614fc370621ea640ca29701cfd65be787da) | [`0xb31b44cacd...`](https://explorer.testnet.arc.io/tx/0xb31b44cacdc788d7bf2dfd9b8c96bb53a081c3bc09dc8b47b7eb4076f20ccfe8) |

USDC (ERC-20 view, 6 decimals): `0x3600000000000000000000000000000000000000`. ERC-8004 registries used: Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`, Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`.

## Role wallets (public addresses)

| Role | Address | Balance after mission #5 (USDC) |
|---|---|---|
| Operator (demo key, server-held) | [`0xfA0cBCB1E1E011d2fD4aD76784803fD2F829599b`](https://explorer.testnet.arc.io/address/0xfA0cBCB1E1E011d2fD4aD76784803fD2F829599b) | 15.08316 |
| Buyer agent (vault executor) | [`0x2A4C4378EE6Ed672e17D50a9520bF90E8E296CEa`](https://explorer.testnet.arc.io/address/0x2A4C4378EE6Ed672e17D50a9520bF90E8E296CEa) | 0.419731 |
| Provider A: Delta Gauge Co-op | [`0x4ad09eF9705e1b0671Dc8d75620A721084d680c9`](https://explorer.testnet.arc.io/address/0x4ad09eF9705e1b0671Dc8d75620A721084d680c9) | 1.066098 |
| Provider B: Paddy Scout Network | [`0xa89732b3b40bFc0EAD0680F3AE2B9bB8ee9CB6e4`](https://explorer.testnet.arc.io/address/0xa89732b3b40bFc0EAD0680F3AE2B9bB8ee9CB6e4) | 0.282182 |
| Verifier agent | [`0x5a15f6c6Aa81f6CA983435E64DFb9E4F211C3286`](https://explorer.testnet.arc.io/address/0x5a15f6c6Aa81f6CA983435E64DFb9E4F211C3286) | 0.807142 |
| Human arbiter (demo key, server-held) | [`0x066fC10050d2E5084A7985fF40E362CF0b61aEa8`](https://explorer.testnet.arc.io/address/0x066fC10050d2E5084A7985fF40E362CF0b61aEa8) | 0.19776 |

## One-time setup (`bun run fq:setup --with-8004`), 17 transactions, all `success`

- funded buyer 0x2A4C4378EE6Ed672e17D50a9520bF90E8E296CEa with 0.5 USDC: [0x1e7f1c9924ce...](https://explorer.testnet.arc.io/tx/0x1e7f1c9924ce41d26b95050da76ed4c6d3e792b018d236597102616a9b4ad231)
- funded providerA 0x4ad09eF9705e1b0671Dc8d75620A721084d680c9 with 0.3 USDC: [0xdaa3629a78d8...](https://explorer.testnet.arc.io/tx/0xdaa3629a78d82a9f2f824884c646fe98f27f7141952d7893a8b4cfefae7d4edb)
- funded providerB 0xa89732b3b40bFc0EAD0680F3AE2B9bB8ee9CB6e4 with 0.3 USDC: [0xc946c7f4774a...](https://explorer.testnet.arc.io/tx/0xc946c7f4774ad1931fd8593548b82d4e537a6c73b29bfee711a95734e21ee31f)
- funded verifier 0x5a15f6c6Aa81f6CA983435E64DFb9E4F211C3286 with 0.6 USDC: [0x18f2af03bd73...](https://explorer.testnet.arc.io/tx/0x18f2af03bd73860ef33226c08023bc6ed40b53a54200bad1ee7911735248aa9a)
- funded arbiter 0x066fC10050d2E5084A7985fF40E362CF0b61aEa8 with 0.2 USDC: [0xed8cf2a5d538...](https://explorer.testnet.arc.io/tx/0xed8cf2a5d538210544b1d60c58206bded310160b53092d05719d44e454a5aa72)
- operator approved vault for 3 USDC: [0x6b661c65b896...](https://explorer.testnet.arc.io/tx/0x6b661c65b8960f07ef701cd0767069434cf5449ab7a451a0e2e7416ec78e5513)
- operator deposited 3 USDC into vault: [0x4b1c4b39f727...](https://explorer.testnet.arc.io/tx/0x4b1c4b39f727b1302d58ae830636ddec27807763c358b9e9d56189b283ae14f7)
- operator authorised buyer agent (per-mission 1.5, total 10, daily 5 USDC, 30 days): [0x5f3284710c37...](https://explorer.testnet.arc.io/tx/0x5f3284710c37ee3ab755505addf153a39a1392d959567e89f0831267ae033f4a)
- operator allowlisted escrow: [0xa856649bea35...](https://explorer.testnet.arc.io/tx/0xa856649bea35c8e20a9c159bd90543bb8ab25c01fb145d65adcaf69c816e6f14)
- providerA registered simulated device key 0x47617D72c9E0EFB7215d6F90D875285bDed96Ce4: [0x0c353421b52e...](https://explorer.testnet.arc.io/tx/0x0c353421b52ea89f29076419918ac30dbecc2aa1b67dc85aacbc713fa34d5b8d)
- providerB registered simulated device key 0xF5308e5381BE3B060537E53927699724A82AE9C8: [0xe8479f5b90fe...](https://explorer.testnet.arc.io/tx/0xe8479f5b90fed9cca07271f5859d8df68e66dc5cb5d42e1a0d51faf25cf9c904)
- providerA registered ERC-8004 identity 897705: [0xc0c6da29bd7e...](https://explorer.testnet.arc.io/tx/0xc0c6da29bd7ea13c3ae50ef7996541bc07223655ce8dee773fc041981f167348)
- providerA bound agent 897705 in the adapter: [0xcd3204d62ff7...](https://explorer.testnet.arc.io/tx/0xcd3204d62ff7309e42c3713eba93a601290c46c3cc6c313645620b2d425c9708)
- providerB registered ERC-8004 identity 897706: [0xe7918e5d6fc5...](https://explorer.testnet.arc.io/tx/0xe7918e5d6fc599ce4f6d3a03a9ce13f062b243236483bbcc2353720c0ec1d29b)
- providerB bound agent 897706 in the adapter: [0x186e2abbe6bb...](https://explorer.testnet.arc.io/tx/0x186e2abbe6bba95891bcdff9ecda892fa808c852654e0b5bdbf5867faf9854bd)
- verifier registered ERC-8004 identity 897707: [0xa7bf1fec6b2b...](https://explorer.testnet.arc.io/tx/0xa7bf1fec6b2b7fed3bb589c9f0c5263d8759db62189c1980ed0012e8b0a042e1)
- verifier bound agent 897707 in the adapter: [0xaea98592cb97...](https://explorer.testnet.arc.io/tx/0xaea98592cb97b887a61ce1d902fdcdf557097f203366187b30616abef4e5e141)

ERC-8004 agent ids 897705 (Provider A), 897706 (Provider B), 897707 (verifier) were bound in the adapter; ownership of 897705 by the Provider A wallet was read back from the Identity Registry. Reputation feedback (`recordOutcome`) was not called in this run.

## Mission journeys

### Mission #1: Accepted journey (tile B2, Provider A)

Public receipt route: `/receipt/e20c735e` (also `/receipt/1`). Final onchain state: **Settled / ProviderPaid**.

| Step | Block | Transaction | USDC ERC-20 Transfer logs in that tx |
|---|---|---|---|
| buyer agent funds mission from vault | 69860433 | [0x83ef0ad3b887...](https://explorer.testnet.arc.io/tx/0x83ef0ad3b8874b6710b823a5ecdc3c88d057f293ff06424c54c0edd055cb13a2) | AgentBudgetVault to MissionEscrow: 0.45 USDC |
| provider accepts assignment | 69860442 | [0x2b614c96912a...](https://explorer.testnet.arc.io/tx/0x2b614c96912a4147e01f9b789deb3b3c3f9344d559f379b236424d738925288c) | - |
| provider submits evidence hash | 69860453 | [0xfba6b6dad81c...](https://explorer.testnet.arc.io/tx/0xfba6b6dad81c95d631d38966b7950aed88fe83b604eed57211b2c621573a4bc7) | - |
| verifier submits signed accept verdict | 69860462 | [0x9224863584be...](https://explorer.testnet.arc.io/tx/0x9224863584be73feb5ed0da718756fcfeb95a0b9bc1591b5b0826bc61025e636) | - |
| keeper finalizes after challenge window and credits payouts | 69860532 | [0x3ae0b0818dbc...](https://explorer.testnet.arc.io/tx/0x3ae0b0818dbc60e672e7143575e6eb1ba530eac404342d16d5dcc402780ddf05) | - |
| vault reconciles settlement and restores refund to operator budget | 69860541 | [0x42325f2d629f...](https://explorer.testnet.arc.io/tx/0x42325f2d629ffa35e614a4f8238e9f6daad8fed742eb611c97796d975fe47a36) | - |
| provider withdraws credited USDC | 69860549 | [0xf8d6e66acc03...](https://explorer.testnet.arc.io/tx/0xf8d6e66acc0356aac278904a030be37c64a3d7330daf25dfdcfc06b530e90126) | MissionEscrow to Provider A: Delta Gauge Co-op: 0.4 USDC |
| verifier withdraws credited USDC | 69860558 | [0x5e30f3a97124...](https://explorer.testnet.arc.io/tx/0x5e30f3a971240cbce381e5f5f775cd758a3bc5692b7da8c6cf4cecc165c87c93) | MissionEscrow to Verifier agent: 0.05 USDC |

### Mission #2: Rejected journey, first run (tile C3): won by Provider A

Public receipt route: `/receipt/2ab0f2f7` (also `/receipt/2`). Final onchain state: **Settled / BuyerRefunded**.

| Step | Block | Transaction | USDC ERC-20 Transfer logs in that tx |
|---|---|---|---|
| buyer agent funds mission from vault | 69860581 | [0xebe9818b0cb6...](https://explorer.testnet.arc.io/tx/0xebe9818b0cb673c9e705516dbd289958d40eeffb726c0415de65318c81ff91cd) | AgentBudgetVault to MissionEscrow: 0.65 USDC |
| provider accepts assignment | 69860591 | [0xea88fed8162d...](https://explorer.testnet.arc.io/tx/0xea88fed8162d8ba797131e5b90049da1098864f5b9b4bbddbcb8a7f0b592cacc) | - |
| provider submits evidence hash | 69860600 | [0x2f75a59134eb...](https://explorer.testnet.arc.io/tx/0x2f75a59134ebbb5a2a2c1fd1d4878aa3bb6bfd302181956cb4ec484765a6b2e8) | - |
| verifier submits signed reject verdict | 69860610 | [0xa8b8ed1c0e76...](https://explorer.testnet.arc.io/tx/0xa8b8ed1c0e7622dff79d35c2315619fc5533ae2182436afae98da171070e7e59) | - |
| keeper finalizes after challenge window and credits payouts | 69860674 | [0xe97e83065c25...](https://explorer.testnet.arc.io/tx/0xe97e83065c258a596c96b1e8940421a77175e60ebf76ef5f99e25d4f65355195) | - |
| vault reconciles settlement and restores refund to operator budget | 69860684 | [0x1dd3bfb7db26...](https://explorer.testnet.arc.io/tx/0x1dd3bfb7db26a242d97b782481e1973ed542d6b706d41c0d6b7c06961586a9dc) | MissionEscrow to AgentBudgetVault: 0.6 USDC |
| verifier withdraws credited USDC | 69860692 | [0x609c5e736466...](https://explorer.testnet.arc.io/tx/0x609c5e7364665f6c362b630c4cbbfb31b96cab59c476aaf1820b83843f21274c) | MissionEscrow to Verifier agent: 0.05 USDC |

### Mission #3: Dispute journey (tile D1): ambiguous reading escalated, arbiter rules for buyer

Public receipt route: `/receipt/dcdd6a3e` (also `/receipt/3`). Final onchain state: **Settled / BuyerRefunded**.

| Step | Block | Transaction | USDC ERC-20 Transfer logs in that tx |
|---|---|---|---|
| buyer agent funds mission from vault | 69860743 | [0x5f17bd764d9a...](https://explorer.testnet.arc.io/tx/0x5f17bd764d9a475d2c5b3b58129fbf6510c137bc6694706ddc320e945bf5f3a9) | AgentBudgetVault to MissionEscrow: 0.45 USDC |
| provider accepts assignment | 69860753 | [0x307c4609ceb7...](https://explorer.testnet.arc.io/tx/0x307c4609ceb7ef5a49f59ff70b26a82de6e0824aa0ce3ca9ac4fba97efffda74) | - |
| provider submits evidence hash | 69860772 | [0x71022b6a31fe...](https://explorer.testnet.arc.io/tx/0x71022b6a31fed71db77cfc6749860278ef0d90176b3a417cabe14114591a90b1) | - |
| verifier submits signed escalate verdict | 69860782 | [0x50d152a0297d...](https://explorer.testnet.arc.io/tx/0x50d152a0297d5ca7a4be0acd9010960b8818be190413ef25feb6cc1f21f2509e) | - |
| arbiter rules for buyer | 69860798 | [0x0990774ac8f6...](https://explorer.testnet.arc.io/tx/0x0990774ac8f6d1bb2bc09df615e5028ea4954b1a2c19bee3fdc7ca931764aa0a) | - |
| vault reconciles settlement and restores refund to operator budget | 69860802 | [0x235535b21f73...](https://explorer.testnet.arc.io/tx/0x235535b21f731f334a80ceb856646c1d62efbe12c1b5c0a5ed62d06d0bdeb047) | MissionEscrow to AgentBudgetVault: 0.4 USDC |
| verifier withdraws credited USDC | 69860806 | [0x320a7484c3b1...](https://explorer.testnet.arc.io/tx/0x320a7484c3b1ae4fb8806dfc339769ab2b38c653ebef658ce762ee3bcc973edb) | MissionEscrow to Verifier agent: 0.05 USDC |

### Mission #4: Rejected journey (tile E2, Provider B): implausible reading rejected, buyer refunded

Public receipt route: `/receipt/de02363a` (also `/receipt/4`). Final onchain state: **Settled / BuyerRefunded**.

| Step | Block | Transaction | USDC ERC-20 Transfer logs in that tx |
|---|---|---|---|
| buyer agent funds mission from vault | 69860899 | [0xc34aaf33d2ae...](https://explorer.testnet.arc.io/tx/0xc34aaf33d2ae51b2eb8cc93082317c16235576efc9dd0af443c19f5ecd5aa47b) | AgentBudgetVault to MissionEscrow: 0.35 USDC |
| provider accepts assignment | 69860910 | [0x41db26bb4360...](https://explorer.testnet.arc.io/tx/0x41db26bb4360f4568d008aa360ae96608aa4233c28a18c9e59b27ca562db2ce0) | - |
| provider submits evidence hash | 69860919 | [0xd01fac50bb13...](https://explorer.testnet.arc.io/tx/0xd01fac50bb1338569972ef87984a9cb74ceed19d6be532f6ffbd29aa0dbdf941) | - |
| verifier submits signed reject verdict | 69860929 | [0xf2db3e2cf4ad...](https://explorer.testnet.arc.io/tx/0xf2db3e2cf4ad318afae2af8bff53481c97414c70b8e4f2d0ab421f27cc0fa113) | - |
| keeper finalizes after challenge window and credits payouts | 69860992 | [0x62264b1ecf1b...](https://explorer.testnet.arc.io/tx/0x62264b1ecf1b852bd31932f443bddc3dd3b809f05292261cc8d6ffd617d46742) | - |
| vault reconciles settlement and restores refund to operator budget | 69861002 | [0xb29ddee70f6d...](https://explorer.testnet.arc.io/tx/0xb29ddee70f6d5c6388b7ea0cd09e6bb7ad9648fc6dcb939a025947641e2f6d97) | MissionEscrow to AgentBudgetVault: 0.3 USDC |
| verifier withdraws credited USDC | 69861011 | [0xafa023579f23...](https://explorer.testnet.arc.io/tx/0xafa023579f235f6a0934b5c65600ef0b13d5a0bf05bd8823ffbff3719b9bdebe) | MissionEscrow to Verifier agent: 0.05 USDC |

### Mission #5: Accepted journey AFTER API hardening (tile F1, Provider A), every write EIP-712 wallet-signed

Public receipt route: `/receipt/5` (also `/receipt/6308814e`). Final onchain state: **Settled / ProviderPaid**. Budget requested: 1 USDC; funded 0.45 USDC (0.40 provider price + 0.05 verifier fee).

This is the only mission that ran after the API was hardened. The only API write for it, `POST /missions` (which enabled the simulated fixture feed), was an EIP-712 wallet-signed request with a single-use server nonce, signed by the role wallet that the server's role check requires (the vault operator wallet to open the mission). Nothing was sent unsigned. The agents' onchain transactions below are signed by the agent wallets as before. The signing happened in `scripts/fq-journey.ts` via `scripts/lib/signed-api.ts` (the same protocol the browser uses), using the demo operator key held in the sandbox, so this proves the protocol and the role checks, not a visitor-driven browser flow.

The reading (401 mm) came from the testnet-only SIMULATED sensor fixture. It is not a physical measurement. The payment is real test USDC movement.

| Step | Block | Transaction | USDC ERC-20 Transfer logs in that tx |
|---|---|---|---|
| buyer agent funds mission from vault | 69863876 | [0x9225fbb41161...](https://explorer.testnet.arc.io/tx/0x9225fbb41161dce92048845a0c8e26a8b29de8c6c6fff7aaebf5510c0b1740ab) | AgentBudgetVault to MissionEscrow: 0.45 USDC |
| provider accepts assignment | 69863885 | [0x02062b9e022b...](https://explorer.testnet.arc.io/tx/0x02062b9e022b4e5711959e551a547182ea1efb60bc6146dced713012f2aefdd3) | - |
| provider submits evidence hash | 69863895 | [0x62938b0925cc...](https://explorer.testnet.arc.io/tx/0x62938b0925cc243a237ec3f62a830ea2178e92aacd3db1b92aa635e1070c4593) | - |
| verifier submits signed accept verdict | 69863905 | [0x2f8af8bbd179...](https://explorer.testnet.arc.io/tx/0x2f8af8bbd1797855f8f0f106e703791962966d76cd5273900f3294984bd4a900) | - |
| keeper finalizes after challenge window and credits payouts | 69863974 | [0x0d9f43289132...](https://explorer.testnet.arc.io/tx/0x0d9f4328913201951220fd9ae8fa3a397d4c43562980c8bb0770a2c55726529e) | - |
| vault reconciles settlement and restores refund to operator budget | 69863984 | [0xc9be51df0d75...](https://explorer.testnet.arc.io/tx/0xc9be51df0d75dd9cbf480484bdf1f1fc04097e2e1b43ee12ed0ff0bb5d54a0d2) | - |
| provider withdraws credited USDC | 69863992 | [0x284a1cf3ee79...](https://explorer.testnet.arc.io/tx/0x284a1cf3ee790ed81acc0b2711965986857b2395afa92e5fcf3fc57c110124be) | MissionEscrow to Provider A: Delta Gauge Co-op: 0.4 USDC |
| verifier withdraws credited USDC | 69864001 | [0x2a23272c85b3...](https://explorer.testnet.arc.io/tx/0x2a23272c85b3649027263c46d8030d23973a08db38eb6fb27317f780a9e7731c) | MissionEscrow to Verifier agent: 0.05 USDC |

Verified by `bun run scripts/fq-verify.ts`: all eight receipts `success`; funding Transfer AgentBudgetVault to MissionEscrow 0.45 USDC; payout Transfers MissionEscrow to Provider A (0.40) and to the verifier (0.05) in their own withdrawal transactions; refund 0 (accepted, nothing to refund). The browser-side receipt proofs (evidence hash, reading digest, device signature, spec hash, verdict reason hash) were recomputed from the live receipt and all passed.

## What was verified

- Every transaction above: receipt status `success`, re-fetched from the public RPC after the journey, and (for the provider withdrawal) also found by the explorer API.
- USDC movement was read from ERC-20 `Transfer` logs emitted by the USDC contract. Each transaction also carries one EIP-7708 system Transfer log for the same funds; those were counted but never added, so nothing is double counted.
- Accepted journey: vault to escrow 0.45 USDC (0.40 provider price + 0.05 verifier fee); escrow to **Provider A wallet 0.40 USDC** (its own `withdraw`); escrow to verifier 0.05 USDC. The provider wallet is distinct from the buyer, operator and verifier wallets.
- Rejected journeys: the escrow paid the verifier fee 0.05 USDC and the **buyer refund went from the escrow back to the vault** (0.60, 0.40 and 0.30 USDC respectively), and the vault credited it to the operator's budget. The provider received nothing.
- Mission #4 is the rejection with a provider wallet separate from the accepted journey: Paddy Scout Network (Provider B, `0xa89732...CB6e4`) was chosen by the buyer agent, submitted an implausible simulated reading (valid signature, outside plausibility bounds), and was rejected.
- Escrow held 0 USDC with 0 liabilities after every mission.
- After missions #1 to #4 the vault had 2.40 USDC available, 0 committed, 0.60 net spent (0.45 + 0.05 + 0.05 + 0.05), matching the transfers. After mission #5 it had 1.95 available and 1.05 net spent.
- Evidence hash and spec hash recomputed by the receipt API match the onchain commitments for all five missions.
- Mission #5 (after hardening): vault to escrow 0.45 USDC; escrow to Provider A 0.40 USDC; escrow to verifier 0.05 USDC. The vault then showed 1.95 USDC available, 0 committed, 1.05 net spent; the escrow held 0 with 0 liabilities.

## Honest notes

- **First rejected run picked Provider A, not B.** The buyer agent weighs historical reliability, and Provider A had just been paid, so it outscored Provider B at the scripted price. That mission (#2) is a real, valid rejection and is kept. To demonstrate a rejection with a separate provider wallet I widened the scripted price gap and reran on a new tile (mission #4). Nothing was paid twice.
- **Dispute journey (#3)** used the demo arbiter key held by the server. It is a demonstration of the dispute path, not an independent human review.
- The public RPC rate limits bursts and rejected one multi-topic log query as too large. The backend now retries with backoff and reads logs with an address-only filter. Only reads were affected; no transaction was sent twice.
- Gas is paid in USDC, so wallet balances differ slightly from payout totals.

## Not yet done

- Real physical-sensor input (see `docs/ADAPTERS.md`); the sample adapter was not run against hardware.
- ERC-8004 outcome feedback (`recordOutcome`) was not exercised on testnet.
- No independent third-party review of the contracts; no mainnet deployment (see `docs/MAINNET_RUNBOOK.md`).

## Reproduce

```bash
bun run fq:keygen      # only if .env lacks role keys
# fund the operator wallet with >= 6 test USDC, then:
bun run server &
bun run fq:setup --with-8004
bun run fq:journey accept
bun run fq:journey reject          # FQ_TILE_REJECT=E2 to pick a different tile
bun run fq:journey dispute
bun run scripts/fq-verify.ts       # independent receipt + Transfer-log verification
```
