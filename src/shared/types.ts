import type { Address, Hex } from 'viem'

export type NetworkMode = 'testnet' | 'mainnet'

/** Mission objective, hashed (canonical JSON) into the escrow as objectiveHash. */
export interface MissionSpec {
  schema: 'fieldquest.mission/1'
  tile: string // e.g. "B2"
  region: string
  plotId: string // fictional unless real rights/consent are supplied
  objective: string
  metric: 'water_level'
  unit: 'mm'
  plausibleMin: number // inclusive, in unit
  plausibleMax: number // inclusive, in unit
  maxReadingAgeSec: number
  deadlineUnix: number // absolute unix seconds
  challengeWindowSec: number
  budgetUsdc: string // base units (6 decimals) decimal string; provider price + verifier fee ceiling
  requireSecondSource: boolean
  evidenceRequirements: string[]
}

export interface SignedQuote {
  quoteId: string
  provider: Address
  providerName: string
  priceUsdc: string // base units, 6 decimals
  etaSec: number
  evidenceCapability: 'signed-device' | 'signed-device+photo' | 'field-operator'
  validUntil: number
  tileId: Hex
  specHash: Hex
  signature: Hex // EIP-712 Quote signed by provider
  simulated: boolean
}

export interface ScoredQuote {
  quote: SignedQuote
  score: number
  /** `reliability` is the blended trust score; `trust` exposes every component behind it. */
  parts: { price: number; capability: number; reliability: number; deadline: number; trust?: TrustBreakdown }
  excluded?: string
  /** Informational only: invitations are recommendations, never an allowlist, and do not change the score. */
  invited?: boolean
}

/** Registry-published directory entry for an external provider wallet. Public metadata only: no keys, no secrets. */
export interface AgentRecord {
  wallet: Address
  agentId: string // ERC-8004 identity token id (decimal string)
  displayName: string
  capability: SignedQuote['evidenceCapability']
  minPriceUsdc: string // base units: the least this agent would quote
  maxPriceUsdc: string // base units: the most this agent would quote
  maxEtaSec: number // the slowest delivery this agent will promise
  cardUrl?: string // optional public https profile URL. Never fetched by the backend.
  registrationUri: string // standards-shaped ERC-8004 registration metadata (data URI) or the card URL
  active: boolean
  createdAt: number
  updatedAt: number
  /** Wallets that have held this identity in this directory. More than one means the identity NFT changed hands
   *  and its inherited onchain reputation is NOT counted (reputation follows the token, not the operator). */
  ownerHistory: Address[]
  identity?: { ok: boolean; reason?: string; checkedAt: number }
  supersededBy?: Address
}

/** Every component of an agent's trust score, so ranking is inspectable. Reputation is a social signal, not proof of truth. */
export interface TrustBreakdown {
  local: { ok: number; total: number; score: number }
  onchain: { available: boolean; count: number; avgValue?: number; score?: number; reason?: string; agentId?: string }
  weights: { local: number; onchain: number }
  blended: number
  sampleCount: number
  note: string
}

export interface Invite {
  wallet: Address
  agentId: string
  name: string
  capability: SignedQuote['evidenceCapability']
  score: number
  trust: number
  reasons: string[]
}
export interface MissionInvites {
  at: number
  entries: Invite[]
  considered: number
  skipped: { wallet: Address; reason: string }[]
  note?: string
}
export interface FeedbackRecord {
  status: 'recorded' | 'partial' | 'failed' | 'skipped'
  at: number
  txHash?: Hex
  txHashes?: Hex[] // all confirmed attempts when one role needed a retry
  reason?: string
  entries: { role: 'provider' | 'verifier'; agentId: string; outcome: 'recorded' | 'failed'; value?: string }[]
}

export type ObservationKind = 'simulated-fixture' | 'field-operator-upload' | 'device-adapter'

export interface SignedReadingInput {
  reading: {
    missionId: string
    tileId: Hex
    observedAt: number
    value: string // int256 decimal
    unit: Hex
    nonce: string
    payloadHash: Hex
  }
  signature: Hex
  rawPayload: Record<string, unknown> // device payload; hashed to payloadHash
  kind: ObservationKind
  deviceSerial?: string
  operatorNote?: string
  photoSha256?: Hex // advisory only, never proof of date/location
}

/** Public part of the evidence bundle. The private part is kept server-side and committed by digest. */
export interface EvidenceBundle {
  schema: 'fieldquest.evidence/1'
  missionRef: { chainId: number; escrow: Address; missionId: string }
  tile: string
  plotId: string
  provenance: { kind: ObservationKind; label: string; simulated: boolean; deviceSerialMasked?: string }
  reading: SignedReadingInput['reading']
  signature: Hex
  signer: Address
  provider: Address
  photo?: { sha256: Hex; advisory: true; note: string }
  privateDigest: Hex // keccak256(canonical(private)) — private body is not published
  createdAt: number
}

export interface VerdictRecord {
  decision: 'accept' | 'reject' | 'escalate'
  reasons: { code: string; ok: boolean; detail: string }[]
  reasonHash: Hex
  nonce: string
  expiry: number
  signature: Hex
  verifier: Address
}

/** A separately operated, paid reference reading. The x402 payment is a Gateway
 * authorization and may settle in a later batch, so `transaction` is not
 * necessarily an Arc transaction hash. */
export interface SecondSourceRecord {
  schema: 'a2a.reference/1'
  missionId: string
  tile: string
  valueMm: number
  observedAt: number
  sourceId: string
  provenance: 'field-operator-upload' | 'device-adapter' | 'simulated-fixture'
  signer: Address
  signature: Hex
  payloadHash: Hex
  seller: Address
  payer: Address
  network: string
  priceUsdc: string
  paymentReference: string
  purchasedAt: number
}

export type StageId =
  | 'quoting'
  | 'decided'
  | 'funding'
  | 'funded'
  | 'assigned'
  | 'awaiting_observation'
  | 'evidence_submitted'
  | 'verdict'
  | 'challenge_window'
  | 'challenged'
  | 'settled'
  | 'expired'
  | 'blocked'
  | 'failed'

export interface TxRecord {
  label: string
  hash: Hex
  from: Address
  status: 'pending' | 'success' | 'reverted'
  blockNumber?: string
  at: number
}

export interface AuditEntry {
  at: number
  agent: 'operator' | 'buyer' | 'provider' | 'verifier' | 'keeper' | 'arbiter' | 'system'
  level: 'info' | 'warn' | 'error'
  message: string
  data?: Record<string, unknown>
}

export interface MissionRecord {
  id: string // local id
  createdAt: number
  operator: Address
  scenario: 'accept' | 'reject' | 'dispute' | 'custom'
  spec: MissionSpec
  specHash: Hex
  /** Public-bid close time. Absent on legacy scripted missions. */
  quoteDeadlineUnix?: number
  stage: StageId
  stageNote?: string
  quotes: SignedQuote[]
  /** Snapshot of agents invited when the request opened. Recommendations only; any signed quote may still bid. */
  invites?: MissionInvites
  /** ERC-8004 outcome feedback. Present only when an adapter transaction was actually confirmed (or skipped with a reason). */
  feedback?: FeedbackRecord
  /** Final escrow outcome read onchain (1 = provider paid, 2 = buyer refunded). */
  chainOutcome?: number
  decision?: {
    chosenQuoteId: string
    scored: ScoredQuote[]
    rationale: string
    at: number
  }
  chain?: {
    chainId: number
    escrow: Address
    onchainId: string
    provider: Address
    verifier: Address
    providerPrice: string
    verifierFee: string
    deadline: number
    createdBlock: string
    createdAtChain: number
  }
  /** When true the provider agent feeds the SIMULATED fixture automatically (used by demo scripts). */
  autoFixture?: boolean
  observation?: SignedReadingInput
  evidenceHash?: Hex
  verdict?: VerdictRecord
  secondSource?: SecondSourceRecord
  secondSourceAttemptAt?: number
  txs: TxRecord[]
  audit: AuditEntry[]
  jobs: Record<string, JobRecord>
}

export interface JobRecord {
  key: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  txHash?: Hex
  lastError?: string
  updatedAt: number
}
