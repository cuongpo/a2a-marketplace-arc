# Threat model and trust assumptions

Status: unaudited. The contracts passed two internal review rounds (one Critical and one High found in round one, both fixed) and 161 Foundry tests, including invariants. That is not an independent audit. Do not use on mainnet without one.

## What the system does and does not prove

- A valid sensor signature proves that the holder of a registered device key signed that reading for that mission, tile, unit and time. It does not prove the water level is true. A compromised, spoofed or lying sensor still signs.
- The verifier's checks are deterministic and public: hashes, signatures, nonce uniqueness, schema, freshness, plausibility bounds and an optional second source. Passing them means the evidence is internally consistent, not that the physical world matches.
- Ambiguous evidence (second source disagrees) is escalated to a human arbiter. The system does not claim a definitive physical truth.
- ERC-8004 reputation is a social signal, not proof of truth. The adapter is optional and cannot affect escrow.
- A photo hash, if supplied, is advisory only and never treated as proof of date or location. No model-based photo review is implemented in this build.
- The demo fixture is simulated. Its readings are labelled SIMULATED in the bundle, the UI and the receipt.

## Actors and trust

| Actor | Trusted for | Cannot do |
| --- | --- | --- |
| Operator | Own vault budget and policy | Touch other operators' funds |
| Buyer agent (executor) | Creating missions inside caps | Withdraw, change policy, pay anyone but an allowlisted escrow |
| Provider | Delivering a signed observation | Get paid without a verifier accept or arbiter ruling |
| Verifier | Honest verdicts for its fee | Move funds; its signature only selects accept, reject or escalate |
| Arbiter | Ruling challenged or escalated missions | Pay itself or anyone except the mission's provider, verifier or refund address |
| Anyone | Relaying verdicts, finalizing, expiring, claiming refunds | Redirect funds |

There is no owner, admin, pause or upgrade key on the escrow, registry or adapter. The vault has no admin; operators control only themselves.

## Settlement table

P = provider price, F = verifier fee.

| Route | Provider | Verifier | Buyer refund |
| --- | --- | --- | --- |
| Accept verdict, window passes | P | F | 0 |
| Reject verdict, window passes | 0 | F | P |
| Deadline missed or cancelled before assignment | 0 | 0 | P + F |
| Challenge, arbiter rules for provider (signed verdict exists) | P | F | 0 |
| Challenge, arbiter rules for buyer (signed verdict exists) | 0 | F | P |
| Arbiter silent for 7 days after challenge, verdict was Accept | P | F | 0 |
| Arbiter silent, verdict was Reject or Escalate | 0 | F | P |
| No verdict for 3 days, escalated, arbiter silent | 0 | 0 | P + F |

Design choice: when the arbiter is silent, the independently signed verifier verdict stands, and with no verdict the buyer is made whole. Arbiter silence can never let the challenging party win by default.

## Threats and controls

- Replay of verdicts: EIP-712 domain binds chain id and escrow address; payload binds mission, evidence hash, decision, reason hash, expiry and a per-verifier nonce. Tested across missions, chains and contract deployments.
- Replay of sensor readings: nonce is single-use per (consuming contract, signer); another caller cannot burn the escrow's nonces. Reading binds mission, tile and unit and must be fresh and after mission creation.
- Wrong device: signers are bound to a provider and countersign the binding; revoked or re-registered keys are rejected.
- Vault drain via a hostile escrow: operators can only allowlist escrows fixed when the vault was deployed; funding must debit exactly the committed amount; refund credits are bounded by the commitment. (This was the round-one Critical.)
- Reentrancy: ReentrancyGuard on all token-moving paths; tested with a reentrant token.
- Odd tokens: exact-amount funding is verified by balance delta, so fee-on-transfer tokens are rejected.
- USDC blocklist or transfer failure: withdrawals and refunds revert with state intact; one blocked party cannot trap others; `withdraw(to)` and `redirectRefund` allow an alternative address.
- Stuck funds: verifier inaction is escalated after 3 days, arbiter inaction resolves after 7 days, unassigned or unfinished missions expire after the deadline.
- Time: only coarse comparisons against `block.timestamp`; no reliance on strictly increasing timestamps; no PREVRANDAO.
- Challenge griefing: a losing party can delay by challenging once; delay is bounded by the 7 day arbiter timeout and there is no bond. A bond is a recommended improvement for production.
- Backend key custody: on testnet the role keys live in the backend's `.env` and never reach the browser. On mainnet the server refuses to use them. Mainnet roles must be separate wallets you control; the arbiter must be a human-controlled wallet.
- Public API: reads are public. Every mutating endpoint requires a wallet-signed request (next section). The API also validates input, caps body size, rate limits challenges and writes, never serves private evidence bodies, and the demo guard limits a mission budget to 5 USDC.
- Privacy: only hashes and the reading value are public. Fictional plot ids are used; replace them only with locations you have rights and consent to publish.

## API authentication and authorisation

The backend holds funded demo role keys, so an unauthenticated write endpoint would let anyone make those keys act. Every mutating endpoint (`POST /missions`, `/missions/:id/observation`, `/fixture`, `/challenge`, `/arbiter`) therefore needs an EIP-712 wallet signature. Reads (map, feed, missions, receipts, evidence previews, vault status) stay public.

Flow (`server/auth.ts`):

1. The client posts `{method, path, bodyHash}` to `POST /auth/challenge`. `bodyHash` is keccak256 of the canonical JSON of the body (sorted keys, no whitespace), computed by the client over exactly what it will send.
2. The server mints a 32-byte random nonce, stores it in memory with the method, normalised path, body hash and chain id, and sets a 120 second expiry. Only the paths of the five mutating routes can get a challenge.
3. The wallet signs the typed data `ApiRequest(statement, method, path, bodyHash, nonce, issuedAt, expiresAt)` under the domain `FieldQuest API v1` on the chain id. Signing sends no transaction and moves no funds.
4. The real request carries `Authorization: FieldQuest nonce=0x..., signature=0x...`. The server looks the nonce up, marks it used immediately (first presentation consumes it, success or not), then checks expiry, method, path, chain id and that the received body hashes to what was signed. It rebuilds the typed data from its own stored copy, never from client input, and recovers the signer address.

Roles (`server/authz.ts`) are decided only from the recovered address plus onchain and persisted state:

| Action | Required signer |
|---|---|
| Open a mission | A wallet whose vault policy currently names this buyer agent as executor, not paused, not expired. The mission's operator is the signer; a body that names another operator is refused. |
| Upload evidence, or feed the simulated fixture | The provider wallet bound to that mission (recorded when the buyer agent funded it). |
| Challenge as operator through the API | The mission's operator. The browser instead sends `challengeMission` as a normal wallet transaction. |
| Arbitrate | The `arbiter` address stored in the escrow contract. The server additionally needs to hold that key to act; otherwise it answers 409 and the arbiter calls `resolve` from their own wallet. |

Properties:

- No bearer secret, API key, shared password or cookie exists in the browser bundle or the API. There is no setting that turns authentication off. A missing server key can only make an action unavailable (503/409); it never skips a check.
- Replay: a nonce works once, for one request. A captured Authorization header cannot be reused, on any path, with any body. Restarting the server forgets outstanding nonces, which can only invalidate old signatures.
- Tampering: changing the body, path or method after signing fails with `body_tampered` or `challenge_mismatch`. A forged challenge with a client-chosen nonce is `unknown_challenge`.
- Authenticate first: unauthenticated callers cannot learn whether a mission exists or who holds a role.
- Wrong chain id, expired challenge and malformed headers are rejected; role failures return 403 with the required role and expected address so the UI can explain them.

Limits of this design:

- Signatures are recovered as EOA ECDSA. Smart-contract wallets (ERC-1271) are not supported for API access.
- Challenges live in one process's memory; running several backend instances behind a load balancer would need a shared nonce store.
- The scripted fixture mode (`autoFixture`) is chosen by the authorised operator at creation and is enabled only on testnet; it cannot be triggered by anyone else.
- Authentication proves who is asking, not that a reading is true. Evidence checks are unchanged.
- The server still holds the testnet role keys, so a compromise of the host is a compromise of those wallets. Authentication protects the HTTP surface, not the machine.
- Rate limits are global, not per client, because the backend sits behind a proxy.

## Known limitations

- Verifier and arbiter are single addresses in this version.
- Quote signatures are checked by the buyer agent off-chain and only their hash is committed onchain.
- The reference gauge (second source) is a simulated fixture.
- Pooled vault design means all operators share one contract; operators trust only escrows fixed at its construction.
- The deployed testnet contracts were deployed by the platform deployer account; they have no owner so there is nothing to administer.
