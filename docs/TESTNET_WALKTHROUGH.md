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

This was the first mission that ran after the API was hardened. The API write for it, `POST /missions` (which enabled the simulated fixture feed), was an EIP-712 wallet-signed request with a single-use server nonce, signed by the role wallet that the server's role check requires (the vault operator wallet to open the mission). Nothing was sent unsigned. The agents' onchain transactions below are signed by the agent wallets as before. The signing happened in `scripts/fq-journey.ts` via `scripts/lib/signed-api.ts` (the same protocol the browser uses), using the demo operator key held in the sandbox, so this proves the protocol and the role checks, not a visitor-driven browser flow.

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

### Mission #6: Accepted journey with ONE paid x402 reference purchase (tile A1, Provider A)

Public receipt route: `/receipt/6` (also `/receipt/6bc3df6d`). Final onchain state: **Settled / ProviderPaid**. Funded 0.45 USDC (0.40 provider price + 0.05 verifier fee). Every API write was an EIP-712 wallet-signed request.

The second-source reading is a **SIMULATED fixture** served by a separate seller process with its own wallet (`demo-reference-seller`, provenance `simulated-fixture`, 394 mm). It is a protocol test, not a physical field reading. The primary provider's simulated sensor reading was 406 mm; the difference of 12 mm was inside the 80 mm tolerance.

| Step | Transaction |
|---|---|
| operator funds the new buyer wallet with 0.02 USDC | [0xa4b4ad48...](https://explorer.testnet.arc.io/tx/0xa4b4ad4822290344bfd67a9e730e98a6351d99d7cd0585ccff6bcb6fb69d5fb3) |
| buyer approves the Gateway wallet | [0xd6f5a536...](https://explorer.testnet.arc.io/tx/0xd6f5a53645cfe56995f3f8c8c4af5df78e71f1fb1963fa4dbc4ba92941a5fed2) |
| buyer deposits 0.005 USDC into Circle Gateway | [0x212e4c9e...](https://explorer.testnet.arc.io/tx/0x212e4c9ededd945a236d19d350a4040a1084c728137fba4dc35a7e193794f62f) |
| buyer agent funds mission from vault (0.45 USDC to escrow) | [0x96351f5f...](https://explorer.testnet.arc.io/tx/0x96351f5f35ce74a904b920863495ed0f599131fcb163d041054ee6457eeacf8e) |
| provider accepts | [0x7de16c34...](https://explorer.testnet.arc.io/tx/0x7de16c34b4ba77f17ec1b6381ccc9f8917ef1c0eefbd22cf367530f3a85cc7bf) |
| provider submits evidence hash | [0xeca2fe36...](https://explorer.testnet.arc.io/tx/0xeca2fe368b4973f942a8cd103c2c72e799d94d42938fbfa0a5d78cac794da61e) |
| verifier signed accept verdict | [0x4f5e1cbb...](https://explorer.testnet.arc.io/tx/0x4f5e1cbb10a5368dd32a012d55b695d6245d6a7cd7f25ec1c63fa8e495b7f2b4) |
| keeper finalizes | [0xb0b1f348...](https://explorer.testnet.arc.io/tx/0xb0b1f348bb10f35679a4fc2a4abe23a04816ff7b692830254ea42b93d8ca53cd) |
| vault reconciles | [0x628b4317...](https://explorer.testnet.arc.io/tx/0x628b4317fc99ac10859738d89a389ad4cc603c333e921caf7e337ff81c810b64) |
| provider withdraws 0.40 USDC | [0xedbe49fe...](https://explorer.testnet.arc.io/tx/0xedbe49fe7c8556406e1abb0ee3b746c5fa27cbf2f4b5c88b62ecabe8f4aa1645) |
| verifier withdraws 0.05 USDC | [0x374c4a58...](https://explorer.testnet.arc.io/tx/0x374c4a5820e58d966b6fcb03dcdb12ce6b6598eb9f58c7de77e573a8053d63d7) |

Paid reference: exactly one x402 request of 1000 atomic USDC (0.001) on `eip155:5042002` from payer `0x34d9dA6aec0370b86aDC96E8c3aF70aE8d8fe7A0` to seller `0xCD2A55206dDFE2F8d14C36Bad8379378D323cD26`. Gateway transfer id `7c30e76e-4ae1-4c2e-8031-dc7685617b5a`, status `received` (accepted by Gateway; batch settlement had no onchain hash yet, so none is claimed). Buyer Gateway balance went from 0.005 to 0.004 USDC. The job ran once (1 attempt).

## Open agent network demo (missions #7 and #8)

This section is the first run of the open agent network (external provider runner, directory, invitations, adapter-filtered trust and
ERC-8004 feedback). It ran on the PUBLIC Arc Testnet after the API hardening: every API write was an EIP-712 wallet-signed request (the demo
operator opened the requests; each external provider signed its own directory entry and quotes with its own key). No server-held key
belongs to an external provider.

**External providers (own keys, own env files, separate processes):**

| Agent | ERC-8004 id | Wallet | Feed |
|---|---|---|---|
| Delta Field Operator ("X") | 897726 | `0xE22C543B07a9d9b5CBeba52976CF2C9e144A09b7` | operator-supplied numbers (`field-operator-upload`) |
| Atlas Simulated Feed ("Y") | 897727 | `0xeD7c5BBd96c9A75e338BF8AC753a5cC29231B2Fb` | testnet SIMULATED feed (never selected; it only bid) |

Total test USDC sent to the two new provider wallets for gas: **0.060** (0.035 + 0.025). The readings used the feed file values 421 mm
(request B3) and 415 mm (request C4), typed by the test operator and labelled `field-operator-upload`; they are not physical measurements.

**Onboarding and funding (confirmed receipts):**

| Step | Block | Transaction | Confirmed logs |
|---|---|---|---|
| operator funds external provider X with 0.035 USDC gas | 70111057 | [0x4f684e1c3b...](https://explorer.testnet.arc.io/tx/0x4f684e1c3b14182f935708e93f7583836b2be066650dced853de63d1641f26cd) | Operator to External provider X: 0.035 USDC |
| operator funds external provider Y with 0.025 USDC gas | 70111074 | [0x1043dcd0a5...](https://explorer.testnet.arc.io/tx/0x1043dcd0a54e82c2ea1d22bae90b1ca8e8c3fa800c086d10938ec8abb90a6731) | Operator to External provider Y: 0.025 USDC |
| X registers ERC-8004 identity #897726 | 70111099 | [0xb6c28066ea...](https://explorer.testnet.arc.io/tx/0xb6c28066ea3b2fbdff299eb99f8de84cd31d43650d418b89592f9122aa25633b) | - |
| X binds identity in the marketplace adapter | 70111107 | [0x3c70ce2eb1...](https://explorer.testnet.arc.io/tx/0x3c70ce2eb13cbdaf766f981ad83262e91004d9771844538d6c676ae6688b1dd0) | - |
| X registers its device signer in EvidenceRegistry | 70111116 | [0x3c032609df...](https://explorer.testnet.arc.io/tx/0x3c032609df7984b0bf17d43142c9e616d74c3df5f82c201b8fa72a6d73674d6d) | - |
| Y registers ERC-8004 identity #897727 | 70111133 | [0x84a9c89962...](https://explorer.testnet.arc.io/tx/0x84a9c89962591d6479f6bb66c728aec646e1ce3548b0f2e6307f08fe6018895f) | - |
| Y binds identity in the marketplace adapter | 70111141 | [0xcca2b92e35...](https://explorer.testnet.arc.io/tx/0xcca2b92e35ddde12a3f5c1290c4f028a463a7b4f95be81ba0dc9437996c11813) | - |
| Y registers its device signer in EvidenceRegistry | 70111150 | [0xff33936e18...](https://explorer.testnet.arc.io/tx/0xff33936e18b06ee19b477dbe3d640f0dc7a6eb95cb6e8a55e6cd5ccbd03d33da) | - |

**Mission #7, request B3 (open auction, two invited agents, two signed bids: 0.30 vs 0.34 USDC; X won on price; trust was neutral for both):**

| Step | Block | Transaction | Confirmed logs |
|---|---|---|---|
| mission #7: ERC-8004 outcome feedback via marketplace adapter | 70111748 | [0xa1c0c369bc...](https://explorer.testnet.arc.io/tx/0xa1c0c369bcef4ce866f0b022cf9addabfd903f893cbef33ed7d4bbea1a50d12b) | adapter FeedbackRecorded: provider agent #897726 value 100<br>adapter FeedbackRecorded: verifier agent #897707 value 100 |
| mission #7: verifier withdraws credited USDC | 70111741 | [0x0a527c086a...](https://explorer.testnet.arc.io/tx/0x0a527c086a99a22305ba0b1a681d04b179b7f42d156b0d468c7488b869de914a) | 0xdF6f312e10E6D57eb9b7FAfc599c92e87288d16e to Verifier agent: 0.05 USDC |
| mission #7: vault reconciles settlement and restores refund to operator budget | 70111732 | [0xc30bd96df5...](https://explorer.testnet.arc.io/tx/0xc30bd96df54272590111b31d7fc73aaaf75d7e8ed395946a243324ea2298875f) | - |
| mission #7: keeper finalizes after challenge window and credits payouts | 70111727 | [0x9065ee26c5...](https://explorer.testnet.arc.io/tx/0x9065ee26c577cf7a9dcd600ee8687a708170a8c015b3af82cb31dd5ac9db8c81) | - |
| mission #7: verifier submits signed accept verdict | 70111654 | [0x1d86ce6a00...](https://explorer.testnet.arc.io/tx/0x1d86ce6a00271c38d89146fab14482a07185444cbe84b17ece5c253f1cf1ccec) | - |
| mission #7: buyer agent funds mission from vault | 70111619 | [0xcf5c6acfc4...](https://explorer.testnet.arc.io/tx/0xcf5c6acfc4ffbd7a4842235c51ea70315cd13f0f5518af2596f47bfc56c85d1d) | 0x8C29aC73ee2FeF44542192c4A217620473BCfe76 to 0xdF6f312e10E6D57eb9b7FAfc599c92e87288d16e: 0.35 USDC |
| mission #7: external provider accepts assignment (runner) | 70111637 | [0x6b1a245b43...](https://explorer.testnet.arc.io/tx/0x6b1a245b43ac9c5872844c340c14e392c17ad7d1a0fdfcbbc7db39fd1ff69b5d) | - |
| mission #7: external provider commits evidence hash (runner) | 70111649 | [0x03b35e7e6f...](https://explorer.testnet.arc.io/tx/0x03b35e7e6f11783f1f3d5331a0ae91a297f63de6f3b4a9763aecff375d0ddeea) | - |
| mission #7: external provider withdraws its USDC credit (runner) | 70111729 | [0x182180c69e...](https://explorer.testnet.arc.io/tx/0x182180c69ed4c47f23cbced955276bd6298910b1c8e97af8254b27021ad14757) | 0xdF6f312e10E6D57eb9b7FAfc599c92e87288d16e to External provider X: 0.3 USDC |

**Mission #8, request C4 (X bid 0.32, Y bid 0.30; X won because its adapter-posted ERC-8004 record raised its trust):**

| Step | Block | Transaction | Confirmed logs |
|---|---|---|---|
| mission #8: ERC-8004 outcome feedback via marketplace adapter | 70112177 | [0xfda8d06838...](https://explorer.testnet.arc.io/tx/0xfda8d06838bbaca6f19e639c8acdc9e3dbaffda08442f875d34c164e9c49b9ba) | adapter FeedbackRecorded: provider agent #897726 value 100<br>adapter FeedbackRecorded: verifier agent #897707 value 100 |
| mission #8: verifier withdraws credited USDC | 70112169 | [0xb884adcdba...](https://explorer.testnet.arc.io/tx/0xb884adcdba1a57e3b22cba2e05436254ed47bf64cfd5bbb656ffcad4be1ab04a) | 0xdF6f312e10E6D57eb9b7FAfc599c92e87288d16e to Verifier agent: 0.05 USDC |
| mission #8: vault reconciles settlement and restores refund to operator budget | 70112160 | [0x0f37d39482...](https://explorer.testnet.arc.io/tx/0x0f37d3948205befe2306e9e0ed668a2e01ff0d422569172344eee18cf6002b1e) | - |
| mission #8: keeper finalizes after challenge window and credits payouts | 70112150 | [0x4a0f3b67c1...](https://explorer.testnet.arc.io/tx/0x4a0f3b67c1cd4abc9e530dcd85dcf17220269c58d0c394e3bd6cae042914847f) | - |
| mission #8: verifier submits signed accept verdict | 70112087 | [0x83f69ffb99...](https://explorer.testnet.arc.io/tx/0x83f69ffb99df78c100b9602a72a3b7ae39bd4385a65d2db519dfd26af9eea367) | - |
| mission #8: buyer agent funds mission from vault | 70112047 | [0x7179dcc188...](https://explorer.testnet.arc.io/tx/0x7179dcc1886e5cd8151608d46e23f70ca334aa209d6d5cfaac87c1970b586ac9) | 0x8C29aC73ee2FeF44542192c4A217620473BCfe76 to 0xdF6f312e10E6D57eb9b7FAfc599c92e87288d16e: 0.37 USDC |
| mission #8: external provider accepts assignment (runner) | 70112065 | [0x4d569d6eac...](https://explorer.testnet.arc.io/tx/0x4d569d6eacf37056448b33578405c10e5bdce1d300d291181fd9b80bd1fde989) | - |
| mission #8: external provider commits evidence hash (runner) | 70112084 | [0xb165858746...](https://explorer.testnet.arc.io/tx/0xb165858746b39c595f1cc13b98765916ffc2f8f29c6d630c76a9b0dda577a518) | - |
| mission #8: external provider withdraws its USDC credit (runner) | 70112154 | [0xd822ed8b50...](https://explorer.testnet.arc.io/tx/0xd822ed8b50b7e69ce298e088972587ca35b44f305a4204a7f7d9f831bcd560e1) | 0xdF6f312e10E6D57eb9b7FAfc599c92e87288d16e to External provider X: 0.32 USDC |

Both missions ended Settled / ProviderPaid with the escrow at 0 liabilities. Vault budget: 1.50 USDC available before, 0.78 after (0.35 + 0.37 USDC
funded; the winner's price plus the 0.05 USDC verifier fee each). Provider X wallet ends at 0.629204 USDC (0.30 + 0.32 earned, minus gas); provider Y
wallet ends at 0.010948 USDC (unspent).

**Reputation read back from the registry** (`getSummary` / `readAllFeedback` with clients = [our adapter], tag `fieldquest.delivery`): agent
#897726 has 2 records, mean 100; agent #897727 has 0 records. Raw verification output: `docs/network-verification.txt` and `.json`
(`bun run scripts/fq-verify-network.ts`).

**Provider withdrawals on the receipt.** The escrow's `Withdrawn` event is account-level (no mission id). Receipts only list a withdrawal when this
server's own transaction record links it. An external runner's withdrawal is not recorded by the server, so receipts #7 and #8 show the verifier's
withdrawal but not X's; X's withdrawal transactions are listed above and confirmed by their own receipts.

**A blocked request (no spend).** The first attempt (tile A3) was blocked at discovery because the runners advertised a 1800 s maximum ETA, which does
not fit a 30 minute request with the one-minute margin. No bids, no escrow, no onchain mission. After lowering the advertised ETA to 1200 s the
runners updated their directory entries (no transaction) and requests B3 and C4 proceeded.

## What was verified

- Every transaction above: receipt status `success`, re-fetched from the public RPC after the journey, and (for the provider withdrawal) also found by the explorer API.
- USDC movement was read from ERC-20 `Transfer` logs emitted by the USDC contract. Each transaction also carries one EIP-7708 system Transfer log for the same funds; those were counted but never added, so nothing is double counted.
- Accepted journey: vault to escrow 0.45 USDC (0.40 provider price + 0.05 verifier fee); escrow to **Provider A wallet 0.40 USDC** (its own `withdraw`); escrow to verifier 0.05 USDC. The provider wallet is distinct from the buyer, operator and verifier wallets.
- Rejected journeys: the escrow paid the verifier fee 0.05 USDC and the **buyer refund went from the escrow back to the vault** (0.60, 0.40 and 0.30 USDC respectively), and the vault credited it to the operator's budget. The provider received nothing.
- Mission #4 is the rejection with a provider wallet separate from the accepted journey: Paddy Scout Network (Provider B, `0xa89732...CB6e4`) was chosen by the buyer agent, submitted an implausible simulated reading (valid signature, outside plausibility bounds), and was rejected.
- Escrow held 0 USDC with 0 liabilities after every mission.
- After missions #1 to #4 the vault had 2.40 USDC available, 0 committed, 0.60 net spent (0.45 + 0.05 + 0.05 + 0.05), matching the transfers. After mission #5 it had 1.95 available and 1.05 net spent. After mission #6 it had 1.50 available.
- Evidence hash and spec hash recomputed by the receipt API match the onchain commitments for missions #1 to #5.
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
